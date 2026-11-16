import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { publicModelId } from "../src/public-models";
const numeric = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2e9
    ? v
    : null;
const pick = (record: any, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, numeric(record?.[k])]));
/** QA-only native counter evidence. Content/session/auth fields are never retained. */
export function nativeMeasurementAudit(raw: any): object | null {
  if (
    raw?.type === "native-token-usage" &&
    ["codex", "cursor"].includes(raw.harness)
  )
    return {
      type: raw.type,
      harness: raw.harness,
      modelId: publicModelId(raw.modelId),
      ...pick(raw, [
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
        "cacheWriteInputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "reasoningOutputTokens",
        "totalTokens",
      ]),
    };
  if (
    raw?.type !== "result" ||
    !raw.modelUsage ||
    typeof raw.modelUsage !== "object" ||
    Array.isArray(raw.modelUsage)
  )
    return null;
  const entries = Object.entries(raw.modelUsage)
    .slice(0, 16)
    .map(([id, value]) => ({
      modelId: publicModelId(id),
      ...pick(value, [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
      ]),
    }));
  return { type: "native-token-usage", harness: "claude", modelUsage: entries };
}
export function createMeasurementAudit(
  root: string,
  taskId: string,
  runId: string | undefined,
) {
  const enabled =
    process.env.MEMCODE_NATIVE_TEST_PROFILE === "1" &&
    process.env.MEMCODE_TELEMETRY_TEST_CHANNEL === "1";
  let tail = Promise.resolve(),
    count = 0;
  return {
    observe(raw: unknown) {
      if (!enabled || count >= 32) return;
      const safe = nativeMeasurementAudit(raw);
      if (!safe) return;
      ++count;
      tail = tail
        .catch(() => {})
        .then(async () => {
          const dir = join(root, ".memcode", "workers", taskId);
          await mkdir(dir, { recursive: true });
          await appendFile(
            join(dir, `measurement-audit-${runId ?? "unknown"}.jsonl`),
            JSON.stringify(safe) + "\n",
            { mode: 0o600 },
          );
        });
    },
    flush: () => tail.catch(() => {}),
  };
}
