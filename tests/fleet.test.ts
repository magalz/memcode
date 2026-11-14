import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed.ts";
import { git, within, exists } from "../electron/local.ts";
import { WorkerManager } from "../electron/workers.ts";
import { FleetBlocked } from "../electron/fleet.ts";
import type { MemtraceEngine } from "../electron/memtrace.ts";
import type { HarnessRuntime, WorkItem } from "../src/shared.ts";

class TestFleet {
  intents = new Map<string, string[]>();
  leases = new Map<string, { agent: string; scope: string[] }>();
  calls: Array<{ name: string; args: any }> = [];
  async analyze() {
    return "fixture";
  }
  async qualify(_project: unknown, task: WorkItem) {
    return {
      state: "partial",
      symbols: [],
      incomplete: true,
      note: "Fixture scope",
      measuredAt: new Date().toISOString(),
    };
  }
  async call(_project: unknown, name: string, args: any) {
    this.calls.push({ name, args });
    const overlap = (scope: string[], other: string[]) =>
      scope.some((key) => other.includes(key));
    if (name === "fleet_branch_context") return { pending_escalations: [] };
    if (name === "fleet_preflight")
      return {
        active_conflicts: [...this.intents]
          .filter(
            ([agent, scope]) =>
              agent !== args.agent_id && overlap(scope, args.touched),
          )
          .map(([agent_id]) => ({ agent_id })),
      };
    if (name === "fleet_acquire_lease") {
      const blocked = [...this.leases.values()].some(
        (lease) =>
          lease.agent !== args.agent_id && overlap(lease.scope, args.scope),
      );
      if (blocked) return { state: "requested" };
      const lease_id = "lease-" + args.agent_id;
      this.leases.set(lease_id, { agent: args.agent_id, scope: args.scope });
      return { state: "granted", lease_id };
    }
    if (name === "fleet_release_lease") {
      this.leases.delete(args.lease_id);
      return { state: "released" };
    }
    if (name === "fleet_renew_lease") {
      assert.ok(this.leases.has(args.lease_id));
      return { state: "granted" };
    }
    if (name === "fleet_publish_intent") {
      if (args.touched.length) this.intents.set(args.agent_id, args.touched);
      else this.intents.delete(args.agent_id);
      return { active_conflicts: [] };
    }
    if (name === "fleet_record_episode") return { conflict_class: "A" };
    if (name === "fleet_list_escalations") return { pending: [] };
    return {};
  }
}
async function fixture(sharedScope = false) {
  const root = await mkdtemp(join(tmpdir(), "memcode-fleet-test-")),
    repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await writeFile(join(repo, "README.md"), "Fleet fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@local.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  const state = initialState();
  state.tasks = [];
  state.epics = [];
  state.fleetConflicts = [];
  const project = {
    ...state.projects[0],
    id: "fixture",
    path: repo,
    repoId: "fixture",
    analysis: "ready" as const,
    example: false,
  };
  state.projects = [project];
  state.settings.maxWorkers = 4;
  const epic = {
    id: "fixture-epic",
    projectId: project.id,
    identifier: "EP-01",
    title: "Shared feature",
    description: "Fixture",
    phase: "now" as const,
    color: "mint" as const,
    order: 0,
  };
  state.epics = [epic];
  const tasks: WorkItem[] = ["one", "two"].map((id) => ({
    ...initialState().tasks[0],
    id,
    identifier: `MC-${id}`,
    projectId: project.id,
    epicId: epic.id,
    example: false,
    assignment: "auto" as const,
    scope: [sharedScope ? "shared.ts" : `${id}.ts`],
    stage: "planned" as const,
    run: { state: "idle" as const },
    messages: [],
    dependsOn: [],
  }));
  state.tasks = tasks;
  const script = join(root, "fixture.mjs");
  await writeFile(
    script,
    `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';for await(const chunk of process.stdin){}await writeFile(process.env.MEMCODE_TASK_ID+'.txt','Shared branch change');await writeFile(join(process.env.MEMCODE_ARTIFACT_DIR,'report.html'),'<h1>'+process.env.MEMCODE_TASK_ID+'</h1>');await new Promise(r=>setTimeout(r,1400));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture done. No model called.'}}));`,
  );
  const engine = new TestFleet();
  const catalog: HarnessRuntime[] = [
    {
      id: "codex",
      name: "Fixture Codex",
      available: true,
      path: script,
      models: [
        { id: "fixture", label: "Fixture", tier: "extreme", source: "alias" },
      ],
    },
  ];
  const manager = new WorkerManager(
    () => state,
    async () => {},
    engine as unknown as MemtraceEngine,
    join(root, "data"),
    async () => ({ command: process.execPath, prefix: [script] }),
    async () => catalog,
  );
  const cleanup = async () => {
    await manager.close();
    assert.ok(
      within(tmpdir(), root) &&
        basename(root).startsWith("memcode-fleet-test-"),
    );
    await rm(root, { recursive: true, force: true });
  };
  return { state, project, epic, tasks, manager, engine, repo, cleanup };
}
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(check(), "Expected worker outcome before deadline");
}

test("two story processes collaborate on one epic branch and one checkout", async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.tasks[0], f.project);
    await f.manager.start(f.tasks[1], f.project);
    assert.equal(f.tasks[0].run.workspace, f.repo);
    assert.equal(f.tasks[1].run.workspace, f.repo);
    assert.equal(f.tasks[0].run.branch, f.tasks[1].run.branch);
    assert.equal(
      (await git(f.repo, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
    await until(() =>
      f.tasks.every((task) =>
        task.messages.some((message) =>
          message.text.startsWith("Worker finished."),
        ),
      ),
    );
    for (const task of f.tasks) {
      assert.equal(task.stage, "review");
      assert.equal(task.run.state, "finished");
      assert.equal(task.run.worktree, undefined);
      assert.equal(
        await readFile(join(f.repo, task.id + ".txt"), "utf8"),
        "Shared branch change",
      );
    }
    assert.equal(f.state.artifacts.length, 2);
    assert.notEqual(f.state.artifacts[0].path, f.state.artifacts[1].path);
    const branches = f.engine.calls.filter((call) =>
      [
        "fleet_branch_context",
        "fleet_preflight",
        "fleet_publish_intent",
        "fleet_record_episode",
      ].includes(call.name),
    );
    assert.ok(
      branches.every((call) => call.args.branch === f.tasks[0].run.branch),
    );
    assert.equal(f.engine.leases.size, 0);
    assert.equal(f.engine.intents.size, 0);
    assert.equal(
      await git(f.repo, ["show", "main:README.md"]),
      "Fleet fixture",
    );
  } finally {
    await f.cleanup();
  }
});
test("an overlapping story pauses the epic and requires an explicit human decision", async () => {
  const f = await fixture(true);
  try {
    await f.manager.start(f.tasks[0], f.project);
    const ready = Date.now() + 3000;
    while (!(await exists(join(f.repo, "one.txt"))) && Date.now() < ready)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await exists(join(f.repo, "one.txt")), true);
    await assert.rejects(f.manager.start(f.tasks[1], f.project), FleetBlocked);
    await until(() => f.tasks[0].run.state === "blocked");
    assert.equal(f.state.fleetConflicts.length, 1);
    const conflict = f.state.fleetConflicts[0];
    assert.equal(conflict.status, "open");
    assert.ok(
      conflict.taskIds.includes("one") && conflict.taskIds.includes("two"),
    );
    assert.equal(await exists(join(f.repo, "two.txt")), false);
    assert.equal(
      await readFile(join(f.repo, "one.txt"), "utf8"),
      "Shared branch change",
    );
    await f.manager.fleet.resolve(
      conflict.id,
      "Preserve the first story; re-scope the second before continuing.",
      "one",
    );
    assert.equal(conflict.status, "resolved");
    assert.equal(conflict.winnerTaskId, "one");
    assert.throws(
      () => f.manager.fleet.assertClear(f.tasks[1], f.project),
      /deferred/,
    );
    assert.doesNotThrow(() =>
      f.manager.fleet.assertClear(f.tasks[0], f.project),
    );
    assert.ok(
      f.tasks.every(
        (task) => !["preparing", "running"].includes(task.run.state),
      ),
      "A human decision never automatically restarts workers",
    );
  } finally {
    await f.cleanup();
  }
});
