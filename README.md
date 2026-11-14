# MemCode

**The local Fleet Agentic Worker Suite.** An independent Tauri workspace for
planning work, talking to coding agents, and reviewing what they produce.
Memtrace supplies code intelligence and coordination through its installed MCP
server. Its backend is not copied into this repository.

## Run

Requires Node.js 22.12+ and Git. Native development/builds also require Rust and
Tauri prerequisites. Windows builds use MSVC Build Tools and installed WebView2.

```sh
npm install
npm run dev
```

For the compiled desktop app:

```sh
npm run build
npm run build:native
npm start
```

Development checkouts open the real MemCode dogfood project with **9 epics and 38
stories**. A separate **Design preview** project is clearly labelled as example data.
Use **Add a project**
to choose an existing folder or start a new Git repository from a project brief.
MemCode then connects to the installed Memtrace engine to analyze it.

## The first working version

- Board, grouped list, calendar and timeline views, with saved filters and grouping.
- Independently scrolling lanes, custom workflow states and advisory WIP limits.
- Cycles with explicit scope, manual points, capacity, start/finish and carryover.
- Recorded burndown/burnup, throughput and evidence-gated pace projections.
- Labels, child stories, related/duplicate links, custom fields and bulk edits.
- A persisted Now / Next / Later roadmap, epics, stories, source scope and cycle-checked prerequisites.
- Project briefs, editable runbooks, conversations, worker status and change review.
- Native folder selection and project creation. State stays in the local workspace
  directory (`%APPDATA%\MemCode` on Windows), preserving existing desktop data.
- Local CLI worker adapters for **Codex, Claude Code and Cursor Agent**, including Windows standalone/runtime discovery.
- Official bundled SVG marks with provenance in [adapter sources](public/adapters/SOURCES.md).
- Automatic routing to a concrete harness, model and reasoning effort, with manual overrides and visible reasons.
- One Git branch per epic, with story workers sharing the project folder.
- Memtrace Fleet scope reservations, intent heartbeats, overlap checks and a persisted human decision queue.
- Memtrace MCP indexing, relevant-symbol context and measured quality/impact inputs.
- Cooperative Fleet preflight, typed declared intent and independent heartbeats.
- Code Insights for quality, architecture, flows, APIs, history, style and governance.
- Improve checkpoints comparing compatible, revision-bound measurements over time.
- HTML/image previews in an isolated native WebView without the app RPC capability.
- Separate output folders under `.memcode/workers/<story-id>/artifacts/`, text previews and browser screenshots.
- Dictation via an existing local whisper.cpp server; audio is converted to WAV locally.

Execution, project state, coordination and artifacts stay on this computer. A harness
may use its configured cloud model. Codex can alternatively use an installed Ollama
model; select local-model mode and its model name in Settings. MemCode does not
provide a hosted control plane or require a MemCode account.

Tauri uses the operating system's WebView. A bundled Node service retains installed
harness and MCP integrations over private, validated stdio RPC. Node remains a
prerequisite. The app no longer bundles Chromium or Electron. The current native
build produces a local executable, not a signed installer.

## Engine and harness boundaries

Install/configure [Memtrace](https://memtrace.io/docs) separately. The app discovers
`memtrace` on PATH; Settings also accepts an absolute executable or JavaScript entry
point. It connects with the MCP SDK and scopes indexing to the selected repository.
Engine authentication and licensing remain Memtrace's responsibility.

If an existing Folder Group does not admit the selected repository, MemCode can
open an explicit, single-project index under `.memcode/memtrace/`. It keeps that
index separate from the existing workspace and exposes the binding in coverage
details; it does not reindex the parent directory.

All three local runtimes were detected on the development machine. Codex model IDs
come from its local model cache; Cursor models come from `--list-models`; Claude
supports its documented CLI aliases. Provider authentication, entitlements and actual
execution are confirmed at launch. Cross-provider conformance remains an explicit
roadmap story. Opening the app or creating a story never launches a coding session.

Automatic assignment uses AST cognitive/cyclomatic complexity, nesting, observed
primary-anchor blast radius, affected processes and module roots. Unknown values
remain unknown and block the fast tier. The four capability envelopes adapt the
previous orchestrator's policy; their thresholds and model-to-tier mappings are
**provisional**, not calibrated probabilities. Task length is not a complexity input.
The route records source/graph revisions and explains incomplete coverage.

Claude workers now have a [context broker pilot](docs/context-broker.md): three
small retrieval capabilities backed by host-run Memtrace workflows, literal
source, revision checks and preserved project constraints. Fleet remains under
host supervision. Settings also offers optional local retrieval assistance through
cached ONNX weights or a loopback model server. It starts disabled, uses no automatic
model downloads, and falls back to deterministic retrieval if assistance fails.
The [measured pilot results](docs/context-broker-results.md) include reproducible token/quality measurements and
explicit limits on shell-search control and other adapters.

For local speech, run a whisper.cpp server and set its `/inference` endpoint in
Settings. No speech model is bundled or automatically downloaded. The microphone
is activated only by the dictation control. Speech endpoints and browser addresses
are constrained to loopback; this prototype's browser is for local development and
artifacts, not general web browsing.

## An honest prototype boundary

A finished process creates an **In review** candidate. It never proves that tests
passed or automatically publishes a change. Review the actual diff and evidence.
There is no automatic Git merge, push or deployment.

Fleet scope comes from qualification seeds and is explicitly incomplete where the
graph says so. Typed intents describe the declared story category; refactor/fix
subtypes are coarse defaults, not a post-diff semantic classification. Story workers
share the epic branch and its files. The host acquires and renews Fleet reservations,
checks intent overlaps and polls escalations. Unresolved overlaps pause affected work
and appear in **Decisions**. A human can choose who proceeds or ask for reconciliation.
Decisions are recorded without resetting files or automatically restarting workers.
Fleet coordination depends on clients honoring the protocol; it is not hard filesystem
write fencing. The developer owns reconciliation and acceptance of shared changes.

The app is a single local owner with serialized atomic JSON persistence. Distributed
durability, calibrated model routing, authoritative write fencing, independent acceptance
checks and broader adapter validation are future iterations, tracked in the dogfood
backlog. See [the product brief](docs/PRODUCT.md) and [design rules](docs/DESIGN.md).

See [the planning comparison](docs/PLANNING.md) for the itsaplan reference and chart
semantics. Planning estimates are separate from measured routing complexity.
Historical delivery begins when MemCode records it; existing completed stories
are a baseline. Improve keeps missing metrics unknown and excludes stale or
incompatible captures from comparisons. Successive valid checkpoints build history;
a hotspot leaving the top results does not prove it was repaired.

## Dogfood

Open **MemCode → Roadmap**. Expand an epic, pick a ready story, and use **Plan
worker** to inspect its measured route. Commit existing project changes before
activating an epic branch, then launch story workers. Other workers on the same epic
join that branch. Finish or stop that fleet before switching this project to another
epic. Review each conversation, runbook and output alongside the **combined epic
diff**; a shared diff is not verified per-worker attribution. The next
bounded dogfood story adds routing regression tests. **Sync build plan** adds
missing stories without replacing edited briefs, dependencies or progress.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
```

Tests use fixture harnesses to exercise actual concurrent worker processes on one
epic branch, separate artifact ownership, overlap pausing and human resolution,
without calling a model. The desktop smoke test uses a temporary profile, the real
native WebView and a private test inspector. It checks preview isolation and RPC.

This is a separate local Git repository. No remote repository has been published;
an open-source license and release policy remain to be selected.
