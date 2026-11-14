import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Harness, Message, Project, WorkItem } from "../src/shared";
import {
  reviewContext,
  markReviewContext,
  retainReviewContext,
} from "../runtime/review-context";
import { harnessArgs, WorkerManager } from "../runtime/workers";
import { initialState } from "../src/seed";
import { git, within } from "../runtime/local";
import type { MemtraceEngine } from "../runtime/memtrace";
import { approveFixtureWorker } from "./fixtures/worker-consent";

const at = "2026-11-14T19:00:00.000Z";
const message = (id: string, role: Message["role"] = "assistant"): Message => ({
  id,
  role,
  text: id,
  at,
});

test("unread review follow-ups survive a long assistant history without duplicating recent context", () => {
  const delivered = { ...message("previous request", "user"), promptedAt: at },
    review = {
      ...message("review", "user"),
      text: 'Please replace the exact quote.\nSelection target: {"page":2,"cells":"B4:C5"}',
      commentIds: ["comment-1"],
    },
    outputs = Array.from({ length: 40 }, (_, i) => message("output-" + i)),
    latest = message("latest follow-up", "user"),
    context = reviewContext([delivered, review, ...outputs, latest]);
  assert.deepEqual(
    context.map((m) => m.id),
    ["review", ...outputs.slice(-14).map((m) => m.id), latest.id],
  );
  assert.equal(context.filter((m) => m.id === latest.id).length, 1);
  assert.equal(context[0].text, review.text);
  assert.deepEqual(context[0].commentIds, ["comment-1"]);
  assert.equal(review.promptedAt, undefined);
});

test("spawn marking consumes only the exact prompt snapshot and persists inclusion rather than completion", () => {
  const first = message("first", "user"),
    changed = message("edited while preparing", "user"),
    messages = [first, changed, message("prior answer")],
    snapshot = reviewContext(messages),
    incoming = message("arrived after prompt snapshot", "user");
  changed.text = "new wording";
  messages.push(incoming);
  markReviewContext(messages, snapshot, at);
  assert.equal(first.promptedAt, at);
  assert.equal(changed.promptedAt, undefined);
  assert.equal(incoming.promptedAt, undefined);
  assert.equal(messages[2].promptedAt, undefined);
  const restored: Message[] = JSON.parse(JSON.stringify(messages));
  assert.equal(restored[0].promptedAt, at);
  markReviewContext(restored, snapshot, "later timestamp");
  assert.equal(restored[0].promptedAt, at);
  assert.deepEqual(
    reviewContext(restored, 1)
      .filter((m) => m.role === "user")
      .map((m) => m.id),
    [changed.id, incoming.id],
  );
});

test("worker output retention never prunes a user follow-up awaiting a brief", () => {
  const pending = message("unread comment", "user"),
    delivered = { ...message("old delivered request", "user"), promptedAt: at },
    history = [
      message("original brief", "user"),
      pending,
      delivered,
      ...Array.from({ length: 500 }, (_, i) => message("tool-" + i, "tool")),
    ],
    retained = retainReviewContext(history);
  assert.equal(retained[0], history[0]);
  assert.ok(retained.includes(pending));
  assert.ok(!retained.includes(delivered));
  assert.equal(retained.at(-1), history.at(-1));
  assert.equal(retained.length, 251);
});

test("all adapter transports use the complete review brief without injecting its text into shell arguments", () => {
  const prompt = 'Review B4:C5 and lines 12–15; $(not-a-command) & "quoted"';
  for (const provider of ["codex", "claude", "cursor"] as Harness[]) {
    const briefPath = ".memcode/workers/review with spaces/brief.md",
      invocation = harnessArgs(
        provider,
        "C:/repo with spaces",
        prompt,
        "fixture",
        false,
        "medium",
        briefPath,
      );
    assert.equal(invocation.args.includes(prompt), false);
    if (provider === "cursor") {
      assert.equal(invocation.stdin, undefined);
      assert.ok(invocation.args.at(-1)?.includes(briefPath));
    } else assert.equal(invocation.stdin, prompt);
  }
});

async function workerFixture(commandFails = false, preparationFails = false) {
  const root = await mkdtemp(join(tmpdir(), "memcode-review-context-")),
    repo = join(root, "repo"),
    stub = join(root, "fixture.mjs"),
    state = initialState();
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await writeFile(join(repo, "README.md"), "Fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "Fixture",
  ]);
  await writeFile(
    stub,
    `import {writeFile} from 'node:fs/promises';let text='';for await(const data of process.stdin)text+=data;await writeFile('received.txt',text);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture received the brief; no model ran.'}}));`,
  );
  const project: Project = {
      id: "review-project",
      name: "Review fixture",
      description: "No production model",
      path: repo,
      branch: "main",
      analysis: "ready",
      repoId: "fixture",
      createdAt: at,
    },
    note = message("pending review", "user"),
    later = message("new review after snapshot", "user"),
    task: WorkItem = {
      ...state.tasks[0],
      id: "review-task",
      projectId: project.id,
      example: false,
      assignment: "manual",
      harness: "codex",
      modelOverride: "fixture-model",
      scope: ["received.txt"],
      messages: [note],
      stage: "planned",
      run: { state: "idle" },
    };
  state.projects = [project];
  state.tasks = [task];
  const fixtureCommand = commandFails
    ? join(root, "missing-program.exe")
    : process.execPath;
  approveFixtureWorker(state, "codex", fixtureCommand);
  let appended = false;
  const observations: Array<{ state: string; promptedAt?: string }> = [];
  const manager = new WorkerManager(
    () => state,
    async () => {
      observations.push({ state: task.run.state, promptedAt: note.promptedAt });
      if (task.run.state === "running" && !appended) {
        task.messages.push(later);
        appended = true;
      }
    },
    {
      analyze: async () => "fixture",
      qualify: async () => {
        if (preparationFails) throw Error("Preparation fixture failed");
        return {
          state: "unavailable",
          symbols: [],
          incomplete: true,
          note: "Fixture",
          measuredAt: at,
        };
      },
      call: async (_project: unknown, name: string) =>
        name === "fleet_acquire_lease"
          ? { state: "granted", lease_id: "review-lease" }
          : {},
    } as unknown as MemtraceEngine,
    join(root, "data"),
    async () => ({
      command: fixtureCommand,
      prefix: [stub],
    }),
    async () => [
      {
        id: "codex",
        name: "Fixture",
        available: true,
        path: fixtureCommand,
        models: [
          {
            id: "fixture-model",
            label: "Fixture",
            tier: "extreme",
            source: "alias",
          },
        ],
      },
    ],
  );
  return {
    root,
    repo,
    manager,
    task,
    project,
    note,
    later,
    observations,
    async cleanup() {
      await manager.close();
      assert.ok(
        within(tmpdir(), root) &&
          basename(root).startsWith("memcode-review-context-"),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function settled(fixture: Awaited<ReturnType<typeof workerFixture>>) {
  const deadline = Date.now() + 10000;
  while (
    !fixture.task.messages.some((m) =>
      /Worker (finished|needs attention)\./.test(m.text),
    ) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a real spawned fixture marks its brief snapshot while later incoming reviews remain pending", async () => {
  const fixture = await workerFixture();
  try {
    await fixture.manager.start(fixture.task, fixture.project);
    await settled(fixture);
    assert.equal(fixture.task.run.state, "finished");
    assert.ok(fixture.note.promptedAt);
    assert.equal(fixture.later.promptedAt, undefined);
    assert.ok(
      fixture.observations
        .filter((o) => o.state === "preparing")
        .every((o) => !o.promptedAt),
    );
    const received = await readFile(join(fixture.repo, "received.txt"), "utf8");
    assert.ok(received.includes(fixture.note.text));
    assert.ok(!received.includes(fixture.later.text));
  } finally {
    await fixture.cleanup();
  }
});

test("preparation and process spawn failure leave reviews pending for retry", async () => {
  for (const preparationFails of [false, true]) {
    const fixture = await workerFixture(!preparationFails, preparationFails);
    try {
      if (preparationFails)
        await assert.rejects(
          fixture.manager.start(fixture.task, fixture.project),
          /Preparation fixture failed/,
        );
      else {
        await fixture.manager.start(fixture.task, fixture.project);
        await settled(fixture);
        assert.equal(fixture.task.run.state, "failed");
      }
      assert.equal(fixture.note.promptedAt, undefined);
    } finally {
      await fixture.cleanup();
    }
  }
});
