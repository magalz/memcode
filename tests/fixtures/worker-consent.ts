import type { AppState, Harness } from "../../src/shared";

/** Explicit test-only consent for a fixture executable, never a real provider. */
export function approveFixtureWorker(
  state: AppState,
  harness: Harness,
  runtimePath = process.execPath,
) {
  state.workerConnections ??= {};
  state.workerConnections[harness] = {
    harness,
    runtimePath,
    approvedAt: new Date().toISOString(),
    auth: "local",
    accountLabel: "Local test fixture",
    scopeVersion: 1,
  };
}
