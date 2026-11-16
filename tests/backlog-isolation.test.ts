import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../runtime/app";
import { LocalStore, within } from "../runtime/local";
import { initialState } from "../src/seed";

async function fixture(saved: boolean) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "memcode-backlog-isolation-")),
  );
  const appPath = join(root, "checkout");
  const profile = join(root, "profile");
  await mkdir(join(appPath, ".git"), { recursive: true });
  const baseline = initialState();
  if (saved) {
    const project = {
      ...baseline.projects[0],
      id: "memcode-dogfood",
      name: "User-owned project",
      example: false,
      path: appPath,
    };
    baseline.projects = [project];
    baseline.activeProjectId = project.id;
    baseline.tasks = [
      {
        ...baseline.tasks[0],
        id: "saved-story",
        identifier: "W-001",
        projectId: project.id,
        title: "An edited user story",
        description: "The user's saved brief",
        sourceKey: "legacy-source-marker",
        messages: [
          {
            id: "saved-message",
            role: "user",
            text: "A personal follow-up",
            at: "2026-01-01T00:00:00Z",
          },
        ],
        run: { state: "idle" },
      },
    ];
    const store = new LocalStore(profile);
    await mkdir(profile);
    store.state = baseline;
    await store.save();
  }
  const runtime = await createRuntime(
    profile,
    appPath,
    {
      call: async (method) => {
        if (method === "beta_store_read")
          return { configured: false, credentials: null } as any;
        if (method === "preview_hide") return null as any;
        throw Error("Unexpected native action: " + method);
      },
    },
    () => {},
    { discoverHarnesses: async () => [] },
  );
  return {
    runtime,
    baseline,
    async close() {
      await runtime.close();
      assert.ok(
        within(await realpath(tmpdir()), root) &&
          basename(root).startsWith("memcode-backlog-isolation-"),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("launching from a Git checkout never imports developer projects, epics or stories", async () => {
  const app = await fixture(false);
  try {
    assert.deepEqual(app.runtime.store.state.projects, app.baseline.projects);
    assert.deepEqual(app.runtime.store.state.tasks, app.baseline.tasks);
    assert.deepEqual(app.runtime.store.state.epics, app.baseline.epics);
    await assert.rejects(
      app.runtime.request("roadmap:install", "example"),
      /Unknown MemCode method/,
    );
  } finally {
    await app.close();
  }
});

test("existing local stories remain intact even when their project has the legacy developer ID", async () => {
  const app = await fixture(true);
  try {
    assert.deepEqual(app.runtime.store.state.projects, app.baseline.projects);
    assert.deepEqual(app.runtime.store.state.tasks, app.baseline.tasks);
    assert.equal(
      app.runtime.store.state.tasks[0].messages[0].text,
      "A personal follow-up",
    );
    assert.equal(app.runtime.store.state.projects.length, 1);
    assert.equal(app.runtime.store.state.tasks.length, 1);
    assert.equal(app.runtime.store.state.epics.length, 0);
  } finally {
    await app.close();
  }
});
