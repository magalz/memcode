# Bounded context broker evaluation

Six complete Claude Code fixture tasks passed independent acceptance: two distinct cases across the full Memtrace baseline, deterministic broker, and broker with cached local assistance. This is evidence that the pilot works on those tasks. It does not establish statistical savings or broad engineering quality.

Claude Code 2.1.323 resolved the `haiku` alias to **claude-haiku-5-5**. The baseline startup reported **129 tools and 104 skills**. Broker sessions reported **7 tools and 0 skills**: four native tools and three gateway capabilities. The full Memtrace server advertised 99 tools, whose serialized catalog was 189,146 characters. Catalog characters are not provider token usage; Claude can defer schemas through ToolSearch.

## Exact provider usage

Values below are the CLI's final aggregate usage for the complete coding task. `Read total` is defined as `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Output is shown separately. Reported USD is the CLI's emitted list-basis estimate, not an independently verified invoice.

| Case | Variant | Input | Cache creation | Cache read | Read total | Output | Reported USD | Worker seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Signature | Full baseline | 12 | 32,624 | 236,652 | 269,288 | 3,404 | 0.01059452 | 37.699 |
| Signature | Deterministic broker | 10 | 26,963 | 88,217 | 115,190 | 3,042 | 0.00779677 | 31.669 |
| Signature | Broker + local | 8 | 25,767 | 75,437 | 101,212 | 3,314 | 0.00756557 | 32.878 |
| Zero quantity bug | Full baseline | 8 | 37,814 | 152,780 | 190,602 | 2,417 | 0.01029990 | 29.809 |
| Zero quantity bug | Deterministic broker | 6 | 23,434 | 44,320 | 67,760 | 2,306 | 0.00628360 | 25.949 |
| Zero quantity bug | Broker + local | 10 | 21,755 | 94,076 | 115,841 | 1,977 | 0.00628126 | 27.155 |

Worker seconds measure CLI launch through exit. They exclude fixture/index preparation and the fixed retrieval probes performed before launch. The local helper's preparation overhead is listed below. These measurements therefore do not establish a full host-preparation-to-completion latency improvement. Provider usage covers every model turn in each task, including cached input; it is not limited to the final answer or a retrieval call.

The signature case added optional discounts across `total` and `makeReceipt`. Independent assertions checked old one-argument behavior, forwarding, finite 0..1 validation, RangeError, DKK and cents rounding. The bug case fixed a zero-quantity line charged as one item. Independent assertions checked zero, null and missing quantities, caller behavior, DKK and rounding. All six passed the existing fixture tests and preserved allowed source files. Actual diffs and raw streams remain under the temporary roots named in the JSON reports.

## Local helper use and limits

The reused model was **onnx-community/Qwen2.5-Coder-0.5B-Instruct**, q4, from an existing Transformers.js 4.3.2 cache. Its ONNX file is 862,087,110 bytes. Remote loading was disabled and all model files were local. No model/package download was performed. The app accepts a configured installed package directory and does not depend on this evaluation worktree path.

The signature case accepted its query plan and recorded **2,007.590 ms** helper preparation time, including cold startup. Planning used 61 tokenizer-counted input tokens and six retokenized output tokens. Ranking also ran in that revision, but separate ranking usage was not retained by its earlier instrumentation; its exact token count is unknown.

The bug case accepted both planning and ranking, with **3,655.711 ms** combined helper preparation time including cold startup. The local tokenizer counted 61 planning input tokens and 625 ranking input tokens; generated text retokenized to six and seven tokens respectively. These are local tokenizer measurements, not provider billing. Neither case reported a rejected plan or ranking. `understand` and `assess` do not call the helper; their old default telemetry label `fallback` meant no helper request, not a rejection. Current code labels that state `not-requested` explicitly.

The helper did not improve every observed metric: the bug case used more aggregate cached/read context with local assistance than deterministic retrieval. With one sample per case/variant, the differences can reflect normal coding-model variation. The evidence does not justify enabling local assistance by default. Deterministic retrieval remains the default and fallback.

## Other adapters and packaging

Read-only conformance used the actual bundled `dist-runtime/context-gateway.cjs`. **Codex gpt-6-luna** and **Cursor composer-2.5** each successfully invoked `find`, `understand` and `assess`. Host diagnostics recorded all three requests; the tracked fixture diff remained unchanged. These are interoperability checks, not complete-task quality comparisons.

Codex completed in 17.483 seconds and reported input_tokens 125,875, cached_input_tokens 104,960 and output_tokens 443. Cursor completed in 20.366 seconds and reported inputTokens 30,174, cacheReadTokens 23,424 and outputTokens 1,100. Their provider-specific fields have different semantics and are retained without cross-provider aggregation or a fabricated USD estimate.

Codex's per-call server map added the gateway, but inherited app/plugin MCP startup was still observed, including an unrelated failed localhost handshake. Its catalog/skills isolation is not certified. Cursor needed explicit fixture-local `Mcp(server:tool)` permissions in addition to `--approve-mcps`; it retained global tools and skills. The production worker integration is the Claude pilot. Codex/Cursor production launch paths remain unchanged. Native Read/Bash can bypass cooperative retrieval; no adapter is described as a hard shell or write fence.

The ONNX child program is a fixed inline string in `runtime/context/onnx.ts`, included by the service bundle. It needs no third helper resource: the packaged runtime files are `service.cjs` and `context-gateway.cjs`. Native ONNX/package/model assets come from the explicitly configured existing package directory.

## Reproduction and coverage

```powershell
node scripts/build-runtime.mjs
node --import tsx --test tests/context-broker.test.ts
$env:MEMCODE_CONTEXT_TRANSFORMERS_DIR = 'C:/path/to/installed/@huggingface/transformers'
node --import tsx scripts/context-evaluate.ts --claude
node --import tsx scripts/context-evaluate.ts --claude --case bug
node --import tsx scripts/context-adapter-evaluate.ts
```

`context-broker-evaluation.json` and `context-broker-evaluation-bug.json` retain actual usage, models, startup catalogs, quality results and fixture paths. `context-broker-adapters.json` retains adapter conformance. `context-broker.md` documents the contracts and operational limits.

Fourteen isolated tests exercise dirty-save invalidation, independent governance refresh, graph revision changes, branch changes, ambiguity, source changes during lookup, constraints spanning budget pages, continuation invalidation, explicit text fallback, stale declarations, visibility, local-model failure and the real three-tool stdio/HTTP gateway. They also reject a mismatched ONNX model and verify preparation-time renewal plus cancellation/close: the optional fake helper exits, the endpoint closes, pending renewal completes before final release, and no coding process launches. Semantic embedding was deliberately skipped in the fixture index. Historical decision applicability and complete reachability are not established by these synthetic tasks and remain explicit unknowns.
