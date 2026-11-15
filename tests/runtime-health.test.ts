import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeHealthStore } from "../src/runtime-health";

test("terminal IPC errors invalidate liveness, ordinary tool errors do not", () => {
  const health = new RuntimeHealthStore();
  assert.equal(health.observeError("Tool execution needs approval."), false);
  assert.equal(health.observeError("EPERM: workspace save failed"), false);
  assert.equal(health.observeError("The runtime response timed out."), false);
  assert.equal(health.snapshot().available, true);
  assert.equal(
    health.observeError(
      "The local runtime stopped. Reopen MemCode to reconnect; saved work has been preserved.",
    ),
    true,
  );
  assert.equal(health.snapshot().available, false);
  assert.match(health.snapshot().message!, /runtime stopped/);
});

test("save failure and recovery do not erase terminal runtime failure", () => {
  const health = new RuntimeHealthStore();
  health.saveStatus({ state: "error", message: "Changes are not saved." });
  assert.equal(health.snapshot().available, true);
  assert.equal(health.snapshot().saveError, "Changes are not saved.");
  health.stopped("Connection lost.");
  health.saveStatus({ state: "saved" });
  assert.equal(health.snapshot().saveError, undefined);
  assert.equal(health.snapshot().available, false);
  assert.equal(health.snapshot().message, "Connection lost.");
});

test("health subscribers receive changed states and can unsubscribe", () => {
  const health = new RuntimeHealthStore();
  let count = 0;
  const unsubscribe = health.subscribe(() => count++);
  health.stopped("Connection lost.");
  health.stopped("Connection lost.");
  assert.equal(count, 1);
  unsubscribe();
  health.saveStatus({ state: "error" });
  assert.equal(count, 1);
});
