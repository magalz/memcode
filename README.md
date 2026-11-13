# MemCode

**The local Fleet Agentic Worker Suite.** An independent Electron workspace for
planning work, talking to coding agents, and reviewing what they produce.
Memtrace supplies code intelligence and coordination through its installed MCP
server. Its backend is not copied into this repository.

## Run

Requires Node.js 22.12+ and Git.

```sh
npm install
npm run dev
```

For the compiled desktop app:

```sh
npm run build
npm start
```

The first launch opens a clearly labelled example workspace. Use **Add a project**
to choose an existing folder or start a new Git repository from a project brief.
MemCode then connects to the installed Memtrace engine to analyze it.

## The first working version

- A board and grouped list sharing one work-item model, with filtering and search.
- Project briefs, editable runbooks, conversations, worker status and change review.
- Native folder selection and project creation. State stays in Electron userData.
- Local CLI worker adapters for Codex, Claude Code and Amp, detected on PATH.
- A private Git worktree per work item; process-tree stop and preserved partial work.
- Memtrace MCP indexing, relevant-symbol context and measured quality/impact inputs.
- Cooperative Fleet preflight, declared feature intent and independent heartbeats.
- HTML/image previews in a sandboxed `WebContentsView` without the app preload.
- Artifact discovery under `.memcode/artifacts/`, text previews and browser screenshots.
- Dictation via an existing local whisper.cpp server; audio is converted to WAV locally.

Execution, project state, coordination and artifacts stay on this computer. A harness
may use its configured cloud model. Codex can alternatively use an installed Ollama
model; select local-model mode and its model name in Settings. MemCode does not
provide a hosted control plane or require a MemCode account.

## Engine and harness boundaries

Install/configure [Memtrace](https://memtrace.io/docs) separately. The app discovers
`memtrace` on PATH; Settings also accepts an absolute executable or JavaScript entry
point. It connects with the MCP SDK and scopes indexing to the selected repository.
Engine authentication and licensing remain Memtrace's responsibility.

The local Codex installation was used to verify its CLI contract. Claude and Amp
adapters are implemented but need conformance testing against installed versions;
they are not detected on the initial development machine. No cloud coding session
is launched merely by opening the app or creating a work item.

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
graph says so. The initial typed intent describes feature implementation; it is not
a post-diff semantic classification. Fleet is cooperative coordination, not hard
write fencing. Worktrees keep edits separate; the user owns integration.

The app is a single local owner with serialized atomic JSON persistence. Distributed
durability, calibrated model routing, enforced write leases, independent acceptance
checks and broader adapter validation are future iterations, tracked in the dogfood
backlog. See [the product brief](docs/PRODUCT.md) and [design rules](docs/DESIGN.md).

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
```

Tests use a fixture harness to exercise real Git worktrees and artifact collection
without calling a model. The desktop smoke test uses a separate temporary profile.

This is a separate local Git repository. No remote repository has been published;
an open-source license and release policy remain to be selected.
