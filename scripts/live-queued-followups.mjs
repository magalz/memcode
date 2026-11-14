// Real two-pass native UI conformance. Explicit busy Send must start the next
// pass automatically. Never calls startWorker or Resume for that second pass.
// Leaves its separate lab window open; never closes the user's existing app.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initialState } from "../src/seed.ts";
import { nativeBinary, nativeEnv } from "./tauri-env.mjs";
import { createReviewQueueGate } from "./fixtures/review-queue-browser-gate.mjs";
const profile = await mkdtemp(join(tmpdir(), "memcode-queued-followups-")),
  runId = randomUUID(),
  root = resolve("../memcode-queue-lab-" + runId.slice(0, 8)),
  sourceDir = "reviews/" + runId,
  labels = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" },
  models = { claude: "haiku", cursor: "composer-2.5", codex: "gpt-6-luna" },
  fixtures = ["claude", "cursor", "codex"].map((harness) => ({
    harness,
    path: sourceDir + "/" + harness + ".md",
    quote: "Draft wording for " + labels[harness] + " " + runId + ".",
    replacement: "Queued review applied by " + labels[harness] + ".",
    protectedQuote: "Keep this sentence unchanged for " + labels[harness] + ".",
  })),
  evidence = join(root, ".memcode/evidence"),
  report = {
    at: new Date().toISOString(),
    runId,
    profile,
    root,
    passed: false,
    mechanism: "managed browser response held by test driver",
    results: [],
  };
await mkdir(join(root, sourceDir), { recursive: true });
let initialized = true;
const gateServer = await createReviewQueueGate(root, runId);
try {
  execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], {
    stdio: "ignore",
  });
} catch {
  initialized = false;
}
if (!initialized) {
  execFileSync("git", ["init", "--initial-branch=main", root]);
  await writeFile(join(root, ".gitignore"), ".memcode/\n");
}
await writeFile(
  join(root, "queue-lab.ts"),
  "// Labelled queue workflow lab entry point.\nexport const queueLab = true;\n",
);
for (const fixture of fixtures)
  await writeFile(
    join(root, fixture.path),
    "# Queued review fixture\n\n" +
      fixture.quote +
      "\n\n" +
      fixture.protectedQuote +
      "\n",
  );
execFileSync("git", [
  "-C",
  root,
  "add",
  "--",
  sourceDir,
  ".gitignore",
  "queue-lab.ts",
]);
execFileSync("git", [
  "-C",
  root,
  "-c",
  "user.name=MemCode Queue Lab",
  "-c",
  "user.email=queue-lab@localhost",
  "commit",
  "-m",
  "Seed bounded automatic follow-up queue fixtures",
]);
const state = initialState(),
  original = JSON.parse(
    await readFile(join(process.env.APPDATA, "MemCode/workspace.json"), "utf8"),
  );
state.settings = {
  ...original.settings,
  maxWorkers: Math.max(3, original.settings.maxWorkers),
};
state.projects = [
  {
    ...state.projects[0],
    id: "queue-adapters",
    name: "Automatic Follow-up Lab",
    description:
      "Real Claude Code, Cursor and Codex busy-run follow-ups; labelled driver gate fixtures.",
    path: root,
    branch: "main",
    example: false,
    analysis: "idle",
  },
];
state.tasks = [];
state.epics = [];
state.artifacts = [];
state.reviewComments = [];
state.activeProjectId = "queue-adapters";
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
report.port = port;
await mkdir(evidence, { recursive: true });
await writeFile(
  join(evidence, "queued-followups.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ queueLab: profile, port, runId }));
const stdout = openSync(join(profile, "stdout.log"), "a"),
  stderr = openSync(join(profile, "stderr.log"), "a"),
  child = spawn(nativeBinary(), [], {
    cwd: resolve("."),
    windowsHide: true,
    detached: true,
    env: nativeEnv({
      MEMCODE_DATA_DIR: profile,
      MEMCODE_APP_PATH: resolve("."),
      MEMCODE_SERVICE_PATH: resolve("dist-runtime/service.cjs"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    }),
    stdio: ["ignore", stdout, stderr],
  });
closeSync(stdout);
closeSync(stderr);
let browser, main;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
      timeout: 1000,
    });
    break;
  } catch {
    if (child.exitCode !== null)
      throw Error(
        (await readFile(join(profile, "stderr.log"), "utf8")).slice(-4000),
      );
    await new Promise((done) => setTimeout(done, 250));
  }
}
assert.ok(browser, "Native queue lab did not start");
await expect
  .poll(() => {
    main = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes("tauri.localhost"));
    return !!main;
  })
  .toBeTruthy();
await main.waitForFunction(() => !!window.memcode);
const call = (method, ...args) =>
    main.evaluate(({ method, args }) => window.memcode[method](...args), {
      method,
      args,
    }),
  click = (locator) => locator.evaluate((element) => element.click()),
  snapshot = async (taskId) => {
    const { state } = await call("load");
    return { state, task: state.tasks.find((t) => t.id === taskId) };
  },
  saveReport = () =>
    writeFile(
      join(evidence, "queued-followups.json"),
      JSON.stringify(report, null, 2),
    );
async function openTask(task) {
  if (await main.locator(".detail-overlay").count())
    await click(
      main.getByRole("button", { name: "Close work item", exact: true }),
    );
  await click(main.getByRole("button", { name: "Conversations", exact: true }));
  await click(main.getByRole("button").filter({ hasText: task.title }).first());
}
async function send(text) {
  await main
    .getByRole("textbox", { name: "Message to worker", exact: true })
    .fill(text);
  await click(main.locator("button.send-button"));
}
async function select(view, quote) {
  await view.locator(".markdown-document").evaluate((element, quote) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(quote);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + quote.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
      }
    }
    throw Error("Selection quote not found");
  }, quote);
  await expect(
    view.getByRole("button", { name: "Comment on selection", exact: true }),
  ).toBeEnabled();
  await click(
    view.getByRole("button", { name: "Comment on selection", exact: true }),
  );
}
try {
  await call("analyzeProject", "queue-adapters");
  const connected = (await call("load")).state.projects.find(
    (p) => p.id === "queue-adapters",
  );
  assert.equal(connected.analysis, "ready", connected.analysisNote);
  const epic = await call("createEpic", {
    projectId: "queue-adapters",
    title: "Automatic busy-worker follow-ups",
    description:
      "Same branch, same review UI, automatic second passes for all three adapters.",
    phase: "now",
  });
  for (const fixture of fixtures) {
    const task = await call("createTask", {
      projectId: "queue-adapters",
      epicId: epic.id,
      title: "Automatic follow-up — " + labels[fixture.harness],
      description:
        "Bounded two-pass queue conformance. First pass must leave source unchanged and open its managed-browser workload. A later automatically queued pass applies only newly sent review comments. Do not commit, change tools, stop other sessions or inspect the UI's private state. On any pass containing an explicit queued-review instruction, skip the first-pass workload and act on that new instruction.",
      harness: fixture.harness,
      assignment: "manual",
      priority: "medium",
      kind: "test",
    });
    fixture.taskId = task.id;
    await call("updateTask", task.id, {
      scope: [fixture.path],
      modelOverride: models[fixture.harness],
    });
    await call(
      "addMessage",
      task.id,
      "Test-driver source reference only; do not edit until a review is explicitly sent.",
      [
        {
          kind: "file",
          taskId: task.id,
          name: fixture.harness + ".md",
          path: join(root, fixture.path),
          quote: fixture.quote,
        },
      ],
    );
    await call("selectProject", "queue-adapters");
    await openTask(task);
    await send(
      "FIRST PASS ONLY. Do not change source or run a shell gate. Use the MemCode managed browser tool to open " +
        gateServer.url(fixture.harness) +
        " . The loopback test page takes a few seconds to respond while the user queues a follow-up. After browser.open returns, observe its page, save first-pass-receipt.md in this worker's artifact directory stating the browser page completed and source was unchanged, then finish promptly. Do not look for or act on later user messages during this first pass. If this brief also contains a newer QUEUED REVIEW PASS instruction, skip this first-pass instruction and follow the newer one instead.",
    );
    const gateDirectory = join(root, ".memcode/queue-gates", runId),
      readyPath = join(gateDirectory, fixture.harness + ".ready.json");
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(readyPath, "utf8").catch(() => "null")),
        { timeout: 150000, intervals: [500] },
      )
      .toBeTruthy();
    const first = (await snapshot(task.id)).task,
      firstRun = { ...first.run },
      gate = JSON.parse(await readFile(readyPath, "utf8"));
    assert.equal(first.run.state, "running");
    assert.ok(firstRun.changeRunId);
    await click(main.locator(".message-review-ref").first());
    let view;
    await expect
      .poll(() => {
        view = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find(
            (p) => p.url().includes("/p/") && p.url().endsWith("/index.html"),
          );
        return !!view;
      })
      .toBeTruthy();
    await expect(view.locator(".markdown-document")).toContainText(
      fixture.quote,
      { timeout: 15000 },
    );
    const beforeUserMessages = (await snapshot(task.id)).task.messages.filter(
      (m) => m.role === "user",
    ).length;
    await select(view, fixture.quote);
    await main
      .getByRole("textbox", { name: "Review comment", exact: true })
      .fill(
        'Replace only this selected sentence with "' +
          fixture.replacement +
          '". Preserve the other sentence.',
      );
    await click(
      main.getByRole("button", { name: "Save comment", exact: true }),
    );
    await expect(
      main.getByRole("region", { name: "New annotation" }),
    ).toHaveCount(0);
    const saved = await snapshot(task.id),
      note = saved.state.reviewComments
        .filter((c) => c.taskId === task.id)
        .at(-1);
    assert.equal(
      saved.task.messages.filter((m) => m.role === "user").length,
      beforeUserMessages,
    );
    assert.equal(saved.task.run.changeRunId, firstRun.changeRunId);
    assert.equal(note.status, "saved");
    await expect(
      view.locator(`[data-comment-id="${note.id}"] .annotation-rect`).first(),
    ).toBeVisible();
    await click(view.locator(`[data-comment-id="${note.id}"] .annotation-pin`));
    const panel = main.getByRole("region", { name: "Saved review comments" });
    await expect(panel).toContainText(note.text);
    await click(panel.getByRole("button", { name: /Add 1 to follow-up/ }));
    assert.equal(
      (await snapshot(task.id)).task.messages.filter((m) => m.role === "user")
        .length,
      beforeUserMessages,
      "Staging must not send",
    );
    await expect(main.locator(".followup-comment-chips>span")).toHaveCount(1);
    await send(
      "QUEUED REVIEW PASS. This is the newer instruction authorized while your previous run was busy. Do not run the first-pass gate again. Apply only the attached selected review comment to its source file. Coordinate inspect, obey canEdit, edit, checkpoint, and run a focused source-content check preserving the other sentence. Save queued-review-receipt.md in this worker's artifact directory with the original quote, source path, exact selection offsets, source version and actual check result. Do not commit; finish briefly.",
    );
    const queued = await snapshot(task.id),
      message = queued.task.messages.find((m) =>
        m.commentIds?.includes(note.id),
      );
    assert.ok(message);
    assert.equal(message.followupState, "queued");
    assert.equal(message.promptedAt, undefined);
    assert.equal(queued.task.run.changeRunId, firstRun.changeRunId);
    assert.equal(queued.task.run.startedAt, firstRun.startedAt);
    assert.equal(queued.task.run.state, "running");
    assert.equal(
      (await readFile(join(root, fixture.path), "utf8")).includes(
        fixture.quote,
      ),
      true,
    );
    const result = {
      harness: fixture.harness,
      taskId: task.id,
      firstRun,
      gate,
      commentId: note.id,
      messageId: message.id,
      reference: note.reference,
      savedWithoutSending: true,
      stagedWithoutSending: true,
      queuedWhileBusy: true,
      firstRunUnchangedWhileQueued: true,
      automaticSecondPass: false,
    };
    report.results.push(result);
    await saveReport();
    await gateServer.release(fixture.harness);
    console.log(
      "Queued the real " +
        labels[fixture.harness] +
        " follow-up while its original managed-browser request was pending; released original pass.",
    );
  }
  const deadline = Date.now() + 360000;
  while (Date.now() < deadline) {
    const { state } = await call("load");
    for (const result of report.results) {
      const task = state.tasks.find((t) => t.id === result.taskId);
      if (
        task.run.changeRunId &&
        task.run.changeRunId !== result.firstRun.changeRunId
      )
        result.automaticSecondPass = true;
      result.latestRun = { ...task.run };
      const message = task.messages.find((m) => m.id === result.messageId);
      if (
        ["failed", "blocked", "stopped"].includes(task.run.state) &&
        message?.followupState !== "queued"
      )
        throw Error(
          labels[result.harness] +
            " stopped before completing the automatic queue check: " +
            (task.run.error ?? message?.followupState ?? task.run.state),
        );
    }
    if (
      report.results.every(
        (result) =>
          result.automaticSecondPass &&
          ["finished", "failed", "stopped", "blocked"].includes(
            result.latestRun.state,
          ),
      )
    ) {
      for (const result of report.results) {
        const task = state.tasks.find((t) => t.id === result.taskId),
          fixture = fixtures.find((f) => f.taskId === task.id),
          content = await readFile(join(root, fixture.path), "utf8"),
          message = task.messages.find((m) => m.id === result.messageId),
          completion = JSON.parse(
            await readFile(
              join(
                root,
                ".memcode/queue-gates",
                runId,
                fixture.harness + ".completed.json",
              ),
              "utf8",
            ),
          ),
          firstReceipt = state.artifacts.find(
            (a) => a.taskId === task.id && a.name === "first-pass-receipt.md",
          ),
          receipt = state.artifacts.find(
            (a) =>
              a.taskId === task.id && a.name === "queued-review-receipt.md",
          ),
          text = receipt ? await readFile(receipt.path, "utf8") : "";
        result.firstPassCompletion = completion;
        result.firstPassReceipt = firstReceipt?.path;
        result.receipt = receipt?.path;
        result.requestedEditApplied =
          content.includes(fixture.replacement) &&
          !content.includes(fixture.quote);
        result.unselectedTextPreserved = content.includes(
          fixture.protectedQuote,
        );
        result.followupState = message?.followupState;
        result.promptedAt = message?.promptedAt;
        result.explicitMessageCount = task.messages.filter(
          (m) => m.id === result.messageId,
        ).length;
        result.quoteAcknowledged = text.includes(result.reference.quote);
        result.offsetsAcknowledged =
          text.includes(String(result.reference.startOffset)) &&
          text.includes(String(result.reference.endOffset));
        result.sourceVersionAcknowledged = text.includes(
          result.reference.revision,
        );
        result.passed =
          result.automaticSecondPass &&
          task.run.state === "finished" &&
          completion.sourceUnchanged &&
          !!firstReceipt &&
          result.requestedEditApplied &&
          result.unselectedTextPreserved &&
          message?.followupState === "included" &&
          !!message.promptedAt &&
          result.explicitMessageCount === 1 &&
          result.quoteAcknowledged &&
          result.offsetsAcknowledged &&
          result.sourceVersionAcknowledged;
      }
      report.at = new Date().toISOString();
      report.passed = report.results.every((r) => r.passed);
      await saveReport();
      await main.screenshot({ path: join(evidence, "queued-followups.png") });
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.passed ? 0 : 1);
    }
    await saveReport();
    await new Promise((done) => setTimeout(done, 750));
  }
  throw Error(
    "The automatically queued second passes did not complete within six minutes. Inspect actual lab state; do not click Resume to make this test pass.",
  );
} catch (error) {
  report.error = error.stack ?? String(error);
  report.at = new Date().toISOString();
  await saveReport();
  console.error(report.error);
  process.exit(1);
}
