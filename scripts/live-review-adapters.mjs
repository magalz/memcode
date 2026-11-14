// Real installed-model conformance through the shared review UI. Leaves its
// separate lab window open and never closes the user's existing browser/app.
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

const profile = await mkdtemp(join(tmpdir(), "memcode-review-adapters-")),
  root = resolve("../memcode-review-lab"),
  runId = randomUUID(),
  sourceDir = "reviews/" + runId,
  harnesses = ["claude", "cursor", "codex"],
  labels = { claude: "Claude Code", cursor: "Cursor", codex: "Codex" },
  models = { claude: "haiku", cursor: "composer-2.5", codex: "gpt-6-luna" };
await mkdir(join(root, sourceDir), { recursive: true });
let gitReady = true;
try {
  execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], {
    stdio: "ignore",
  });
} catch {
  gitReady = false;
}
if (!gitReady) {
  execFileSync("git", ["init", "--initial-branch=main", root]);
  await writeFile(join(root, ".gitignore"), ".memcode/\n");
}
await writeFile(
  join(root, "review-lab.ts"),
  "// Review workflow lab entry point.\nexport const reviewLab = true;\n",
);
const fixtures = harnesses.map((harness) => ({
  harness,
  path: sourceDir + "/" + harness + ".md",
  quote: "Draft wording for " + labels[harness] + " " + runId + ".",
  replacement: "Reviewed wording approved for " + labels[harness] + ".",
  protectedQuote: "Keep this sentence unchanged for " + labels[harness] + ".",
}));
for (const fixture of fixtures)
  await writeFile(
    join(root, fixture.path),
    "# Review workflow fixture\n\n" +
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
  "review-lab.ts",
]);
execFileSync("git", [
  "-C",
  root,
  "-c",
  "user.name=MemCode Review Lab",
  "-c",
  "user.email=review-lab@localhost",
  "commit",
  "-m",
  "Seed explicit review workflow fixtures",
]);

const state = initialState(),
  original = JSON.parse(
    await readFile(join(process.env.APPDATA, "MemCode/workspace.json"), "utf8"),
  );
state.settings = original.settings;
state.projects = [
  {
    ...state.projects[0],
    id: "review-adapters",
    name: "Review Workflow Lab",
    description:
      "Real Claude Code, Cursor and Codex review follow-ups; test-driver fixtures are labelled.",
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
state.activeProjectId = "review-adapters";
await writeFile(join(profile, "workspace.json"), JSON.stringify(state));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
console.log(JSON.stringify({ reviewLab: profile, port, runId }));
const stdout = openSync(join(profile, "stdout.log"), "a"),
  stderr = openSync(join(profile, "stderr.log"), "a");
const child = spawn(nativeBinary(), [], {
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
assert.ok(browser, "Native review lab did not start");
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
  };
const epic = await call("createEpic", {
  projectId: "review-adapters",
  title: "Shared review workflow",
  description:
    "Save, choose, stage and explicitly send review comments through each real adapter.",
  phase: "now",
});
const results = [];
await call("analyzeProject", "review-adapters");
const connected = (await call("load")).state.projects.find(
  (p) => p.id === "review-adapters",
);
assert.equal(connected.analysis, "ready", connected.analysisNote);
console.log("Review lab connected to the installed Memtrace engine.");
for (const fixture of fixtures) {
  const task = await call("createTask", {
    projectId: "review-adapters",
    epicId: epic.id,
    title: "Review follow-up — " + labels[fixture.harness],
    description:
      "Apply only explicitly sent review comments. Preserve other files and unselected text. This is a bounded real-adapter test; do not commit or stop other sessions.",
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
    "Test-driver source reference. Review comments are saved locally until explicitly attached and sent.",
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
  await call("selectProject", "review-adapters");
  if (await main.locator(".detail-overlay").count())
    await click(
      main.getByRole("button", { name: "Close work item", exact: true }),
    );
  await click(main.getByRole("button", { name: "Conversations", exact: true }));
  await click(main.getByRole("button").filter({ hasText: task.title }).first());
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
  const before = (await snapshot(task.id)).task.messages.length,
    notes = [];
  for (const [quote, text] of [
    [
      fixture.quote,
      'Replace only the selected sentence with "' +
        fixture.replacement +
        '". Preserve the other sentence.',
    ],
    [
      fixture.protectedQuote,
      'UNSELECTED TEST SENTINEL: replace this sentence with "THIS MUST NEVER BE APPLIED".',
    ],
  ]) {
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
    await main
      .getByRole("textbox", { name: "Review comment", exact: true })
      .fill(text);
    await click(
      main.getByRole("button", { name: "Save comment", exact: true }),
    );
    await expect(
      main.getByRole("region", { name: "New annotation" }),
    ).toHaveCount(0);
    const { state, task: current } = await snapshot(task.id),
      note = state.reviewComments.filter((c) => c.taskId === task.id).at(-1);
    assert.equal(current.messages.length, before);
    assert.equal(current.run.state, "idle");
    assert.equal(note.reference.quote, quote);
    assert.equal(note.status, "saved");
    await expect(
      view.locator(`[data-comment-id="${note.id}"] .annotation-rect`).first(),
    ).toBeVisible();
    notes.push(note);
  }
  await click(
    view.locator(`[data-comment-id="${notes[0].id}"] .annotation-pin`),
  );
  const panel = main.getByRole("region", { name: "Saved review comments" });
  await expect(panel).toContainText(notes[0].text);
  for (const checkbox of await panel.getByRole("checkbox").all())
    await checkbox.uncheck();
  await call("updateTask", task.id, { priority: "high" });
  await expect(
    panel.getByRole("checkbox", { name: "Include comment 1" }),
  ).not.toBeChecked();
  await expect(
    panel.getByRole("checkbox", { name: "Include comment 2" }),
  ).not.toBeChecked();
  await expect(
    panel.getByRole("button", { name: /Add 0 to follow-up/ }),
  ).toBeDisabled();
  await panel.getByRole("checkbox", { name: "Include comment 1" }).check();
  await click(panel.getByRole("button", { name: /Add 1 to follow-up/ }));
  await expect(main.locator(".followup-comment-chips>span")).toHaveCount(1);
  assert.equal(
    (await snapshot(task.id)).task.messages.length,
    before,
    "Staging must not send",
  );
  await main
    .getByRole("textbox", { name: "Message to worker", exact: true })
    .fill(
      "Apply only the attached selected review comment. Before editing coordinate inspect with a concrete plan, obey canEdit, then checkpoint. Do not change unselected sentences or any other source file. After editing use a short native test command to confirm the source contains the requested wording and preserves its other sentence. Save a Markdown receipt in MEMCODE_ARTIFACT_DIR as review-receipt.md with the attached original quote, source path, exact character offsets from Selection target, source version, what changed and the actual check result. Do not commit. Finish with a short answer.",
    );
  await click(
    main.getByRole("button", { name: "Send follow-up", exact: true }),
  );
  await expect
    .poll(async () => {
      const { task } = await snapshot(fixture.taskId);
      return task.messages.some((m) => m.commentIds?.includes(notes[0].id));
    })
    .toBeTruthy();
  const sent = await snapshot(task.id),
    message = sent.task.messages.find((m) =>
      m.commentIds?.includes(notes[0].id),
    );
  assert.deepEqual(message.commentIds, [notes[0].id]);
  assert.equal(message.text.includes("UNSELECTED TEST SENTINEL"), false);
  assert.equal(
    sent.state.reviewComments.find((c) => c.id === notes[1].id).status,
    "saved",
  );
  results.push({
    harness: fixture.harness,
    taskId: task.id,
    commentId: notes[0].id,
    unselectedCommentId: notes[1].id,
    savedWithoutSending: true,
    stagedWithoutSending: true,
    deselectSurvivesRefresh: true,
    explicitUiSend: true,
    reference: notes[0].reference,
  });
  console.log(
    "Sent selected review through real " +
      labels[fixture.harness] +
      " card UI.",
  );
}
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  const current = (await call("load")).state;
  if (
    results.every((r) =>
      ["finished", "failed", "stopped", "blocked"].includes(
        current.tasks.find((t) => t.id === r.taskId).run.state,
      ),
    )
  ) {
    for (const result of results) {
      const task = current.tasks.find((t) => t.id === result.taskId),
        fixture = fixtures.find((f) => f.taskId === task.id),
        content = await readFile(join(root, fixture.path), "utf8");
      result.run = task.run;
      result.requestedEditApplied =
        content.includes(fixture.replacement) &&
        !content.includes(fixture.quote);
      result.unselectedTextPreserved =
        content.includes(fixture.protectedQuote) &&
        !content.includes("THIS MUST NEVER BE APPLIED");
      result.harnessUnchanged = task.harness === result.harness;
      const receipt = current.artifacts.find(
        (a) => a.taskId === task.id && a.name === "review-receipt.md",
      );
      const text = receipt ? await readFile(receipt.path, "utf8") : "";
      result.receipt = receipt?.path;
      result.quoteAcknowledged = text.includes(result.reference.quote);
      result.offsetsAcknowledged =
        text.includes(String(result.reference.startOffset)) &&
        text.includes(String(result.reference.endOffset));
      result.sourceVersionAcknowledged = text.includes(
        result.reference.revision,
      );
      result.passed =
        task.run.state === "finished" &&
        result.requestedEditApplied &&
        result.unselectedTextPreserved &&
        result.harnessUnchanged &&
        result.quoteAcknowledged &&
        result.offsetsAcknowledged &&
        result.sourceVersionAcknowledged;
    }
    const report = {
      at: new Date().toISOString(),
      runId,
      profile,
      root,
      port,
      passed: results.every((r) => r.passed),
      results,
    };
    await mkdir(join(root, ".memcode/evidence"), { recursive: true });
    await writeFile(
      join(root, ".memcode/evidence/review-adapters.json"),
      JSON.stringify(report, null, 2),
    );
    await main.screenshot({
      path: join(root, ".memcode/evidence/review-adapters.png"),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  }
  await new Promise((done) => setTimeout(done, 1000));
}
throw Error(
  "Review workers are still pending after five minutes. Their lab window remains open; inspect before retrying.",
);
