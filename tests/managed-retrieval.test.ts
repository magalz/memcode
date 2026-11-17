import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRetrievalAssistant } from "../runtime/context/managed-assistant";
import type { RetrievalAssistant } from "../runtime/context/local-model";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-managed-retrieval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDirectory = join(root, "runtime"), entry = "node_modules/@huggingface/transformers/dist/transformers.node.mjs";
  const content = Buffer.from("// Unit fixture; real inference is covered by native installer acceptance.\n");
  await mkdir(join(runtimeDirectory, "node_modules/@huggingface/transformers/dist"), { recursive: true });
  await writeFile(join(runtimeDirectory, entry), content);
  await writeFile(join(runtimeDirectory, "provenance.json"), JSON.stringify({ schema: 1, version: "4.3.2", platform: "win32", arch: "x64", entry, files: [{ name: entry, bytes: content.length, sha256: sha(content) }] }));
  const source = new Map([["config.json", Buffer.from('{"fixture":true}')], ["onnx/model_q4.onnx", Buffer.from("not a model; unit download fixture")]]);
  const modelManifest = { id: "fixture/retriever", revision: "fixture-revision", runtimeVersion: "4.3.2", assets: [...source].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes), url: "https://models.example/" + name })) };
  let requests = 0, starts = 0, closes = 0, concurrent = 0, maxConcurrent = 0;
  const fetcher = (async (input: string | URL | Request) => {
    requests++;
    const name = new URL(String(input)).pathname.slice(1), bytes = source.get(name)!;
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch;
  const createAssistant = (): RetrievalAssistant => {
    starts++;
    return { model: "unit-fixture", async plan(query) { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await new Promise(resolve => setTimeout(resolve, 5)); concurrent--; return { query }; }, async rank(_query, candidates) { return { ids: candidates.map(c => c.id) }; }, close() { closes++; } };
  };
  const options = { runtimeDirectory, modelManifest, createAssistant, fetch: fetcher, platform: "win32" as const, arch: "x64" };
  return { root, options, source, counts: () => ({ requests, starts, closes, maxConcurrent }) };
}

test("managed setup verifies downloads once and restores a cached install without network", async t => {
  const f = await fixture(t), data = join(f.root, "profile");
  const first = new ManagedRetrievalAssistant(data, f.options);
  assert.equal((await first.status()).status, "not-installed");
  const installing = first.install(); assert.equal(first.install(), installing);
  assert.equal((await installing).status, "ready");
  assert.equal(f.counts().requests, 2);
  assert.equal(f.counts().starts, 1, "Setup tests actual assistant readiness through its production seam.");
  await first.close();
  const restored = new ManagedRetrievalAssistant(data, { ...f.options, fetch: (async () => { throw Error("No network on cached start"); }) as typeof fetch });
  assert.equal((await restored.status()).status, "ready");
  assert.equal((await restored.install()).status, "ready");
  assert.equal(f.counts().requests, 2);
  await restored.close();
});

test("managed workers share one serialized model and releasing one card preserves another", async t => {
  const f = await fixture(t), manager = new ManagedRetrievalAssistant(join(f.root, "profile"), f.options);
  await manager.install();
  const a = await manager.assistant(), b = await manager.assistant();
  assert.equal(f.counts().starts, 2, "One setup verification and one shared worker process.");
  await Promise.all([a.plan("token expiry"), b.plan("session validation")]);
  assert.equal(f.counts().maxConcurrent, 1);
  await a.close?.(); assert.equal(f.counts().closes, 1, "Closing one card keeps the shared worker model alive.");
  assert.equal((await b.plan("remaining worker")).query, "remaining worker");
  await b.close?.(); await manager.close(); assert.equal(f.counts().closes, 2);
});

test("corrupt downloads fail closed, remove partials, and can be retried", async t => {
  const f = await fixture(t);
  let corrupt = true;
  const manager = new ManagedRetrievalAssistant(join(f.root, "profile"), { ...f.options, fetch: (async (...args) => {
    const response = await f.options.fetch(...args);
    if (!corrupt) return response;
    const bytes = Buffer.from(await response.arrayBuffer()); bytes[0] ^= 1;
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch });
  assert.equal((await manager.install()).status, "error");
  assert.match((await manager.status()).message!, /checksum/);
  assert.equal((await readdir(manager.modelDirectory, { recursive: true })).some(name => String(name).includes(".partial-")), false);
  corrupt = false; assert.equal((await manager.install()).status, "ready");
  await manager.close();
});

test("a missing or altered bundled runtime never enables a model or begins downloads", async t => {
  const f = await fixture(t);
  await writeFile(join(f.options.runtimeDirectory, "node_modules/@huggingface/transformers/dist/transformers.node.mjs"), "altered");
  const manager = new ManagedRetrievalAssistant(join(f.root, "profile"), f.options);
  assert.equal((await manager.status()).status, "error");
  assert.equal((await manager.install()).status, "error");
  assert.equal(f.counts().requests, 0);
  await manager.close();
});

test("ready metadata never substitutes for a full model hash before the first worker load", async t => {
  const f = await fixture(t), profile = join(f.root, "profile");
  const first = new ManagedRetrievalAssistant(profile, f.options);
  await first.install(); await first.close();
  const weight = join(first.modelDirectory, "onnx/model_q4.onnx"), changed = Buffer.from(await readFile(weight)); changed[0] ^= 1;
  await writeFile(weight, changed);
  const receiptPath = join(profile, "local-retriever/fixture-revision/ready.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.files.find((file: { name: string }) => file.name === "onnx/model_q4.onnx").modifiedMs = (await stat(weight)).mtimeMs;
  await writeFile(receiptPath, JSON.stringify(receipt));
  const restored = new ManagedRetrievalAssistant(profile, f.options);
  assert.equal((await restored.status()).status, "ready", "Status is a cheap metadata check.");
  await assert.rejects(restored.assistant(), /failed verification/);
  assert.equal(f.counts().starts, 1, "Changed weights are rejected before a worker model is loaded.");
  await restored.close();
});

test("a failed shared process is released and the next request creates a fresh instance", async t => {
  const f = await fixture(t); let fail = true;
  const manager = new ManagedRetrievalAssistant(join(f.root, "profile"), { ...f.options, createAssistant: () => {
    const assistant = f.options.createAssistant();
    return { ...assistant, async plan(query) { if (query === "simulate failure" && fail) { fail = false; throw Error("Local process exited"); } return assistant.plan(query); } };
  } });
  await manager.install(); const worker = await manager.assistant();
  await assert.rejects(worker.plan("simulate failure"), /process exited/);
  assert.equal((await worker.plan("recover")).query, "recover");
  assert.equal(f.counts().starts, 3, "Setup, failed worker process, replacement process.");
  await worker.close?.(); await manager.close(); assert.equal(f.counts().closes, 3);
});

test("closing a card cancels its queued model request before it can run", async t => {
  const f = await fixture(t); let unblock!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), hold = new Promise<void>(resolve => { unblock = resolve; });
  const queries: string[] = [];
  const manager = new ManagedRetrievalAssistant(join(f.root, "profile"), { ...f.options, createAssistant: () => {
    const assistant = f.options.createAssistant();
    return { ...assistant, async plan(query) { queries.push(query); if (query === "hold") { started(); await hold; } return assistant.plan(query); } };
  } });
  await manager.install(); const a = await manager.assistant(), b = await manager.assistant();
  const first = a.plan("hold"); await entered;
  const queued = b.plan("must not run"), rejected = assert.rejects(queued, /session is closed/);
  await b.close?.(); unblock(); await first; await rejected;
  assert.equal(queries.includes("must not run"), false);
  await a.close?.(); await manager.close();
});

test("app shutdown closes an active setup probe and waits for bounded cancellation", async t => {
  const f = await fixture(t); let rejectProbe!: (error: Error) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); let closes = 0;
  const manager = new ManagedRetrievalAssistant(join(f.root, "profile"), { ...f.options, createAssistant: () => ({
    model: "unit-probe", plan: () => new Promise((_, reject) => { rejectProbe = reject; entered(); }), rank: async () => ({ ids: [] }), close: () => { closes++; rejectProbe(Error("probe cancelled")); },
  }) });
  const install = manager.install(); await started;
  await manager.close(); assert.equal((await install).status, "error"); assert.ok(closes > 0);
});
