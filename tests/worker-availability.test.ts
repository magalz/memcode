import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { approvedRuntime, workerReadiness } from "../src/worker-availability";
import type { HarnessRuntime, WorkItem } from "../src/shared";
const runtimes: HarnessRuntime[] = [
  {
    id: "codex",
    name: "Codex",
    available: true,
    path: "/runtime/codex",
    models: [],
  },
  {
    id: "claude",
    name: "Claude Code",
    available: true,
    path: "/runtime/claude",
    models: [],
  },
];
function setup() {
  const state = initialState(),
    task = {
      ...state.tasks[0],
      example: false,
      harness: "codex",
      assignment: "manual",
    } as WorkItem;
  return { state, task };
}
test("installed and unknown runtimes never imply approval", () => {
  const { state, task } = setup();
  assert.equal(
    workerReadiness(task, runtimes, state.workerConnections).canStart,
    false,
  );
  state.workerConnections = {
    codex: {
      harness: "codex",
      approvedAt: new Date().toISOString(),
      runtimePath: "/runtime/codex",
      auth: "authenticated",
      scopeVersion: 1,
    },
  };
  assert.equal(
    workerReadiness(task, runtimes, state.workerConnections).canStart,
    true,
  );
  assert.equal(
    approvedRuntime({ ...runtimes[0], path: null }, state.workerConnections),
    false,
  );
  assert.equal(
    approvedRuntime(
      { ...runtimes[0], available: false },
      state.workerConnections,
    ),
    false,
  );
  assert.equal(
    approvedRuntime(
      { ...runtimes[0], path: "/different/codex" },
      state.workerConnections,
    ),
    false,
  );
});
test("automatic assignment can choose another approved adapter while manual assignment cannot", () => {
  const { state, task } = setup();
  state.workerConnections = {
    claude: {
      harness: "claude",
      approvedAt: new Date().toISOString(),
      runtimePath: "/runtime/claude",
      auth: "authenticated",
      scopeVersion: 1,
    },
  };
  assert.equal(
    workerReadiness(task, runtimes, state.workerConnections).canStart,
    false,
  );
  task.assignment = "auto";
  const automatic = workerReadiness(task, runtimes, state.workerConnections);
  assert.equal(automatic.canStart, true);
  assert.equal(automatic.selectedConnected, false);
  assert.equal(automatic.connectedCount, 1);
  assert.equal(automatic.routeConnected, false);
  assert.equal(
    workerReadiness(
      { ...task, example: true },
      runtimes,
      state.workerConnections,
    ).canStart,
    false,
  );
});
