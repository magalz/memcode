import test from "node:test";
import assert from "node:assert/strict";
import { WorkerStartupQueue } from "../runtime/worker-startup";
import { WorkerManager } from "../runtime/workers";
import type { MemtraceEngine } from "../runtime/memtrace";
import { initialState } from "../src/seed";
import { approveFixtureWorker } from "./fixtures/worker-consent";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("preparation is FIFO while all three launched harnesses can keep coding", async () => {
  const queue = new WorkerStartupQueue();
  const started: string[] = [];
  const coding = new Set<string>();
  const gates = [deferred(), deferred(), deferred()];
  const finishes = [deferred(), deferred(), deferred()];
  const launched = [deferred(), deferred(), deferred()];
  let preparing = 0;
  let peak = 0;
  const run = async (name: string, index: number) => {
    const release = await queue.enter(new AbortController().signal);
    try {
      started.push(name);
      peak = Math.max(peak, ++preparing);
      await gates[index].promise;
      coding.add(name);
      preparing--;
    } finally {
      release();
    }
    launched[index].resolve();
    await finishes[index].promise;
    coding.delete(name);
  };
  const runs = [run("claude", 0), run("codex", 1), run("cursor", 2)];
  await Promise.resolve();
  assert.deepEqual(started, ["claude"]);
  gates[0].resolve();
  await launched[0].promise;
  assert.deepEqual(started, ["claude", "codex"]);
  gates[1].resolve();
  await launched[1].promise;
  assert.deepEqual(started, ["claude", "codex", "cursor"]);
  gates[2].resolve();
  await launched[2].promise;
  assert.equal(peak, 1);
  assert.equal(queue.busy, false);
  assert.deepEqual([...coding], ["claude", "codex", "cursor"]);
  finishes.forEach((finish) => finish.resolve());
  await Promise.all(runs);
});

test("stopping a queued worker removes it without waiting for the current preparation", async () => {
  const queue = new WorkerStartupQueue();
  const releaseFirst = await queue.enter(new AbortController().signal);
  const cancelled = new AbortController();
  const second = queue.enter(cancelled.signal);
  const rejected = assert.rejects(second, /Cancelled by user/);
  const third = queue.enter(new AbortController().signal);
  cancelled.abort(new Error("Cancelled by user"));
  await rejected;
  assert.equal(queue.busy, true);
  releaseFirst();
  const releaseThird = await third;
  releaseThird();
  assert.equal(queue.busy, false);
});

test("preparation failure releases the next worker and duplicate release cannot admit two", async () => {
  const queue = new WorkerStartupQueue();
  const releaseFirst = await queue.enter(new AbortController().signal);
  const second = queue.enter(new AbortController().signal);
  let thirdEntered = false;
  const third = queue.enter(new AbortController().signal).then((release) => {
    thirdEntered = true;
    return release;
  });
  await assert.rejects(async () => {
    try {
      throw new Error("Preparation failed");
    } finally {
      releaseFirst();
    }
  }, /Preparation failed/);
  const releaseSecond = await second;
  releaseFirst();
  await Promise.resolve();
  assert.equal(thirdEntered, false);
  releaseSecond();
  (await third)();
  assert.equal(queue.busy, false);
});

test("an already stopped worker never reserves startup", async () => {
  const queue = new WorkerStartupQueue();
  const controller = new AbortController();
  controller.abort(new Error("Already stopped"));
  await assert.rejects(queue.enter(controller.signal), /Already stopped/);
  assert.equal(queue.busy, false);
});

test("WorkerManager reserves queued slots, stops queued work before activation and advances after preparation failure", async () => {
  const state = initialState();
  const project = {
    ...state.projects[0],
    path: "fixture-project",
    analysis: "ready" as const,
    repoId: "startup-fixture",
  };
  state.projects = [project];
  state.settings.maxWorkers = 2;
  state.tasks = ["first", "cancelled", "next"].map((id) => ({
    ...state.tasks[0],
    id,
    projectId: project.id,
    example: false,
    harness: "codex" as const,
    assignment: "manual" as const,
    messages: [],
    run: { state: "idle" as const },
  }));
  approveFixtureWorker(state, "codex");
  const held = deferred();
  const entered = deferred();
  const waiting = deferred();
  const activated: string[] = [];
  const qualified: string[] = [];
  const manager = new WorkerManager(
    () => state,
    async () => {
      if (
        state.tasks[1].run.activity?.label ===
        "Waiting for local worker startup"
      )
        waiting.resolve();
    },
    {
      qualify: async (_project: unknown, task: { id: string }) => {
        qualified.push(task.id);
        if (task.id === "first") {
          entered.resolve();
          await held.promise;
        }
        throw Error("Fixture preparation failure");
      },
      call: async () => ({}),
    } as unknown as MemtraceEngine,
    "fixture-data",
  );
  // Isolate the preparation boundary: no git, model or harness processes run.
  Object.assign(manager, {
    workspaces: {
      activate: async (task: { id: string }) => {
        activated.push(task.id);
        return { changedBranch: false };
      },
    },
  });
  const first = assert.rejects(
    manager.start(state.tasks[0], project),
    /Fixture preparation failure/,
  );
  await entered.promise;
  const cancelled = assert.rejects(
    manager.start(state.tasks[1], project),
    /Worker preparation was cancelled/,
  );
  await waiting.promise;
  await assert.rejects(
    manager.start(state.tasks[2], project),
    /All worker slots are occupied/,
  );
  await manager.stop("cancelled");
  await cancelled;
  assert.equal(state.tasks[1].run.state, "stopped");
  assert.deepEqual(activated, ["first"]);
  const next = assert.rejects(
    manager.start(state.tasks[2], project),
    /Fixture preparation failure/,
  );
  held.resolve();
  await Promise.all([first, next]);
  assert.deepEqual(activated, ["first", "next"]);
  assert.deepEqual(qualified, ["first", "next"]);
  await manager.close();
});
