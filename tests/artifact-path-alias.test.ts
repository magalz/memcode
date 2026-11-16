import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { canonicalArtifactRoots, resolveFile } from "../runtime/files";
import { readArtifactThumbnail } from "../runtime/artifact-thumbnail";
import { PreviewManager } from "../runtime/preview";
import { createRuntime } from "../runtime/app";
import { within } from "../runtime/local";
import type { Artifact } from "../src/shared";
import type { NativeHost } from "../runtime/host";

async function fixture(
  run: (input: {
    base: string;
    alias: string;
    physical: string;
    data: string;
    state: ReturnType<typeof initialState>;
    artifact: (name: string) => Artifact;
  }) => Promise<void>,
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "memcode-path-alias-")),
  );
  const physical = join(base, "physical"),
    alias = join(base, "selected-alias");
  await mkdir(physical);
  await symlink(
    physical,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const data = join(alias, "data"),
    state = initialState(),
    task = state.tasks[0];
  task.run.workspace = join(alias, "project");
  state.projects[0].path = task.run.workspace;
  state.artifacts = [];
  await mkdir(data);
  await mkdir(task.run.workspace);
  const artifact = (name: string): Artifact => ({
    id: name,
    taskId: task.id,
    projectId: task.projectId,
    name,
    path: join(data, "captures", task.id, name),
    kind: name.endsWith(".html") ? "html" : "text",
    source: "Synthetic alias regression",
    createdAt: new Date().toISOString(),
  });
  try {
    await run({ base, alias, physical, data, state, artifact });
  } finally {
    assert(
      within(await realpath(tmpdir()), base) &&
        basename(base).startsWith("memcode-path-alias-"),
    );
    await rm(base, { recursive: true, force: true });
  }
}

test("an approved folder alias retains saved HTML identity and readable gallery content", () =>
  fixture(async ({ data, state, artifact }) => {
    const task = state.tasks[0],
      saved = artifact("page.html");
    await mkdir(join(data, "captures", task.id), { recursive: true });
    await writeFile(saved.path, "<h1>Readable saved page</h1>");
    state.artifacts.push(saved);
    const canonical = await realpath(saved.path);
    const file = await resolveFile(state, data, task.id, canonical);
    assert.equal(file.artifactId, saved.id);
    assert.equal(file.format, "html");
    assert.equal(file.path, canonical);
    const thumbnail = await readArtifactThumbnail(saved, [
      join(data, "captures", task.id),
    ]);
    assert.equal(thumbnail.kind, "document");
    assert.match(JSON.stringify(thumbnail), /Readable saved page/);
    const source = join(task.run.workspace!, "source.html");
    await writeFile(source, "<h1>Source, not an interactive artifact</h1>");
    assert.equal(
      (await resolveFile(state, data, task.id, source)).format,
      "text",
    );
  }));

test("a redirected output subtree cannot grant access to another project folder", () =>
  fixture(async ({ data, state, artifact }) => {
    const task = state.tasks[0],
      unapproved = join(task.run.workspace!, "private-source");
    await mkdir(unapproved);
    await mkdir(join(data, "captures"));
    await symlink(
      unapproved,
      join(data, "captures", task.id),
      process.platform === "win32" ? "junction" : "dir",
    );
    const saved = artifact("hidden.html");
    await writeFile(saved.path, "<h1>Not a saved output</h1>");
    state.artifacts.push(saved);
    const roots = await canonicalArtifactRoots(data, task);
    assert.deepEqual(roots, []);
    await assert.rejects(
      readArtifactThumbnail(saved, roots),
      /outside the output folders/,
    );
    const source = await resolveFile(state, data, task.id, saved.path);
    assert.equal(source.artifactId, undefined);
    assert.equal(source.format, "text");
    const previews = new PreviewManager(
      { call: async () => undefined } as NativeHost,
      () => state,
      data,
      async () => {},
      () => {},
    );
    try {
      await assert.rejects(
        previews.show({
          taskId: task.id,
          artifactId: saved.id,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        }),
        /outside this worker/,
      );
    } finally {
      await previews.close();
    }
  }));

test("artifact previews serve a canonical viewer and document through raw selected-folder aliases", () =>
  fixture(async ({ alias, data, state, artifact }) => {
    const task = state.tasks[0],
      saved = artifact("report.md"),
      app = join(alias, "app");
    await mkdir(join(data, "captures", task.id), { recursive: true });
    await mkdir(join(app, "dist-artifact-viewer"), { recursive: true });
    await writeFile(
      join(app, "dist-artifact-viewer", "index.html"),
      "<title>Synthetic viewer</title>",
    );
    await writeFile(
      join(app, "dist-artifact-viewer", "viewer.js"),
      "// approved viewer script",
    );
    await writeFile(saved.path, "# Readable report\n");
    state.artifacts.push(saved);
    let url = "";
    const previews = new PreviewManager(
      {
        call: async (_method: string, input: any) => {
          url = input.url ?? url;
        },
      } as NativeHost,
      () => state,
      data,
      async () => {},
      () => {},
      app,
    );
    try {
      await previews.show({
        taskId: task.id,
        artifactId: saved.id,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      });
      assert.match(await (await fetch(url)).text(), /Synthetic viewer/);
      assert.equal(
        await (await fetch(new URL("viewer.js", url))).text(),
        "// approved viewer script",
      );
      assert.equal(
        await (await fetch(new URL("__document", url))).text(),
        "# Readable report\n",
      );
      assert.equal(
        (await fetch(new URL("__asset/../../private.txt", url))).status,
        400,
      );
    } finally {
      await previews.close();
    }
  }));

test("inline image reads use canonical approved roots and still reject outside files", () =>
  fixture(async ({ data, artifact }) => {
    const runtime = await createRuntime(
      data,
      resolve("."),
      {
        call: async () => {
          throw Error("Inline image must not create a native view");
        },
      },
      () => {},
    );

    try {
      const task = runtime.store.state.tasks[0],
        saved = { ...artifact("image.png"), kind: "image" as const };
      await mkdir(join(data, "captures", task.id), { recursive: true });
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(saved.path, bytes);
      runtime.store.state.artifacts.push(saved);
      assert.equal(
        await runtime.request("artifact:read", saved.id),
        "data:image/png;base64," + bytes.toString("base64"),
      );
      const outside = join(data, "outside.png");
      await writeFile(outside, bytes);
      saved.path = outside;
      await assert.rejects(
        runtime.request("artifact:read", saved.id),
        /outside the output folders/,
      );
    } finally {
      await runtime.close();
    }
  }));

test("a link below an approved output root cannot expose files outside all approved anchors", () =>
  fixture(async ({ base, data, state, artifact }) => {
    const task = state.tasks[0],
      output = join(data, "captures", task.id),
      outside = join(base, "unapproved");
    await mkdir(output, { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(outside, "secret.html"),
      "<h1>Unapproved fixture</h1>",
    );
    await symlink(
      outside,
      join(output, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const saved = {
      ...artifact("secret.html"),
      path: join(output, "linked", "secret.html"),
    };
    state.artifacts.push(saved);
    const roots = await canonicalArtifactRoots(data, task);
    assert(roots.includes(await realpath(output)));
    await assert.rejects(
      readArtifactThumbnail(saved, roots),
      /outside the output folders/,
    );
    await assert.rejects(
      resolveFile(state, data, task.id, saved.path),
      /outside the project/,
    );
  }));
