import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findSchema, understandSchema, assessSchema } from "./contracts";
import { loopbackUrl } from "./local-model";

export async function runContextGateway(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const endpoint = loopbackUrl(config.endpoint);
  if (endpoint.pathname !== "/context" || !/^[a-f0-9]{64}$/.test(config.token))
    throw new Error("Invalid host-bound context session");
  const server = new McpServer({ name: "memcode-context", version: "1.0.0" });
  for (const [name, schema, description] of [
    [
      "find",
      findSchema,
      "Find code with scoped graph search and verified literal excerpts. Text fallback needs a narrow scope and explicit reason.",
    ],
    [
      "understand",
      understandSchema,
      "Understand one exact symbol: literal source, observed callers/dependencies and refreshed constraints. Ambiguity requires selecting a file.",
    ],
    [
      "assess",
      assessSchema,
      "Assess a declared change using source, preflight and constraints. Suggestions are not executed checks. Fleet decisions remain with the host.",
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: Record<string, unknown>) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + config.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ capability: name, ...input }),
          signal: AbortSignal.timeout(120000),
          redirect: "error",
        });
        const text = await response.text();
        return {
          content: [{ type: "text" as const, text }],
          ...(response.ok ? {} : { isError: true }),
        };
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
