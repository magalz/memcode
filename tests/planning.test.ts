import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import { registerPlanning } from "../runtime/planning.ts";
import { validateDependencies } from "../src/domain.ts";

test("planning creates only the user's requested epic and preserves their edits", async () => {
  const state = initialState();
  const project = state.projects[0];
  const handlers = new Map<string, (input: any) => unknown>();
  let saves = 0;
  registerPlanning(
    (name, _schema, handler) => handlers.set(name, handler),
    () => state,
    (id) => {
      assert.equal(id, project.id);
      return project;
    },
    async () => {
      saves++;
    },
  );
  const tasksBefore = structuredClone(state.tasks);
  const created = (await handlers.get("epic:create")!({
    projectId: project.id,
    title: "Customer-authored initiative",
    description: "The user's own scope",
    phase: "now",
  })) as (typeof state.epics)[number];
  assert.equal(state.epics.length, 1);
  assert.equal(created.title, "Customer-authored initiative");
  await handlers.get("epic:update")!({
    id: created.id,
    patch: { title: "Updated by its owner", phase: "next" },
  });
  assert.equal(created.title, "Updated by its owner");
  assert.equal(created.phase, "next");
  assert.deepEqual(state.tasks, tasksBefore);
  assert.equal(saves, 2);
});

test("story prerequisites reject cycles and references to another project", () => {
  const [a, b] = initialState().tasks;
  a.dependsOn = [b.id];
  assert.throws(() => validateDependencies([a, b], b, [a.id]), /cycle/);
  b.projectId = "another";
  assert.throws(() => validateDependencies([a, b], a, [b.id]), /same project/);
  assert.throws(
    () => validateDependencies([a, b], a, ["missing"]),
    /same project/,
  );
});
