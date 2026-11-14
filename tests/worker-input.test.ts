import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { WorkerInputs } from "../runtime/worker-input";
import type { AppState } from "../src/shared";
import type { WorkerInputPrompt } from "../src/worker-input";

const approval: WorkerInputPrompt = {
  kind: "approval",
  title: "Allow command?",
  options: [
    { id: "once", label: "Allow once", kind: "allow-once" },
    { id: "deny", label: "Deny", kind: "deny" },
  ],
};
function fixture(save?: (state: AppState) => Promise<void>) {
  const state = initialState();
  state.tasks = state.tasks.slice(0, 2).map((task, index) => ({
    ...task,
    id: `task-${index}`,
    run: { state: "running", changeRunId: `run-${index}` },
  }));
  const snapshots: AppState[] = [];
  const inputs = new WorkerInputs(
    () => state,
    async () => {
      snapshots.push(structuredClone(state));
      if (save) await save(state);
    },
  );
  return {
    state,
    task: state.tasks[0],
    other: state.tasks[1],
    inputs,
    snapshots,
  };
}

test("worker input is persisted as pending and the same native promise waits until an explicit answer", async () => {
  const f = fixture();
  let resolved = false;
  const waiting = f.inputs.ask(f.task, approval).then((response) => {
    resolved = true;
    return response;
  });
  const request = f.state.workerInputs![0];
  assert.equal(request.status, "pending");
  assert.equal(request.runId, f.task.run.changeRunId);
  assert.equal(request.taskId, f.task.id);
  assert.equal(request.harness, f.task.harness);
  assert.equal(f.snapshots[0].workerInputs?.[0].status, "pending");
  assert.equal(f.task.run.activity?.phase, "waiting_for_user");
  await Promise.resolve();
  assert.equal(resolved, false);
  const response = { optionId: "once" };
  await f.inputs.respond(f.task.id, request.id, response);
  assert.deepEqual(await waiting, response);
  assert.equal(request.status, "answered");
  assert.ok(request.answeredAt);
  assert.equal(f.task.run.activity?.phase, "working");
  assert.equal(f.snapshots.at(-1)?.workerInputs?.[0].status, "answered");
  await assert.rejects(
    f.inputs.respond(f.task.id, request.id, response),
    /no longer waiting/,
  );
});

test("wrong task, stale run, stopped worker and invalid option cannot resolve or consume a pending request", async () => {
  const f = fixture(),
    waiting = f.inputs.ask(f.task, approval),
    request = f.state.workerInputs![0];
  await assert.rejects(
    f.inputs.respond(f.other.id, request.id, { optionId: "once" }),
    /no longer waiting/,
  );
  await assert.rejects(
    f.inputs.respond(f.task.id, "unknown-request", { optionId: "once" }),
    /no longer waiting/,
  );
  await assert.rejects(
    f.inputs.respond(f.task.id, request.id, { optionId: "invented" }),
    /offered actions/,
  );
  f.task.run.changeRunId = "new-run";
  await assert.rejects(
    f.inputs.respond(f.task.id, request.id, { optionId: "once" }),
    /no longer waiting/,
  );
  f.task.run.changeRunId = "run-0";
  f.task.run.state = "stopped";
  await assert.rejects(
    f.inputs.respond(f.task.id, request.id, { optionId: "once" }),
    /no longer waiting/,
  );
  assert.equal(request.status, "pending");
  f.inputs.cancelTask(f.task.id);
  assert.deepEqual(await waiting, { cancelled: true });
});

test("structured questions validate single choice, multiple choices, missing answers and free text", async () => {
  const f = fixture();
  const prompt: WorkerInputPrompt = {
    kind: "question",
    title: "Choose scope",
    questions: [
      {
        id: "single",
        question: "Which one?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        allowText: false,
      },
      {
        id: "multi",
        question: "Which tests?",
        options: [
          { id: "unit", label: "Unit" },
          { id: "browser", label: "Browser" },
        ],
        multiple: true,
        allowText: false,
      },
      { id: "notes", question: "Anything else?", options: [], allowText: true },
    ],
  };
  const waiting = f.inputs.ask(f.task, prompt),
    request = f.state.workerInputs![0];
  for (const answers of [
    { single: "a", multi: [], notes: "Notes" },
    { single: ["a", "b"], multi: ["unit"], notes: "Notes" },
    { single: "invented", multi: ["unit"], notes: "Notes" },
    { single: "a", multi: ["unit", "invented"], notes: "Notes" },
    { single: "a", multi: ["unit"], notes: " " },
  ])
    await assert.rejects(f.inputs.respond(f.task.id, request.id, { answers }));
  assert.equal(request.status, "pending");
  const answers = {
    single: "b",
    multi: ["unit", "browser"],
    notes: "Use the existing API contract.",
  };
  await f.inputs.respond(f.task.id, request.id, { answers });
  assert.deepEqual(await waiting, { answers });
});

test("secret answers reach only the native waiting promise while persisted state is redacted", async () => {
  const f = fixture(),
    secret = "synthetic-fixture-secret-do-not-store";
  const waiting = f.inputs.ask(f.task, {
    kind: "question",
    title: "Credentials",
    questions: [
      { id: "name", question: "Name", options: [], allowText: true },
      {
        id: "token",
        question: "Token",
        options: [],
        allowText: true,
        secret: true,
      },
    ],
  });
  const request = f.state.workerInputs![0],
    response = { answers: { name: "Fixture", token: secret } };
  await f.inputs.respond(f.task.id, request.id, response);
  assert.deepEqual(await waiting, response);
  assert.equal(request.response?.answers?.token, "[redacted]");
  assert.equal(request.response?.answers?.name, "Fixture");
  assert.ok(!JSON.stringify(f.state).includes(secret));
  assert.ok(!JSON.stringify(f.snapshots).includes(secret));
  assert.equal(
    response.answers.token,
    secret,
    "redaction must not mutate the actual native response",
  );
});

test("explicit cancel, AbortSignal and task cancellation resolve only the matching pending requests", async () => {
  const f = fixture(),
    controller = new AbortController();
  const first = f.inputs.ask(f.task, approval, controller.signal),
    second = f.inputs.ask(f.other, approval);
  const [firstRequest, secondRequest] = f.state.workerInputs!;
  controller.abort();
  assert.deepEqual(await first, { cancelled: true });
  assert.equal(firstRequest.status, "cancelled");
  assert.equal(secondRequest.status, "pending");
  await f.inputs.respond(f.other.id, secondRequest.id, { cancelled: true });
  assert.deepEqual(await second, { cancelled: true });
  const third = f.inputs.ask(f.task, approval);
  f.inputs.cancelTask(f.task.id);
  assert.deepEqual(await third, { cancelled: true });
  await assert.rejects(
    f.inputs.respond(f.task.id, firstRequest.id, { optionId: "once" }),
    /no longer waiting/,
  );
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const count = f.state.workerInputs!.length;
  assert.deepEqual(
    await f.inputs.ask(f.task, approval, alreadyAborted.signal),
    { cancelled: true },
  );
  assert.equal(f.state.workerInputs!.length, count);
});

test("inactive or untracked worker runs cannot create a persisted interactive request", async () => {
  const f = fixture();
  f.task.run.state = "idle";
  await assert.rejects(f.inputs.ask(f.task, approval), /no longer waiting/);
  f.task.run.state = "preparing";
  delete f.task.run.changeRunId;
  await assert.rejects(f.inputs.ask(f.task, approval), /no longer waiting/);
  assert.equal(f.state.workerInputs, undefined);
  assert.equal(f.snapshots.length, 0);
});

test("a failed save does not release the answer; the pending request can be retried", async () => {
  let fail = false;
  const f = fixture(async () => {
    if (fail) throw Error("disk unavailable");
  });
  const waiting = f.inputs.ask(f.task, approval),
    request = f.state.workerInputs![0];
  fail = true;
  await assert.rejects(
    f.inputs.respond(f.task.id, request.id, { optionId: "once" }),
    /disk unavailable/,
  );
  assert.equal(request.status, "pending");
  assert.equal(request.response, undefined);
  assert.equal(
    f.task.run.activity?.phase,
    "waiting_for_user",
    "a failed save must not claim the answer was sent",
  );
  fail = false;
  await f.inputs.respond(f.task.id, request.id, { optionId: "deny" });
  assert.deepEqual(await waiting, { optionId: "deny" });
});

test("cancellation during a failed answer save cannot resurrect a stale pending question", async () => {
  let begin!: () => void,
    release!: () => void,
    gated = false;
  const began = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async () => {
    if (gated) {
      begin();
      await gate;
      throw Error("disk unavailable");
    }
  });
  const waiting = f.inputs.ask(f.task, approval),
    request = f.state.workerInputs![0];
  gated = true;
  const response = f.inputs.respond(f.task.id, request.id, {
    optionId: "once",
  });
  await began;
  f.inputs.cancelTask(f.task.id);
  assert.deepEqual(await waiting, { cancelled: true });
  release();
  await assert.rejects(response, /disk unavailable|cancelled/);
  assert.equal(request.status, "cancelled");
  assert.deepEqual(request.response, { cancelled: true });
  await assert.rejects(
    f.inputs.respond(f.task.id, request.id, { optionId: "once" }),
    /no longer waiting/,
  );
});
