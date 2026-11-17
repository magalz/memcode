import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../runtime/app";
import { MemtraceEngine } from "../runtime/memtrace";
import type { Project } from "../src/shared";

test("saving Settings preserves project analysis and changed engine paths reopen instead of permanently closing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-settings-engine-"));
  const source = join(root, "project");
  await mkdir(source);
  let opened = 0,
    closed = 0;
  let engine: MemtraceEngine | undefined;
  // Stub only MCP transport and index payloads. Public connect, close and
  // reconnect plus the real settings/analyze routes execute unchanged.
  t.mock.method(
    MemtraceEngine.prototype as any,
    "open",
    async function (this: any, project: Project) {
      opened++;
      const client = {
        close: async () => {
          closed++;
        },
      };
      this.clients.set(project.id, {
        client,
        transport: {},
        projectPath: project.path,
      });
      return client;
    },
  );
  t.mock.method(
    MemtraceEngine.prototype,
    "analyze",
    async function (this: MemtraceEngine, project: Project) {
      engine = this;
      await this.connect(project);
      return "settings-fixture";
    },
  );
  const runtime = await createRuntime(
    join(root, "profile"),
    root,
    {
      async call<T>(method: string) {
        if (method === "beta_store_read")
          return { configured: false, credentials: null } as T;
        return undefined as T;
      },
    },
    () => {},
  );
  const selected: Project = {
    id: "settings-project",
    name: "Settings lifecycle",
    path: source,
    branch: "main",
    description: "",
    analysis: "idle",
    createdAt: new Date().toISOString(),
  };
  runtime.store.state.settings.memtracePath = process.execPath;
  try {
    await runtime.request("settings:save", {
      ...runtime.store.state.settings,
      model: "updated-coding-model",
    });
    runtime.store.state.projects.push(selected);
    await runtime.request("project:analyze", selected.id);
    assert.equal(
      selected.analysis,
      "ready",
      "A new project can connect after settings were saved.",
    );
    await runtime.request("settings:save", {
      ...runtime.store.state.settings,
      speechEndpoint: "http://127.0.0.1:8181",
    });
    await runtime.request("project:analyze", selected.id);
    assert.equal(selected.analysis, "ready");
    assert.equal(
      opened,
      1,
      "Coding model/speech/retrieval preferences must not tear down an unrelated engine connection.",
    );
    assert.equal(closed, 0);
    const alternate = join(root, "alternate-engine.mjs");
    await writeFile(alternate, "// Transport is stubbed; never executed.\n");
    await runtime.request("settings:save", {
      ...runtime.store.state.settings,
      memtracePath: alternate,
    });
    await runtime.request("project:analyze", selected.id);
    assert.equal(
      opened,
      2,
      "A changed executable must open a new engine session.",
    );
    assert.equal(closed, 1);
    await runtime.request("settings:save", { ...runtime.store.state.settings });
    await runtime.request("project:analyze", selected.id);
    assert.equal(opened, 2, "Repeated saves leave the new engine usable.");
    await runtime.close();
    await assert.rejects(
      engine!.connect(selected),
      /connection is closing/,
      "Actual application shutdown remains terminal.",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
