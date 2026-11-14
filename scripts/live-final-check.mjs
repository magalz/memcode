import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
const root = resolve("../memcode-browser-lab"),
  directory = join(root, ".memcode/evidence"),
  manifest = JSON.parse(
    await readFile(join(directory, "same-file-proof.json"), "utf8"),
  );
const browser = await chromium.connectOverCDP("http://127.0.0.1:9329", {
    timeout: 10000,
  }),
  main = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes("tauri.localhost"));
const call = (method, ...args) =>
  main.evaluate(({ method, args }) => window.memcode[method](...args), {
    method,
    args,
  });
const initial = (await call("load")).state;
if (
  initial.tasks.some((task) =>
    ["running", "preparing", "stopping"].includes(task.run.state),
  )
)
  throw Error("Preserving active workers before the final verification.");
await copyFile(
  "scripts/fixtures/browser-lab-server.mjs",
  join(root, "tools/lab.mjs"),
);
const at = new Date().toISOString(),
  records = [];
for (const worker of manifest.workers) {
  const h = worker.harness,
    path = join(root, "apps", h, "report.md"),
    content = await readFile(path, "utf8"),
    quote =
      content
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "") ?? "Report",
    info = await stat(path);
  await call("updateTask", worker.taskId, {
    scope: ["apps/" + h + "/report.md"],
  });
  const note = await call("saveReviewComment", {
    taskId: worker.taskId,
    reference: {
      taskId: worker.taskId,
      kind: "file",
      name: h + "/report.md",
      path,
      quote,
      selectionType: "lines",
      lineStart: 1,
      lineEnd: 1,
      revision: info.mtimeMs + ":" + info.size,
    },
    text:
      "Test-driver review " +
      manifest.token +
      "-" +
      h +
      ": append the final shared-process evidence to this report. Preserve the app, participants and existing Office artifacts.",
  });
  await call(
    "shareReviewComments",
    worker.taskId,
    [note.id],
    [
      "FINAL CONFORMANCE RUN ONLY. Apply the attached test-driver review to apps/" +
        h +
        "/report.md; do not apply older UI-test notes or change the app, participants.mjs or Office files. Do not commit.",
      'Use MemCode terminal tool to list sessions. Start ONE managed PTY program=node, args=["tools/lab.mjs","serve","' +
        h +
        '"' +
        (h === "claude" ? ',"58415"' : "") +
        "], label=" +
        h +
        " live demo. Do not detach. If that requested port is occupied, use port 0; never kill an unknown process. Observe the real URL and PID.",
      "Write ping worker-" +
        manifest.token +
        "-" +
        h +
        " using terminal.write submit=true. The test driver will send a unique human- marker through the exact card terminal input API after your server starts. Wait 20 seconds once, then observe the SAME session; quote only echoes you actually see. Leave this managed process running after you finish.",
      "Open that actual managed URL with MemCode browser. Observe its page, exercise ONE actual control (choose for a select), observe the changed value, and capture a real screenshot. If the user has browser control, preserve it and report that accurately.",
      "Before the report source edit coordinate inspect and only edit with canEdit=true. Append the real session ID, PID, URL, both observed markers, browser result and this attached review token to the report. Checkpoint, copy the report to your artifact directory as " +
        h +
        "-fleet-verification.md, run node --test lab.test.mjs and finish. Keep the final answer short; do not stop the managed server.",
    ].join("\n\n"),
  );
}
const startedAt = new Date().toISOString();
let pendingStarts = manifest.workers.length;
const launches = manifest.workers.map((worker) =>
  call("startWorker", worker.taskId)
    .then(() =>
      console.log("Started real " + worker.harness + " verification."),
    )
    .catch((error) => console.error(worker.harness + ": " + error.message))
    .finally(() => pendingStarts--),
);
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  for (const worker of manifest.workers.filter(
    (w) => !records.some((record) => record.harness === w.harness),
  )) {
    const list = await call("terminal", worker.taskId, { action: "list" }),
      session = list.sessions.find(
        (session) =>
          session.origin === "worker" &&
          session.status === "running" &&
          session.startedAt >= startedAt,
      );
    if (!session) continue;
    const output = await call("terminal", worker.taskId, {
      action: "observe",
      sessionId: session.id,
    });
    if (!output.text?.includes("Live " + worker.harness + " dev server"))
      continue;
    const message = "human-" + randomUUID() + "-" + worker.harness,
      inputAt = new Date().toISOString();
    await call("terminal", worker.taskId, {
      action: "write",
      sessionId: session.id,
      data: "ping " + message,
      submit: true,
    });
    records.push({
      harness: worker.harness,
      taskId: worker.taskId,
      sessionId: session.id,
      pid: session.pid,
      message,
      input: "card terminal input API",
      at: inputAt,
    });
    await writeFile(
      join(directory, "terminal-roundtrip-inputs.json"),
      JSON.stringify({ startedAt, records }, null, 2),
    );
    console.log(
      "Sent the card input to the real " + worker.harness + " process.",
    );
  }
  const state = (await call("load")).state,
    states = manifest.workers.map(
      (worker) =>
        state.tasks.find((task) => task.id === worker.taskId).run.state,
    );
  if (
    !pendingStarts &&
    states.every(
      (status) => !["running", "preparing", "stopping"].includes(status),
    )
  ) {
    console.log(
      JSON.stringify(
        {
          at,
          records,
          results: manifest.workers.map((worker) => ({
            harness: worker.harness,
            run: state.tasks.find((task) => task.id === worker.taskId).run,
            answer: state.tasks
              .find((task) => task.id === worker.taskId)
              .messages.filter((message) => message.role === "assistant")
              .at(-1)
              ?.text.slice(-1800),
          })),
        },
        null,
        2,
      ),
    );
    process.exit(records.length === 3 ? 0 : 1);
  }
  await new Promise((done) => setTimeout(done, 750));
}
throw Error(
  "The final workers have not finished within five minutes. Inspect their actual status before continuing.",
);
