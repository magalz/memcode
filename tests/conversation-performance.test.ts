import test from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../src/shared.ts";
import {
  followsConversationTail,
  sameDisplayedMessage,
  toolMessageParts,
} from "../src/conversation-performance.ts";

test("collapsed tool output exposes only its summary and expansion retains exact output", () => {
  const body = "a large tool result\n".repeat(50_000);
  const text = "Context retrieval result\n" + body;
  assert.deepEqual(toolMessageParts(text, false), {
    summary: "Context retrieval result",
    body: undefined,
  });
  assert.equal(toolMessageParts(text, true).body, body);
  assert.equal(
    toolMessageParts("status without a newline", true).body,
    "status without a newline",
  );
});

test("unchanged messages survive snapshot cloning while visible changes invalidate them", () => {
  const message: Message = {
    id: "message-one",
    role: "assistant",
    text: "Completed the implementation.\n\n- The tests pass.",
    at: "2026-11-15T01:00:00.000Z",
    followupState: "queued",
  };
  const received: Message = JSON.parse(JSON.stringify(message));
  assert.equal(sameDisplayedMessage(message, received), true);
  assert.equal(
    sameDisplayedMessage(message, {
      ...received,
      promptedAt: "2026-11-15T01:01:00.000Z",
    }),
    true,
    "brief inclusion metadata does not change the rendered message",
  );
  for (const patch of [
    { text: "The implementation failed verification." },
    { pickedUpAt: "2026-11-15T01:01:00.000Z" },
    { followupState: "cancelled" as const },
    { reviewText: "Changed wording" },
    { commentIds: ["a-different-comment"] },
  ]) {
    assert.equal(
      sameDisplayedMessage(message, { ...received, ...patch }),
      false,
    );
  }
});

test("changed review anchors invalidate a message even when its text is unchanged", () => {
  const message: Message = {
    id: "review-message",
    role: "user",
    text: "Please revise this.",
    at: "2026-11-15T01:00:00.000Z",
    references: [
      {
        taskId: "task-one",
        kind: "file",
        name: "notes.md",
        quote: "original wording",
      },
    ],
  };
  const received: Message = JSON.parse(JSON.stringify(message));
  assert.equal(sameDisplayedMessage(message, received), true);
  received.references![0].quote = "different wording";
  assert.equal(sameDisplayedMessage(message, received), false);
});

test("incoming conversation updates follow the tail only while the reader remains near it", () => {
  assert.equal(
    followsConversationTail({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    }),
    true,
  );
  assert.equal(
    followsConversationTail({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2350,
    }),
    true,
  );
  assert.equal(
    followsConversationTail({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 1100,
    }),
    false,
  );
  assert.equal(
    followsConversationTail({
      scrollHeight: 300,
      clientHeight: 600,
      scrollTop: 0,
    }),
    true,
  );
});
