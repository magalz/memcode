import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { admitPrivateEpisodeRepository } from "../runtime/memtrace-workspace";
import { verifiedIndexRevision } from "../runtime/memtrace-peer-index";
import { MemtraceEngine } from "../runtime/memtrace";
import { git } from "../runtime/local";
import type { Project } from "../src/shared";

const directory = join(tmpdir(), "canonical-private-admission-fixture");
const scope = {
  directory,
  workspaceFile: join(directory, ".memcode", "memtrace", "workspace.toml"),
  dataDirectory: join(directory, ".memcode", "memtrace", ".memdb"),
  jobDirectory: join(directory, ".memcode", "memtrace", ".memtrace"),
};
// Exact native 96fe2f54e episode-only startup contract: an Episode can precede
// the Repository node, suppressing the later discovered-member/path row.
const episode = { repo_id: "selected-repo", ingestion_path: "episode_only", repo_path: null, path: null };
const stats = { repo_in_store: true, nodes: 0, edges: 0 };
const revision = { repo_id: episode.repo_id, worktree: directory, branch: "main", ready: false, status: "partial" };
function reads(membership: any = stats, binding: any = revision) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    read: async (name: "get_repository_stats" | "get_query_revision", args: { repo_id: string; branch: string }) => {
      calls.push({ name, args });
      return name === "get_repository_stats" ? membership : binding;
    },
  };
}

test("single private native episode-only row requires positive membership followed by exact source/branch binding", async () => {
  const f = reads();
  assert.equal(await admitPrivateEpisodeRepository([episode], scope, "main", f.read), episode);
  assert.deepEqual(f.calls, [
    { name: "get_repository_stats", args: { repo_id: "selected-repo", branch: "main" } },
    { name: "get_query_revision", args: { repo_id: "selected-repo", branch: "main" } },
  ]);
  assert.equal(verifiedIndexRevision(revision, { path: directory, branch: "main" } as Project, episode.repo_id), false,
    "a source-bound cold connection must not become an analysis-ready certificate");
});

test("non-private, foreign, multiple and non-episode rows are rejected before any membership query", async () => {
  const scenarios = [
    { rows: [episode], local: null },
    { rows: [], local: scope },
    { rows: [episode, { ...episode, repo_id: "another" }], local: scope },
    { rows: [{ ...episode, path: join(tmpdir(), "foreign-repository") }], local: scope },
    { rows: [{ ...episode, repo_path: directory }], local: scope },
    { rows: [{ ...episode, ingestion_path: "indexed" }], local: scope },
    { rows: [{ repo_id: episode.repo_id }], local: scope },
    { rows: [{ ...episode, repo_id: "" }], local: scope },
    { rows: [null], local: scope },
  ];
  for (const scenario of scenarios) {
    const f = reads();
    assert.equal(await admitPrivateEpisodeRepository(scenario.rows, scenario.local, "main", f.read), null);
    assert.deepEqual(f.calls, []);
  }
});

test("false, unknown and inconsistent membership never reaches revision or permits a cold index", async () => {
  for (const membership of [
    { repo_in_store: false }, {}, null,
    { repo_in_store: true, diagnostic: { kind: "wrong_store" } },
    { repo_in_store: true, repo_id: "different-repository" },
    { repo_in_store: true, path: join(tmpdir(), "foreign-repository") },
    { repo_in_store: true, repo_path: join(tmpdir(), "foreign-repository") },
  ]) {
    const f = reads(membership);
    assert.equal(await admitPrivateEpisodeRepository([episode], scope, "main", f.read), null);
    assert.deepEqual(f.calls.map(call => call.name), ["get_repository_stats"]);
  }
});

test("partial revisions with missing or mismatched worktree/branch/identity never admit a pathless row", async () => {
  for (const binding of [
    {}, null,
    { ...revision, worktree: undefined },
    { ...revision, worktree: join(tmpdir(), "foreign-repository") },
    { ...revision, branch: undefined },
    { ...revision, branch: "epic/another" },
    { ...revision, repo_id: "different-repository" },
  ]) {
    const f = reads(stats, binding);
    assert.equal(await admitPrivateEpisodeRepository([episode], scope, "main", f.read), null);
    assert.deepEqual(f.calls.map(call => call.name), ["get_repository_stats", "get_query_revision"]);
  }
});

test("a stats path when present must agree, and a failed binding read cannot be treated as permission", async () => {
  const matching = reads({ ...stats, path: directory, repo_path: directory });
  assert.equal(await admitPrivateEpisodeRepository([episode], scope, "main", matching.read), episode);
  const calls: string[] = [];
  await assert.rejects(admitPrivateEpisodeRepository([episode], scope, "main", async name => {
    calls.push(name);
    if (name === "get_repository_stats") return stats;
    throw Error("source binding unavailable");
  }), /source binding unavailable/);
  assert.deepEqual(calls, ["get_repository_stats", "get_query_revision"]);
});

test("real MCP transport admits the certified cold source binding and rejects wrong-store analysis before any index submission", async () => {
  for (const wrongStore of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "memcode-admission-protocol-"));
    const requestedPath = join(root, "project"); await mkdir(requestedPath);
    const path = await realpath(requestedPath), callsPath = join(root, "calls.jsonl"), executable = join(root, "protocol-fixture.mjs");
    await git(path, ["init", "-b", "main"]);
    const values = { wrongStore, path, callsPath };
    await writeFile(executable, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const fixture=${JSON.stringify(values)};
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 const message=JSON.parse(line);if(message.id===undefined)return;
 let result;
 if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-cold-admission',version:'1'}};
 else if(message.method==='tools/call'){
  const {name,arguments:args}=message.params;appendFileSync(fixture.callsPath,JSON.stringify({name,args})+'\\n');
  const value=name==='list_indexed_repositories'?[{repo_id:'fixture-repo',ingestion_path:'episode_only',path:null,repo_path:null}]
    :name==='get_repository_stats'?{repo_in_store:!fixture.wrongStore,nodes:0,edges:0}
    :name==='get_query_revision'?{repo_id:'fixture-repo',worktree:fixture.path,branch:'main',ready:false,status:'partial'}
    :{unexpected:true};
  result={content:[{type:'text',text:JSON.stringify(value)}]};
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`);
    const selected = { id: "cold-admission", name: "Synthetic project", path, branch: "main", description: "", createdAt: "2026-11-16T00:00:00Z", analysis: "idle" } as Project;
    const engine = new MemtraceEngine(() => executable, { privateProject: () => true });
    try {
      if (wrongStore) {
        await assert.rejects(engine.analyze(selected, () => {}), /workspace does not include/);
        assert.equal(engine.scopeFor(selected.id), null, "a rejected store must never be attached");
      } else {
        await engine.connect(selected);
        assert.equal(engine.scopeFor(selected.id)?.mode, "project");
        assert.equal(engine.scopeFor(selected.id)?.dataDirectory, join(path, ".memcode", "memtrace", ".memdb"));
        assert.equal(selected.analysis, "idle", "connecting does not declare an index ready");
      }
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(calls.map(call => call.name), wrongStore
        ? ["list_indexed_repositories", "get_repository_stats"]
        : ["list_indexed_repositories", "get_repository_stats", "get_query_revision"]);
      assert.ok(calls.every(call => call.name !== "index_directory"));
    } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
  }
});
