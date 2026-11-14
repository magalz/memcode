import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import { installDogfoodPlan } from "../src/dogfood.ts";
import { validateDependencies } from "../src/domain.ts";

test("the banked build plan is complete, idempotent and preserves edited stories", () => {
  const state = initialState(),
    project = { ...state.projects[0], id: "dogfood", example: false };
  state.projects.push(project);
  assert.deepEqual(installDogfoodPlan(state, project), {
    epics: 9,
    stories: 38,
  });
  const stories = state.tasks.filter((t) => t.projectId === project.id);
  assert.equal(new Set(stories.map((task) => task.identifier)).size, 38);
  for (const task of stories) {
    validateDependencies(state.tasks, task, task.dependsOn ?? []);
    assert.ok(state.epics.some((epic) => epic.id === task.epicId));
    assert.equal(task.run.state, "idle");
  }
  const edited = stories.find((t) => t.sourceKey === "route-regressions")!;
  edited.title = "User edited brief";
  edited.dependsOn = [];
  edited.stage = "review";
  assert.deepEqual(installDogfoodPlan(state, project), {
    epics: 0,
    stories: 0,
  });
  assert.equal(edited.title, "User edited brief");
  assert.equal(edited.stage, "review");
  assert.deepEqual(edited.dependsOn, []);
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
