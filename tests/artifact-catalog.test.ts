import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { initialState } from "../src/seed";
import type { Artifact } from "../src/shared";
import {
  collectedArtifactFiles,
  reconcileArtifacts,
} from "../runtime/artifact-catalog";
import { within } from "../runtime/local";
import { watchArtifacts } from "../runtime/artifact-watch";

async function fixture(
  run: (f: {
    root: string;
    dataDir: string;
    output: string;
    state: ReturnType<typeof initialState>;
    make: (name: string, taskId?: string) => Artifact;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "memcode-artifact-catalog-"));
  try {
    const state = initialState(),
      task = state.tasks[0],
      project = state.projects.find((x) => x.id === task.projectId)!;
    project.path = join(root, "project");
    task.run.workspace = project.path;
    const dataDir = join(root, "data"),
      output = join(project.path, ".memcode", "workers", task.id, "artifacts");
    await mkdir(output, { recursive: true });
    await mkdir(dataDir);
    state.artifacts = [];
    const make = (name: string, taskId = task.id): Artifact => ({
      id: name,
      name,
      path: join(output, name),
      taskId,
      projectId: project.id,
      kind: "text",
      source: "claude",
      createdAt: "2026-11-15T00:00:00Z",
      revision: "1",
    });
    await run({ root, state, dataDir, output, make });
  } finally {
    assert.ok(
      within(tmpdir(), root) &&
        basename(root).startsWith("memcode-artifact-catalog-"),
    );
    await rm(root, { recursive: true, force: true });
  }
}

test("reconciles confirmed missing output entries across stories and preserves files, IDs and review references", () =>
  fixture(async ({ state, dataDir, output, make }) => {
    const kept = make("REPORT.md"),
      gone = make("probe.mts"),
      secondTask = { ...state.tasks[0], id: "second-task" };
    state.tasks.push(secondTask);
    const second = make("second.log", secondTask.id);
    second.path = join(
      secondTask.run.workspace!,
      ".memcode",
      "workers",
      secondTask.id,
      "artifacts",
      second.name,
    );
    state.artifacts = [kept, gone, second];
    await writeFile(kept.path, "# Report");
    state.reviewComments = [
      {
        id: "preserved-review",
        taskId: gone.taskId,
        reference: {
          kind: "artifact",
          taskId: gone.taskId,
          name: gone.name,
          path: gone.path,
          artifactId: gone.id,
          quote: "prior saved selection",
          revision: "saved-version",
        },
        text: "Check this earlier finding",
        status: "saved",
        createdAt: "2026-11-15T00:00:00Z",
        updatedAt: "2026-11-15T00:00:00Z",
      },
    ];
    const retained = structuredClone(state.reviewComments);
    const removed = await reconcileArtifacts(state, dataDir, {
      settle: async () => {},
    });
    assert.deepEqual(
      removed.map((x) => x.id),
      [gone.id, second.id],
    );
    assert.deepEqual(state.artifacts, [kept]);
    assert.equal(state.artifacts[0], kept);
    await access(join(output, "REPORT.md"));
    assert.deepEqual(state.reviewComments, retained);
  }));

test("permission failures, inaccessible workspaces and out-of-scope records are retained", () =>
  fixture(async ({ state, dataDir, root, make }) => {
    const denied = make("denied.log"),
      outside = make("outside.log"),
      inaccessible = make("offline.log");
    outside.path = join(root, "unrelated", outside.name);
    state.artifacts = [denied, outside];
    const probe = async (path: string) => {
      if (path === denied.path)
        throw Object.assign(Error("denied"), { code: "EACCES" });
      return stat(path);
    };
    assert.deepEqual(
      await reconcileArtifacts(state, dataDir, {
        probe,
        settle: async () => {},
      }),
      [],
    );
    assert.deepEqual(state.artifacts, [denied, outside]);
    const task = state.tasks[0];
    task.run.workspace = join(root, "offline-drive");
    state.projects.find((x) => x.id === task.projectId)!.path =
      task.run.workspace;
    inaccessible.path = join(
      task.run.workspace,
      ".memcode",
      "workers",
      task.id,
      "artifacts",
      inaccessible.name,
    );
    state.artifacts = [inaccessible];
    assert.deepEqual(await reconcileArtifacts(state, dataDir), []);
  }));

test("temporary disappearance and revisions changed during confirmation are preserved", () =>
  fixture(async ({ state, dataDir, make }) => {
    const transient = make("rewritten.log"),
      newer = make("changed.log");
    state.artifacts = [transient, newer];
    const removed = await reconcileArtifacts(state, dataDir, {
      settle: async () => {
        await writeFile(transient.path, "returned");
        newer.revision = "new-revision";
      },
    });
    assert.deepEqual(removed, []);
    assert.equal(state.artifacts.length, 2);
  }));

test("a nested evidence write is discovered live and deletion can be reconciled without restarting the worker", () =>
  fixture(async ({ state, dataDir, output, make }) => {
    const folder = join(output, "evidence");
    await mkdir(folder);
    const path = join(folder, "watch-check.mts"),
      entry = { ...make("watch-check.mts"), path };
    const errors: Error[] = [];
    let collections = 0;
    const close = watchArtifacts(
      output,
      async () => {
        const files = await collectedArtifactFiles(output);
        if (
          files.some((x) => x.path === path) &&
          !state.artifacts.some((x) => x.id === entry.id)
        )
          state.artifacts.push(entry);
        await reconcileArtifacts(state, dataDir);
        collections++;
      },
      (error) => errors.push(error),
    );
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "artifact watcher settles");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await until(() => collections > 0);
      await writeFile(path, "// live evidence");
      await until(() => state.artifacts.length === 1);
      await rm(path);
      await until(() => state.artifacts.length === 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  }));

test("scoped collection finds nested evidence beyond the former fifty-file cap without altering files", () =>
  fixture(async ({ state, dataDir, output, make }) => {
    await mkdir(join(output, "evidence"));
    for (let i = 0; i < 55; i++)
      await writeFile(join(output, `output-${i}.md`), `# Output ${i}`);
    await writeFile(join(output, "evidence", "check.mts"), "// support");
    await mkdir(join(output, "web-app", "node_modules"), { recursive: true });
    await writeFile(join(output, "web-app", "index.js"), "// implementation");
    await writeFile(
      join(output, "web-app", "node_modules", "dependency.js"),
      "// dependency",
    );
    const result = await collectedArtifactFiles(output);
    assert.equal(result.length, 56);
    assert.ok(
      result.some((x) => x.path === join(output, "evidence", "check.mts")),
    );
    assert.equal(new Set(result.map((x) => x.path)).size, 56);
    const first = make("old.log"),
      other = make("other.log", "unrelated-task");
    state.artifacts = [first, other];
    await reconcileArtifacts(state, dataDir, {
      taskIds: new Set([first.taskId]),
      settle: async () => {},
    });
    assert.deepEqual(state.artifacts, [other]);
  }));
