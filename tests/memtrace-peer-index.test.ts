import test from "node:test";
import assert from "node:assert/strict";
import { waitForPeerIndex } from "../runtime/memtrace-peer-index";
import { MemtraceEngine } from "../runtime/memtrace";
import type { Project } from "../src/shared";

const project: Project = {
  id: "peer-fixture",
  name: "Peer fixture",
  description: "Synthetic job protocol",
  path: process.cwd(),
  branch: "main",
  repoId: "fixture",
  analysis: "ready",
  createdAt: "2026-11-16",
};
const skipped = {
  skipped: true,
  reason: "peer_indexing",
  repo_id: "fixture",
  branch: "main",
};
const job = (patch: Record<string, unknown> = {}) => ({
  id: "existing-job",
  repo_id: "fixture",
  status: "running",
  stage: "parse",
  message: "Parsing source files",
  runtime_context: { requested_path: project.path },
  ...patch,
});
const clock = () => {
  let time = 100000;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    discoveryMs: 30,
    timeoutMs: 100,
    pollMs: 10,
    readTimeoutMs: 100,
  };
};

test("peer job discovery follows matching owner progress and verifies branch/source at completion", async () => {
  const calls: Array<[string, Record<string, any>]> = [],
    notes: string[] = [];
  let polls = 0;
  const client = {
    call: async (
      _project: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      calls.push([name, args]);
      if (name === "list_jobs")
        return {
          jobs: [job({ progress: { completed: 2, total: 8, unit: "files" } })],
        };
      if (name === "check_job_status")
        return ++polls === 1
          ? job({
              stage: "embed",
              message: "Embedding changed symbols",
              progress: { completed: 3, total: null, unit: "symbols" },
            })
          : job({ status: "completed" });
      if (name === "get_query_revision") return { ready: true, branch: "main" };
      throw Error("Unexpected mutation " + name);
    },
  };
  assert.equal(
    await waitForPeerIndex(
      client,
      project,
      skipped,
      "fixture",
      (note) => notes.push(note),
      clock(),
    ),
    "fixture",
  );
  assert.equal(polls, 2);
  assert.match(notes[0], /existing-job.*parse.*2\/8 files/);
  assert.ok(notes.some((note) => note.includes("Embedding changed symbols")));
  assert.ok(
    notes.every((note) => !note.includes("%")),
    "Unknown totals do not produce invented percentages",
  );
  assert.deepEqual(
    calls
      .filter(([name]) => name === "check_job_status")
      .map(([, args]) => args.job_id),
    ["existing-job", "existing-job"],
  );
  assert.equal(calls.at(-1)?.[0], "get_query_revision");
});

test("engine peer handling queues once and adopts the tracked job rather than resubmitting indexes", async () => {
  const engine = new MemtraceEngine(() => "unused-fixture"),
    calls: string[] = [],
    payloads: Record<string, any>[] = [];
  engine.connect = (async () => ({})) as unknown as MemtraceEngine["connect"];
  engine.watch = async () => null;
  engine.call = async (_project, name, args) => {
    calls.push(name);
    if (name === "list_indexed_repositories")
      return {
        repos: [
          { repo_id: "fixture", repo_path: project.path, index_state: "stale" },
        ],
      };
    if (name === "index_directory") {
      payloads.push(args);
      return skipped;
    }
    if (name === "list_jobs") return { jobs: [job()] };
    if (name === "check_job_status") return job({ status: "completed" });
    if (name === "get_query_revision") return { ready: true, branch: "main" };
    throw Error("Unexpected " + name);
  };
  try {
    assert.equal(await engine.analyze({ ...project }, () => {}), "fixture");
    assert.equal(calls.filter((name) => name === "index_directory").length, 1);
    assert.equal(payloads[0].branch, "main");
    assert.equal(payloads[0].incremental, true);
    assert.equal(payloads[0].clear_existing, undefined);
  } finally {
    await engine.close();
  }
});

test("a missing active job or stale lease stops promptly without creating another job", async () => {
  let lists = 0;
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") {
        lists++;
        return { jobs: [] };
      }
      if (name === "get_query_revision")
        return { ready: false, branch: "main" };
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /no active job.*lease may be stale/,
  );
  assert.ok(
    lists <= 4,
    "Discovery is bounded independently of the normal index duration",
  );
});

test("unrelated repositories, checkouts and explicit other branches are never followed", async () => {
  let statusCalls = 0;
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs")
        return {
          jobs: [
            job({ id: "other-repo", repo_id: "other" }),
            job({
              id: "other-root",
              runtime_context: { requested_path: project.path + "-different" },
            }),
            job({ id: "other-branch", branch: "epic/other" }),
          ],
        };
      if (name === "get_query_revision")
        return { ready: false, branch: "main" };
      if (name === "check_job_status") {
        statusCalls++;
        throw Error("Wrong job polled");
      }
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /no active job/,
  );
  assert.equal(statusCalls, 0);
});

test("a returned job ID is preferred and still checked against its exact local scope", async () => {
  const calls: string[] = [];
  const client = {
    call: async (
      _project: Project,
      name: string,
      args: Record<string, any>,
    ) => {
      if (name === "list_jobs")
        return {
          jobs: [job({ id: "unselected-job" }), job({ id: "returned-job" })],
        };
      if (name === "check_job_status") {
        calls.push(args.job_id);
        return job({ id: args.job_id, status: "completed" });
      }
      if (name === "get_query_revision") return { ready: true, branch: "main" };
      throw Error("Unexpected " + name);
    },
  };
  assert.equal(
    await waitForPeerIndex(
      client,
      project,
      { ...skipped, job_id: "returned-job" },
      "fixture",
      () => {},
      clock(),
    ),
    "fixture",
  );
  assert.deepEqual(calls, ["returned-job"]);
  await assert.rejects(
    waitForPeerIndex(
      {
        call: async () => ({
          jobs: [job({ id: "returned-job", repo_id: "unrelated" })],
        }),
      },
      project,
      { ...skipped, job_id: "returned-job" },
      "fixture",
      () => {},
      clock(),
    ),
    /does not match this local checkout/,
  );
});

test("completed legacy jobs without branch metadata still require independently ready source on the intended branch", async () => {
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") return { jobs: [job()] };
      if (name === "check_job_status") return job({ status: "completed" });
      if (name === "get_query_revision")
        return { ready: true, branch: "epic/different" };
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /completed, but current source on branch main is not verified/,
  );
  await assert.rejects(
    waitForPeerIndex(
      client,
      project,
      { ...skipped, branch: "epic/different" },
      "fixture",
      () => {},
      clock(),
    ),
    /another repository or branch/,
  );
});

test("the actual existing job failure is surfaced rather than a generic peer-indexing message", async () => {
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") return { jobs: [job()] };
      if (name === "check_job_status")
        return job({
          status: "failed",
          error: "Source input certificate could not be qualified",
        });
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, clock()),
    /existing-job failed: Source input certificate/,
  );
});

test("an active but unfinished job has a bounded wait with its identity retained for reconnect", async () => {
  let polls = 0;
  const options = { ...clock(), timeoutMs: 20 };
  const client = {
    call: async (_project: Project, name: string) => {
      if (name === "list_jobs") return { jobs: [job()] };
      if (name === "check_job_status") {
        polls++;
        return job();
      }
      throw Error("Unexpected " + name);
    },
  };
  await assert.rejects(
    waitForPeerIndex(client, project, skipped, "fixture", () => {}, options),
    /existing-job is still running.*no duplicate index/,
  );
  assert.equal(polls, 2);
});

test("unresponsive owner diagnostics are bounded rather than inheriting a long blind MCP wait", async () => {
  await assert.rejects(
    waitForPeerIndex(
      { call: async () => new Promise(() => {}) },
      project,
      skipped,
      "fixture",
      () => {},
      { ...clock(), readTimeoutMs: 5 },
    ),
    /list_jobs did not respond/,
  );
});
