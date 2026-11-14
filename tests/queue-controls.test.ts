import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { registerReview } from "../runtime/review";
import {
  claimReviewContext,
  releaseReviewClaims,
  reviewContext,
} from "../runtime/review-context";
import type { Message } from "../src/shared";
import { restartSafeState } from "../src/domain";
function fixture() {
  const state = initialState(),
    task = state.tasks[0],
    routes = new Map<string, { schema: any; run: (input: any) => unknown }>();
  const message: Message = {
    id: "pending",
    role: "user",
    text: "Original instruction",
    at: "2026-11-14T12:00:00Z",
    queuedAt: "2026-11-14T12:01:00Z",
    queueOrder: 12,
    followupState: "queued",
  };
  task.messages = [message];
  task.example = false;
  task.run.state = "running";
  let saves = 0;
  registerReview(
    (name, schema, run) => routes.set(name, { schema, run }),
    () => state,
    async () => {
      saves++;
    },
    () => {},
  );
  return {
    state,
    task,
    message,
    saves: () => saves,
    call: async (name: string, input: unknown) => {
      const route = routes.get(name)!;
      return route.run(route.schema.parse(input));
    },
  };
}
test("editing waiting follow-ups preserves order and rebuilds attached review text from immutable targets", async () => {
  const h = fixture();
  const reference = {
    taskId: h.task.id,
    kind: "file" as const,
    name: "plan.md",
    path: "/project/plan.md",
    quote: "Original quotation",
    startOffset: 4,
    endOffset: 22,
    revision: "source-version",
    selectionType: "text" as const,
  };
  h.state.reviewComments = [
    {
      id: "review-note",
      taskId: h.task.id,
      reference,
      text: "Old review wording",
      createdAt: h.message.at,
      updatedAt: h.message.at,
      status: "shared",
      messageId: h.message.id,
    },
  ];
  h.message.commentIds = ["review-note"];
  h.message.references = [reference];
  h.message.reviewText = "Original instruction";
  await h.call("review:queue-update", {
    taskId: h.task.id,
    messageId: h.message.id,
    text: "Updated instruction",
    commentEdits: [{ id: "review-note", text: "Precise updated request" }],
  });
  assert.equal(h.message.reviewText, "Updated instruction");
  assert.match(h.message.text, /Precise updated request/);
  assert.doesNotMatch(h.message.text, /Old review wording/);
  assert.match(h.message.text, /"startOffset":4/);
  assert.deepEqual(h.message.references, [reference]);
  assert.deepEqual(h.state.reviewComments[0].reference, reference);
  assert.equal(h.message.queueOrder, 12);
  assert.equal(h.message.queuedAt, "2026-11-14T12:01:00Z");
  assert.equal(h.message.followupState, "queued");
  const before = structuredClone(h.message);
  await assert.rejects(
    h.call("review:queue-update", {
      taskId: h.task.id,
      messageId: h.message.id,
      text: "Forged",
      commentEdits: [{ id: "different-note", text: "Tamper" }],
    }),
    /attached/,
  );
  assert.deepEqual(h.message, before);
});
test("cancelled waiting follow-ups stay visible and never enter later prompts", async () => {
  const h = fixture();
  await h.call("review:queue-cancel", {
    taskId: h.task.id,
    messageId: h.message.id,
  });
  assert.equal(h.message.followupState, "cancelled");
  assert.equal(h.message.text, "Original instruction");
  assert.equal(
    reviewContext(h.task.messages).some(
      (message) => message.id === h.message.id,
    ),
    false,
  );
  await assert.rejects(
    h.call("review:queue-update", {
      taskId: h.task.id,
      messageId: h.message.id,
      text: "Too late",
    }),
    /no longer waiting/,
  );
});
test("snapshot pickup closes edit and cancel atomically; failed preparation releases the claim", async () => {
  const h = fixture(),
    snapshot = claimReviewContext(h.task.messages, "picked-up-now");
  assert.equal(h.message.pickedUpAt, "picked-up-now");
  await assert.rejects(
    h.call("review:queue-update", {
      taskId: h.task.id,
      messageId: h.message.id,
      text: "Stale edit",
    }),
    /picked up/,
  );
  await assert.rejects(
    h.call("review:queue-cancel", {
      taskId: h.task.id,
      messageId: h.message.id,
    }),
    /picked up/,
  );
  assert.equal(h.message.text, snapshot[0].text);
  releaseReviewClaims(h.task.messages, snapshot);
  assert.equal(h.message.pickedUpAt, undefined);
  await h.call("review:queue-update", {
    taskId: h.task.id,
    messageId: h.message.id,
    text: "Updated after release",
  });
  assert.equal(
    claimReviewContext(h.task.messages, "picked-again")[0].text,
    "Updated after release",
  );
});
test("queue operations cannot target another card or an already spawned brief", async () => {
  const h = fixture();
  await assert.rejects(
    h.call("review:queue-cancel", {
      taskId: h.state.tasks[1].id,
      messageId: h.message.id,
    }),
    /no longer waiting/,
  );
  h.message.promptedAt = "spawned";
  await assert.rejects(
    h.call("review:queue-cancel", {
      taskId: h.task.id,
      messageId: h.message.id,
    }),
    /picked up/,
  );
  assert.equal(h.saves(), 0);
});

test("restart drops an unconsumed pickup claim but keeps pending text and pauses interrupted execution", () => {
  const h = fixture();
  claimReviewContext(h.task.messages, "before-crash");
  const restored = restartSafeState(h.state).tasks[0],
    message = restored.messages[0];
  assert.equal(restored.run.state, "stopped");
  assert.equal(message.followupState, "paused");
  assert.equal(message.pickedUpAt, undefined);
  assert.equal(message.text, "Original instruction");
  assert.equal(
    h.message.pickedUpAt,
    "before-crash",
    "Restoration does not mutate the input snapshot",
  );
});
