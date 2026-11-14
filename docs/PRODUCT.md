# MemCode: Fleet Agentic Worker Suite

MemCode is an independent local Tauri app built around a scrum-inspired work
board. A work item owns its brief, runbook, conversation, worker attempt, changes
and artifacts. Memtrace provides the understanding underneath the experience.

## Two starting points

**Existing code:** choose a folder, analyze it with Memtrace, describe an outcome,
then run coordinated story workers on one shared epic branch.

**New idea:** choose a location, describe the project, create the initial brief and
runbook, then iteratively turn that into working software. Dictation is another
way to write the brief, not a separate product flow.

## Implementation boundary

React renders the workspace. A narrow Tauri bridge exposes validated IPC. Rust owns
native windows, folder dialogs and isolated preview WebViews. A bundled local Node
service owns project files, persistence, process launches and Memtrace MCP.
Installed harnesses own model execution; the app normalizes their observable output.
The browser never receives the desktop bridge.

An epic owns a branch. Its story workers share the project folder on that branch.
Memtrace Fleet supplies intent, scope reservations, conflict classification and
escalation. Unresolved overlaps pause the fleet and enter the human decision queue.
Changes remain in place; recording a decision does not reset files or automatically
resume a worker. A project switches epic branches only when its fleet is quiet and
the existing changes have been handled.

There is no mandatory cloud service and no MemCode account. Cloud model use is
optional through a user's harness. Transcription uses a loopback speech server.

## Dogfood loop

Open the MemCode repository as a project. Use Memtrace to examine it. Improve the
app through small work items, inspect the produced change, and record what the
iteration taught us. Keep the experience useful while gradually strengthening its
evidence and execution contracts.

Suggested next work items:

1. Extract the heaviest UI and IPC functions using measured source impact.
2. Add host-run verification receipts bound to candidate revisions.
3. Qualify actual diffs and refine Fleet intents instead of reusing scope seeds.
4. Conformance-test each harness, cancellation and resume behavior.
5. Make routing explainable in shadow mode before optimizing model selection.
6. Improve voice onboarding and offer a managed local speech model installation.
7. Add authoritative acceptance fencing before automated parallel integration.

The product should earn trust through useful changes and an excellent workflow.
It should not claim deterministic task difficulty, guaranteed correctness, or
unlimited safe concurrency.
