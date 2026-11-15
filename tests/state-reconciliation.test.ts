import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSnapshot } from "../src/state-reconciliation";

const workspace = () => ({
  tasks: [
    { id: "one", messages: [{ id: "m1", text: "kept" }], run: { state: "running" } },
    { id: "two", messages: [], run: { state: "idle" } },
  ],
  comments: [{ id: "c1", text: "review this" }],
  queue: ["follow-up"],
});

test("an identical JSON receipt reuses the existing workspace", () => {
  const prior = workspace();
  assert.equal(reconcileSnapshot(prior, JSON.parse(JSON.stringify(prior))), prior);
});

test("a streamed edit preserves unrelated cards and unchanged transcript rows", () => {
  const prior = workspace();
  const incoming = structuredClone(prior);
  incoming.tasks[0].messages.push({ id: "m2", text: "new answer" });
  const result = reconcileSnapshot(prior, incoming);
  assert.notEqual(result, prior);
  assert.equal(result.tasks[1], prior.tasks[1]);
  assert.equal(result.tasks[0].messages[0], prior.tasks[0].messages[0]);
  assert.equal(result.comments, prior.comments);
  assert.equal(result.queue, prior.queue);
  assert.deepEqual(result, incoming);
  assert.equal(prior.tasks[0].messages.length, 1);
  assert.notEqual(incoming.tasks[1], prior.tasks[1]);
});

test("edits, removals, reordering and nullable values reach the renderer", () => {
  const prior = { records: [{ id: "one", text: "old" }, { id: "two", text: "kept" }], value: "date", obsolete: true };
  const incoming = { records: [{ id: "two", text: "kept" }, { id: "one", text: "edited" }], value: null };
  const result = reconcileSnapshot<object>(prior, incoming);
  assert.deepEqual(result, incoming);
  assert.equal(Object.hasOwn(result, "obsolete"), false);
  assert.deepEqual(prior.records[0], { id: "one", text: "old" });
  assert.deepEqual(reconcileSnapshot([1, 2], [2]), [2]);
});

test("snapshot reconciliation handles JSON property names as data", () => {
  const previous = JSON.parse('{"__proto__":{"flag":"before"}}');
  const incoming = JSON.parse('{"__proto__":{"flag":"after"}}');
  const result = reconcileSnapshot(previous, incoming);
  assert.deepEqual(result, incoming);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
});
