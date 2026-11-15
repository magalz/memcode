import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { WorkerManager } from "../runtime/workers";
import type { Harness, Project, WorkItem } from "../src/shared";
import type { MemtraceEngine } from "../runtime/memtrace";

for (const harness of ["claude", "codex", "cursor"] as Harness[]) {
  test(`${harness}: direct and automatically queued starts cannot cross the account-session barrier`, async () => {
    const state = initialState();
    const task: WorkItem = { ...state.tasks[0], id: "account-guard-story", projectId: "account-guard-project", example: false, harness, assignment: "auto", stage: "planned", run: { state: "idle" }, messages: [{ id: "followup", role: "user", text: "Start the next pass", at: "2026-11-15" }] };
    const project: Project = { id: task.projectId, name: "Account guard fixture", path: process.cwd(), branch: "main", description: "No model runs", analysis: "ready", repoId: "fixture", createdAt: "2026-11-15" };
    state.projects = [project]; state.tasks = [task]; state.epics = []; state.fleetConflicts = [];
    let checked = 0, engineCalls = 0, teamCalls = 0;
    const manager = new WorkerManager(() => state, async () => {}, { call: async () => { engineCalls++; return {}; } } as unknown as MemtraceEngine, process.cwd(), undefined, undefined, undefined, undefined, undefined,
      { acquire: async () => { teamCalls++; }, release: async () => { teamCalls++; } },
      () => { checked++; assert.equal(task.run.state, "idle", "Account validation precedes the Preparing mutation"); throw Error("Restart MemCode after changing the Memtrace session"); });
    try {
      const direct = manager.start(task, project);
      assert.equal(checked, 1, "Guard runs synchronously before the first awaited preparation step");
      assert.equal(task.run.state, "idle");
      await assert.rejects(direct, /Restart MemCode/);
      manager.enqueue(task, "followup"); manager.dispatchQueued();
      const deadline = Date.now() + 3000;
      while (checked < 2 || task.messages[0].followupState !== "paused") {
        if (Date.now() > deadline) throw Error("Queued worker bypassed the account guard");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(task.run.state, "idle"); assert.equal(engineCalls, 0); assert.equal(teamCalls, 0);
      assert.ok(task.messages.some((message) => /Queued follow-up paused: Restart MemCode/.test(message.text)));
    } finally { await manager.close(); }
  });
}
