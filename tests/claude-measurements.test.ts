import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeMeasurements } from "../runtime/agents/claude-measurements";

const tokens = (
  inputTokens = 10,
  outputTokens = 20,
  cacheReadInputTokens = 30,
  cacheCreationInputTokens = 40,
) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheCreationInputTokens,
});
const result = (modelUsage: Record<string, unknown>, extra = {}) => ({
  type: "result",
  subtype: "success",
  modelUsage,
  ...extra,
});

test("Claude reports response model rather than configured init model and keeps helper models separate", () => {
  const meter = new ClaudeMeasurements();
  assert.equal(
    meter.observe({
      type: "system",
      subtype: "init",
      model: "configured-opus",
    }),
    undefined,
  );
  assert.equal(
    meter.observe({
      type: "assistant",
      parent_tool_use_id: "child-task",
      message: { model: "helper-haiku" },
    }),
    undefined,
  );
  assert.equal(
    meter.observe({
      type: "assistant",
      message: { model: "claude-sonnet-4-6" },
    })?.model?.id,
    "claude-sonnet-4-6",
  );
  const event = meter.observe(
    result({
      "claude-sonnet-4-6": tokens(),
      "claude-haiku-4-5-20251001": tokens(1, 2, 3, 4),
    }),
  );
  assert.equal(event?.model?.id, "claude-sonnet-4-6");
  assert.deepEqual(event?.models, [
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ]);
  assert.deepEqual(event?.usage, {
    inputTokens: 88,
    outputTokens: 22,
    cachedInputTokens: 33,
    cacheCreationInputTokens: 44,
    scope: "attempt",
    source: "claude-model-total",
    totalTokens: 110,
  });
});

test("whole-tree totals replace earlier snapshots and repeated parallel tool frames do not double count", () => {
  const meter = new ClaudeMeasurements();
  meter.observe({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 9999 },
      },
    },
  });
  for (let i = 0; i < 5; i++)
    meter.observe({
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 9999 },
      },
    });
  const first = meter.observe(result({ "claude-sonnet-4-6": tokens() }));
  assert.equal(first?.usage?.outputTokens, 20);
  assert.equal(
    meter.observe(result({ "claude-sonnet-4-6": tokens() })),
    undefined,
  );
  const later = meter.observe(
    result({ "claude-sonnet-4-6": tokens(15, 25, 35, 45) }),
  );
  assert.equal(later?.usage?.inputTokens, 95);
  assert.equal(later?.usage?.outputTokens, 25);
});

test("main-loop fallback is labelled, sums unique turns and never pretends to include subagents", () => {
  const meter = new ClaudeMeasurements(),
    usage = {
      input_tokens: 2,
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 5,
    };
  const frame = { type: "result", subtype: "success", uuid: "result-1", usage };
  assert.equal(meter.observe(frame)?.usage?.inputTokens, 11);
  assert.equal(meter.observe(frame), undefined);
  const second = meter.observe({ ...frame, uuid: "result-2" });
  assert.deepEqual(second?.usage, {
    inputTokens: 22,
    outputTokens: 6,
    cachedInputTokens: 8,
    cacheCreationInputTokens: 10,
    scope: "main_loop",
    source: "claude-main-loop",
    totalTokens: 28,
  });
});

test("cache categories missing or malformed stay unknown rather than becoming zero or leaking cost fields", () => {
  const meter = new ClaudeMeasurements();
  const event = meter.observe(
    result({
      "claude-sonnet-4-6": {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: -1,
        costUSD: 9.5,
      },
    }),
  );
  assert.deepEqual(event?.usage, {
    inputTokens: null,
    outputTokens: 3,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    scope: "attempt",
    source: "claude-model-total",
  });
  assert.equal(JSON.stringify(event).includes("costUSD"), false);
  assert.equal(
    meter.observe(
      result({ "claude-sonnet-4-6": tokens(Number.MAX_SAFE_INTEGER) }),
    )?.usage?.inputTokens,
    null,
  );
});

test("zeroed crash counters invalidate usage instead of reporting a free successful task", () => {
  const meter = new ClaudeMeasurements();
  meter.observe(result({ "claude-sonnet-4-6": tokens() }));
  const event = meter.observe(
    result(
      { "claude-sonnet-4-6": tokens(0, 0, 0, 0) },
      { subtype: "error_during_execution", is_error: true },
    ),
  );
  assert.equal(event?.usage?.inputTokens, null);
  assert.equal(event?.usage?.outputTokens, null);
});

test("explicit conversation resets preserve prior whole-tree spend within the same attempt", () => {
  const meter = new ClaudeMeasurements();
  meter.observe(result({ "claude-sonnet-4-6": tokens() }));
  meter.observe({
    type: "conversation_reset",
    new_conversation_id: "new-conversation",
  });
  const event = meter.observe(
    result({ "claude-sonnet-4-6": tokens(1, 2, 3, 4) }),
  );
  assert.equal(event?.usage?.inputTokens, 88);
  assert.equal(event?.usage?.outputTokens, 22);
});
