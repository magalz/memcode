import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { initialState } from "../src/seed";
import {
  assertWorkerConnected,
  connectedRuntimes,
  parseWorkerAuth,
  registerConnections,
} from "../runtime/worker-connections";
import {
  memtraceClaimUrl,
  MemtraceAccountManager,
  parseMemtraceStatus,
} from "../runtime/account";
import type { AppState, HarnessRuntime } from "../src/shared";

test("Memtrace status never invents a person or returns credential fields", () => {
  const account = parseMemtraceStatus({
    auth_session: { state: "Valid", degraded: false },
    memdb: { owner_reachable: true, mode: "local" },
    session_token: "DO-NOT-EXPOSE",
    license_key: "PRIVATE",
  });
  assert.equal(account.status, "connected");
  assert.equal(account.principal, undefined);
  assert.doesNotMatch(JSON.stringify(account), /DO-NOT-EXPOSE|PRIVATE/);
  assert.equal(
    parseMemtraceStatus({
      auth_session: { state: "Valid", degraded: false },
      memdb: { owner_reachable: false },
    }).status,
    "unknown",
  );
  const seat = parseMemtraceStatus({
    auth_session: { state: "Valid", degraded: false },
    memdb: {
      mode: "external",
      seat_principal: "studio-seat-123",
      user_org_id: "studio",
    },
  });
  assert.equal(seat.principal?.id, "studio-seat-123");
  assert.equal(seat.organizationId, "studio");
  assert.equal(
    parseMemtraceStatus({
      auth_session: { state: "Expired", degraded: true },
      memdb: { seat_principal: "studio-seat-123" },
    }).principal,
    undefined,
  );
});

test("claim links permit only the official HTTPS Memtrace claim action", () => {
  assert.equal(
    memtraceClaimUrl("https://www.memtrace.io/claim?code=abc_def-123"),
    "https://www.memtrace.io/claim?code=abc_def-123",
  );
  for (const url of [
    "https://memtrace.io.evil/claim?code=abcdefgh",
    "http://memtrace.io/claim?code=abcdefgh",
    "https://memtrace.io/settings?code=abcdefgh",
    "https://user:secret@memtrace.io/claim?code=abcdefgh",
    "https://memtrace.io:9999/claim?code=abcdefgh",
    "https://memtrace.io/claim?code=abcdefgh&redirect=https://evil.test",
  ])
    assert.equal(memtraceClaimUrl(url), undefined);
});

test("provider auth status parsing exposes only harmless account labels", () => {
  assert.deepEqual(
    parseWorkerAuth("codex", "", "Logged in using an API key: sk-SECRET"),
    { auth: "authenticated", accountLabel: "Configured API key" },
  );
  assert.deepEqual(
    parseWorkerAuth(
      "claude",
      JSON.stringify({
        loggedIn: true,
        email: "user@example.com",
        accessToken: "SECRET",
      }),
    ),
    { auth: "authenticated", accountLabel: "user@example.com" },
  );
  assert.deepEqual(
    parseWorkerAuth(
      "cursor",
      JSON.stringify({
        isAuthenticated: true,
        userInfo: { email: "user@example.com" },
        token: "SECRET",
      }),
    ),
    { auth: "authenticated", accountLabel: "user@example.com" },
  );
  assert.equal(parseWorkerAuth("claude", "unexpected output").auth, "unknown");
});

test("installed adapters are disconnected until an explicit path-bound grant", () => {
  const state = initialState(),
    runtime: HarnessRuntime = {
      id: "codex",
      name: "Codex",
      available: true,
      path: "/bin/codex",
      models: [],
    };
  assert.throws(() => assertWorkerConnected(state, "codex"), /Connect Codex/);
  assert.deepEqual(connectedRuntimes(state, [runtime]), []);
  state.workerConnections = {
    codex: {
      harness: "codex",
      approvedAt: new Date().toISOString(),
      runtimePath: runtime.path!,
      auth: "authenticated",
      scopeVersion: 1,
    },
  };
  assert.doesNotThrow(() =>
    assertWorkerConnected(state, "codex", runtime.path!),
  );
  assert.deepEqual(connectedRuntimes(state, [runtime]), [runtime]);
  assert.throws(
    () => assertWorkerConnected(state, "codex", "/other/codex"),
    /Connect Codex/,
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-connect-test-")),
    script = join(directory, "cli.mjs"),
    audit = join(directory, "audit.ndjson");
  await writeFile(
    script,
    `import{appendFileSync}from'node:fs';const[name,...args]=process.argv.slice(2);appendFileSync(${JSON.stringify(audit)},JSON.stringify({name,args})+'\\n');if(name==='codex')console.error('Logged in using ChatGPT');else if(name==='claude')console.log(JSON.stringify({loggedIn:true,email:'test@example.com',accessToken:'SECRET'}));else if(name==='cursor')console.log(JSON.stringify({isAuthenticated:true,userInfo:{email:'test@example.com'},token:'SECRET'}));`,
  );
  return {
    directory,
    script,
    audit,
    cleanup: async () => {
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
          basename(directory).startsWith("memcode-connect-test-"),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("connection consent uses only read-only auth probes and persists no credentials", async () => {
  const f = await fixture(),
    state = initialState(),
    routes = new Map<string, { schema: any; handler: (input: any) => any }>();
  let saves = 0;
  const registry = registerConnections(
    (name, schema, handler) => routes.set(name, { schema, handler }),
    () => state,
    async () => {
      saves++;
    },
    () => join(f.directory, "not-installed.exe"),
    { call: async () => undefined as any },
    async (name) => ({ command: process.execPath, prefix: [f.script, name] }),
  );
  const call = (name: string, input?: unknown) => {
    const r = routes.get(name)!;
    return r.handler(r.schema.parse(input));
  };
  try {
    const installed = await call("connection:status");
    assert.equal(
      installed.every((s: any) => s.installed && !s.connected),
      true,
    );
    assert.equal(state.workerConnections, undefined);
    assert.throws(() =>
      call("connection:approve", { harness: "claude", approved: false }),
    );
    const result = await call("connection:approve", {
      harness: "claude",
      approved: true,
    });
    assert.equal(result.connected, true);
    assert.equal(
      (state as AppState).workerConnections?.claude?.scopeVersion,
      1,
    );
    assert.equal(saves, 1);
    assert.doesNotMatch(
      JSON.stringify(state.workerConnections),
      /SECRET|accessToken|"token"/,
    );
    const audit = (await readFile(f.audit, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      audit.every(({ name, args }) =>
        name === "codex"
          ? args.join(" ") === "login status"
          : name === "claude"
            ? args.join(" ") === "auth status"
            : args.join(" ") === "status --format json",
      ),
    );
    const task = state.tasks[0];
    task.harness = "claude";
    task.example = false;
    task.run.state = "running";
    await assert.rejects(
      call("connection:disconnect", { harness: "claude" }),
      /Stop this adapter/,
    );
    task.run.state = "finished";
    await call("connection:disconnect", { harness: "claude" });
    assert.equal((state as AppState).workerConnections?.claude, undefined);
  } finally {
    await registry.close();
    await f.cleanup();
  }
});

test("explicit Memtrace sign-in delegates the official claim to the system-browser host only", async () => {
  const f = await fixture(),
    script = join(f.directory, "memtrace.mjs"),
    opened: any[] = [];
  await writeFile(
    script,
    `const args=process.argv.slice(2);if(args[0]==='status')console.log(JSON.stringify({auth_session:{state:'Valid',degraded:false},memdb:{owner_reachable:true},token:'SECRET'}));else if(args.join(' ')==='auth login'){console.error('Claim URL: https://www.memtrace.io/claim?code=test-device-code');setTimeout(()=>process.exit(0),500);}`,
  );
  const manager = new MemtraceAccountManager(() => script, {
    call: async (method, input) => {
      opened.push({ method, input });
      return undefined as any;
    },
  });
  try {
    const pending = await manager.signIn();
    assert.equal(pending.loginPending, true);
    for (let i = 0; i < 100 && !opened.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(opened, [
      {
        method: "open_memtrace_claim",
        input: { url: "https://www.memtrace.io/claim?code=test-device-code" },
      },
    ]);
    const loginDeadline = Date.now() + 5000;
    while (manager.current.loginPending && Date.now() < loginDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.current.loginPending, false);
    const status = await manager.refresh();
    assert.equal(status.status, "connected");
    assert.equal(status.principal, undefined);
    assert.doesNotMatch(JSON.stringify(status), /SECRET/);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});

test("a confirmed official login fast-path works before a local owner has started", async () => {
  const f = await fixture(),
    script = join(f.directory, "memtrace-fast.mjs"),
    opened: any[] = [];
  await writeFile(
    script,
    `if(process.argv[2]==='status')console.log(JSON.stringify({auth_session:{state:'Valid',degraded:false},memdb:{owner_reachable:false}}));else console.error('Already signed in (community).');`,
  );
  const manager = new MemtraceAccountManager(() => script, {
    call: async (method) => {
      opened.push(method);
      return undefined as any;
    },
  });
  try {
    assert.equal((await manager.refresh()).status, "unknown");
    await manager.signIn();
    for (let i = 0; i < 100 && manager.current.loginPending; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.refresh()).status, "connected");
    assert.equal(manager.current.principal, undefined);
    assert.deepEqual(opened, []);
  } finally {
    await manager.close();
    await f.cleanup();
  }
});
