import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../runtime/app";

test("saved image artifacts render inline while retaining the owning task's file boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-artifact-inline-"));
  const runtime = await createRuntime(
    dir,
    dir,
    {
      call: async () => {
        throw Error("An inline image must not open a native browser");
      },
    },
    () => {},
  );
  try {
    const task = runtime.store.state.tasks[0];
    const root = join(dir, "captures", task.id);
    await mkdir(root, { recursive: true });
    const path = join(root, "image.png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path, bytes);
    const artifact = {
      id: "inline-image",
      taskId: task.id,
      projectId: task.projectId,
      name: "image.png",
      path,
      kind: "image" as const,
      source: "Fixture",
      createdAt: new Date().toISOString(),
    };
    runtime.store.state.artifacts.push(artifact);
    const data = await runtime.request("artifact:read", artifact.id);
    assert.equal(data, "data:image/png;base64," + bytes.toString("base64"));
    const outside = join(dir, "outside.png");
    await writeFile(outside, bytes);
    artifact.path = outside;
    await assert.rejects(
      runtime.request("artifact:read", artifact.id),
      /outside the output folders/,
    );
  } finally {
    await runtime.close();
  }
});
