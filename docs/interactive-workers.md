# Interactive worker sessions

MemCode uses each installed harness's native interactive protocol rather than
closing a one-shot prompt's stdin:

| Harness     | Transport                                  | Input returned to                                      |
| ----------- | ------------------------------------------ | ------------------------------------------------------ |
| Codex       | app-server JSON-RPC                        | Original server request / active turn                  |
| Claude Code | Bidirectional stream JSON control protocol | Original control request / active session              |
| Cursor      | Agent Client Protocol (ACP)                | Original JSON-RPC permission, question or plan request |

Questions and permissions appear at the top of the story card with a **Waiting
for you** state. Offered approval decisions remain harness decisions; MemCode
does not add an automatic force/skip-permissions mode. Answers go to the waiting
session immediately. They do not become queued follow-ups. Stale, cancelled,
wrong-story or wrong-run replies are refused. Secret answers are returned to the
native session but redacted from persisted workspace history and renderer drafts.

Codex's installed default-mode question capability is enabled for the MemCode
process only. The installed version otherwise hides that tool outside planning
mode. Existing global configuration is preserved. Cursor CLI model aliases are
matched to the same model and effort in advertised ACP selectors; unavailable
variants produce an explicit error instead of a silent model substitution.

Worker status distinguishes tool work, waiting for the developer, Fleet handoff
and final result collection. Tool failures are visible as they happen. The old
generic “continuing implementation” status no longer hides the last observed
activity or an extended period without updates. A new attempt clears the prior
attempt's exit code and session identifier. Queue delivery is marked at the
actual prompt boundary after protocol initialization.

## The Cursor stall

In the Lishuai-test-2 incident, Cursor installed dependencies, started Next.js and
tested browser controls after its last visible assistant message. MemCode's
one-shot parser discarded Cursor tool events, including repeated MCP screenshot
timeouts. Claude then waited behind Cursor's earlier Fleet reservation. The
captured tool results did not show a pending human approval or question.

Native verification also reproduced a related hidden-page actionability failure:
hidden WebView2 pages did not produce the frames needed by some Playwright input
checks. Worker actions now briefly paint the same page outside the client area,
without taking focus or showing another card's page. Native captures and same-page
CDP fallback are bounded. If both fail, DOM observations remain available with an
explicit no-image diagnostic.

## Verification

- All three transports have child-process protocol fixtures for exact request IDs,
  answer/decision mapping, cancellation, invalid replies and logical completion.
- Actual installed Codex and Claude Code completed native question and approval
  round-trips. The harmless approved command was Node's version check.
- Actual Cursor ACP permission cancellation was observed. Questions and plan
  responses have protocol-fixture coverage; the model did not produce a native
  question during the bounded real probes. No stronger live claim is made.
- Native MemCode UI verification selected a radio answer, sent it, inspected the
  exact command, chose Allow once, and observed the same session/run finish.
- Native browser verification covered hidden/visible animated pages, typing and
  clicking, another card's responsiveness and a forced native-failure/CDP fallback.
- Story, epic and cycle deletion passed through the actual UI. Source byte hashes
  were unchanged. Epic/cycle deletion keeps their stories; active workers block
  deletion before mutation.

Evidence is saved outside the repository under `../tmp/memcode-interaction-ui/`,
`../tmp/memcode-browser-capture/` and the labelled native harness probe folders.
The UI test script retains earlier assertion-only failures alongside the final
passing run. No user project was used for these tests.
