import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextBinding, GraphClient } from "./contracts";
import { ContextBroker } from "./broker";
import {
  discoverLocalModel,
  localAssistant,
  type RetrievalAssistant,
} from "./local-model";
import { discoverOnnxAssistant } from "./onnx";
import { OnnxAssistant } from "./onnx";
import {
  contextAssistantDefaults,
  type ContextAssistantSettings,
} from "../../src/context-settings";

export interface ContextSession {
  endpoint: string;
  token: string;
  configPath: string;
  close(): Promise<void>;
  broker: ContextBroker;
}
/** The worker gateway forwards three requests; graph clients and Fleet authority stay here. */
export async function startContextSession(
  engine: GraphClient,
  binding: ContextBinding,
  directory: string,
  options: {
    assistant?: RetrievalAssistant;
    discoverModel?: boolean;
    settings?: ContextAssistantSettings;
  } = {},
): Promise<ContextSession> {
  await mkdir(directory, { recursive: true });
  let assistant = options.assistant;
  if (!assistant && options.settings?.enabled) {
    const settings = options.settings;
    if (
      settings.provider === "onnx" &&
      settings.model !== contextAssistantDefaults.model
    )
      throw new Error(
        `The ONNX pilot requires model ${contextAssistantDefaults.model}.`,
      );
    assistant =
      settings.provider === "onnx"
        ? new OnnxAssistant(settings.packageDirectory)
        : localAssistant({ baseUrl: settings.baseUrl, model: settings.model });
  }
  if (!assistant && options.discoverModel) {
    const config = await discoverLocalModel();
    assistant = config
      ? localAssistant(config)
      : await discoverOnnxAssistant(binding.project.path!);
  }
  const broker = new ContextBroker(engine, binding, assistant, (record) =>
    appendFile(
      join(directory, "context-diagnostics.jsonl"),
      JSON.stringify(record) + "\n",
      { mode: 0o600 },
    ),
  );
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    const supplied = req.headers.authorization ?? "",
      expected = "Bearer " + token;
    if (
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/context") {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 12000)
          throw new Error("Context request exceeds 12 KiB");
      }
      const result = await broker.execute(JSON.parse(body));
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify(result));
    } catch (error) {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Context host failed to bind loopback");
  const endpoint = `http://127.0.0.1:${address.port}/context`,
    configPath = join(directory, "context-session.json");
  await writeFile(configPath, JSON.stringify({ version: 1, endpoint, token }), {
    mode: 0o600,
  });
  let closing: Promise<void> | undefined;
  return {
    endpoint,
    token,
    configPath,
    broker,
    close: () =>
      (closing ??= (async () => {
        await assistant?.close?.();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })()),
  };
}
