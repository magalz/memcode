import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app.ts";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import { planDefinedStory } from "../runtime/story-route.ts";
import { initialState } from "../src/seed.ts";
import type { Evidence, HarnessRuntime, WorkItem } from "../src/shared.ts";

const measured: Evidence = {
  state: "measured",
  symbols: [
    {
      name: "render",
      file: "src/components/View.tsx",
      line: 1,
      cognitive: 4,
      cyclomatic: 3,
      nesting: 2,
      metricSource: "ast",
    },
  ],
  affected: 2,
  affectedProcesses: 1,
  incomplete: false,
  note: "Test fixture, not a production measurement",
  measuredAt: "2026-11-14T00:00:00.000Z",
};
const catalog: HarnessRuntime[] = ["codex", "claude", "cursor"].map((id) => ({
  id: id as HarnessRuntime["id"],
  name: id,
  available: true,
  path: "fixture",
  models: (["fast", "balanced", "frontier", "extreme"] as const).map(
    (tier) => ({ id: `${id}-${tier}`, label: tier, tier, source: "alias" }),
  ),
}));

test("a defined story names an installed harness and model without starting work", () => {
  const state = initialState();
  const task = {
    ...state.tasks[0],
    assignment: "auto" as const,
    run: { state: "idle" as const },
  };
  const route = planDefinedStory(task, measured, catalog, state.settings);
  assert.equal(route.mode, "automatic");
  assert.equal(route.status, "measured");
  assert.equal(route.harness, "cursor");
  assert.equal(route.model, "cursor-fast");
  assert.equal(task.run.state, "idle");
});

test("an uninstalled harness is not named for a defined story", () => {
  const state = initialState();
  const task = { ...state.tasks[0], assignment: "auto" as const };
  assert.throws(
    () =>
      planDefinedStory(
        task,
        measured,
        catalog.map((runtime) => ({ ...runtime, available: false })),
        state.settings,
      ),
    /No eligible installed harness/,
  );
});

test("a manual harness stays selected while its model comes from the measurement", () => {
  const state = initialState();
  const task = {
    ...state.tasks[0],
    assignment: "manual" as const,
    harness: "claude" as const,
  };
  const route = planDefinedStory(task, measured, catalog, state.settings);
  assert.equal(route.harness, "claude");
  assert.equal(route.model, "claude-fast");
  assert.equal(route.mode, "manual");
});

test("defining a story records the assignee and leaves the worker idle", async () => {
  const qualify = mock.method(
    MemtraceEngine.prototype,
    "qualify",
    async () => measured,
  );
  const dir = await mkdtemp(join(tmpdir(), "memcode-story-route-"));
  const runtime = await createRuntime(
    dir,
    dir,
    { call: async () => { throw new Error("No native calls expected"); } },
    () => {},
    { discoverHarnesses: async () => catalog },
  );
  try {
    const project = runtime.store.state.projects[0];
    project.example = false;
    project.analysis = "ready";
    project.repoId = "fixture";
    project.path = dir;
    const created = (await runtime.request("task:create", {
      projectId: project.id,
      title: "Name the harness",
      description: "Define who picks this up without starting work.",
      priority: "medium",
      harness: "codex",
      assignment: "auto",
    })) as WorkItem;
    const deadline = Date.now() + 2000;
    let stored = runtime.store.state.tasks.find((item) => item.id === created.id);
    while (!stored?.route && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stored = runtime.store.state.tasks.find((item) => item.id === created.id);
    }
    assert.ok(stored?.route, "the defined story should name a harness and model");
    assert.equal(stored.route.mode, "automatic");
    assert.equal(stored.route.harness, "cursor");
    assert.equal(stored.route.model, "cursor-fast");
    assert.equal(stored.harness, "cursor");
    assert.equal(stored.run.state, "idle");
    assert.equal(stored.stage, "planned");
    assert.equal(qualify.mock.callCount(), 1);
  } finally {
    qualify.mock.restore();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("example stories stay unmeasured and idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-story-route-example-"));
  const runtime = await createRuntime(
    dir,
    dir,
    { call: async () => { throw new Error("No native calls expected"); } },
    () => {},
  );
  try {
    const projectId = runtime.store.state.projects[0].id;
    const created = (await runtime.request("task:create", {
      projectId,
      title: "Example only",
      description: "Preview data",
      priority: "medium",
      harness: "codex",
      assignment: "auto",
    })) as WorkItem;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created.example, true);
    assert.equal(created.route, undefined);
    assert.equal(created.run.state, "idle");
    await assert.rejects(
      runtime.request("task:qualify", created.id),
      /Example context is not measured/,
    );
    assert.equal(created.run.state, "idle");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
