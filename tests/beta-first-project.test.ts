import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../runtime/app";
import { within } from "../runtime/local";

test("a first project without an engine is saved for planning with a visible connection action, without launching a worker or browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-beta-first-project-")),
    folder = join(root, "source"),
    profile = join(root, "profile");
  await mkdir(folder);
  await writeFile(join(folder, "README.md"), "# Existing source\n");
  const calls: string[] = [];
  const runtime = await createRuntime(
    profile,
    root,
    {
      call: async (method) => {
        calls.push(method);
        if (method === "beta_store_read")
          return { configured: false, credentials: null } as any;
        if (method === "select_folder") return folder as any;
        if (method === "preview_hide") return null as any;
        throw Error("Unexpected native action: " + method);
      },
    },
    () => {},
  );
  try {
    runtime.store.state.settings.memtracePath = join(
      root,
      "not-installed",
      "memtrace.exe",
    );
    await runtime.request("project:select-folder");
    const item: any = await runtime.request("project:create", {
      mode: "existing",
      parent: folder,
      name: "First local project",
      description: "Start with a clear outcome",
    });
    await runtime.request("project:analyze", item.id);
    assert.equal(item.analysis, "idle");
    assert.equal(item.repoId, undefined);
    assert.match(item.analysisNote, /Connect Memtrace beta/);
    assert.equal(runtime.store.state.activeProjectId, item.id);
    assert.equal(
      runtime.store.state.tasks.filter((task) => task.projectId === item.id)
        .length,
      0,
    );
    assert.equal(
      await readFile(join(folder, "README.md"), "utf8"),
      "# Existing source\n",
    );
    assert.equal(
      calls.some((method) =>
        /open_|terminal|process|beta_store_write/.test(method),
      ),
      false,
    );
    const saved = JSON.parse(
      await readFile(join(profile, "workspace.json"), "utf8"),
    );
    assert.equal(
      saved.projects.find((project: any) => project.id === item.id).name,
      item.name,
    );
  } finally {
    await runtime.close();
    assert.ok(
      within(tmpdir(), root) &&
        basename(root).startsWith("memcode-beta-first-project-"),
    );
    await rm(root, { recursive: true, force: true });
  }
});
