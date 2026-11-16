import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextBroker } from "../runtime/context/broker";
import { gitText } from "../runtime/context/source";
import { savedRead } from "../runtime/context/saved-read";
import type { ContextBinding, GraphClient } from "../runtime/context/contracts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-saved-read-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src/value.ts"),
    "export function existing() { return 1; }\n",
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
  await writeFile(
    join(root, "src/value.ts"),
    "export function existing() { return 1; }\nexport function newlyAdded() { return existing(); }\n",
  );
  const binding: ContextBinding = {
    project: {
      id: "saved",
      name: "Saved fixture",
      description: "Synthetic pending read",
      analysis: "ready",
      createdAt: "2026-11-16",
      path: root,
      repoId: "saved",
      branch: "main",
    },
    branch: "main",
    workerId: "test-worker",
    scope: [],
  };
  let pending = true;
  let omitted = false;
  let revisionPending = false,
    rule = "";
  const calls: string[] = [];
  const marker = {
    current: false,
    note: "native pending parse",
    files: ["src/value.ts"],
    gone: [],
    names_in_flux: ["newlyAdded"],
    declared: [
      {
        name: "newlyAdded",
        kind: "Function",
        file: "src/value.ts",
        line: 2,
        node_id: "must-not-be-trusted",
      },
    ],
    calls_to: [
      {
        name: "newlyAdded",
        caller: "unresolvedCaller",
        caller_kind: "Method",
        file: "src/value.ts",
        line: 1,
        call_line: 1,
      },
    ],
  };
  const row = {
    name: "newlyAdded",
    kind: "Function",
    file_path: "src/value.ts",
    start_line: 2,
    end_line: 2,
    node_id: "linked-id",
  };
  const engine: GraphClient = {
    async call(_project, name) {
      calls.push(name);
      if (name === "get_query_revision")
        return {
          token: "same-graph",
          ready: true,
          source_revision: "before-save",
          requested_revision_matches: true,
          source_unchanged_during_observation: true,
          ...(revisionPending ? { _saved_not_linked: marker } : {}),
        };
      if (name === "find_code")
        return {
          found: !pending && !omitted,
          status: "complete",
          results: pending || omitted ? [] : [row],
          ...(pending ? { _saved_not_linked: marker } : {}),
          ...(omitted
            ? {
                _read_check: {
                  not_searched_yet: ["src/value.ts"],
                  not_searched_yet_count: 1,
                },
              }
            : {}),
        };
      if (name === "get_symbol_context")
        return {
          found: true,
          symbol: row,
          callers: [{ name: "indexedCaller", node_id: "indexed-caller-id" }],
          callees: [],
          ...(pending ? { _saved_not_linked: marker } : {}),
        };
      if (name === "governing_rules") return { rules: rule ? [rule] : [] };
      if (name === "recall_decision") return { decisions: [] };
      throw Error("Unexpected tool " + name);
    },
  };
  return {
    binding,
    marker,
    calls,
    broker: new ContextBroker(engine, binding),
    setLinked() {
      pending = false;
    },
    setOmitted(value: boolean) {
      omitted = value;
    },
    pendingRevision() {
      revisionPending = true;
    },
    longRule() {
      rule = "Preserve this rule. ".repeat(1000);
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("files omitted while being saved remain explicitly incomplete and cannot enter the ready cache", async () => {
  const f = await fixture();
  try {
    f.setLinked();
    f.setOmitted(true);
    const request = {
      capability: "find" as const,
      query: "newlyAdded",
      budgetChars: 16000,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const pack = await f.broker.execute(request);
      assert.equal(pack.revision.graphReady, false);
      assert.equal(pack.coverage.canAct, false);
      assert.equal(pack.coverage.status, "partial");
      assert.equal(pack.telemetry.cacheHit, false);
      const saved = JSON.parse(
        pack.evidence.find((item) =>
          item.origin.startsWith("saved-file parse"),
        )!.text,
      );
      assert.deepEqual(saved.not_searched_yet, ["src/value.ts"]);
      assert.equal(saved.not_searched_yet_count, 1);
      assert.match(saved.note, /not searched/);
    }
    assert.equal(f.calls.filter((name) => name === "find_code").length, 2);
    f.setOmitted(false);
    const current = await f.broker.execute(request);
    assert.equal(current.revision.graphReady, true);
    assert.equal(current.coverage.canAct, true);
  } finally {
    await f.close();
  }
});

test("new declarations are immediately discoverable as verified text without acquiring graph identity or readiness", async () => {
  const f = await fixture();
  try {
    const pack = await f.broker.execute({
      capability: "find",
      query: "newlyAdded",
      budgetChars: 16000,
    });
    const source = pack.evidence.find((item) => item.kind === "source")!;
    assert.match(source.text, /2: export function newlyAdded/);
    assert.equal(source.origin, "verified-working-file");
    assert.equal(source.ref?.file, "src/value.ts");
    assert.equal(source.handle?.nodeId, undefined);
    assert.equal(pack.candidates[0].nodeId, undefined);
    assert.equal(pack.revision.graphReady, false);
    assert.equal(pack.coverage.status, "partial");
    assert.equal(pack.coverage.canAct, false);
    assert.ok(
      pack.coverage.unknown.some((reason) =>
        reason.startsWith("Saved source is not linked yet"),
      ),
    );
    const saved = JSON.parse(
      pack.evidence.find((item) => item.origin.startsWith("saved-file parse"))!
        .text,
    );
    assert.equal(saved.current, false);
    assert.match(saved.note, /not resolved graph edges/);
    assert.equal(saved.calls_to[0].caller, "unresolvedCaller");
    assert.equal(JSON.stringify(pack).includes("must-not-be-trusted"), false);
  } finally {
    await f.close();
  }
});

test("pending evidence is never cached and normal certified retrieval regains cacheability after linking", async () => {
  const f = await fixture();
  try {
    const request = {
      capability: "find",
      query: "newlyAdded",
      budgetChars: 16000,
    };
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal((await f.broker.execute(request)).telemetry.cacheHit, false);
    assert.equal(f.calls.filter((name) => name === "find_code").length, 2);
    f.setLinked();
    const linked = await f.broker.execute(request);
    assert.equal(linked.revision.graphReady, true);
    assert.equal(linked.candidates[0].nodeId, "linked-id");
    assert.equal(linked.telemetry.cacheHit, false);
    assert.equal((await f.broker.execute(request)).telemetry.cacheHit, true);
  } finally {
    await f.close();
  }
});

test("saved name-only calls stay separate from the indexed caller list", async () => {
  const f = await fixture();
  try {
    const pack = await f.broker.execute({
      capability: "understand",
      target: { symbol: "newlyAdded", file: "src/value.ts" },
      budgetChars: 16000,
    });
    const indexed = JSON.parse(
      pack.evidence.find((item) => item.kind === "relationships")!.text,
    );
    assert.deepEqual(indexed.callers, [
      { name: "indexedCaller", node_id: "indexed-caller-id" },
    ]);
    assert.equal(JSON.stringify(indexed).includes("unresolvedCaller"), false);
    const saved = JSON.parse(
      pack.evidence.find((item) => item.origin.startsWith("saved-file parse"))!
        .text,
    );
    assert.equal(saved.calls_to[0].caller, "unresolvedCaller");
    assert.equal(pack.revision.graphReady, false);
    assert.equal(pack.coverage.canAct, false);
  } finally {
    await f.close();
  }
});

test("a pending read observed during continuation cannot restore an earlier graph-ready page", async () => {
  const f = await fixture();
  try {
    f.setLinked();
    f.longRule();
    const request = {
      capability: "find",
      query: "newlyAdded",
      budgetChars: 5000,
    };
    const first = await f.broker.execute(request);
    assert.ok(first.coverage.continuation);
    f.pendingRevision();
    const next = await f.broker.execute({
      ...request,
      continuation: first.coverage.continuation,
    });
    assert.equal(next.revision.graphReady, false);
    assert.equal(next.coverage.canAct, false);
    assert.ok(
      next.coverage.unknown.some((reason) =>
        reason.startsWith("Saved source is not linked yet"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("saved parse metadata is bounded, ignores unrelated fields and respects worker visibility", () => {
  const binding = {
    project: { path: "/fixture", repoId: "fixture" },
    scope: ["src"],
  } as ContextBinding;
  const declared = Array.from({ length: 80 }, (_, i) => ({
    name: "visible" + i,
    file: "src/" + "x".repeat(180) + i + ".ts",
    line: i + 1,
    kind: "Function",
  }));
  const result = savedRead(
    {
      _saved_not_linked: {
        files: [
          "src/file.ts",
          "../escape.ts",
          "private/secret.ts",
          ".memcode/token.json",
        ],
        names_in_flux: ["visible0", "secretName"],
        declared: [
          { name: "secretName", file: "private/secret.ts", line: 1 },
          ...declared,
        ],
        calls_to: declared.map((item) => ({
          ...item,
          caller: "caller" + "z".repeat(100),
          call_line: item.line,
        })),
        secret: "must-not-leak",
        note: "must-not-leak",
      },
    },
    binding,
  )!;
  assert.ok(JSON.stringify(result.metadata).length <= 3000);
  assert.equal(result.metadata.truncated, true);
  assert.deepEqual(result.metadata.files, ["src/file.ts"]);
  assert.ok(result.declared.length <= 8);
  assert.equal(JSON.stringify(result).includes("secretName"), false);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(
    result.declared.some((item) => item.file.includes("..")),
    false,
  );
});
