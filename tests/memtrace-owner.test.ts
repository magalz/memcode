import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import {
  ManagedMemtraceOwners,
  pendingMemtraceOwner,
} from "../runtime/memtrace-owner.ts";

const pending = () =>
  Error(
    "-32603 repository summary revision probe failed: memdb: server_info unavailable: no workspace owner is attached yet; this session attaches when memtrace start publishes one",
  );
const scope = {
  directory: "C:/temporary/selected-project",
  workspaceFile:
    "C:/temporary/selected-project/.memcode/memtrace/workspace.toml",
  dataDirectory: "C:/temporary/selected-project/.memcode/memtrace/.memdb",
  jobDirectory: "C:/temporary/selected-project/.memcode/memtrace/.memtrace",
};
const command = { command: "node", prefix: ["installed/memtrace.js"] };
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    exitCode: null as number | null,
    signalCode: null,
    stdout: { resume() {} },
    stderr: { resume() {} },
  }) as unknown as ChildProcess;
  const spawns: unknown[][] = [],
    stopped: ChildProcess[] = [];
  const start = ((...args: unknown[]) => {
    spawns.push(args);
    return child;
  }) as typeof spawn;
  const owners = new ManagedMemtraceOwners({
    spawn: start,
    pollMs: 1,
    timeoutMs: 100,
    stop: async (process) => {
      stopped.push(process);
    },
  });
  return { owners, child, spawns, stopped };
}

test("pending owner is a distinct cold-start state, never generic wrong-store/auth failure", () => {
  assert.equal(pendingMemtraceOwner(pending()), true);
  assert.equal(pendingMemtraceOwner(Error("wrong_store")), false);
  assert.equal(pendingMemtraceOwner(Error("authentication expired")), false);
});

test("a reachable owner is borrowed without a process or shutdown ownership", async () => {
  const f = fixture();
  await f.owners.ready(scope, command, {}, async () => {});
  await f.owners.close();
  assert.equal(f.spawns.length, 0);
  assert.equal(f.stopped.length, 0);
});

test("cold project starts exact one-member headless scope, waits for queries, closes only its child", async () => {
  const f = fixture();
  let queries = 0;
  await f.owners.ready(
    scope,
    command,
    { PATH: "prepared-path", USER_SETTING: "keep" },
    async () => {
      if (++queries < 4) throw pending();
    },
  );
  assert.equal(f.spawns.length, 1);
  const [binary, args, options] = f.spawns[0] as [
    string,
    string[],
    { cwd: string; env: Record<string, string>; shell?: boolean },
  ];
  assert.equal(binary, "node");
  assert.deepEqual(args, [
    "installed/memtrace.js",
    "start",
    "--headless",
    "--workspace-file",
    scope.workspaceFile,
  ]);
  assert.equal(options.cwd, scope.directory);
  assert.equal(options.env.MEMTRACE_MEMDB_DATA_DIR, scope.dataDirectory);
  assert.equal(options.env.MEMTRACE_DATA_DIR, scope.jobDirectory);
  assert.equal(options.env.MEMTRACE_UI_PORT, "0");
  assert.equal(options.env.USER_SETTING, "keep");
  assert.equal(options.shell, undefined);
  await f.owners.close();
  assert.deepEqual(f.stopped, [f.child]);
});

test("unexpected probe failures do not start or seize any owner", async () => {
  const f = fixture();
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {
      throw Error("wrong_store");
    }),
    /wrong_store/,
  );
  assert.equal(f.spawns.length, 0);
  await f.owners.close();
});

test("overlapping bootstrap requests share one owned process", async () => {
  const f = fixture();
  let first = 0,
    second = 0;
  await Promise.all([
    f.owners.ready(scope, command, {}, async () => {
      if (++first < 3) throw pending();
    }),
    f.owners.ready(scope, command, {}, async () => {
      if (++second < 3) throw pending();
    }),
  ]);
  assert.equal(f.spawns.length, 1);
  await f.owners.close();
  assert.equal(f.stopped.length, 1);
});

test("readiness timeout releases its own process instead of leaving a hidden owner", async () => {
  const f = fixture();
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {
      throw pending();
    }),
    /taking too long/,
  );
  assert.equal(f.stopped.length, 1);
  await f.owners.close();
  assert.equal(f.stopped.length, 1);
});

test("close cancels bootstrap and cannot launch or stop a borrowed owner", async () => {
  const f = fixture();
  const waiting = f.owners.ready(scope, command, {}, async () => {
    throw pending();
  });
  await new Promise((done) => setTimeout(done, 5));
  await f.owners.close();
  await assert.rejects(waiting, /closing/);
  assert.equal(f.stopped.length, 1);
  await assert.rejects(
    f.owners.ready(scope, command, {}, async () => {}),
    /closing/,
  );
  assert.equal(f.spawns.length, 1);
});
