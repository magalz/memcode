import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { WorkerManager } from "../runtime/workers";
import type { MemtraceEngine } from "../runtime/memtrace";
import type { Harness, Project, WorkItem } from "../src/shared";

for (const harness of ["claude", "codex", "cursor"] as Harness[]) {
  test(`${harness}: a shared project cannot switch a checkout used by its personal alias`, async () => {
    const state = initialState();
    const project: Project = {
      id: "shared",
      name: "Team project",
      path: process.cwd(),
      branch: "main",
      description: "",
      analysis: "ready",
      repoId: "fixture",
      createdAt: "2026-11-15",
    };
    const local: Project = {
      ...project,
      id: "personal",
      name: "Personal project",
    };
    const task: WorkItem = {
      ...state.tasks[0],
      id: "new-worker",
      projectId: project.id,
      harness,
      assignment: "auto",
      example: false,
      run: { state: "idle" },
      dependsOn: [],
    };
    state.projects = [project, local];
    state.tasks = [
      task,
      {
        ...task,
        id: "existing-worker",
        projectId: local.id,
        run: { state: "running" },
      },
    ];
    state.fleetConflicts = [];
    let preparations = 0;
    const manager = new WorkerManager(
      () => state,
      async () => {
        preparations++;
      },
      {} as MemtraceEngine,
      process.cwd(),
    );
    try {
      await assert.rejects(
        manager.start(task, project),
        /already in use.*Personal project/,
      );
      assert.equal(task.run.state, "idle");
      assert.equal(
        preparations,
        0,
        "No Fleet, claim or branch preparation should start",
      );
    } finally {
      state.tasks[1].run.state = "finished";
      await manager.close();
    }
  });
}
