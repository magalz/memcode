# Worker browser, terminal and artifact conformance

Observed on Windows with the installed Codex, Claude Code and Cursor CLIs,
2026-11-14. These are real worker runs, separate from the unit-test fixture harnesses.

## Three workers, one epic branch

The Live Browser Lab ran all three providers in the same checkout on
`epic/ep-01-68c1f22547`. Each produced its own interactive HTML demo, SVG poster,
Markdown report and saved output. The follow-up runs also produced an Excel
workbook (Codex), a Word creative brief (Claude Code) and a two-slide PowerPoint
deck (Cursor). All three Office outputs rendered in the isolated native reader.

The shared-file test made every worker append its own participant to the same
array. Later workers adopted the earlier published plan and reread the source
after handoff. The final array contained all three participants, with no open
semantic human conflicts. Each card's checkpoint showed its own one-line addition
and one-line deletion, rather than the combined branch diff.

## Shared browser and persistent terminal

Each provider started a persistent development server through the MemCode
terminal capability and opened that server through the card's browser capability.
The user and worker operated the same browser page. Earlier interaction tests
submitted notes through the rendered page; the workers read those notes, changed
the heading, replied and published their outputs.

The final terminal check sent a fresh, unpredictable marker after each server
started, using the same terminal input API as the card. Every real worker then
observed the session output and quoted its marker in its report. The host audit
confirmed observation occurred after input. This final round was API-driven input,
not a claim that a human typed on the keyboard; native keyboard input had a
separate desktop check. All three workers used their managed browser, captured
real screenshots, passed the lab's three independent assertions and left their
server sessions running.

The recorded server ports were 57195 (Codex), 58415 (Claude Code) and 57201
(Cursor). Ports and process IDs are observations from this run, not product defaults.
Sessions belong to the running application; restarting it stops those processes.

## Why managed sessions

The adapters preserve the distinction between short shell tool calls and a
persistent interactive process. Short searches, tests and one-shot commands stay
in tool history. Development servers, watchers and REPLs use an owned PTY that
both the worker and card can observe and write to.

Relevant primary references:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) exposes command execution and process interaction.
- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) documents background task controls and output.
- [Cursor terminal tools](https://cursor.com/docs/agent/tools/terminal) and [hooks](https://cursor.com/docs/hooks) describe its terminal integration surface.
- [Windows pseudoconsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole) supplies the native Windows PTY boundary.

This does not attach to every private terminal or browser a vendor might start
outside the managed capabilities. The worker profile directs persistent sessions
and browser interaction through MemCode so the card and worker share actual state.

## Review interaction checks

The native review test covers 17 groups: file and artifact links, source line
selection, Word text, Excel cell ranges, PDF selection/navigation/zoom, native
video/audio playback and seeking, timestamps, diff and terminal selections,
HTML elements/areas, editable-field offsets, save-without-send, persistent
highlights and explicit selected-comment sharing. Fixtures are labelled; the
Office files came from real worker output.

A separate live check reopened the user's existing PowerPoint comments, verified
both highlights, clicked a pin to open its saved note, and checked that focusing
the comment kept the complete target text within the resized preview.

The evidence is generated locally, outside this repository:

- `../memcode-browser-lab/.memcode/evidence/verified-lab.json`
- `../memcode-browser-lab/.memcode/evidence/user-presentation-annotations.json`
- `../tmp/memcode-review/review-interactions/results.json`

These tests establish the exercised Windows workflows. They do not establish
unlimited agent capacity, native macOS/Linux parity, pixel-perfect Office editing,
hard filesystem write fencing or a universal token saving. The separate
[context coding comparison](context-coding-results.md) contains the measured
Codex/Cursor token results and its two-task quality limits.
