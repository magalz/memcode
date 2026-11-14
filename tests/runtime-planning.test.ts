import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createRuntime } from "../runtime/app.ts";
import { within } from "../runtime/local.ts";
import type { WorkItem } from "../src/shared.ts";

test("runtime validates bulk updates atomically and accepts children before their parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memcode-runtime-test-"));
  const runtime = await createRuntime(
    dir,
    dir,
    {
      call: async () => {
        throw new Error("No native calls expected");
      },
    },
    () => {},
  );
  try {
    const projectId = runtime.store.state.projects[0].id;
    const create = (title: string, parentId?: string) =>
      runtime.request("task:create", {
        projectId,
        title,
        description: "A fixture",
        priority: "medium",
        harness: "codex",
        assignment: "auto",
        parentId,
      }) as Promise<WorkItem>;
    const parent = await create("Fixture parent"),
      child = await create("Fixture child", parent.id);
    await assert.rejects(
      runtime.request("task:bulk-update", {
        ids: [parent.id, "missing"],
        patch: { priority: "high" },
      }),
      /no longer exists/,
    );
    assert.equal(parent.priority, "medium");
    await runtime.request("task:bulk-update", {
      ids: [parent.id, child.id],
      patch: { statusId: `${projectId}:done` },
    });
    assert.equal(parent.stage, "done");
    assert.equal(child.stage, "done");
    child.run.state = "running";
    child.stage = "working";
    await assert.rejects(
      runtime.request("task:bulk-update", {
        ids: [parent.id, child.id],
        patch: { archivedAt: new Date().toISOString() },
      }),
      /active worker/,
    );
    assert.equal(parent.archivedAt, undefined);
    await assert.rejects(
      runtime.request("task:update", {
        id: child.id,
        patch: { madeUp: "field" },
      }),
      /Unrecognized/,
    );
    await assert.rejects(
      runtime.request("not:a:method"),
      /Unknown MemCode method/,
    );
    child.run.state = "stopped";
    await assert.rejects(
      runtime.request("settings:save", {
        ...runtime.store.state.settings,
        contextAssistant: {
          enabled: true,
          provider: "openai-compatible",
          packageDirectory: "",
          baseUrl: "https://remote.example/v1",
          model: "local-helper",
        },
      }),
    );
    assert.equal(runtime.store.state.settings.contextAssistant, undefined);
  } finally {
    await runtime.close();
    assert.ok(
      within(tmpdir(), dir) &&
        basename(dir).startsWith("memcode-runtime-test-"),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
