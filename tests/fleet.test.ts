import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed.ts";
import { git, within, exists } from "../runtime/local.ts";
import { WorkerManager } from "../runtime/workers.ts";
import { FleetBlocked, FleetCoordinator } from "../runtime/fleet.ts";
import type { MemtraceEngine } from "../runtime/memtrace.ts";
import type { HarnessRuntime, WorkItem } from "../src/shared.ts";
import { approveFixtureWorker } from "./fixtures/worker-consent";

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
      const renewing = this.intents.has(args.agent_id);
      if (args.touched.length) this.intents.set(args.agent_id, args.touched);
      else this.intents.delete(args.agent_id);
      return {
        active_conflicts: renewing ? [{ agent_id: args.agent_id }] : [],
      };
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
  // Connecting a previously unconfigured project can create these stores
  // before its first epic is activated. They must not block that switch.
  for (const directory of [".memdb", ".memtrace"]) {
    await mkdir(join(repo, directory));
    await writeFile(join(repo, directory, "runtime.lock"), "Local engine data");
  }
  const state = initialState();
  approveFixtureWorker(state, "codex");
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
    `import {writeFile,readFile} from 'node:fs/promises';import {join} from 'node:path';for await(const chunk of process.stdin){}const session=JSON.parse(await readFile(join('.memcode','workers',process.env.MEMCODE_TASK_ID,'context-session.json'),'utf8'));async function coordinate(input){const r=await fetch(session.endpoint,{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify({capability:'coordinate',...input})});if(!r.ok)throw Error(await r.text());return r.json()}let result=await coordinate({action:'inspect',plan:'Preserve the shared fixture contract and add the assigned worker output.'});for(let i=0;result.canEdit!==true&&i<10;i++)result=await coordinate({action:'adopt',waitMs:2000});if(result.canEdit!==true)throw Error('No edit reservation');await writeFile(process.env.MEMCODE_TASK_ID+'.txt','Shared branch change');await writeFile(join(process.env.MEMCODE_ARTIFACT_DIR,'report.html'),'<h1>'+process.env.MEMCODE_TASK_ID+'</h1>');await new Promise(r=>setTimeout(r,${sharedScope ? 3000 : 1400}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture done. No model called.'}}));`,
  );
  const engine = new TestFleet();
  const catalog: HarnessRuntime[] = [
    {
      id: "codex",
      name: "Fixture Codex",
      available: true,
      path: process.execPath,
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
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
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
    f.tasks[0].description =
      "A detailed source task. ".repeat(180) +
      "PRESERVE_FINAL_ACCEPTANCE_CRITERION";
    await f.manager.start(f.tasks[0], f.project);
    assert.match(
      await readFile(
        join(f.repo, ".memcode", "workers", f.tasks[0].id, "brief.md"),
        "utf8",
      ),
      /PRESERVE_FINAL_ACCEPTANCE_CRITERION/,
    );
    assert.ok(
      f.engine.calls
        .filter((call) => call.name === "find_code")
        .every((call) => call.args.query.length <= 1000),
    );
    await f.manager.fleet.heartbeat(f.project, f.tasks[0]);
    assert.equal(
      f.state.fleetConflicts.length,
      0,
      "Renewing one's own intent is not a peer conflict",
    );
    await f.manager.start(f.tasks[1], f.project);
    assert.equal(f.tasks[0].run.workspace, f.repo);
    await until(() => f.state.artifacts.length === 2);
    assert.ok(
      f.tasks.some((task) => task.run.state === "running"),
      "Published artifacts appear before the worker exits",
    );
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
test("overlapping workers adhere to the first owner, wait and reread instead of asking a human", async () => {
  const f = await fixture(true);
  try {
    await f.manager.start(f.tasks[0], f.project);
    const ready = Date.now() + 3000;
    while (!(await exists(join(f.repo, "one.txt"))) && Date.now() < ready)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await exists(join(f.repo, "one.txt")), true);
    await f.manager.start(f.tasks[1], f.project);
    assert.equal(f.state.fleetConflicts.length, 0);
    assert.equal(
      await readFile(join(f.repo, "one.txt"), "utf8"),
      "Shared branch change",
    );
    await until(() => f.tasks.every((task) => task.run.state === "finished"));
    assert.equal(await exists(join(f.repo, "two.txt")), true);
    assert.equal(f.state.fleetConflicts.length, 0);
    assert.equal(
      f.state.fleetPlans?.find((plan) => plan.taskId === "two")?.adoptedFrom,
      "one",
    );
    const audit = (
      await readFile(
        join(f.repo, ".memcode", "workers", "two", "fleet-activity.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(audit.some((event) => event.directive === "adhere"));
    assert.ok(audit.some((event) => event.directive === "proceed"));
  } finally {
    await f.cleanup();
  }
});
