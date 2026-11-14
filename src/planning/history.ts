import type { AppState, WorkItem } from "../shared";
import type { CycleSnapshot, TaskObservation } from "./types";

function observation(task: WorkItem): TaskObservation {
  return {
    projectId: task.projectId,
    stage: task.stage,
    cycleId: task.cycleId ?? null,
    estimate: task.estimate ?? null,
    archived: !!task.archivedAt,
  };
}
export function initializePlanning(
  state: AppState,
  at = new Date().toISOString(),
): void {
  state.cycles ??= [];
  state.savedViews ??= [];
  state.workflowStates ??= [];
  state.customFields ??= [];
  state.planning ??= { startedAt: at, events: [], observations: {} };
  observePlanning(state, at, true);
}
export function observePlanning(
  state: AppState,
  at = new Date().toISOString(),
  baseline = false,
): void {
  for (const task of state.tasks) {
    const next = observation(task),
      previous = state.planning.observations[task.id];
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) continue;
    const sequence = (state.planning.events.at(-1)?.sequence ?? 0) + 1;
    state.planning.events.push({
      id: `event-${sequence}`,
      sequence,
      taskId: task.id,
      projectId: task.projectId,
      at,
      kind: previous ? "changed" : baseline ? "baseline" : "created",
      before: previous,
      after: next,
    });
    state.planning.observations[task.id] = next;
  }
  for (const cycle of state.cycles) {
    if (cycle.state === "completed") continue;
    const next = cycleSnapshot(state, cycle.id, at),
      previous = cycle.snapshots.at(-1);
    if (
      previous &&
      [
        "total",
        "completed",
        "planned",
        "working",
        "review",
        "points",
        "completedPoints",
        "unestimated",
      ].every(
        (key) =>
          previous[key as keyof CycleSnapshot] ===
          next[key as keyof CycleSnapshot],
      )
    )
      continue;
    cycle.snapshots.push(next);
  }
}
export function cycleSnapshot(
  state: AppState,
  cycleId: string,
  at = new Date().toISOString(),
): CycleSnapshot {
  const tasks = state.tasks.filter(
    (task) =>
      task.cycleId === cycleId && (!task.archivedAt || task.stage === "done"),
  );
  const sum = (items: WorkItem[]) =>
    items.reduce((sum, task) => sum + (task.estimate ?? 0), 0);
  const done = tasks.filter((task) => task.stage === "done");
  return {
    at,
    sequence: state.planning.events.at(-1)?.sequence ?? 0,
    total: tasks.length,
    completed: done.length,
    planned: tasks.filter((task) => task.stage === "planned").length,
    working: tasks.filter((task) => task.stage === "working").length,
    review: tasks.filter((task) => task.stage === "review").length,
    points: sum(tasks),
    completedPoints: sum(done),
    unestimated: tasks.filter(
      (task) => task.estimate === null || task.estimate === undefined,
    ).length,
  };
}
