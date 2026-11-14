import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { initialState } from "../src/seed.ts";
import { canMoveTask, restartSafeState } from "../src/domain.ts";
import { LocalStore, exists, git, within } from "../runtime/local.ts";
import { localURL } from "../runtime/urls.ts";
import {
  eventMessage,
  harnessArgs,
  WorkerManager,
} from "../runtime/workers.ts";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import type { Project, WorkItem } from "../src/shared.ts";
import { approveFixtureWorker } from "./fixtures/worker-consent";

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "memcode-test-"));
  return {
    root,
    cleanup: async () => {
      assert.ok(
        within(tmpdir(), root) && basename(root).startsWith("memcode-test-"),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("active workers cannot be manually moved to done", () => {
  const task = initialState().tasks[0];
  task.run.state = "running";
  task.stage = "working";
  assert.equal(canMoveTask(task, "done"), false);
  assert.equal(canMoveTask(task, "working"), true);
});

test("restart preserves unfinished work as review, not success", () => {
  const state = initialState();
  const task = state.tasks[0];
  task.example = false;
  task.run = { state: "running", worktree: "C:/work/isolated" };
  const restored = restartSafeState(state).tasks[0];
  assert.equal(restored.run.state, "stopped");
  assert.equal(restored.stage, "review");
  assert.equal(restored.run.worktree, "C:/work/isolated");
  assert.match(restored.run.error!, /unfinished/);
});

test("path boundary rejects sibling prefix and parent traversal", () => {
  const root = join(tmpdir(), "memcode-root");
  assert.equal(within(root, join(root, "artifacts", "preview.html")), true);
  assert.equal(within(root, root + "-other/secret.txt"), false);
  assert.equal(within(root, join(root, "..", "outside")), false);
});

test("browser and dictation destinations are loopback only", () => {
  assert.equal(
    localURL("http://127.0.0.1:8080/inference").hostname,
    "127.0.0.1",
  );
  for (const url of [
    "https://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://user:password@localhost:8080",
  ])
    assert.throws(() => localURL(url));
});

test("Codex prompt is stdin data with no approval bypass", () => {
  const prompt = 'change a label; $(do-not-execute) & a "quoted value"';
  const invocation = harnessArgs(
    "codex",
    "C:/repo with spaces",
    prompt,
    "",
    false,
  );
  assert.equal(invocation.stdin, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  assert.equal(
    invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"),
    false,
  );
  assert.deepEqual(invocation.args.slice(-1), ["-"]);
});

test("harness events preserve actual output and unknown events stay unknown", () => {
  assert.deepEqual(
    eventMessage({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Changed the label. No tests were run.",
      },
    }),
    { role: "assistant", text: "Changed the label. No tests were run." },
  );
  assert.equal(
    eventMessage({ type: "something-new", result: "not a verified result" }),
    null,
  );
});

test("serialized atomic saves preserve the latest workspace", async () => {
  const temp = await temporary();
  try {
    const store = new LocalStore(temp.root);
    await store.load();
    store.state.projects[0].name = "First";
    const first = store.save();
    store.state.projects[0].name = "Latest";
    const latest = store.save();
    await Promise.all([first, latest]);
    const disk = JSON.parse(
      await readFile(join(temp.root, "workspace.json"), "utf8"),
    );
    assert.equal(disk.projects[0].name, "Latest");
    assert.equal(await exists(join(temp.root, "workspace.json.next")), false);
  } finally {
    await temp.cleanup();
  }
});

test("worker joins its epic branch and returns shared changes plus separate artifacts", async () => {
  const temp = await temporary();
  let manager: WorkerManager | undefined;
  try {
    const repo = join(temp.root, "repo");
    await mkdir(repo);
    await git(repo, ["init", "--initial-branch=main"]);
    await writeFile(join(repo, "README.md"), "Fixture project\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@local.invalid",
      "commit",
      "-m",
      "Initial fixture",
    ]);
    const stub = join(temp.root, "fixture-harness.mjs");
    await writeFile(
      stub,
      `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';let prompt='';for await(const chunk of process.stdin)prompt+=chunk;await writeFile('result.txt','A real fixture change');await writeFile(join(process.env.MEMCODE_ARTIFACT_DIR,'report.html'),'<h1>Fixture artifact</h1>');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture complete. No production model was called.'}}));`,
    );
    const state = initialState();
    approveFixtureWorker(state, "codex");
    const project: Project = {
      id: "test-project",
      name: "Test",
      description: "A fixture",
      path: repo,
      branch: "main",
      analysis: "ready",
      repoId: "fixture",
      createdAt: new Date().toISOString(),
    };
    const task: WorkItem = {
      ...state.tasks[0],
      id: "test-work",
      identifier: "MC-001",
      projectId: project.id,
      example: false,
      messages: [],
      stage: "planned",
      run: { state: "idle" },
      scope: ["result.txt"],
    };
    state.projects.push(project);
    state.tasks.push(task);
    manager = new WorkerManager(
      () => state,
      async () => {},
      {
        analyze: async () => "fixture",
        qualify: async () => ({
          state: "unavailable",
          symbols: [],
          incomplete: true,
          note: "Fixture",
          measuredAt: new Date().toISOString(),
        }),
        call: async (_project: unknown, name: string) =>
          name === "fleet_acquire_lease"
            ? { state: "granted", lease_id: "fixture-lease" }
            : {},
      } as unknown as MemtraceEngine,
      join(temp.root, "data"),
      async () => ({ command: process.execPath, prefix: [stub] }),
      async () => [
        {
          id: "codex",
          name: "Fixture Codex",
          available: true,
          path: process.execPath,
          models: [
            {
              id: "fixture-model",
              label: "Fixture",
              tier: "extreme",
              source: "alias",
            },
          ],
        },
      ],
    );
    await manager.start(task, project);
    const deadline = Date.now() + 10000;
    while (
      ["preparing", "running", "stopping"].includes(task.run.state) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    // Final state is persisted after artifact collection, which is asynchronous.
    while (
      !task.messages.some((m) => m.text.startsWith("Worker finished.")) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(task.run.state, "finished");
    assert.equal(task.stage, "review");
    assert.equal(task.run.workspace, repo);
    assert.equal(task.run.worktree, undefined);
    assert.equal(
      await readFile(join(repo, "result.txt"), "utf8"),
      "A real fixture change",
    );
    const { readWorkerChanges } = await import("../runtime/changes");
    const changes = await readWorkerChanges(task);
    assert.equal(changes.files, 1);
    assert.equal(changes.checkpoints[0].files[0].path, "result.txt");
    assert.equal(changes.additions, 1);
    assert.equal(task.diff, undefined);
    assert.equal(state.artifacts.filter((a) => a.taskId === task.id).length, 1);
    assert.match(await git(repo, ["status", "--porcelain"]), /result.txt/);
    assert.equal(
      await git(repo, ["branch", "--show-current"]),
      task.run.branch,
    );
    assert.equal(
      (await git(repo, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
  } finally {
    await manager?.close();
    await temp.cleanup();
  }
});

test("stop during qualification prevents a later process launch", async () => {
  const temp = await temporary();
  const repo = join(temp.root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await writeFile(join(repo, "README.md"), "Fixture");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@local.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  const state = initialState();
  approveFixtureWorker(state, "codex");
  const project = {
    ...state.projects[0],
    path: repo,
    example: false,
    analysis: "ready" as const,
    repoId: "fixture",
  };
  const task: WorkItem = {
    ...state.tasks[0],
    example: false,
    run: { state: "idle" as const },
    stage: "planned" as const,
  };
  state.tasks = [task];
  let release!: (value: any) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let launched = false;
  const engine = {
    qualify: () => pending,
    analyze: async () => "fixture",
  } as unknown as MemtraceEngine;
  const manager = new WorkerManager(
    () => state,
    async () => {},
    engine,
    "unused",
    async () => {
      launched = true;
      return null;
    },
    async () => [],
  );
  const starting = manager.start(task, project);
  const entered = Date.now() + 3000;
  while (!task.run.workspace && Date.now() < entered)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(task.run.state, "preparing");
  await manager.stop(task.id);
  assert.equal(task.run.state, "stopping");
  release({
    state: "unavailable",
    symbols: [],
    incomplete: true,
    note: "Fixture",
    measuredAt: new Date().toISOString(),
  });
  await assert.rejects(starting, /cancelled/);
  assert.equal(launched, false);
  assert.equal(task.run.state, "stopped");
  assert.equal(task.stage, "review");
  await manager.close();
  await temp.cleanup();
});
