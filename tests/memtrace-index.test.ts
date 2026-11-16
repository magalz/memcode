import { test } from "node:test";
import assert from "node:assert/strict";
import { MemtraceEngine } from "../runtime/memtrace.ts";
import type { Project } from "../src/shared.ts";

const project = {
  id: "selected-project",
  path: "C:/temporary/selected-project",
  branch: "epic/local-context",
  repoId: "selected-repo",
} as Project;
const repository = {
  repo_id: project.repoId,
  repo_path: project.path,
  index_state: "current",
};
function fixture(
  rows: unknown,
  revision = { ready: true, branch: project.branch },
) {
  const engine = new MemtraceEngine(() => "");
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  (engine as any).connect = async () => ({});
  (engine as any).watch = async () => undefined;
  engine.call = async (_project, name, args) => {
    calls.push({ name, args });
    if (name === "list_indexed_repositories") return rows;
    if (name === "index_directory") return { job_id: "local-index-job" };
    if (name === "check_job_status")
      return {
        id: "local-index-job",
        status: "completed",
        repo_id: project.repoId,
      };
    if (name === "get_query_revision") return revision;
    throw Error(`Unexpected operation ${name}`);
  };
  return { engine, calls };
}

for (const [shape, rows] of [
  ["array", [repository]],
  ["repos", { repos: [repository] }],
  ["repositories", { repositories: [repository] }],
] as const) {
  test(`current local repository in ${shape} response is reused without indexing`, async () => {
    const f = fixture(rows);
    assert.equal(await f.engine.analyze(project, () => {}), project.repoId);
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ["list_indexed_repositories", "get_query_revision"],
    );
  });
}

test("a current summary waits for independently verified startup publication without enqueueing", async () => {
  const f = fixture([repository]);
  const original = f.engine.call;
  let reads = 0;
  f.engine.call = async (p, name, args) => {
    if (name === "list_jobs") return { jobs: [] };
    if (name === "get_query_revision")
      return {
        ready: ++reads >= 3,
        branch: project.branch,
        repo_id: project.repoId,
        worktree: project.path,
        source_unchanged_during_observation: true,
        graph_revision: { publication_unchanged_during_call: reads >= 3 },
      };
    return original(p, name, args);
  };
  try {
    assert.equal(await f.engine.analyze(project, () => {}), project.repoId);
    assert.equal(reads, 3);
    assert.equal(
      f.calls.some((c) => c.name === "index_directory"),
      false,
    );
  } finally {
    await f.engine.close();
  }
});

test("refresh preserves existing identity and requests incremental indexing of the selected branch", async () => {
  const f = fixture({ repos: [repository] });
  assert.equal(await f.engine.analyze(project, () => {}, true), project.repoId);
  assert.deepEqual(
    f.calls.find((call) => call.name === "index_directory")?.args,
    {
      path: project.path,
      repo_id: project.repoId,
      incremental: true,
      skip_embed: false,
      branch: project.branch,
    },
  );
  assert.equal(f.calls.at(-1)?.name, "get_query_revision");
});

test("job completion does not mark an unpublished graph ready", async () => {
  const f = fixture({ repos: [repository] }, {
    ready: false,
    branch: project.branch,
    reason: "branch_publication_incomplete",
  } as any);
  await assert.rejects(
    f.engine.analyze(project, () => {}, true),
    /source.*not verified.*branch_publication_incomplete/,
  );
});

test("job completion for a different source branch is rejected", async () => {
  const f = fixture([repository], { ready: true, branch: "another-branch" });
  await assert.rejects(
    f.engine.analyze(project, () => {}, true),
    /not verified/,
  );
});

test("native alreadyUpToDate admission still requires a verified revision, not a foreground job", async () => {
  const f = fixture([repository]),
    original = f.engine.call;
  let submissions = 0;
  f.engine.call = async (p, name, args) => {
    if (name === "index_directory") {
      submissions++;
      return { alreadyUpToDate: true, repo_id: project.repoId };
    }
    if (name === "list_jobs") return { jobs: [] };
    return original(p, name, args);
  };
  try {
    assert.equal(
      await f.engine.analyze(project, () => {}, true),
      project.repoId,
    );
    assert.equal(submissions, 1);
  } finally {
    await f.engine.close();
  }
});
