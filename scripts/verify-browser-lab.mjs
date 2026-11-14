import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve("../memcode-browser-lab"),
  evidence = join(root, ".memcode/evidence");
const manifest = JSON.parse(
  await readFile(join(evidence, "same-file-proof.json"), "utf8"),
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9329", {
  timeout: 8000,
});
const main = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes("tauri.localhost"));
const call = (method, ...args) =>
  main.evaluate(({ method, args }) => window.memcode[method](...args), {
    method,
    args,
  });
const { state } = await call("load"),
  source = (
    await readFile(join(root, "shared/participants.mjs"), "utf8")
  ).replaceAll("\r\n", "\n");
const participants = JSON.parse(
  source.match(/export const participants = (\[[^\n]*\]);/)[1],
);
assert.deepEqual(participants, manifest.expected);
assert.equal(
  source.slice(source.indexOf("export function appendParticipant")),
  manifest.initialSource.slice(
    manifest.initialSource.indexOf("export function appendParticipant"),
  ),
);
assert.equal(
  state.fleetConflicts.filter(
    (c) => c.projectId === manifest.projectId && c.status === "open",
  ).length,
  0,
);
const inputs = JSON.parse(
  await readFile(join(evidence, "terminal-roundtrip-inputs.json"), "utf8"),
);
const results = [];
for (const [index, worker] of manifest.workers.entries()) {
  const task = state.tasks.find((t) => t.id === worker.taskId);
  assert.equal(task.run.state, "finished");
  const changes = await call("workerChanges", task.id);
  const shared = changes.checkpoints.flatMap((checkpoint) =>
    checkpoint.files
      .filter((file) => file.path === "shared/participants.mjs")
      .map((file) => ({ checkpoint, file })),
  );
  assert.equal(shared.length, 1);
  assert.equal(shared[0].checkpoint.taskId, task.id);
  assert.equal(shared[0].checkpoint.harness, worker.harness);
  const added = shared[0].file.hunks
    .flatMap((h) => h.lines)
    .find((l) => l.kind === "add").text;
  assert.deepEqual(
    JSON.parse(added.match(/= (\[[^\n]*\]);/)[1]),
    manifest.expected.slice(0, index + 1),
  );
  assert.equal(shared[0].file.additions, 1);
  assert.equal(shared[0].file.deletions, 1);
  const record = inputs.records.find((r) => r.harness === worker.harness);
  assert.ok(record);
  const list = await call("terminal", task.id, { action: "list" }),
    session = list.sessions.find((s) => s.id === record.sessionId);
  assert.equal(session.status, "running");
  assert.equal(session.pid, record.pid);
  assert.equal(session.origin, "worker");
  const output = await call("terminal", task.id, {
    action: "observe",
    sessionId: session.id,
  });
  const human = "Terminal echo (" + worker.harness + "): " + record.message;
  const own =
    "Terminal echo (" +
    worker.harness +
    "): worker-" +
    manifest.token +
    "-" +
    worker.harness;
  assert.ok(output.text.includes(human));
  assert.ok(output.text.includes(own));
  const server = JSON.parse(
    await readFile(
      join(root, ".memcode/lab", worker.harness, "server.json"),
      "utf8",
    ),
  );
  assert.equal(server.pid, session.pid);
  const audit = (
    await readFile(
      join(root, ".memcode/workers", task.id, "terminal-activity.jsonl"),
      "utf8",
    )
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(
    audit.some(
      (event) =>
        event.action === "observe" &&
        event.origin === "worker" &&
        event.sessionId === session.id &&
        event.at >= record.at,
    ),
    "Worker must observe after the actual card input",
  );
  const report = await readFile(
    join(root, "apps", worker.harness, "report.md"),
    "utf8",
  );
  assert.ok(
    report.includes(record.message),
    "Worker report must quote the actual human marker",
  );
  const tabs = (await call("browser", task.id, { action: "state" })).state.tabs;
  assert.ok(
    tabs.some((tab) => tab.url.startsWith(server.url)),
    "Worker browser must use its actual managed server",
  );
  results.push({
    harness: worker.harness,
    taskId: task.id,
    sharedFile: { ownCheckpoint: true, additions: 1, deletions: 1 },
    terminal: {
      sessionId: session.id,
      pid: session.pid,
      userInput: record.input,
      workerObserved: true,
      url: server.url,
    },
    browser: { sameManagedServer: true, tabs: tabs.length },
    office: state.artifacts
      .filter((a) => a.taskId === task.id && /\.(xlsx|docx|pptx)$/.test(a.name))
      .map((a) => a.name),
  });
}
const office = JSON.parse(
  await readFile(join(evidence, "office-views.json"), "utf8"),
);
assert.equal(office.passed, true);
assert.equal(office.results.length, 3);
const result = {
  passed: true,
  at: new Date().toISOString(),
  sharedBranch: state.tasks.find((t) => t.id === manifest.workers[0].taskId).run
    .branch,
  participants,
  semanticHumanConflicts: 0,
  results,
  officePreviews: true,
};
await writeFile(
  join(evidence, "verified-lab.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
