import type {
  Evidence,
  HarnessRuntime,
  Settings,
  WorkItem,
} from "../src/shared";
import { planRoute } from "./router";

/**
 * Name the harness and model for a story that is already defined.
 * Installed harnesses are enough. An approved Workers connection is required
 * only when the worker actually starts. This function does not start one.
 */
export function planDefinedStory(
  task: WorkItem,
  evidence: Evidence | undefined,
  runtimes: HarnessRuntime[],
  settings: Settings,
) {
  return planRoute(
    task,
    evidence,
    runtimes.filter((runtime) => runtime.available),
    settings,
  );
}
