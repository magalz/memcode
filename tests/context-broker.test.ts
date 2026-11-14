import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { ContextBroker } from "../runtime/context/broker";
import { startContextSession } from "../runtime/context/host";
import {
  sourceRevision,
  gitText,
  repoFiles,
  checkedPath,
} from "../runtime/context/source";
import { claudeProfileArgs } from "../runtime/context/profile";
import { localAssistant, loopbackUrl } from "../runtime/context/local-model";
import { contextAssistantDefaults } from "../src/context-settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ContextBinding, GraphClient } from "../runtime/context/contracts";

test("context scans and source reads exclude live engine stores even before Git ignores them", async () => {
  const root = await mkdtemp(join(tmpdir(), "memcode-store-scan-"));
  await gitText(root, ["init", "--initial-branch=main"]);
  for (const directory of [".memdb", ".memtrace", "src"])
    await mkdir(join(root, directory));
  await writeFile(
    join(root, ".memdb", "active.lock"),
    "Runtime database, not source",
  );
  await writeFile(
    join(root, ".memtrace", "job.json"),
    "Runtime job, not source",
  );
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  assert.deepEqual(await repoFiles(root), ["src/index.ts"]);
  await assert.rejects(
    checkedPath(
      { project: { path: root } } as ContextBinding,
      ".memdb/active.lock",
    ),
    /visibility boundary/,
  );
});

async function fixture(scope: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "memcode-context-test-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "price.ts"),
    "export function price(value: number) { return value * 2; }\nexport function invoice() { return price(10); }\n",
  );
  await writeFile(
    join(root, "AGENTS.md"),
    "Preserve the public price contract.\n",
  );
  await gitText(root, ["init", "--initial-branch=main"]);
  await gitText(root, ["add", "."]);
  await gitText(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const binding: ContextBinding = {
    project: {
      id: "fixture",
      name: "Fixture",
      description: "Isolated test",
      path: root,
      repoId: "fixture",
      branch: "main",
      analysis: "ready",
      createdAt: new Date().toISOString(),
    },
    workerId: "fixture-worker",
    branch: "main",
    scope,
  };
  const calls: string[] = [];
  let graph = "graph-1",
    ready = true,
    governance = "Never remove the exported price function.",
    ambiguity = false;
  let onFind: (() => Promise<void>) | undefined;
  const row = {
    name: "price",
    kind: "Function",
    file_path: "src/price.ts",
    start_line: 1,
    end_line: 1,
    node_id: "price-id",
  };
  const engine: GraphClient = {
    async call(_project, name) {
      calls.push(name);
      if (name === "get_query_revision")
        return {
          token: graph,
          source_revision: "index-source",
          ready,
          requested_revision_matches: true,
          source_unchanged_during_observation: true,
        };
      if (name === "find_code") {
        await onFind?.();
        return { found: true, status: "complete", results: [row] };
      }
      if (name === "get_symbol_context")
        return ambiguity
          ? {
              ambiguous: true,
              candidates: [row, { ...row, file_path: "src/other.ts" }],
            }
          : {
              found: true,
              symbol: row,
              callers: [
                { name: "invoice", file_path: "src/price.ts", start_line: 2 },
              ],
              callees: [],
              callers_conclusive: false,
              graph_truncated: !ready,
            };
      if (name === "preflight_check")
        return {
          found: true,
          affected: ["invoice"],
          verification_checklist: ["Run invoice test"],
          truncated: !ready,
        };
      if (name === "governing_rules") return { rules: [governance] };
      if (name === "recall_decision")
        return { decisions: [], coverage: "unknown" };
      throw new Error("Unexpected backend tool " + name);
    },
  };
  const broker = new ContextBroker(engine, binding);
  return {
    root,
    binding,
    engine,
    broker,
    calls,
    row,
    setGraph(value: string) {
      graph = value;
    },
    setReady(value: boolean) {
      ready = value;
    },
    setRules(value: string) {
      governance = value;
    },
    setAmbiguous(value: boolean) {
      ambiguity = value;
    },
    onFind(fn: () => Promise<void>) {
      onFind = fn;
    },
    async close() {
      assert.ok(
        root.startsWith(resolve(tmpdir())) &&
          basename(root).startsWith("memcode-context-test-"),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
const find = { capability: "find", query: "price", budgetChars: 16000 };

test("enabled ONNX configuration rejects a model different from the fixed pilot", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      startContextSession(
        f.engine,
        f.binding,
        join(f.root, ".memcode", "invalid-model"),
        {
          settings: {
            ...contextAssistantDefaults,
            enabled: true,
            model: "unavailable-other-model",
          },
        },
      ),
      /ONNX pilot requires model/,
    );
  } finally {
    await f.close();
  }
});

test("literal evidence binds dirty source, graph, visibility and refreshed constraints", async () => {
  const f = await fixture();
  try {
    const first = await f.broker.execute(find);
    assert.equal(first.revision.stable, true);
    assert.equal(first.revision.dirty, false);
    assert.match(
      first.evidence.find((e) => e.kind === "source")!.text,
      /return value \* 2/,
    );
    assert.equal(first.evidence[0].ref!.file, "src/price.ts");
    assert.equal(first.constraints.length, 2);
    const second = await f.broker.execute(find);
    assert.equal(second.telemetry.cacheHit, true);
    f.setRules("New independent Cortex constraint.");
    const refreshed = await f.broker.execute(find);
    assert.equal(refreshed.telemetry.cacheHit, true);
    assert.ok(
      refreshed.constraints.some((c) => c.text.includes("New independent")),
    );
    await writeFile(
      join(f.root, "src", "price.ts"),
      "export function price(value: number) { return value * 3; }\n",
    );
    const changed = await f.broker.execute(find);
    assert.equal(changed.telemetry.cacheHit, false);
    assert.equal(changed.revision.dirty, true);
    assert.notEqual(changed.revision.fingerprint, first.revision.fingerprint);
    assert.match(changed.evidence[0].text, /value \* 3/);
    await writeFile(
      join(f.root, "src", "price.ts"),
      "export function price(value: number) { return value * 4; }\n",
    );
    assert.notEqual(
      (await f.broker.execute(find)).revision.fingerprint,
      changed.revision.fingerprint,
      "same dirty status must not reuse content cache",
    );
  } finally {
    await f.close();
  }
});

test("graph revision invalidates cached evidence and branch changes refuse requests", async () => {
  const f = await fixture();
  try {
    await f.broker.execute(find);
    f.setGraph("graph-2");
    assert.equal((await f.broker.execute(find)).telemetry.cacheHit, false);
    await gitText(f.root, ["switch", "-c", "other"]);
    await assert.rejects(f.broker.execute(find), /branch changed/);
  } finally {
    await f.close();
  }
});

test("ambiguity returns candidates without claiming a resolved target", async () => {
  const f = await fixture();
  try {
    f.setAmbiguous(true);
    const pack = await f.broker.execute({
      capability: "understand",
      target: { symbol: "price" },
    });
    assert.equal(pack.coverage.status, "ambiguous");
    assert.equal(pack.coverage.canAct, false);
    assert.equal(pack.candidates.length, 2);
    assert.equal(
      pack.evidence.some((e) => e.kind === "source"),
      false,
    );
    assert.equal(f.calls.includes("preflight_check"), false);
  } finally {
    await f.close();
  }
});

test("incomplete graph and preflight checks are explicitly observations, not verification", async () => {
  const f = await fixture();
  try {
    f.setReady(false);
    const pack = await f.broker.execute({
      capability: "assess",
      targets: [{ symbol: "price", file: "src/price.ts" }],
      change: "signature",
      intent: "Add a rounding argument",
    });
    assert.equal(pack.revision.graphReady, false);
    assert.ok(pack.coverage.unknown.some((x) => x.includes("alignment")));
    assert.ok(pack.coverage.truncated.some((x) => x.includes("incomplete")));
    assert.match(
      pack.evidence.find((e) => e.kind === "assessment")!.origin,
      /not executed checks/,
    );
    assert.equal(
      f.calls.some((name) => name.startsWith("fleet_")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("a source save during graph lookup marks pack unstable and refuses acting", async () => {
  const f = await fixture();
  try {
    f.onFind(() =>
      writeFile(
        join(f.root, "src", "price.ts"),
        "export function price() { return 999; }\n",
      ),
    );
    const pack = await f.broker.execute(find);
    assert.equal(pack.revision.stable, false);
    assert.equal(pack.coverage.canAct, false);
  } finally {
    await f.close();
  }
});

test("essential constraints survive every budget page with explicit continuation", async () => {
  const f = await fixture();
  try {
    const rule = "Keep caller compatibility. ".repeat(900);
    f.setRules(rule);
    let pack = await f.broker.execute({ ...find, budgetChars: 4000 });
    let text = "",
      pages = 0;
    do {
      assert.ok(
        JSON.stringify(pack).length <= 4000,
        `page ${pages} exceeds budget`,
      );
      text += pack.constraints
        .filter((c) => c.origin === "governing_rules")
        .map((c) => c.text)
        .join("");
      if (pack.coverage.continuation) {
        assert.equal(pack.coverage.canAct, false);
        pack = await f.broker.execute({
          ...find,
          budgetChars: 4000,
          continuation: pack.coverage.continuation,
        });
      } else break;
      assert.ok(++pages < 100);
    } while (true);
    assert.equal(text, rule);
    assert.ok(pages > 1);
  } finally {
    await f.close();
  }
});

test("continuations reject changes in source and independently refreshed governance", async () => {
  const f = await fixture();
  try {
    f.setRules("Long constraint. ".repeat(600));
    const first = await f.broker.execute({ ...find, budgetChars: 4000 });
    f.setRules("Rule replaced while source and graph did not change.");
    await assert.rejects(
      f.broker.execute({ ...find, continuation: first.coverage.continuation }),
      /Governance changed/,
    );
    f.setRules("Long constraint. ".repeat(600));
    const second = await f.broker.execute({ ...find, budgetChars: 4000 });
    await writeFile(join(f.root, "new.ts"), "export const x = 1;");
    await assert.rejects(
      f.broker.execute({ ...find, continuation: second.coverage.continuation }),
      /source\/graph changed/,
    );
  } finally {
    await f.close();
  }
});

test("scoped fallback is literal, observable and requires a scope and reason", async () => {
  const f = await fixture(["src"]);
  try {
    await assert.rejects(
      f.broker.execute({ ...find, mode: "text" }),
      /narrow scope/,
    );
    const pack = await f.broker.execute({
      ...find,
      mode: "text",
      query: "value * 2",
      scope: "src",
      fallbackReason: "exact-string",
    });
    assert.equal(pack.telemetry.fallback?.filesScanned, 1);
    assert.match(pack.evidence[0].text, /value \* 2/);
    assert.ok(pack.constraints.some((c) => c.origin === "governing_rules"));
    await assert.rejects(
      f.broker.execute({ ...find, scope: "../outside" }),
      /outside/,
    );
  } finally {
    await f.close();
  }
});

test("source excerpts cannot escape worker visibility or invent a stale declaration", async () => {
  const f = await fixture(["other"]);
  try {
    const result = await f.broker.execute(find);
    assert.equal(
      result.evidence.some((e) => e.kind === "source"),
      false,
    );
    await assert.rejects(
      f.broker.execute({
        capability: "understand",
        target: { symbol: "price", file: "src/price.ts" },
      }),
      /outside/,
    );
    const broker = new ContextBroker(f.engine, { ...f.binding, scope: [] });
    await writeFile(
      join(f.root, "src", "price.ts"),
      "export function replacement() { return 1; }\n",
    );
    const stale = await broker.execute(find);
    assert.equal(
      stale.evidence.some((e) => e.kind === "source"),
      false,
    );
    assert.ok(
      stale.coverage.unknown.some((x) => x.includes("no longer matches")),
    );
  } finally {
    await f.close();
  }
});

test("local planning errors fall back, rank IDs are validated, facts remain literal", async () => {
  const f = await fixture();
  try {
    const broker = new ContextBroker(f.engine, f.binding, {
      model: "broken-local",
      plan: async () => {
        throw new Error("offline");
      },
      rank: async () => ({ ids: ["invented"] }),
    });
    const pack = await broker.execute(find);
    assert.equal(pack.telemetry.localModel.state, "fallback");
    assert.match(pack.telemetry.localModel.note!, /offline/);
    assert.match(pack.evidence[0].text, /return value \* 2/);
    assert.equal(
      f.calls.some((x) => x.startsWith("fleet_")),
      false,
    );
    assert.throws(() => loopbackUrl("https://example.com/v1"), /loopback/);
    assert.throws(
      () => localAssistant({ baseUrl: "http://example.com/v1", model: "m" }),
      /loopback/,
    );
  } finally {
    await f.close();
  }
});

test("real stdio gateway exposes exactly three retrieval tools and binds HTTP identity in the host", async () => {
  const f = await fixture();
  const session = await startContextSession(
    f.engine,
    f.binding,
    join(f.root, ".memcode", "worker"),
  );
  const client = new Client({ name: "context-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      resolve("scripts/context-gateway.mjs"),
      session.configPath,
    ],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name).sort(),
      ["assess", "find", "understand"],
    );
    for (const [name, args] of [
      ["find", { query: "price" }],
      ["understand", { target: { symbol: "price", file: "src/price.ts" } }],
      [
        "assess",
        {
          targets: [{ symbol: "price", file: "src/price.ts" }],
          change: "signature",
          intent: "Add tax",
        },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true);
      const pack = JSON.parse((result.content as any)[0].text);
      assert.equal(pack.binding.workerId, "fixture-worker");
      assert.ok(pack.evidence.some((e: any) => e.ref?.sha256));
    }
    assert.equal(
      (await fetch(session.endpoint, { method: "POST", body: "{}" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(session.endpoint, {
          method: "POST",
          headers: { Authorization: "é".repeat(71) },
          body: "{}",
        })
      ).status,
      401,
    );
    const forged = await fetch(session.endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + session.token },
      body: JSON.stringify({ ...find, repoId: "other" }),
    });
    assert.equal(forged.status, 400);
    const args = claudeProfileArgs("profile.json");
    assert.ok(
      args.includes("--strict-mcp-config") &&
        args.includes("--disable-slash-commands"),
    );
    assert.equal(
      args.some((x) => /--bare|--safe-mode|--setting-sources/.test(x)),
      false,
    );
    assert.equal(args.includes("Bash,Read,Edit,Write"), true);
  } finally {
    await client.close();
    await session.close();
    await f.close();
  }
});
