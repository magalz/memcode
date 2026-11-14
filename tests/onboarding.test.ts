import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { firstRunGuide } from "../src/onboarding";
import { registerOnboarding } from "../runtime/onboarding";
function harness() {
  const state = initialState(),
    routes = new Map<
      string,
      { schema: any; handle: (input: any) => unknown }
    >();
  let saves = 0;
  registerOnboarding(
    (name, schema, handle) => routes.set(name, { schema, handle }),
    () => state,
    async () => {
      saves++;
    },
  );
  return {
    state,
    saves: () => saves,
    call: async (input: unknown) => {
      const route = routes.get("onboarding:update")!;
      return route.handle(route.schema.parse(input));
    },
  };
}
test("first-run guidance appears for a new workspace, without taking over an existing project", () => {
  assert.equal(
    firstRunGuide({
      projects: [{ id: "example", example: true }, { id: "memcode-dogfood" }],
    }),
    true,
  );
  assert.equal(firstRunGuide({ projects: [{ id: "my-project" }] }), false);
  assert.equal(
    firstRunGuide({
      projects: [],
      onboarding: { version: 1, step: "worker", dismissed: true },
    }),
    false,
  );
});
test("guide progress validates project ownership and can pause, complete and explicitly restart", async () => {
  const h = harness(),
    project = { ...h.state.projects[0], id: "guide-project", example: false },
    other = { ...project, id: "other" };
  h.state.projects.push(project, other);
  h.state.epics.push({
    id: "guide-epic",
    projectId: project.id,
    identifier: "EP-01",
    title: "First outcome",
    description: "",
    phase: "now",
    color: "mint",
    order: 0,
  });
  const story = {
    ...h.state.tasks[0],
    id: "guide-story",
    projectId: project.id,
    epicId: "guide-epic",
    example: false,
  };
  h.state.tasks.push(story);
  await h.call({ step: "worker", projectId: project.id });
  await assert.rejects(h.call({ epicId: "missing" }), /epic in this project/);
  assert.equal(h.saves(), 1);
  await h.call({ step: "story", epicId: "guide-epic" });
  await h.call({ dismissed: true });
  assert.equal(h.state.onboarding?.step, "story");
  await h.call({ dismissed: false, storyId: story.id, step: "ready" });
  await assert.rejects(h.call({ projectId: other.id }), /epic in this project/);
  await h.call({ complete: true });
  assert.ok(h.state.onboarding?.completedAt);
  assert.equal(h.state.onboarding?.dismissed, true);
  const reset = (await h.call({
    restart: true,
    step: "welcome",
    dismissed: false,
  })) as any;
  assert.equal(reset.completedAt, undefined);
  assert.equal(reset.projectId, undefined);
  assert.equal(reset.storyId, undefined);
  assert.equal(reset.dismissed, false);
});
