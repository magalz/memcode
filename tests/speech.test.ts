import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { SpeechManager, validateSpeechWav } from "../runtime/speech";
import {
  safeArchivePath,
  validateSpeechFiles,
} from "../runtime/speech-install";

function wav() {
  const bytes = Buffer.alloc(76);
  bytes.write("RIFF");
  bytes.writeUInt32LE(68, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(32, 40);
  return bytes;
}
async function endpoint(handler: (request: any, response: any) => void) {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/inference`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

test("speech status never starts a model, downloads assets or requests a microphone", async () => {
  const state = initialState(),
    directory = await mkdtemp(join(tmpdir(), "memcode-speech-status-"));
  let launches = 0,
    saves = 0;
  const manager = new SpeechManager(
    () => state.settings,
    directory,
    async () => {
      saves++;
    },
    ((...args: any[]) => {
      launches++;
      return spawn(...(args as Parameters<typeof spawn>));
    }) as typeof spawn,
  );
  const status = await manager.status();
  assert.equal(status.state, "unconfigured");
  assert.equal(launches, 0);
  assert.equal(saves, 0);
  await manager.close();
});

test("local transcription sends WAV multipart and inserts only returned text", async () => {
  let posts = 0,
    body = "";
  const local = await endpoint((request, response) => {
    if (request.method === "GET") {
      response.end("local");
      return;
    }
    posts++;
    request.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
    request.on("end", () =>
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ text: "  Plan my first story.  " })),
    );
  });
  const state = initialState();
  state.settings.speechEndpoint = local.url;
  state.settings.speech = {
    mode: "endpoint",
    executable: "",
    modelPath: "",
    language: "auto",
  };
  const manager = new SpeechManager(
    () => state.settings,
    tmpdir(),
    async () => {},
  );
  try {
    const text = await manager.transcribe(wav().toString("base64"));
    assert.equal(text, "Plan my first story.");
    assert.equal(posts, 1);
    assert.match(body, /RIFF/);
    assert.match(body, /name="response_format"/);
    assert.match(body, /name="language"/);
  } finally {
    await manager.close();
    await local.close();
  }
});

test("dictation rejects remote endpoints, malformed recordings and empty/silence responses", async () => {
  assert.throws(() => validateSpeechWav("bad"), /WAV/);
  const state = initialState();
  state.settings.speechEndpoint = "https://example.com/inference";
  const manager = new SpeechManager(
    () => state.settings,
    tmpdir(),
    async () => {},
  );
  await assert.rejects(manager.prepare(), /loopback|local/i);
  await manager.close();
  for (const text of ["", "[BLANK_AUDIO]"]) {
    const local = await endpoint((request, response) =>
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ text })),
    );
    state.settings.speechEndpoint = local.url;
    const quiet = new SpeechManager(
      () => state.settings,
      tmpdir(),
      async () => {},
    );
    try {
      await assert.rejects(
        quiet.transcribe(wav().toString("base64")),
        /No speech/,
      );
    } finally {
      await quiet.close();
      await local.close();
    }
  }
});

test("closing local speech aborts a pending request and concurrent requests are refused", async () => {
  let started!: () => void;
  const seen = new Promise<void>((done) => {
    started = done;
  });
  const local = await endpoint((request, response) => {
    if (request.method === "GET") response.end("ready");
    else started();
  });
  const state = initialState();
  state.settings.speechEndpoint = local.url;
  const manager = new SpeechManager(
    () => state.settings,
    tmpdir(),
    async () => {},
  );
  const pending = manager.transcribe(wav().toString("base64"));
  await seen;
  await assert.rejects(manager.transcribe(wav().toString("base64")), /already/);
  await manager.close();
  await assert.rejects(pending, /could not finish/);
  await local.close();
});

test("managed speech shares one loopback child, retains argv boundaries and stops its own process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memcode-speech-managed-")),
    script = join(directory, "server.mjs"),
    model = join(directory, "model.bin");
  await writeFile(model, "fixture");
  await writeFile(
    script,
    'import{createServer}from"node:http";const args=process.argv.slice(2),port=Number(args[args.indexOf("--port")+1]);createServer((q,s)=>s.end("ready")).listen(port,"127.0.0.1");',
  );
  const state = initialState();
  state.settings.speech = {
    mode: "managed",
    executable: process.execPath,
    modelPath: model,
    language: "auto",
  };
  let launches = 0,
    child: ReturnType<typeof spawn> | undefined;
  const launch = ((executable: string, args: string[], options: any) => {
    launches++;
    assert.equal(executable, process.execPath);
    assert.equal(options.shell, false);
    assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(args[args.indexOf("--model") + 1], model);
    return (child = spawn(process.execPath, [script, ...args], options));
  }) as typeof spawn;
  const manager = new SpeechManager(
    () => state.settings,
    directory,
    async () => {},
    launch,
  );
  try {
    const results = await Promise.all([manager.prepare(), manager.prepare()]);
    assert.equal(launches, 1);
    assert.ok(results.every((r) => r.state === "ready"));
    assert.equal((await manager.status()).settings.modelPath, model);
    await manager.stop();
    assert.ok(child?.exitCode !== null || child?.signalCode);
  } finally {
    await manager.close();
  }
});

test("speech archive paths and manual configuration stay local and concrete", async () => {
  for (const name of [
    "../server.exe",
    "/server.exe",
    "C:/server.exe",
    "x\\server.exe",
    "a/../b",
  ])
    assert.equal(safeArchivePath(name), false);
  assert.equal(safeArchivePath("whisper/bin/whisper-server.exe"), true);
  await assert.rejects(
    validateSpeechFiles({
      mode: "managed",
      executable: "whisper-server",
      modelPath: "model.bin",
      language: "auto",
    }),
    /absolute/,
  );
});
