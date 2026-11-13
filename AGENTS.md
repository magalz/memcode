# MemCode

MemCode is an independent Electron app. It uses the installed Memtrace engine;
do not copy the Memtrace backend into this repository.

## Product

- Visual quality is a first-prototype requirement. Use the benchmark-derived
  charcoal, paper, mint and cyan tokens in `src/styles.css`.
- Keep the board, conversation, runbook and artifact experience coherent.
- Keep project state, coordination, execution and artifacts local. Cloud models
  may be used by an explicitly selected installed harness.
- Do not invent live workers, successful tests, metric values or confidence.
  The example project must remain visibly labelled as example data.
- A worker exit creates a review candidate, never an automatically verified change.

## Engineering

- Use Memtrace graph context for nontrivial discovery and impact when indexed.
  Follow results with bounded source reads. Index this repository, never its parent.
- Keep Node capabilities in Electron main; expose typed, validated IPC methods.
- Isolate browser/artifact content from the app and its preload.
- Never interpolate prompts into shell commands. Spawn with argument arrays.
- Run workers in isolated Git worktrees; preserve patches on stop/failure.
- Prefer small modules and native APIs over extra frameworks.
- Run `npm run typecheck`, `npm test`, `npm run build` and the Electron smoke
  check for relevant changes. Inspect the actual desktop UI for visual changes.

## Iteration

Use this app's own dogfood backlog to improve it. Keep a clear distinction
between functionality available now and planned correctness/policy hardening.
Never describe cooperative Fleet coordination as hard write fencing.
