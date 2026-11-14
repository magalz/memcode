import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialState } from "../src/seed";
import { TerminalManager, installedShells } from "../runtime/terminals";
import { git } from "../runtime/local";
import type { NativeHost } from "../runtime/host";
import { terminalRequestSchema } from "../src/terminal";

test("persistent terminal identity and folder are bound by the host, with argv and raw input preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-terminal-contract-"));
  await git(root, ["init", "--initial-branch=main"]);
  await mkdir(join(root, "app"));
  const state = initialState();
  const project = state.projects[0];
  project.path = root;
  project.example = false;
  const task = state.tasks[0];
  task.example = false;
  task.run = { state: "running", branch: "main", workspace: root };
  const calls: Array<{ method: string; input: any }> = [];
  const host = {
    call: async (method: string, input: any) => {
      calls.push({ method, input });
      return method === "terminal_start"
        ? {
            id: input.id,
            taskId: input.taskId,
            label: input.label,
            origin: input.origin,
            status: "running",
            seq: 0,
          }
        : method === "terminal_observe"
          ? {
              session: { id: input.sessionId, taskId: input.taskId },
              chunks: [
                {
                  seq: 1,
                  data: Buffer.from("\x1b[32mReady ✓\x1b[0m").toString(
                    "base64",
                  ),
                },
              ],
            }
          : [];
    },
  } as NativeHost;
  const manager = new TerminalManager(() => state, host);
  const started = await manager.execute(
    task.id,
    {
      action: "start",
      label: "Dev server",
      program: "node",
      args: ["server.mjs", "a b", "$(literal)"],
      cwd: "app",
    },
    "worker",
  );
  assert.deepEqual(calls[0].input.args, ["server.mjs", "a b", "$(literal)"]);
  assert.equal(calls[0].input.taskId, task.id);
  assert.equal(calls[0].input.cwd, join(root, "app"));
  const id = started.session!.id;
  await manager.execute(task.id, {
    action: "write",
    sessionId: id,
    data: "ping\r",
  });
  assert.equal(
    Buffer.from(calls.at(-1)!.input.data, "base64").toString(),
    "ping\r",
  );
  assert.equal(
    (await manager.execute(task.id, { action: "observe", sessionId: id })).text,
    "Ready ✓",
  );
  await manager.execute(
    task.id,
    {
      action: "start",
      label: "Adapter JSON",
      program: "node",
      args: '["server.mjs","a b"]',
    },
    "worker",
  );
  assert.deepEqual(calls.at(-1)!.input.args, ["server.mjs", "a b"]);
  await assert.rejects(
    manager.execute(task.id, {
      action: "start",
      label: "Bad args",
      program: "node",
      args: "node server.mjs",
    }),
    /JSON-encoded array/,
  );
  await assert.rejects(
    manager.execute(task.id, {
      action: "start",
      label: "Outside",
      program: "node",
      cwd: "..",
    }),
    /inside/,
  );
  assert.equal(
    terminalRequestSchema.safeParse({ action: "list", taskId: "forged" })
      .success,
    false,
  );
  await manager.close();
  assert.equal(calls.at(-1)!.method, "terminal_close_all");
  assert.ok((await installedShells()).length > 0);
});
