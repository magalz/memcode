import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { contextAssistantDefaults } from "../src/context-settings";
import { git, exists, within } from "../runtime/local";
import { WorkerManager } from "../runtime/workers";
import type { MemtraceEngine } from "../runtime/memtrace";
import type { WorkItem } from "../src/shared";

async function preparingFixture(holdRenewal = false) {
  const root = await mkdtemp(join(tmpdir(), "memcode-preparation-test-"));
  const repo = join(root, "repo"),
    packageDirectory = join(root, "fake-transformers");
  await mkdir(repo);
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(
    join(packageDirectory, "dist", "transformers.node.mjs"),
    `import {writeFile} from 'node:fs/promises';export const env={};export async function pipeline(){await writeFile(new URL('../pid.txt',import.meta.url),String(process.pid));setInterval(()=>{},1000);return new Promise(()=>{});}`,
  );
  await writeFile(join(repo, "README.md"), "Preparation fixture\n");
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const state = initialState();
  const project = {
    ...state.projects[0],
    id: "preparation",
    path: repo,
    repoId: "fixture",
    branch: "main",
    analysis: "ready" as const,
    example: false,
  };
  const task: WorkItem = {
    ...state.tasks[0],
    id: "preparing",
    projectId: project.id,
    epicId: "preparation-epic",
    assignment: "auto",
    example: false,
    stage: "planned",
    run: { state: "idle" },
    messages: [],
    dependsOn: [],
    scope: ["README.md"],
  };
  state.projects = [project];
  state.tasks = [task];
  state.fleetConflicts = [];
  state.epics = [
    {
      id: "preparation-epic",
      projectId: project.id,
      identifier: "EP-01",
      title: "Preparation",
      description: "Fixture",
      phase: "now",
      color: "mint",
      order: 0,
    },
  ];
  state.settings.contextAssistant = {
    ...contextAssistantDefaults,
    enabled: true,
    packageDirectory,
  };
  const calls: string[] = [];
  let reserved = false;
  let finishRenewal!: () => void;
  const renewal = new Promise<void>((resolve) => {
    finishRenewal = resolve;
  });
  const engine = {
    analyze: async () => "fixture",
    qualify: async () => ({
      state: "partial",
      symbols: [],
      incomplete: true,
      note: "Fixture",
      measuredAt: new Date().toISOString(),
    }),
    async call(_project: unknown, name: string, args: any) {
      calls.push(name);
      if (name === "fleet_publish_intent" && args.touched?.length)
        calls.push("active_intent");
      if (name === "fleet_acquire_lease") {
        reserved = true;
        return { state: "granted", lease_id: "fixture-lease" };
      }
      if (name === "fleet_release_lease") {
        reserved = false;
        return {};
      }
      if (name === "fleet_renew_lease") {
        assert.equal(reserved, true);
        if (holdRenewal) await renewal;
        return {};
      }
      if (name === "get_query_revision")
        return { ready: true, token: "graph-1" };
      return {};
    },
  } as unknown as MemtraceEngine;
  const script = join(root, "worker.mjs");
  await writeFile(
    script,
    "import {writeFile} from 'node:fs/promises';await writeFile('launched.txt','unexpected worker');",
  );
  const manager = new WorkerManager(
    () => state,
    async () => {},
    engine,
    join(root, "data"),
    async () => ({ command: process.execPath, prefix: [script] }),
    async () => [
      {
        id: "claude",
        name: "Fixture Claude",
        available: true,
        path: script,
        models: [
          { id: "fixture", label: "Fixture", tier: "extreme", source: "alias" },
        ],
      },
    ],
  );
  const running = manager.start(task, project).then(
    () => undefined,
    (error) => error as Error,
  );
  const pidPath = join(packageDirectory, "pid.txt"),
    until = Date.now() + 8000;
  while (
    !(await exists(pidPath)) &&
    task.run.state === "preparing" &&
    Date.now() < until
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!(await exists(pidPath))) {
    await manager.close();
    assert.fail(
      `Optional helper did not start: ${task.run.error ?? task.run.state}`,
    );
  }
  const pid = Number(await readFile(pidPath, "utf8"));
  const session = JSON.parse(
    await readFile(
      join(repo, ".memcode", "workers", task.id, "context-session.json"),
      "utf8",
    ),
  );
  return {
    manager,
    task,
    calls,
    running,
    pid,
    session,
    repo,
    finishRenewal,
    reserved: () => reserved,
    async cleanup() {
      finishRenewal();
      await manager.close();
      assert.ok(
        within(tmpdir(), root) &&
          basename(root).startsWith("memcode-preparation-test-"),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Fleet renews during slow context preparation; stop releases the reservation and closes the helper/session", async () => {
  const f = await preparingFixture(true);
  try {
    const until = Date.now() + 8000;
    while (!f.calls.includes("fleet_renew_lease") && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(f.calls.includes("fleet_renew_lease"));
    assert.equal(f.task.run.state, "preparing");
    const stopping = f.manager.stop(f.task.id);
    // Close the optional process promptly, then finish the existing renewal before releasing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    f.finishRenewal();
    await stopping;
    assert.match((await f.running)!.message, /cancelled/);
    assert.equal(f.task.run.state, "stopped");
    assert.equal(f.reserved(), false);
    assert.ok(
      f.calls.lastIndexOf("fleet_release_lease") >
        f.calls.lastIndexOf("active_intent"),
    );
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    await assert.rejects(fetch(f.session.endpoint));
    assert.equal(await exists(join(f.repo, "launched.txt")), false);
  } finally {
    await f.cleanup();
  }
});

test("closing the manager cancels preparing context work and waits for optional helper exit", async () => {
  const f = await preparingFixture();
  try {
    await f.manager.close();
    assert.match((await f.running)!.message, /cancelled/);
    assert.equal(f.reserved(), false);
    assert.throws(() => process.kill(f.pid, 0), { code: "ESRCH" });
    await assert.rejects(fetch(f.session.endpoint));
    assert.equal(await exists(join(f.repo, "launched.txt")), false);
  } finally {
    await f.cleanup();
  }
});
