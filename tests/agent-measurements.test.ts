import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentMeasurement } from "../runtime/agents/measurements";
import { modelFamily, publicModelId } from "../src/public-models";

test("cumulative native usage replaces prior totals; cache and reasoning remain subsets", () => {
  let measured = applyAgentMeasurement(
    undefined,
    {
      type: "measurement",
      model: { id: "gpt-6.1-terra", source: "codex-thread", effort: "medium" },
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 800,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 120,
        totalTokens: 1200,
        scope: "attempt",
        source: "codex-thread-total",
      },
    },
    "codex",
  );
  measured = applyAgentMeasurement(
    measured,
    {
      type: "measurement",
      usage: {
        inputTokens: 1500,
        outputTokens: 250,
        cachedInputTokens: 900,
        cacheCreationInputTokens: 50,
        reasoningOutputTokens: 150,
        totalTokens: 1750,
        scope: "attempt",
        source: "codex-thread-total",
      },
    },
    "codex",
  );
  assert.equal(measured.usage?.inputTokens, 1500);
  assert.equal(measured.usage?.totalTokens, 1750);
  assert.equal(measured.usage?.cachedInputTokens, 900);
  assert.equal(measured.modelId, "gpt-6.1-terra");
  assert.equal(measured.effort, "medium");
});
test("whole-tree usage supersedes main-loop fallback and reroutes do not invent effort", () => {
  const base = {
    inputTokens: 900,
    outputTokens: 50,
    cachedInputTokens: 800,
    cacheCreationInputTokens: 0,
  };
  let m = applyAgentMeasurement(
    undefined,
    {
      type: "measurement",
      model: { id: "claude-sonnet-5-5", source: "claude-assistant" },
      models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
      usage: { ...base, scope: "attempt", source: "claude-model-total" },
    },
    "claude",
  );
  m = applyAgentMeasurement(
    m,
    {
      type: "measurement",
      usage: {
        ...base,
        inputTokens: 100,
        scope: "main_loop",
        source: "claude-main-loop",
      },
    },
    "claude",
  );
  assert.equal(m.usage?.scope, "attempt");
  assert.equal(m.usage?.inputTokens, 900);
  assert.equal(m.modelIds.length, 2);
  const c = applyAgentMeasurement(
    {
      modelIds: ["gpt-6-luna"],
      modelId: "gpt-6-luna",
      modelSource: "codex-thread",
      effort: "low",
    },
    {
      type: "measurement",
      model: { id: "gpt-6.1-terra", source: "codex-rerouted" },
    },
    "codex",
  );
  assert.equal(c.effort, undefined);
  assert.deepEqual(c.modelIds, ["gpt-6-luna", "gpt-6.1-terra"]);
});
test("malformed counters never replace useful observations or become manufactured zeroes", () => {
  const base = applyAgentMeasurement(
    undefined,
    {
      type: "measurement",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 0,
        scope: "attempt",
        source: "cursor-stop-hook",
      },
    },
    "cursor",
  );
  const invalid = applyAgentMeasurement(
    base,
    {
      type: "measurement",
      usage: {
        inputTokens: NaN,
        outputTokens: -1,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        scope: "attempt",
        source: "cursor-stop-hook",
      },
    },
    "cursor",
  );
  assert.deepEqual(invalid.usage, base.usage);
  const inconsistent = applyAgentMeasurement(
    base,
    {
      type: "measurement",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 100,
        cacheCreationInputTokens: 20,
        reasoningOutputTokens: 9,
        totalTokens: 999,
        scope: "attempt",
        source: "cursor-stop-hook",
      },
    },
    "cursor",
  );
  assert.equal(inconsistent.usage?.cachedInputTokens, null);
  assert.equal(inconsistent.usage?.cacheCreationInputTokens, null);
  assert.equal(inconsistent.usage?.reasoningOutputTokens, null);
  assert.equal(inconsistent.usage?.totalTokens, null);
});
test("public model version allowlist preserves actual identifiers and excludes custom labels", () => {
  assert.equal(publicModelId("claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(modelFamily("claude-sonnet-5-5"), "sonnet");
  assert.equal(publicModelId("private-customer-model"), null);
  assert.equal(modelFamily("private-customer-model"), "other");
});
