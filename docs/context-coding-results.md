# Codex and Cursor: complete coding-task comparison

Measured locally on 14 November 2026. The tasks and initial source match the earlier Claude pilot: an optional discount/signature change and a zero-quantity bug fix. Each harness runs three fresh sessions per task and profile, with alternating profile order. The baseline exposes full Memtrace; the treatment exposes the MemCode gateway. This compares against a Memtrace-enabled setup, not a bare harness.

No task-specific evidence is preloaded and no fixed tool-call sequence is requested. Normal native search/read/edit/test tools and inherited skills remain available. Unrelated MCP services are disabled through local/per-call configuration; user authentication, settings and managed policies are retained. The optional local retrieval model is disabled in both profiles.

## Observed results

Read total is the complete task's emitted input accounting, including cache reads. For Codex it is `input_tokens`; `cached_input_tokens` is a subset and is not added twice. For Cursor it is explicitly defined here as `inputTokens + cacheReadTokens + cacheWriteTokens`, with all raw counters retained. These counters are not a verified invoice and are not used to compare one provider's prices with another's.

| Harness / model | Full Memtrace read total | MemCode read total | Change | Independent task passes (baseline / MemCode) | MemCode caller context / impact before edit |
|---|---:|---:|---:|---:|---:|
| codex / gpt-6-luna | 1,838,247 | 1,317,438 | 28.3% fewer | 6/6 / 6/6 | 6/6 / 6/6 |
| cursor / composer-2.5 | 1,005,516 | 923,805 | 8.1% fewer | 6/6 / 6/6 | 6/6 / 6/6 |

## Usage, latency and retrieval

Uncached input and output remain separate from cached input. Differences in cache reuse, model choices and number of turns can change savings and cost; cache state was not reset between sessions. No significance interval is claimed for these small, synthetic tasks.

### codex

| Profile | Uncached input | Cache read | Cache write | Output | Median worker seconds | Retrieval tool errors |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 187,943 | 1,650,304 | 0 | 8,590 | 42.175 | 2 |
| broker | 116,542 | 1,200,896 | 0 | 7,441 | 41.653 | 0 |

| Task | Repetition | Baseline read total | MemCode read total | Change |
|---|---:|---:|---:|---:|
| signature | 1 | 336,714 | 279,208 | 17.1% fewer |
| signature | 2 | 253,260 | 204,444 | 19.3% fewer |
| signature | 3 | 346,308 | 188,553 | 45.6% fewer |
| bug | 1 | 195,859 | 208,780 | 6.6% more |
| bug | 2 | 309,972 | 222,778 | 28.1% fewer |
| bug | 3 | 396,134 | 213,675 | 46.1% fewer |

MemCode completed retrieval before the first source edit in 6/6 coding runs. Caller/change context (understand or assess) preceded editing in 6/6; assess itself preceded editing in 6/6. A timestamped transparent stdio audit and host diagnostics support these counts. This is observed adoption under the configured routing policy, not shell-search enforcement.

Native tool counts, baseline: {"reads":0,"grep":0,"glob":0,"shell":22,"shellSearch":8}. MemCode: {"reads":0,"grep":0,"glob":0,"shell":12,"shellSearch":3}. Native search can support literal verification and does not by itself imply that graph retrieval was skipped.

### cursor

| Profile | Uncached input | Cache read | Cache write | Output | Median worker seconds | Retrieval tool errors |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 198,220 | 807,296 | 0 | 16,990 | 33.274 | 22 |
| broker | 194,397 | 729,408 | 0 | 13,885 | 28.535 | 6 |

| Task | Repetition | Baseline read total | MemCode read total | Change |
|---|---:|---:|---:|---:|
| signature | 1 | 181,055 | 200,805 | 10.9% more |
| signature | 2 | 205,632 | 129,449 | 37.0% fewer |
| signature | 3 | 171,946 | 192,567 | 12.0% more |
| bug | 1 | 151,007 | 158,225 | 4.8% more |
| bug | 2 | 147,547 | 113,605 | 23.0% fewer |
| bug | 3 | 148,329 | 129,154 | 12.9% fewer |

MemCode completed retrieval before the first source edit in 6/6 coding runs. Caller/change context (understand or assess) preceded editing in 6/6; assess itself preceded editing in 6/6. A timestamped transparent stdio audit and host diagnostics support these counts. This is observed adoption under the configured routing policy, not shell-search enforcement.

Native tool counts, baseline: {"reads":32,"grep":16,"glob":9,"shell":11,"shellSearch":0}. MemCode: {"reads":24,"grep":12,"glob":9,"shell":10,"shellSearch":0}. Native search can support literal verification and does not by itself imply that graph retrieval was skipped.

## Code quality and scope

The independent verifier runs after each worker exits. It checks 28 assertions for the signature task and 23 for the bug task, plus the original test suite. Checks cover caller forwarding, backward compatibility, DKK, zero/null/missing quantities, cents rounding, invalid discount rates, boundary rates and input immutability. It also checks permitted edit files, unexpected untracked files, unchanged branch/HEAD and unchanged host configuration. Worker exit code alone is never counted as quality success.

Passing these contracts supports no observed correctness regression on these fixtures. It does not demonstrate higher general engineering quality, production-scale savings, or complete static reachability. Raw diffs are retained for review; no invented quality score is assigned.

## Launch issues retained outside the comparison

Initial invalid MCP configurations are retained as setup attempts. Cursor ignored an invalid project server map and fell back to global servers; those attempts did not reach the intended gateway. Codex initially rejected incomplete disabled transport entries. A later Codex launch reached retrieval but inherited the desktop parent's registered Core identity, causing shell startup and sandboxed writes to fail. Those incomplete executions are retained with their token usage and are excluded from completed coding-task comparisons.

The process fix removes only `CODEX_WINDOWS_REGISTERED_CORE` and `CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY` from standalone child environments. It retains the configured sandbox, permissions profile, authentication, settings and managed policy. A native sandbox probe successfully wrote/read a disposable fixture file after that correction. No global configuration was edited to run this evaluation.

## Reproduction and evidence

```powershell
node scripts/build-runtime.mjs
node --import tsx scripts/context-coding-evaluate.ts --harness codex --repetitions 3
node --import tsx scripts/context-coding-evaluate.ts --harness cursor --repetitions 3
node scripts/context-coding-report.mjs
```

Add `--resume` to continue a saved run. Reports: `context-coding-codex.json`, `context-coding-cursor.json` and `context-coding-summary.json`. Each worker entry names retained local streams, timed events, the protocol audit, host context diagnostics and its actual diff. The old directed conformance report remains separate.

These are benchmark profiles using the actual installed harnesses and bundled MemCode gateway. They do not silently migrate the production Codex/Cursor worker launch paths to the broker.

Provider reference: [Codex non-interactive JSONL events](https://learn.chatgpt.com/docs/non-interactive-mode), [Cursor CLI output formats](https://cursor.com/docs/cli/reference/output-format), [Cursor per-project permissions](https://cursor.com/docs/cli/reference/permissions).
