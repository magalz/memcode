# Reviewing the work in MemCode

## Save annotations, then send a follow-up

Saving a comment creates a local annotation. It does not add a conversation
message, call a model or start a worker. Highlights and numbered comment pins
remain in the preview after reopening or reloading it. Clicking a pin opens the
saved comment and its quoted target.

Use **Review comments** to edit or delete unsent notes, select the comments to
include, and choose **Add to follow-up**. This stages attachments in the composer;
it still does not send them. The normal send action sends that follow-up and
starts an available idle worker. If a run is active, the message is saved; resume
the worker after that run finishes to apply it. Unread follow-ups are retained in
the next brief even when the active worker produces a long conversation.
Comments already added to a conversation remain in its review history. The same
workflow applies to Codex, Claude Code and Cursor; review does not select or
replace the card's assigned harness.

This follows the distinction in the official Codex workflows: save inline or
visual comments, then send a separate instruction to address them:

- [Codex code review](https://learn.chatgpt.com/docs/code-review?surface=app)
- [Browser annotation mode](https://learn.chatgpt.com/docs/browser#comment-on-the-page)

## Targets

| Surface           | Saved target                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Markdown and Word | Exact quote, surrounding text, text offsets, document page when present                                                     |
| PDF               | Page, exact text position and quote; native-resolution canvas plus selectable text layer                                    |
| Source file       | File, selected line or text range, version and quote                                                                        |
| Changes           | Worker checkpoint, file, old/new side and line range                                                                        |
| Spreadsheet       | Workbook, worksheet and cell range such as `A2:B3`                                                                          |
| HTML artifact     | DOM selector, element or normalized area inside that element, and selected text                                             |
| Editable field    | DOM selector, field character offsets and text lines; character geometry is measured without replacing or editing the field |
| Terminal          | Owned session ID, output row/column positions and quoted output                                                             |
| Video/audio       | File and playback timestamp                                                                                                 |

Source versions and exact quotes travel to the worker with the explicit
follow-up. The conversation displays compact source references instead of raw
absolute paths and version strings. Existing comments created by the earlier
conversation-based UI are migrated into visible annotation history without
deleting their messages.

Text offset anchors are checked against the quote. An offset that no longer
matches falls back only to a unique literal match. Ambiguous or removed text is
not assigned a guessed highlight. Comments on another page or worksheet become
visible when that page or sheet is selected. These are MemCode annotations;
they do not rewrite Word/PDF/Excel files into a proprietary review format.

## File links and previews

Conversation links resolve to the owning card's saved artifact or a readable
project file, including editor-style line suffixes. Web links open that card's
Browser immediately. Opening a URL already in that card selects its existing
tab and preserves page state. A stopped local server produces a readable error
in Browser. A link cannot restart an arbitrary command by itself.

Artifacts remain separate from live browser tabs. Readers are loaded on demand:
Markdown, Word, Excel, PowerPoint, PDF, source text, images, video and audio.
Office previews show saved content, not a complete Office editing engine. The
spreadsheet view shows stored values; it does not recalculate formulas.

PDF uses PDF.js with a device-scale canvas, text layer, page controls, fit/zoom,
font/CMap/image support and password entry. Media uses native playback controls
and HTTP byte ranges for seeking; large media is not buffered into the React
app or sidecar. Codec support follows the system browser. Preview limits are
25 MB for document/text assets, 250 MB for PDF and 4 GB for media. Office ZIP
expansion is separately bounded.

## Boundaries and verification

The guest receives a private read-only file capability and a narrow selection
transport. It never receives the desktop bridge. Selection events can open a
draft; only the main app saves or shares annotations. Annotation updates use one
scoped event stream rather than polling every agent. Project paths are resolved
and checked after following filesystem links.

`scripts/review-smoke.mjs` runs actual Tauri/WebView2 checks in a disposable
profile. It verifies file links, source lines, Word, Excel ranges, PDF selection
and navigation, native video/audio playback, timestamps, diff and terminal
comments, HTML element/area selection, field offsets, persistent highlights,
save-without-send, explicit sharing and same-card web navigation. Local viewer
fixtures are labelled separately from the Office files created in real harness
runs. `tests/review-comments.test.ts` also verifies persistence, editing,
ownership, migration and explicit sharing without worker invocation.

Native browser checks cover real selection, clipboard, input, nested/page
scrolling, popups, isolated storage, background capture, concurrent startup and
RPC liveness. The desktop observations in this iteration are Windows checks.
They do not establish native UI parity on macOS or Linux.
