/** Derive the comparison from retained provider usage, protocol audits and independent checks. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const parse = (text) =>
  text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const sum = (rows, key) =>
  rows.every((row) => Number.isFinite(row[key]))
    ? rows.reduce((total, row) => total + row[key], 0)
    : null;
const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2);
  return ordered.length
    ? ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2
    : null;
};
const number = (value) =>
  value === null ? "unknown" : value.toLocaleString("en-US");
const delta = (baseline, broker) =>
  baseline > 0 && broker !== null ? 100 * (broker / baseline - 1) : null;
const change = (value) =>
  value === null
    ? "unknown"
    : `${Math.abs(value).toFixed(1)}% ${value <= 0 ? "fewer" : "more"}`;
const fullPass = (worker) =>
  worker.code === 0 &&
  !worker.timedOut &&
  worker.quality.independent.passed &&
  worker.quality.existingTestsPassed &&
  worker.quality.scopePreserved &&
  worker.quality.branchPreserved &&
  worker.quality.headPreserved &&
  worker.quality.hostConfigPreserved;
const sources = await Promise.all(
  ["codex", "cursor"].map(async (harness) =>
    JSON.parse(await readFile(`docs/context-coding-${harness}.json`, "utf8")),
  ),
);
const summaries = [];
for (const source of sources) {
  const rows = [];
  for (const worker of source.workers) {
    const usage = worker.usage;
    const input =
      source.harness === "codex" ? usage?.input_tokens : usage?.inputTokens;
    const cacheRead =
      source.harness === "codex"
        ? usage?.cached_input_tokens
        : usage?.cacheReadTokens;
    const cacheWrite =
      source.harness === "codex"
        ? usage?.cache_write_input_tokens
        : usage?.cacheWriteTokens;
    const output =
      source.harness === "codex" ? usage?.output_tokens : usage?.outputTokens;
    const readTotal =
      source.harness === "codex"
        ? input
        : [input, cacheRead, cacheWrite].every(Number.isFinite)
          ? input + cacheRead + cacheWrite
          : null;
    const uncached =
      source.harness === "codex"
        ? Number.isFinite(input) && Number.isFinite(cacheRead)
          ? input - cacheRead
          : null
        : input;
    const events = parse(await readFile(worker.artifacts.stream, "utf8"));
    const native = { reads: 0, grep: 0, glob: 0, shell: 0, shellSearch: 0 };
    const otherMcpCalls = [];
    const nativeSearches = [];
    for (const event of events) {
      let command;
      if (
        source.harness === "cursor" &&
        event.type === "tool_call" &&
        event.subtype === "started"
      ) {
        const call = event.tool_call ?? {};
        if (call.mcpToolCall) {
          const args = call.mcpToolCall.args;
          if (
            args.serverIdentifier !==
            (worker.variant === "broker" ? "memcode-context" : "memtrace")
          )
            otherMcpCalls.push({
              server: args.serverIdentifier,
              tool: args.toolName,
            });
        }
        if (call.readToolCall) native.reads++;
        if (call.grepToolCall) {
          native.grep++;
          nativeSearches.push({ kind: "grep", args: call.grepToolCall.args });
        }
        if (call.globToolCall) {
          native.glob++;
          nativeSearches.push({ kind: "glob", args: call.globToolCall.args });
        }
        if (call.shellToolCall) {
          native.shell++;
          command = call.shellToolCall.args?.command;
        }
      } else if (
        source.harness === "codex" &&
        event.type === "item.completed" &&
        event.item?.type === "command_execution"
      ) {
        native.shell++;
        command = event.item.command;
      }
      if (
        source.harness === "codex" &&
        event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call" &&
        event.item.server !==
          (worker.variant === "broker" ? "memcode_context" : "memtrace")
      )
        otherMcpCalls.push({
          server: event.item.server,
          tool: event.item.tool,
        });
      if (
        command &&
        /\b(rg|grep|findstr|Select-String|Get-ChildItem)\b/i.test(command)
      ) {
        native.shellSearch++;
        nativeSearches.push({ kind: "shell", command });
      }
    }
    const successful = worker.retrieval.successfulBeforeFirstEdit;
    rows.push({
      id: worker.id,
      case: worker.case,
      variant: worker.variant,
      repetition: worker.repetition,
      readTotal,
      input,
      uncached,
      cacheRead,
      cacheWrite,
      output,
      latencyMs: worker.latencyMs,
      passed: fullPass(worker),
      patchSha256: createHash("sha256")
        .update(await readFile(worker.artifacts.diff))
        .digest("hex"),
      assertions: worker.quality.independent,
      calls: worker.retrieval.calls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
      retrievalBeforeEdit: successful,
      callerContextBeforeEdit: successful.some((name) =>
        ["understand", "assess"].includes(name),
      ),
      assessmentBeforeEdit: successful.includes("assess"),
      toolErrors: worker.retrieval.responses.filter(
        (response) => response.isError || response.error,
      ).length,
      native,
      otherMcpCalls,
      nativeSearches,
      artifacts: worker.artifacts,
    });
  }
  const groups = ["baseline", "broker"].map((variant) => {
    const group = rows.filter((row) => row.variant === variant);
    return {
      variant,
      runs: group.length,
      passed: group.filter((row) => row.passed).length,
      readTotal: sum(group, "readTotal"),
      uncached: sum(group, "uncached"),
      cacheRead: sum(group, "cacheRead"),
      cacheWrite: sum(group, "cacheWrite"),
      output: sum(group, "output"),
      medianLatencyMs: median(group.map((row) => row.latencyMs)),
      callerContextBeforeEdit: group.filter(
        (row) => row.callerContextBeforeEdit,
      ).length,
      assessmentBeforeEdit: group.filter((row) => row.assessmentBeforeEdit)
        .length,
      successfulRetrievalBeforeEdit: group.filter(
        (row) => row.retrievalBeforeEdit.length > 0,
      ).length,
      toolErrors: sum(group, "toolErrors"),
      native: Object.fromEntries(
        Object.keys(group[0]?.native ?? {}).map((key) => [
          key,
          group.reduce((total, row) => total + row.native[key], 0),
        ]),
      ),
    };
  });
  const pairs = [];
  for (const row of rows.filter((row) => row.variant === "baseline")) {
    const broker = rows.find(
      (other) =>
        other.variant === "broker" &&
        other.case === row.case &&
        other.repetition === row.repetition,
    );
    if (broker)
      pairs.push({
        case: row.case,
        repetition: row.repetition,
        baselineRead: row.readTotal,
        brokerRead: broker.readTotal,
        changePercent: delta(row.readTotal, broker.readTotal),
        identicalPatch: row.patchSha256 === broker.patchSha256,
      });
  }
  summaries.push({
    harness: source.harness,
    model: source.model,
    complete: rows.length === source.repetitions * 4,
    groups,
    aggregateReadChangePercent: delta(groups[0].readTotal, groups[1].readTotal),
    pairs,
    rows,
    excludedSetupAttempts:
      source.setupAttempts?.map((worker) => ({
        id: worker.id,
        reason: worker.excludedReason,
        usage: worker.usage,
        artifacts: worker.artifacts,
      })) ?? [],
    preparationFailures: source.preparationFailures ?? [],
    error: source.error ?? null,
  });
}
const summary = { at: new Date().toISOString(), summaries };
await writeFile(
  "docs/context-coding-summary.json",
  JSON.stringify(summary, null, 2) + "\n",
);
const lines = [
  "# Codex and Cursor: complete coding-task comparison",
  "",
  "Measured locally on 14 November 2026. The tasks and initial source match the earlier Claude pilot: an optional discount/signature change and a zero-quantity bug fix. Each harness runs three fresh sessions per task and profile, with alternating profile order. The baseline exposes full Memtrace; the treatment exposes the MemCode gateway. This compares against a Memtrace-enabled setup, not a bare harness.",
  "",
  "No task-specific evidence is preloaded and no fixed tool-call sequence is requested. Normal native search/read/edit/test tools and inherited skills remain available. Unrelated MCP services are disabled through local/per-call configuration; user authentication, settings and managed policies are retained. The optional local retrieval model is disabled in both profiles.",
  "",
  "## Observed results",
  "",
  "Read total is the complete task's emitted input accounting, including cache reads. For Codex it is `input_tokens`; `cached_input_tokens` is a subset and is not added twice. For Cursor it is explicitly defined here as `inputTokens + cacheReadTokens + cacheWriteTokens`, with all raw counters retained. These counters are not a verified invoice and are not used to compare one provider's prices with another's.",
  "",
  "| Harness / model | Full Memtrace read total | MemCode read total | Change | Independent task passes (baseline / MemCode) | MemCode caller context / impact before edit |",
  "|---|---:|---:|---:|---:|---:|",
];
for (const s of summaries) {
  const [baseline, broker] = s.groups;
  lines.push(
    `| ${s.harness} / ${s.model} | ${number(baseline.readTotal)} | ${number(broker.readTotal)} | ${change(s.aggregateReadChangePercent)} | ${baseline.passed}/${baseline.runs} / ${broker.passed}/${broker.runs} | ${broker.callerContextBeforeEdit}/${broker.runs} / ${broker.assessmentBeforeEdit}/${broker.runs} |`,
  );
}
lines.push(
  "",
  "## Usage, latency and retrieval",
  "",
  "Uncached input and output remain separate from cached input. Differences in cache reuse, model choices and number of turns can change savings and cost; cache state was not reset between sessions. No significance interval is claimed for these small, synthetic tasks.",
  "",
);
for (const s of summaries) {
  const [baseline, broker] = s.groups;
  lines.push(
    `### ${s.harness}`,
    "",
    "| Profile | Uncached input | Cache read | Cache write | Output | Median worker seconds | Retrieval tool errors |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...s.groups.map(
      (group) =>
        `| ${group.variant} | ${number(group.uncached)} | ${number(group.cacheRead)} | ${number(group.cacheWrite)} | ${number(group.output)} | ${group.medianLatencyMs === null ? "unknown" : (group.medianLatencyMs / 1000).toFixed(3)} | ${group.toolErrors} |`,
    ),
    "",
    "| Task | Repetition | Baseline read total | MemCode read total | Change |",
    "|---|---:|---:|---:|---:|",
    ...s.pairs.map(
      (pair) =>
        `| ${pair.case} | ${pair.repetition} | ${number(pair.baselineRead)} | ${number(pair.brokerRead)} | ${change(pair.changePercent)} |`,
    ),
    "",
    `MemCode completed retrieval before the first source edit in ${broker.successfulRetrievalBeforeEdit}/${broker.runs} coding runs. Caller/change context (understand or assess) preceded editing in ${broker.callerContextBeforeEdit}/${broker.runs}; assess itself preceded editing in ${broker.assessmentBeforeEdit}/${broker.runs}. A timestamped transparent stdio audit and host diagnostics support these counts. This is observed adoption under the configured routing policy, not shell-search enforcement.`,
    "",
    `Native tool counts, baseline: ${JSON.stringify(baseline.native)}. MemCode: ${JSON.stringify(broker.native)}. Native search can support literal verification and does not by itself imply that graph retrieval was skipped.`,
    "",
  );
}
lines.push(
  "## Code quality and scope",
  "",
  "The independent verifier runs after each worker exits. It checks 28 assertions for the signature task and 23 for the bug task, plus the original test suite. Checks cover caller forwarding, backward compatibility, DKK, zero/null/missing quantities, cents rounding, invalid discount rates, boundary rates and input immutability. It also checks permitted edit files, unexpected untracked files, unchanged branch/HEAD and unchanged host configuration. Worker exit code alone is never counted as quality success.",
  "",
  "Passing these contracts supports no observed correctness regression on these fixtures. It does not demonstrate higher general engineering quality, production-scale savings, or complete static reachability. Raw diffs are retained for review; no invented quality score is assigned.",
  "",
  "## Launch issues retained outside the comparison",
  "",
  "Initial invalid MCP configurations are retained as setup attempts. Cursor ignored an invalid project server map and fell back to global servers; those attempts did not reach the intended gateway. Codex initially rejected incomplete disabled transport entries. A later Codex launch reached retrieval but inherited the desktop parent's registered Core identity, causing shell startup and sandboxed writes to fail. Those incomplete executions are retained with their token usage and are excluded from completed coding-task comparisons.",
  "",
  "The process fix removes only `CODEX_WINDOWS_REGISTERED_CORE` and `CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY` from standalone child environments. It retains the configured sandbox, permissions profile, authentication, settings and managed policy. A native sandbox probe successfully wrote/read a disposable fixture file after that correction. No global configuration was edited to run this evaluation.",
  "",
  "## Reproduction and evidence",
  "",
  "```powershell",
  "node scripts/build-runtime.mjs",
  "node --import tsx scripts/context-coding-evaluate.ts --harness codex --repetitions 3",
  "node --import tsx scripts/context-coding-evaluate.ts --harness cursor --repetitions 3",
  "node scripts/context-coding-report.mjs",
  "```",
  "",
  "Add `--resume` to continue a saved run. Reports: `context-coding-codex.json`, `context-coding-cursor.json` and `context-coding-summary.json`. Each worker entry names retained local streams, timed events, the protocol audit, host context diagnostics and its actual diff. The old directed conformance report remains separate.",
  "",
  "These are benchmark profiles using the actual installed harnesses and bundled MemCode gateway. They do not silently migrate the production Codex/Cursor worker launch paths to the broker.",
  "",
  "Provider reference: [Codex non-interactive JSONL events](https://learn.chatgpt.com/docs/non-interactive-mode), [Cursor CLI output formats](https://cursor.com/docs/cli/reference/output-format), [Cursor per-project permissions](https://cursor.com/docs/cli/reference/permissions).",
  "",
);
await writeFile("docs/context-coding-results.md", lines.join("\n"));
console.log(
  JSON.stringify(
    summaries.map((s) => ({
      harness: s.harness,
      complete: s.complete,
      groups: s.groups,
      changePercent: s.aggregateReadChangePercent,
    })),
    null,
    2,
  ),
);
