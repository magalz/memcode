# MemCode context broker pilot

Claude story workers now receive one host-owned context gateway. The gateway advertises exactly `find`, `understand`, and `assess`. It cannot select arbitrary Memtrace tools or mutate Fleet state. The existing host still reserves scope, checks the shared epic branch, renews coordination, stops affected workers, records actual changes, and leaves human resolutions with the existing coordinator.

The first evidence pack is prepared before Claude starts. Further requests travel over MCP stdio to a token-bound loopback host session. The host supplies the worker identity, actual checkout, repository ID, branch, and visibility; the worker cannot replace these in a request. The gateway and runtime are bundled separately and shipped beside one another.

## Evidence and freshness

`find` uses scoped Memtrace hybrid search, resolves readable locations, and copies literal numbered excerpts from verified working files. `understand` requests exact symbol context and observed relationships. `assess` adds the existing preflight recipe for the selected declaration; its verification checklist remains a suggestion until a check actually runs. Ambiguous declarations produce selectable symbol/file candidates.

Every pack names Git HEAD, branch, dirty state, a content fingerprint of Git-visible files, the graph revision, graph source revision and alignment status. The host samples source and graph before and after retrieval. A source/graph change blocks acting on that pack. A stale or incomplete graph remains explicitly partial, even when a source excerpt can be verified. Excerpts carry the full file SHA-256 and actual line range. Junction/symlink escapes and paths outside configured visibility are rejected.

The fingerprint includes uncommitted changes and untracked Git-visible files, so two saves with the same `git status` still invalidate cached evidence. Files over 16 MiB cause an explicit revision-scan error; source excerpts reject binary files and files over 2 MiB. These are bounded pilot limits, not proof that larger repositories have complete coverage.

Only graph-ready retrieval evidence can be cached. Keys include repository, worker, branch, visibility, full source fingerprint, graph revision, normalized request, workflow version and optional model identity. Applicable `AGENTS.md` files and `governing_rules` are refreshed on every request. Cortex revisions are independent of graph revisions; rule content is hashed separately, including during continuation. Historical recall results are labelled ranked candidates with uncertain applicability. The broker does not infer that an unavailable rule/decision service means there are no constraints.

## Budgets and fallback

`budgetChars` bounds the serialized response, from 4,000 to 48,000 characters. The optional token figure is explicitly `ceil(characters / 4)` and is not provider usage. Essential constraints precede ranked evidence. If they do not fit, literal continuation pages block acting until all constraints have been read. A changed source, graph or rule snapshot invalidates the continuation. Omitted evidence and backend truncation remain visible.

The text fallback is part of `find`: select `mode: "text"`, an explicit narrow `scope`, and `fallbackReason` (`exact-string`, `generated-file`, or `incomplete-graph`). It performs bounded substring search over Git-visible files, reports scanned files and the reason, and proves no reachability. It scans at most 250 files and returns at most eight matches. `.git`, `.memcode`, dependencies and build-output trees are excluded. Generated Git-visible source such as `*.gen.ts` is eligible; ignored build artifacts require a later dedicated artifact reader.

Full diagnostic packs are retained locally under each worker's `.memcode/workers/<id>/context-diagnostics.jsonl`. Retrieval cache hits avoid backend work; evidence returned to a coding model still occupies context.

## Claude profile and control limits

The dedicated profile uses `--strict-mcp-config` and `--disable-slash-commands`, then exposes native `Bash`, `Read`, `Edit`, and `Write`. It keeps the normal user/project/local settings, authentication, project instructions, required hooks and managed policy. It does not use `--bare`, `--safe-mode`, a replacement home directory, or a stripped settings-source list. Managed policies can further restrict the available gateway; a profile is not allowed to bypass them.

Native Grep/Glob and the inherited full Memtrace catalog are absent in the measured Claude sessions. Bash and Read remain available for implementation and verification. They can also search/read files. This is a cooperative retrieval policy, not exclusive retrieval enforcement or a filesystem write fence. The host's coordination authority is independent of model turns.

The installed Claude help and [official CLI reference](https://code.claude.com/docs/en/cli-reference) establish those controls. The [settings documentation](https://code.claude.com/docs/en/settings) describes preserved setting sources. The live evaluation inspects startup tool/skill lists rather than assuming flags imply the intended session.

## Optional local helper

`settings.contextAssistant` selects an optional ONNX or loopback OpenAI-compatible helper. It defaults to disabled. ONNX accepts a configured installed `@huggingface/transformers` package directory containing the cached `onnx-community/Qwen2.5-Coder-0.5B-Instruct` q4 assets. No prior worktree path is a runtime dependency. The evaluation explicitly points at the previously installed dogfood cache.

ONNX runs in a separate process with two CPU inference threads, remote models disabled, and `local_files_only=true`. The pilot rejects any configured ONNX model other than the fixed Qwen model named above. It does not install packages or download models. Loopback HTTP endpoints must use a local host and cannot redirect. Timeouts, invalid JSON and invalid rankings fall back to deterministic retrieval. A model can add search terms or reorder existing candidate IDs; the host always retains the original query, validates IDs, copies source, preserves constraints, and keeps every Fleet decision. The [Transformers.js environment documentation](https://huggingface.co/docs/transformers.js/api/env) describes local-only model loading and cache configuration.

Fleet renewal starts immediately after reservation and continues during context preparation before transferring to the running process. Stop and close cancel preparation, terminate and await the optional helper, close the context session, drain its initial evidence request, and release the reservation after any renewal already in progress. A closed ONNX helper cannot start another child process.

## Validation and scope

Run `node --import tsx --test tests/context-broker.test.ts` for the isolated contract and real MCP gateway tests. The normal build invokes `scripts/build-context.mjs`; production requires `dist-runtime/context-gateway.cjs` beside `service.cjs`.

For bounded live tests, run `node --import tsx scripts/context-evaluate.ts --claude`, then repeat with `--case bug`. Set `MEMCODE_CONTEXT_TRANSFORMERS_DIR` only when testing the optional cached helper. The scripts create new temporary Git repositories, admit only each fixture in an explicit Memtrace manifest, disable watch restoration, and retain actual streams/diffs for review. They never run a worker in the user's source checkout. Acceptance assertions are run independently of the worker.

The two JSON reports distinguish provider input, cache creation, cache reads, output, reported USD, local tokenizer measurements, response-character estimates and latency. One bounded synthetic case per variant does not establish production savings, statistical significance, complete graph reachability or broad engineering quality. Native index parsing and Cortex applicability are separate coverage limits. The subsequent [Codex and Cursor coding evaluation](context-coding-results.md) adds 24 complete tasks with repeated baseline/broker comparisons and actual retrieval timing. Claude session isolation must not be inferred for either adapter.
