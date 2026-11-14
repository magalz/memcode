import type { AppState, HarnessRuntime, WorkItem } from "./shared";

function pathKey(path: string) {
  return /\\|^[a-z]:/i.test(path)
    ? path.replaceAll("\\", "/").toLowerCase()
    : path;
}
export function approvedRuntime(
  runtime: HarnessRuntime | undefined,
  connections: AppState["workerConnections"],
) {
  if (!runtime?.available || !runtime.path) return false;
  const receipt = connections?.[runtime.id];
  return (
    !!receipt &&
    receipt.scopeVersion === 1 &&
    receipt.harness === runtime.id &&
    !!receipt.approvedAt &&
    ["authenticated", "local"].includes(receipt.auth) &&
    pathKey(receipt.runtimePath) === pathKey(runtime.path)
  );
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
