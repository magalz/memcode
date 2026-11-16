# MemCode

MemCode is an independent Tauri app. Official installers include a pinned,
separately licensed compiled Memtrace engine, staged during release packaging.
Do not copy the Memtrace backend source into this repository or commit generated
engine binaries. Keep managed engines separate from a user's global CLI setup.

## Product

- Visual quality is a first-prototype requirement. Use the benchmark-derived
  charcoal, paper, mint and cyan tokens in `src/styles.css`.
- Keep the board, conversation, runbook and artifact experience coherent.
- Keep execution, credentials, local repository bindings and approvals local.
  Personal projects stay local. Opt-in Team Sync may share planning, comments,
  activity and explicitly published results; source changes use Git in this
  preview. Cloud models may be used by an explicitly selected installed harness.
- Do not invent live workers, successful tests, metric values or confidence.
  The example project must remain visibly labelled as example data.
- A worker exit creates a review candidate, never an automatically verified change.

## Engineering

- Use Memtrace graph context for nontrivial discovery and impact when indexed.
  Follow results with bounded source reads. Index this repository, never its parent.
- Keep Node capabilities in the local runtime sidecar. Tauri owns native windows,
  dialogs and previews. Use the typed, validated stdio/Rust IPC boundary.
- Isolate browser/artifact content from the app and its preload.
- Never interpolate prompts into shell commands. Spawn with argument arrays.
- An epic owns one Git branch. Story workers share the project checkout on that
  branch and coordinate through Memtrace Fleet. Do not create per-worker branches
  or worktrees. Preserve shared changes on stop/failure. Pause affected workers
  and expose unresolved conflicts for a human decision.
- Prefer small modules and native APIs over extra frameworks.
- Run `npm run typecheck`, `npm test`, `npm run build` and the Tauri smoke
  check for relevant changes. Inspect the actual desktop UI for visual changes.

## Iteration

Use this app's own dogfood backlog to improve it. Keep a clear distinction
between functionality available now and planned correctness/policy hardening.
Never describe cooperative Fleet coordination as hard write fencing.
