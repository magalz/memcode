import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemtraceEngine } from "../runtime/memtrace";
import type { Project } from "../src/shared";

const project = (
  id = "project",
  path = join(tmpdir(), "binding-a"),
): Project => ({
  id,
  name: id,
  path,
  branch: "main",
  repoId: "fixture-repo",
  description: "",
  analysis: "ready",
  createdAt: "2026-11-16T00:00:00Z",
});
function fixture(separateAliasStore = false) {
  const engine = new MemtraceEngine(() => "protocol-fixture"),
    internal = engine as any;
  const calls: Array<{ id: string; path: string; name: string }> = [],
    closed: string[] = [],
    opened: Array<{ id: string; path: string }> = [];
  const watches = new Map<string, { repo_id: string; branch: string }>();
  const aliasWatches = new Map<string, { repo_id: string; branch: string }>();
  let openGate: Promise<void> | undefined,
    watchGate: Promise<void> | undefined,
    ownerStops = 0;
  internal.owners.close = async () => {
    ownerStops++;
  };
  // Replace only the transport/admission boundary. Public connect/call/watch/
  // scopeFor/close execute unchanged, including client and watcher lifecycles.
  internal.open = async (selected: Project) => {
    const path = selected.path!,
      id = `${selected.id}/${opened.length}`;
    const selectedWatches =
      separateAliasStore && selected.id === "alias" ? aliasWatches : watches;
    opened.push({ id, path });
    if (openGate) await openGate;
    const client = {
      close: async () => {
        closed.push(id);
      },
      callTool: async ({
        name,
        arguments: args,
      }: {
        name: string;
        arguments: Record<string, unknown>;
      }) => {
        calls.push({ id, path, name });
        let value: unknown;
        if (name === "list_watched_paths")
          value = {
            watches: [...selectedWatches].map(([path, row]) => ({
              path,
              ...row,
            })),
          };
        else if (name === "watch_directory") {
          if (watchGate) await watchGate;
          selectedWatches.set(String(args.path), {
            repo_id: String(args.repo_id),
            branch: String(args.branch),
          });
          value = { ok: true };
        } else if (name === "unwatch_directory") {
          selectedWatches.delete(String(args.path));
          value = { ok: true };
        } else value = { boundPath: path, connection: id };
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      },
    };
    internal.scopes.set(selected.id, {
      mode: "project",
      dataDirectory:
        separateAliasStore && selected.id === "alias"
          ? join(path, ".borrowed-workspace-store")
          : join(path, ".memcode", "memtrace", ".memdb"),
    });
    internal.clients.set(selected.id, {
      client,
      transport: {},
      projectPath: path,
    });
    return client;
  };
  return {
    engine,
    calls,
    opened,
    closed,
    watches,
    aliasWatches,
    get ownerStops() {
      return ownerStops;
    },
    holdOpen(gate: Promise<void> | undefined) {
      openGate = gate;
    },
    holdWatch(gate: Promise<void> | undefined) {
      watchGate = gate;
    },
  };
}

test("rebinding a project queries the new local store and removes its old owned watch; same-path source/branch changes reuse the client", async () => {
  const f = fixture(),
    selected = project(),
    old = selected.path!;
  try {
    const first = await f.engine.call(selected, "get_repository_stats", {});
    await f.engine.watch(selected);
    selected.path = join(tmpdir(), "binding-b");
    selected.repoId = "fixture-b";
    const second = await f.engine.call(selected, "get_repository_stats", {});
    assert.equal(first.boundPath, old);
    assert.equal(second.boundPath, selected.path);
    assert.notEqual(second.connection, first.connection);
    assert.equal(
      f.engine.scopeFor(selected.id)!.dataDirectory,
      join(selected.path, ".memcode", "memtrace", ".memdb"),
    );
    assert.equal(f.engine.watcherFor(selected.id), null);
    assert.equal(f.watches.has(old), false);
    assert.equal(
      f.calls.filter((c) => c.path === old && c.name === "unwatch_directory")
        .length,
      1,
    );
    assert.deepEqual(f.closed, [first.connection]);
    assert.equal(f.ownerStops, 0);
    selected.branch = "epic/updated-after-pull";
    const same = await f.engine.call(selected, "get_repository_stats", {});
    assert.equal(same.connection, second.connection);
    assert.equal(f.opened.length, 2);
  } finally {
    await f.engine.close();
  }
});

test("a rebind preserves another project's old-root client and transfers this session's watch ownership", async () => {
  const f = fixture(),
    selected = project(),
    alias = project("alias", selected.path!);
  try {
    const old = await f.engine.call(selected, "get_repository_stats", {});
    await f.engine.watch(selected);
    const peer = await f.engine.call(alias, "get_repository_stats", {});
    await f.engine.watch(alias);
    assert.equal(f.engine.watcherFor(alias.id)!.origin, "existing");
    selected.path = join(tmpdir(), "new-checkout");
    await f.engine.call(selected, "get_repository_stats", {});
    assert.equal(f.watches.has(alias.path!), true);
    assert.equal(
      f.calls.filter((c) => c.name === "unwatch_directory").length,
      0,
    );
    assert.equal(f.engine.watcherFor(alias.id)!.origin, "memcode");
    assert.equal(
      (await f.engine.call(alias, "get_repository_stats", {})).connection,
      peer.connection,
    );
    assert.deepEqual(f.closed, [old.connection]);
    assert.equal(f.ownerStops, 0);
  } finally {
    await f.engine.close();
  }
  assert.equal(
    f.calls.filter(
      (c) => c.path === alias.path && c.name === "unwatch_directory",
    ).length,
    1,
  );
});

test("rebinding never stops a watch borrowed from another Memtrace owner", async () => {
  const f = fixture(),
    selected = project(),
    old = selected.path!;
  f.watches.set(old, { repo_id: selected.repoId!, branch: selected.branch });
  await f.engine.call(selected, "get_repository_stats", {});
  await f.engine.watch(selected);
  assert.equal(f.engine.watcherFor(selected.id)!.origin, "existing");
  selected.path = join(tmpdir(), "new-borrowed-checkout");
  await f.engine.call(selected, "get_repository_stats", {});
  assert.equal(f.ownerStops, 0);
  await f.engine.close();
  assert.equal(f.watches.has(old), true);
  assert.equal(
    f.calls.filter((c) => c.path === old && c.name === "unwatch_directory")
      .length,
    0,
  );
});

test("same-folder aliases in different physical stores cannot inherit or stop one another's watches", async () => {
  const f = fixture(true),
    selected = project(),
    alias = project("alias", selected.path!),
    old = selected.path!;
  f.aliasWatches.set(old, { repo_id: alias.repoId!, branch: alias.branch });
  try {
    const owned = await f.engine.call(selected, "get_repository_stats", {});
    await f.engine.watch(selected);
    const borrowed = await f.engine.call(alias, "get_repository_stats", {});
    await f.engine.watch(alias);
    assert.notEqual(
      f.engine.scopeFor(selected.id)!.dataDirectory,
      f.engine.scopeFor(alias.id)!.dataDirectory,
    );
    selected.path = join(tmpdir(), "different-store-rebound");
    await f.engine.call(selected, "get_repository_stats", {});
    assert.equal(f.watches.has(old), false);
    assert.equal(f.aliasWatches.has(old), true);
    assert.equal(f.engine.watcherFor(alias.id)!.origin, "existing");
    assert.equal(
      f.calls.filter(
        (call) =>
          call.id === owned.connection && call.name === "unwatch_directory",
      ).length,
      1,
    );
    assert.equal(
      f.calls.filter(
        (call) =>
          call.id === borrowed.connection && call.name === "unwatch_directory",
      ).length,
      0,
    );
    assert.equal(
      (await f.engine.call(alias, "get_repository_stats", {})).connection,
      borrowed.connection,
    );
  } finally {
    await f.engine.close();
  }
  assert.equal(f.aliasWatches.has(old), true);
});

test("a folder changed during connection cannot hand its old store to the new binding", async () => {
  const f = fixture(),
    selected = project();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdOpen(gate);
  const first = f.engine.connect(selected);
  const firstResult = first.then(
    () => "unexpected",
    (error) => String(error),
  );
  selected.path = join(tmpdir(), "changed-during-open");
  const second = f.engine.connect(selected);
  f.holdOpen(undefined);
  release();
  assert.match(await firstResult, /folder changed/);
  await second;
  assert.equal(
    (await f.engine.call(selected, "get_repository_stats", {})).boundPath,
    selected.path,
  );
  assert.equal(f.opened.length, 2);
  assert.equal(f.closed.length, 1);
  await f.engine.close();
});

test("rebinding waits for an issued watch operation and cannot retain or recreate its old-root watch", async () => {
  const f = fixture(),
    selected = project(),
    old = selected.path!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await f.engine.connect(selected);
  f.holdWatch(gate);
  const watching = f.engine.watch(selected);
  while (!f.calls.some((c) => c.name === "watch_directory"))
    await new Promise((resolve) => setImmediate(resolve));
  selected.path = join(tmpdir(), "watch-rebound-checkout");
  const connecting = f.engine.connect(selected);
  release();
  await watching;
  await connecting;
  assert.equal(f.watches.has(old), false);
  assert.equal(f.engine.watcherFor(selected.id), null);
  assert.equal(
    (await f.engine.call(selected, "get_repository_stats", {})).boundPath,
    selected.path,
  );
  assert.equal(
    f.calls.filter((c) => c.path === old && c.name === "unwatch_directory")
      .length,
    1,
  );
  await f.engine.close();
});

test("a cached engine connection still checks current access before every query and cannot fall back after logout", async () => {
  const f = fixture(),
    selected = project();
  let allowed = true,
    checks = 0;
  (f.engine as any).options.environment = async () => {
    checks++;
    if (!allowed) throw Error("Reconnect beta access");
    return {};
  };
  try {
    await f.engine.call(selected, "get_repository_stats", {});
    await f.engine.call(selected, "get_repository_stats", {});
    assert.equal(f.opened.length, 1);
    assert.equal(checks, 2);
    allowed = false;
    await assert.rejects(
      f.engine.call(selected, "get_repository_stats", {}),
      /Reconnect beta/,
    );
    assert.equal(
      f.calls.filter((call) => call.name === "get_repository_stats").length,
      2,
    );
  } finally {
    await f.engine.close();
  }
});

test("account reset closes owned watch/client and reopens the same project under a new engine session", async () => {
  const f = fixture(),
    selected = project();
  await f.engine.watch(selected);
  const first = await f.engine.call(selected, "get_repository_stats", {});
  await f.engine.reconnect();
  assert.equal(f.watches.has(selected.path!), false);
  assert.equal(f.engine.scopeFor(selected.id), null);
  const second = await f.engine.call(selected, "get_repository_stats", {});
  assert.notEqual(second.connection, first.connection);
  assert.equal(f.ownerStops, 1);
  assert.equal(f.closed.length, 1);
  await f.engine.close();
});
