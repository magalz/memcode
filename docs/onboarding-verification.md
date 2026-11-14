# Onboarding and collaboration verification

Verified on Windows on 2026-11-14 using a separate native Tauri profile and a
temporary Git repository. The user's running demo profile was not mutated.

## Native flow

`scripts/onboarding-smoke.mjs` exercises Docs → guided setup → project → an
explicit, initially unchecked Codex connection approval → epic → first story.
Creating a story from its brief alone enables Create, derives the title from the
first line, preserves the full brief, and attaches the chosen epic. Neither story
creation nor worker connection starts a coding model. Cycles are optional.

The same check exercises Markdown story discussion, replies, author-owned edits
and deletion. These discussions remain separate from worker prompts. A queued
follow-up is held by an unfinished prerequisite, edited, and cancelled. Attached
review-note wording can also be edited before pickup. No coding model was run by
this UI check. Real fixture processes separately verify pickup races, failure
recovery, and automatic continuation for all three adapters.

## Local speech

`scripts/test-local-dictation.ts` verifies the pinned official whisper.cpp CPU
runtime and multilingual Whisper Tiny against a prerecorded upstream speech
fixture. One measured inference took 333 ms for approximately 11 seconds of audio;
this is one local observation, not a latency guarantee.

`scripts/speech-native-check.mjs` then uses explicit native Settings setup and a
labelled synthetic microphone stream from the same WAV. It exercises the actual
MediaRecorder → local WAV encoding → loopback model → conversation draft path.
The expected transcript appears, no message is sent, and all recording tracks end.
A simulated microphone denial shows an actionable error without losing the draft.
This verifies the recording path; it does not claim to test the user's room
microphone or real operating-system permission interaction.

Generated evidence lives outside the repository in
`../tmp/memcode-onboarding/` and `../tmp/memcode-speech-evidence/`.

## Account boundary

MemCode delegates to Memtrace's installed CLI/session and official HTTPS claim
flow. Status parsing and the native claim URL boundary have unit coverage. The
test did not sign the user in, copy tokens, or invent a human identity from a valid
license. A supported authenticated-person API is still needed for future
multiplayer identity; see [account and workers](account-and-workers.md).

## New project bootstrap

The Lishuai-test incident exposed an empty folder opened as an existing project:
there was no Git baseline and no attached Memtrace owner. An empty selected folder
now gets the same README, Git ignore rules and initial commit as a fresh project.
Nonempty folders without Git remain untouched and receive an actionable error.
Concurrent analysis requests share one preparation; Start waits for preparation.

Cold MCP owner errors are handled separately from wrong-store and authentication
errors. Recovery starts only the selected project's exact one-member headless
workspace, reuses reachable owners and closes only children MemCode spawned.
The real installed CLI proof used a labelled pending-owner injection, then an
actual headless start, MCP analysis and process cleanup. Borrowed-owner survival
and owned-owner shutdown both passed. On this installed CLI, an initialized Git
repository can also self-bootstrap from MCP, which was separately observed.

The native terminal passes the prepared PATH explicitly, because Windows PTYs
can otherwise rebuild it from registry values and omit Git. Unit checks verify
that only PATH and the card identifiers are forwarded, without copying private
service environment values. These changes passed the full 149-test suite.
