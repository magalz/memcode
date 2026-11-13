import type { AppState, Stage, WorkItem } from "./shared";

export function tasksForProject(
  state: AppState,
  projectId: string,
): WorkItem[] {
  return state.tasks.filter((task) => task.projectId === projectId);
}

export function canMoveTask(task: WorkItem, stage: Stage): boolean {
  return (
    !["preparing", "running", "stopping"].includes(task.run.state) ||
    stage === task.stage
  );
}

export function progress(task: WorkItem): number {
  if (!task.checklist.length) return task.stage === "done" ? 100 : 0;
  return Math.round(
    (task.checklist.filter((item) => item.done).length /
      task.checklist.length) *
      100,
  );
}

export function isActive(task: WorkItem): boolean {
  return (
    task.run.state === "running" ||
    task.run.state === "preparing" ||
    task.run.state === "stopping"
  );
}

export function stageLabel(stage: Stage): string {
  return {
    planned: "Planned",
    working: "In progress",
    review: "In review",
    done: "Done",
  }[stage];
}

export function restartSafeState(state: AppState): AppState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      ["connecting", "indexing"].includes(project.analysis)
        ? {
            ...project,
            analysis: "idle",
            analysisNote: "Analysis was interrupted. Reconnect to continue.",
          }
        : project,
    ),
    tasks: state.tasks.map((task) =>
      !task.example && isActive(task)
        ? {
            ...task,
            stage: "review",
            run: {
              ...task.run,
              state: "stopped",
              error:
                "MemCode restarted. The preserved worktree may contain an unfinished change.",
            },
          }
        : task,
    ),
  };
}
