import type { AgentEvent } from "./types";

type Measurement = Extract<AgentEvent, { type: "measurement" }>;
type Usage = NonNullable<Measurement["usage"]>;
type Counts = Pick<
  Usage,
  | "inputTokens"
  | "outputTokens"
  | "cachedInputTokens"
  | "cacheCreationInputTokens"
>;
type Frame = Record<string, any>;

const count = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1e9
    ? value
    : null;
const modelId = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
const sum = (values: Array<number | null>) =>
  values.some((value) => value === null)
    ? null
    : count(values.reduce<number>((total, value) => total + value!, 0));
const zeros = (): Counts => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
});
const unknown = (): Counts => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheCreationInputTokens: null,
});
const add = (a: Counts, b: Counts): Counts => ({
  inputTokens: sum([a.inputTokens, b.inputTokens]),
  outputTokens: sum([a.outputTokens, b.outputTokens]),
  cachedInputTokens: sum([a.cachedInputTokens, b.cachedInputTokens]),
  cacheCreationInputTokens: sum([
    a.cacheCreationInputTokens,
    b.cacheCreationInputTokens,
  ]),
});
const nonempty = (value: unknown): value is Frame =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0;
const mainLoop = (value: Frame): Counts => {
  const cachedInputTokens = count(value.cache_read_input_tokens),
    cacheCreationInputTokens = count(value.cache_creation_input_tokens);
  return {
    inputTokens: sum([
      count(value.input_tokens),
      cachedInputTokens,
      cacheCreationInputTokens,
    ]),
    outputTokens: count(value.output_tokens),
    cachedInputTokens,
    cacheCreationInputTokens,
  };
};
const modelTotals = (entries: Frame[]): Counts => {
  const rawInput = sum(entries.map((entry) => count(entry.inputTokens))),
    cachedInputTokens = sum(
      entries.map((entry) => count(entry.cacheReadInputTokens)),
    );
  const cacheCreationInputTokens = sum(
    entries.map((entry) => count(entry.cacheCreationInputTokens)),
  );
  return {
    inputTokens: sum([rawInput, cachedInputTokens, cacheCreationInputTokens]),
    outputTokens: sum(entries.map((entry) => count(entry.outputTokens))),
    cachedInputTokens,
    cacheCreationInputTokens,
  };
};

/** Native result.modelUsage is a running whole-tree total, not a delta.
 * result.usage covers the main loop's current turn only. Assistant output-token
 * counts are placeholders and are deliberately never used here.
 * https://code.claude.com/docs/en/agent-sdk/cost-tracking
 */
export class ClaudeMeasurements {
  private models = new Set<string>();
  private primary?: string;
  private treeBase = zeros();
  private treeCurrent?: Counts;
  private loop = zeros();
  private seenResults = new Set<string>();
  private usage?: Usage;
  private emitted?: string;

  observe(frame: Frame): Measurement | undefined {
    if (frame.type === "conversation_reset") {
      if (this.treeCurrent)
        this.treeBase = add(this.treeBase, this.treeCurrent);
      else if (this.usage) this.treeBase = unknown();
      this.treeCurrent = undefined;
      return undefined;
    }
    const assistant =
      frame.type === "assistant" && frame.parent_tool_use_id == null;
    const started =
      frame.type === "stream_event" &&
      frame.parent_tool_use_id == null &&
      frame.event?.type === "message_start";
    if (!assistant && !started && frame.type !== "result") return undefined;
    if (assistant) this.responseModel(frame.message?.model);
    if (started) this.responseModel(frame.event.message?.model);
    if (frame.type === "result") {
      const tree =
        nonempty(frame.modelUsage) && Object.keys(frame.modelUsage).length <= 64
          ? frame.modelUsage
          : undefined;
      if (tree)
        for (const name of Object.keys(tree)) {
          const id = modelId(name);
          if (id && this.models.size < 64) this.models.add(id);
        }
      const values = tree
        ? Object.values(tree).map((value) => (nonempty(value) ? value : {}))
        : undefined;
      const cumulative = values ? modelTotals(values) : undefined;
      const main = nonempty(frame.usage) ? mainLoop(frame.usage) : undefined;
      // A crash result may zero all counters even after requests consumed tokens.
      // This is unknown, not evidence that the task used no tokens.
      const crashZero =
        frame.subtype === "error_during_execution" &&
        [cumulative, main]
          .filter(Boolean)
          .every((value) =>
            Object.values(value!).every((number) => number === 0),
          );
      if (main && !crashZero) {
        const resultId =
          modelId(frame.uuid) ??
          JSON.stringify([frame.session_id, frame.result_index, frame.usage]);
        if (!this.seenResults.has(resultId)) {
          this.seenResults.add(resultId);
          if (this.seenResults.size > 1024)
            this.seenResults.delete(this.seenResults.values().next().value!);
          this.loop = add(this.loop, main);
        }
      }
      if (crashZero) {
        this.usage = {
          ...unknown(),
          scope: tree ? "attempt" : "main_loop",
          source: tree ? "claude-model-total" : "claude-main-loop",
        };
      } else if (cumulative) {
        this.treeCurrent = cumulative;
        this.usage = this.withTotal(
          add(this.treeBase, cumulative),
          "attempt",
          "claude-model-total",
        );
      } else if (main) {
        this.usage = this.withTotal(this.loop, "main_loop", "claude-main-loop");
      }
    }
    const event: Measurement = {
      type: "measurement",
      ...(this.primary
        ? { model: { id: this.primary, source: "claude-assistant" as const } }
        : {}),
      ...(this.models.size ? { models: [...this.models] } : {}),
      ...(this.usage ? { usage: { ...this.usage } } : {}),
    };
    if (!event.model && !event.models && !event.usage) return undefined;
    const key = JSON.stringify(event);
    if (key === this.emitted) return undefined;
    this.emitted = key;
    return event;
  }

  private responseModel(value: unknown) {
    const id = modelId(value);
    if (!id) return;
    this.primary = id;
    if (this.models.size < 64) this.models.add(id);
  }
  private withTotal(
    value: Counts,
    scope: Usage["scope"],
    source: Usage["source"],
  ): Usage {
    const total = sum([value.inputTokens, value.outputTokens]);
    return {
      ...value,
      scope,
      source,
      ...(total === null ? {} : { totalTokens: total }),
    };
  }
}
