import test from "node:test";
import assert from "node:assert/strict";
import type { Harness, Project, WorkItem } from "../src/shared";
import { initialState } from "../src/seed";
import { WorkerManager, type TeamWorkerClaims } from "../runtime/workers";
import type { MemtraceEngine } from "../runtime/memtrace";

function fixture(harness: Harness, claims: TeamWorkerClaims) {
  const state = initialState(), task: WorkItem = { ...state.tasks[0], id: "claim-story", projectId: "claim-project", example: false, harness, assignment: "auto", stage: "planned", run: { state: "idle" }, messages: [{ id: "followup", role: "user", text: "Do the next pass", at: "2026-11-15T12:00:00Z" }] };
  const project: Project = { id: task.projectId, name: "Claim fixture", description: "", path: process.cwd(), branch: "main", analysis: "idle", createdAt: "2026-11-15" };
  state.projects = [project]; state.tasks = [task]; state.epics = []; state.fleetConflicts = []; state.settings.maxWorkers = 3;
  let engineCalls = 0;
  const engine = { call: async () => { engineCalls++; return {}; } } as unknown as MemtraceEngine;
  const manager = new WorkerManager(() => state, async () => {}, engine, process.cwd(), undefined, undefined, undefined, undefined, undefined, claims);
  return { state, task, project, manager, engineCalls: () => engineCalls };
}
for (const harness of ["claude", "codex", "cursor"] as const) {
  test(`${harness}: direct and automatically queued worker passes must claim before local preparation`, async () => {
    let acquired = 0, released = 0;
    const f = fixture(harness, { acquire: async () => { acquired++; throw Error("Teammate already claimed this story"); }, release: async () => { released++; } });
    await assert.rejects(f.manager.start(f.task, f.project), /already claimed/);
    assert.equal(f.task.run.state, "failed"); assert.equal(f.engineCalls(), 0); assert.equal(released, 0);
    f.manager.enqueue(f.task, "followup"); f.manager.dispatchQueued();
    const deadline = Date.now() + 2000;
    while (acquired < 2 || f.task.messages[0].followupState !== "paused") {
      if (Date.now() > deadline) throw Error("Queued pass did not use the claim guard");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(f.engineCalls(), 0); assert.equal(released, 0);
    await f.manager.close();
  });
}
test("an acquired team claim is released when local worker preparation fails", async () => {
  let acquired = 0, released = 0;
  const f = fixture("codex", { acquire: async () => { acquired++; }, release: async () => { released++; } });
  await assert.rejects(f.manager.start(f.task, f.project), /Connect Memtrace/);
  assert.equal(acquired, 1); assert.equal(released, 1); assert.equal(f.engineCalls(), 0);
  await f.manager.close();
});
