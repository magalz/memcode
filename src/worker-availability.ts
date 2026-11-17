import type { AppState, HarnessRuntime, WorkItem } from "./shared";
import { workerApprovalMatches } from "./connections";
export function approvedRuntime(
  runtime: HarnessRuntime | undefined,
  connections: AppState["workerConnections"],
) {
  if (!runtime?.available || !runtime.path) return false;
  return workerApprovalMatches(connections?.[runtime.id], runtime);
}
export function workerReadiness(
  task: Pick<WorkItem, "assignment" | "harness" | "route" | "example">,
  runtimes: HarnessRuntime[],
  connections: AppState["workerConnections"],
) {
  const connected = runtimes.filter((runtime) =>
      approvedRuntime(runtime, connections),
    ),
    selected = runtimes.find((runtime) => runtime.id === task.harness),
    selectedConnected = approvedRuntime(selected, connections),
    routeConnected =
      !!task.route &&
      approvedRuntime(
        runtimes.find((runtime) => runtime.id === task.route!.harness),
        connections,
      );
  return {
    canStart:
      !task.example &&
      (task.assignment === "auto" ? connected.length > 0 : selectedConnected),
    selectedConnected,
    routeConnected,
    connectedCount: connected.length,
    selectedInstalled: !!selected?.available,
    runtimeKnown: !!selected?.available && !!selected.path,
  };
}
