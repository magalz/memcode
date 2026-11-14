import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import {
  bulkEditPatch,
  groupMove,
  groupWork,
  type GroupSources,
} from "../src/planning/groups.ts";
import { defaultWorkflow } from "../src/planning/workflow.ts";
import type { GroupBy } from "../src/planning/types.ts";
import type { Cycle, WorkItem } from "../src/shared.ts";

function sources(): GroupSources {
  const state = initialState(),
    projectId = state.projects[0].id;
  const workflow = defaultWorkflow(projectId);
  workflow.splice(1, 0, {
    ...workflow[0],
    id: "ready",
    name: "Ready",
    order: 1,
  });
  const cycle: Cycle = {
    id: "iteration",
    projectId,
    name: "Iteration",
    goal: "Measured planning",
    startDate: "2026-11-01",
    endDate: "2026-11-14",
    timeZone: "UTC",
    state: "active",
    capacity: null,
    calendar: "weekdays",
    createdAt: "2026-11-01T00:00:00Z",
    snapshots: [],
  };
  const epic = {
    id: "epic",
    projectId,
    identifier: "E-1",
    title: "Platform",
    description: "",
    phase: "now" as const,
    color: "mint" as const,
    order: 0,
  };
  const tasks: WorkItem[] = state.tasks.slice(0, 4).map((task, index) => ({
    ...task,
    id: `story-${index}`,
    stage: index === 2 ? "working" : "planned",
    statusId: index === 0 ? "ready" : workflow[0].id,
    epicId: index === 0 ? epic.id : index === 1 ? "removed-epic" : null,
    cycleId: index === 0 ? cycle.id : index === 1 ? "removed-cycle" : null,
    assignment: index === 0 ? "auto" : index === 1 ? "manual" : undefined,
    harness: index === 0 ? "codex" : index === 1 ? "claude" : "cursor",
  }));
  return { tasks, workflow, epics: [epic], cycles: [cycle] };
}

test("every grouping partitions the visible work exactly once without mutating or reordering it", () => {
  const input = sources(),
    before = structuredClone(input);
  for (const grouping of [
    "status",
    "epic",
    "priority",
    "harness",
    "cycle",
    "none",
  ] as GroupBy[]) {
    const groups = groupWork(grouping, input),
      assigned = groups.flatMap((group) => group.tasks);
    assert.equal(assigned.length, input.tasks.length, grouping);
    assert.equal(
      new Set(assigned.map((task) => task.id)).size,
      input.tasks.length,
      grouping,
    );
    assert.deepEqual(new Set(assigned), new Set(input.tasks), grouping);
    for (const group of groups) {
      const members = new Set(group.tasks);
      assert.deepEqual(
        group.tasks,
        input.tasks.filter((task) => members.has(task)),
        `${grouping} keeps sorted input order`,
      );
    }
  }
  assert.deepEqual(input, before);
  assert.deepEqual(
    groupWork("epic", input)
      .find((group) => group.id === "none")!
      .tasks.map((task) => task.id),
    ["story-1", "story-2", "story-3"],
  );
  assert.deepEqual(
    groupWork("cycle", input)
      .find((group) => group.id === "none")!
      .tasks.map((task) => task.id),
    ["story-1", "story-2", "story-3"],
  );
  assert.equal(
    groupWork("status", input).find(
      (group) =>
        group.id ===
        input.workflow.find((status) => status.stage === "working")!.id,
    )!.tasks[0].id,
    "story-2",
  );
});

test("moving a story updates the matching planning field and regroups it into exactly one destination", () => {
  const input = sources();
  const destinations: [GroupBy, string][] = [
    ["status", "ready"],
    ["epic", "epic"],
    ["priority", "low"],
    ["harness", "claude"],
    ["cycle", "iteration"],
  ];
  for (const [grouping, destination] of destinations) {
    const task = { ...input.tasks[3], modelOverride: "old-model" },
      result = groupMove(grouping, destination, input);
    assert.equal(result.kind, "update");
    if (result.kind !== "update") continue;
    Object.assign(task, result.patch);
    const groups = groupWork(grouping, { ...input, tasks: [task] });
    assert.equal(
      groups.find((group) => group.id === destination)!.tasks[0],
      task,
      grouping,
    );
    assert.equal(groups.flatMap((group) => group.tasks).length, 1, grouping);
  }
  const status = groupMove("status", "ready", input);
  assert.deepEqual(status, {
    kind: "update",
    patch: { statusId: "ready", stage: "planned" },
  });
  assert.deepEqual(groupMove("status", "removed-lane", input), {
    kind: "ignore",
  });
  assert.deepEqual(groupMove("none", "all", input), { kind: "ignore" });
});

test("harness reassignment clears stale model overrides and automatic work remains in its own lane", () => {
  const input = sources(),
    automatic = groupMove("harness", "auto", input),
    manual = groupMove("harness", "cursor", input);
  assert.deepEqual(automatic, {
    kind: "update",
    patch: { assignment: "auto", modelOverride: null },
  });
  assert.deepEqual(manual, {
    kind: "update",
    patch: { harness: "cursor", assignment: "manual", modelOverride: null },
  });
  const groups = groupWork("harness", input);
  assert.equal(
    groups.find((group) => group.id === "auto")!.tasks[0],
    input.tasks[0],
  );
  assert.equal(groups.find((group) => group.id === "codex")!.tasks.length, 0);
  assert.deepEqual(
    groups.find((group) => group.id === "cursor")!.tasks,
    input.tasks.slice(2),
  );
});

test("closed cycles reject additions while backlog moves and explicit archive/restore preserve their meanings", () => {
  const input = sources();
  input.cycles[0].state = "completed";
  assert.equal(groupMove("cycle", "iteration", input).kind, "blocked");
  assert.deepEqual(groupMove("cycle", "none", input), {
    kind: "update",
    patch: { cycleId: null },
  });
  assert.deepEqual(groupMove("epic", "none", input), {
    kind: "update",
    patch: { epicId: null },
  });
  const at = "2026-11-14T00:00:00Z";
  assert.deepEqual(bulkEditPatch("archive", false, input.workflow, at), {
    archivedAt: at,
  });
  assert.deepEqual(bulkEditPatch("archive", true, input.workflow, at), {
    archivedAt: null,
  });
  assert.equal(
    bulkEditPatch("status|removed-lane", false, input.workflow, at),
    undefined,
  );
  assert.equal(bulkEditPatch("none", false, input.workflow, at), undefined);
});
