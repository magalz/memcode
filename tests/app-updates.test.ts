import test from "node:test";
import assert from "node:assert/strict";
import { AppUpdater, updatePercent, type AppUpdateAPI } from "../src/updates";
import {
  AppUpdateGate,
  registerAppUpdates,
  appReleaseHistory,
} from "../runtime/app-updates";
import { initialState } from "../src/seed";
import { WorkerManager } from "../runtime/workers";
import type { Harness, Project, WorkItem } from "../src/shared";
import type { MemtraceEngine } from "../runtime/memtrace";

const release = {
  version: "0.4.0-beta.2",
  notes: "## Improvements\n\n- A real release",
  publishedAt: "2026-11-16T00:00:00Z",
};
const api = (patch: Partial<AppUpdateAPI> = {}): AppUpdateAPI => ({
  context: async () => ({ activeWorkers: 0, activeTerminals: 0 }),
  history: async () => [],
  info: async () => ({ currentVersion: "0.4.0-beta.1", development: false }),
  check: async () => release,
  install: async () => {},
  ...patch,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("network failures never report up to date or retain a stale install announcement", async () => {
  let fail = false;
  const updater = new AppUpdater(
    api({
      check: async () => {
        if (fail) throw Error("The update service is unreachable");
        return release;
      },
    }),
  );
  await updater.check();
  assert.equal(updater.getSnapshot().phase, "available");
  fail = true;
  await updater.check();
  assert.equal(updater.getSnapshot().phase, "error");
  assert.equal(updater.getSnapshot().release, undefined);
  assert.match(updater.getSnapshot().error!, /unreachable/);
});

test("published release history uses only the official endpoint and never passes source or download capabilities into Settings", async () => {
  const result = await appReleaseHistory((async (url, options) => {
    assert.equal(url, "https://www.memtrace.io/api/memcode/releases");
    assert.equal(
      options?.headers &&
        (options.headers as Record<string, string>).authorization,
      undefined,
    );
    return Response.json({
      product: "MemCode",
      channel: "beta",
      source: { privateToken: "neverdisplay" },
      releases: [
        {
          ...release,
          title: "First beta",
          publishedAt: "2026-11-16T00:00:00Z",
          assets: [{ secret: "discard" }],
          extra: "discard",
        },
      ],
    });
  }) as typeof fetch);
  assert.deepEqual(Object.keys(result[0]).sort(), [
    "notes",
    "publishedAt",
    "title",
    "version",
  ]);
  await assert.rejects(
    appReleaseHistory(
      (async () =>
        new Response("Unavailable", { status: 503 })) as typeof fetch,
    ),
    /unavailable/,
  );
  await assert.rejects(
    appReleaseHistory((async () =>
      Response.json({
        product: "MemCode",
        channel: "beta",
        releases: [{ version: "unpublished" }],
      })) as typeof fetch),
  );
});

test("no update is a successful check; development builds never query or install releases", async () => {
  const current = new AppUpdater(api({ check: async () => null }));
  await current.check();
  assert.equal(current.getSnapshot().phase, "current");
  assert.ok(current.getSnapshot().checkedAt);
  let checks = 0,
    installs = 0;
  const development = new AppUpdater(
    api({
      info: async () => ({ currentVersion: "0.4.0-beta.1", development: true }),
      check: async () => {
        checks++;
        return release;
      },
      install: async () => {
        installs++;
      },
    }),
  );
  await development.check();
  await development.install();
  assert.equal(checks, 0);
  assert.equal(installs, 0);
  assert.equal(development.getSnapshot().phase, "idle");
});

test("rapid clicks cannot start concurrent checks or installations, and progress never claims a running new version", async () => {
  let resolveCheck!: (value: typeof release) => void,
    finishInstall!: () => void,
    checks = 0,
    installs = 0;
  const updater = new AppUpdater(
    api({
      check: () => {
        checks++;
        return new Promise((resolve) => (resolveCheck = resolve));
      },
      install: async (version, progress) => {
        installs++;
        assert.equal(version, release.version);
        progress({ phase: "downloading", downloaded: 50, total: 100 });
        await new Promise<void>((resolve) => (finishInstall = resolve));
        progress({ phase: "installing", downloaded: 100, total: 100 });
      },
    }),
  );
  const first = updater.check();
  await tick();
  await updater.check();
  assert.equal(checks, 1);
  resolveCheck(release);
  await first;
  const install = updater.install();
  await tick();
  await updater.install();
  assert.equal(installs, 1);
  assert.equal(updatePercent(updater.getSnapshot().progress), 50);
  finishInstall();
  await install;
  assert.equal(updater.getSnapshot().phase, "installing");
  assert.equal(updater.getSnapshot().info?.currentVersion, "0.4.0-beta.1");
  await updater.install();
  await updater.check();
  assert.equal(installs, 1);
  assert.equal(checks, 1);
});

test("signature/install errors remain visible and do not mark the release installed", async () => {
  const updater = new AppUpdater(
    api({
      install: async () => {
        throw Error("Signature verification failed");
      },
    }),
  );
  await updater.check();
  await updater.install();
  assert.equal(updater.getSnapshot().phase, "error");
  assert.match(updater.getSnapshot().error!, /Signature/);
  assert.equal(updater.getSnapshot().info?.currentVersion, "0.4.0-beta.1");
  assert.equal(
    updatePercent({ phase: "downloading", downloaded: 1, total: 0 }),
    undefined,
  );
});

test("final update reservation rechecks workers that started during download and never stops them", () => {
  const state = initialState(),
    task: WorkItem = {
      ...state.tasks[0],
      example: false,
      run: { state: "idle" },
    };
  state.tasks = [task];
  const gate = new AppUpdateGate(() => state);
  gate.preflight();
  task.run = { state: "running" };
  assert.throws(() => gate.reserve(), /running worker/);
  assert.equal(gate.preparing, false);
  assert.equal(task.run.state, "running");
  for (const stateName of ["preparing", "stopping"] as const) {
    task.run = { state: stateName };
    assert.throws(() => gate.reserve(), /running worker/);
  }
});

test("failed final persistence releases the update gate before new work is allowed", async () => {
  const state = initialState();
  state.tasks = [];
  const gate = new AppUpdateGate(() => state),
    handlers = new Map<string, (input?: unknown) => unknown>();
  let resumes = 0;
  registerAppUpdates(
    (name, _schema, handler) => handlers.set(name, handler),
    gate,
    async () => {
      assert.equal(gate.preparing, true);
      throw Error("Disk is full");
    },
    () => {
      resumes++;
    },
  );
  await assert.rejects(
    Promise.resolve(handlers.get("app:update-prepare")!()),
    /Disk is full/,
  );
  assert.equal(gate.preparing, false);
  assert.equal(resumes, 1);
  assert.doesNotThrow(() => gate.assertMayStart());
});

for (const harness of ["claude", "codex", "cursor"] as Harness[]) {
  test(`${harness}: an update reservation blocks direct starts and preserves queued follow-ups until release`, async () => {
    const state = initialState(),
      task: WorkItem = {
        ...state.tasks[0],
        id: "update-story",
        projectId: "update-project",
        example: false,
        harness,
        assignment: "auto",
        stage: "planned",
        run: { state: "idle" },
        messages: [
          {
            id: "followup",
            role: "user",
            text: "Continue this task",
            at: "2026-11-16",
          },
        ],
      };
    const project: Project = {
      id: task.projectId,
      name: "Update fixture",
      path: process.cwd(),
      branch: "main",
      description: "No model runs",
      analysis: "ready",
      repoId: "fixture",
      createdAt: "2026-11-16",
    };
    state.tasks = [task];
    state.projects = [project];
    state.epics = [];
    state.fleetConflicts = [];
    const gate = new AppUpdateGate(() => state);
    let reachedStart = 0,
      engineCalls = 0;
    const manager = new WorkerManager(
      () => state,
      async () => {},
      {
        call: async () => {
          engineCalls++;
          return {};
        },
      } as unknown as MemtraceEngine,
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        gate.assertMayStart();
        reachedStart++;
        throw Error("Fixture reached the start boundary");
      },
      () => !gate.preparing,
    );
    try {
      gate.reserve();
      await assert.rejects(
        manager.start(task, project),
        /preparing an app update/,
      );
      manager.enqueue(task, "followup");
      manager.dispatchQueued();
      await tick();
      const followupState = () => task.messages[0].followupState;
      assert.equal(followupState(), "queued");
      assert.equal(reachedStart, 0);
      assert.equal(engineCalls, 0);
      gate.release();
      manager.dispatchQueued();
      for (
        let attempt = 0;
        attempt < 100 && followupState() !== "paused";
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(reachedStart, 1);
      assert.equal(followupState(), "paused");
      assert.equal(engineCalls, 0);
    } finally {
      await manager.close();
    }
  });
}
