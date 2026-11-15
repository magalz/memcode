import { useSyncExternalStore } from "react";
import { runtimeHealth } from "./runtime-health";

export function useRuntimeHealth() {
  return useSyncExternalStore(runtimeHealth.subscribe, runtimeHealth.snapshot);
}
