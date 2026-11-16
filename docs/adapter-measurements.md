# Adapter measurements

MemCode records native measurements with their source and scope. A requested
model is a routing decision; it is not evidence that the harness used that model.
Missing measurements remain unknown. They must not become zero or estimates.

## Current native sources

| Adapter | Model evidence | Token evidence |
| --- | --- | --- |
| Codex | App-server thread response and `model/rerouted` notifications | `thread/tokenUsage/updated.tokenUsage.total`, cumulative for the owned thread |
| Claude Code | Assistant response model metadata; result model list | Native result `modelUsage` totals; `usage` fallback is explicitly main-loop-only |
| Cursor | ACP acknowledged model selection (`configOptions.currentValue`, or the legacy acknowledged model setter) | Not reported by the tested ACP implementation; stored as unknown |

Canonical input tokens include cache reads and cache creation. Cache fields are
subsets of input, not additional totals. Output includes any reported reasoning
subset. Claude's separate uncached/cache input counters are combined once;
Codex's native total input is used directly. Cumulative snapshots replace prior
snapshots. They are not summed as if every notification represented new usage.

`attempt` describes the observed worker pass. `main_loop` warns that child-agent
usage is not included or not proven included. Native completion is separate from
code correctness: MemCode's recorded checks and human review provide the result
evidence. A successful harness exit alone does not prove that a task is solved.

## Cursor ACP limitation

Tested installed version: **2026.11.13-eacade1** (Windows). These implementation
findings describe that version, not a guarantee about other Cursor releases.

- ACP `session/prompt` returns a stop reason but no native token totals. The
  session presenter discards internal turn-ended and model-call-completed
  measurements instead of forwarding them to the ACP client.
- Native turn-ended counters exist internally. ACP does not expose them through
  a usage notification or result metadata in this version.
- ACP loads hook configuration, but its new/load-session paths discard the
  lifecycle hook executor. Configuring a `stop` hook therefore did not recover
  usage. Tool hooks and lifecycle completion hooks are different paths.
- The persisted session state contains context-window occupancy, completed-turn
  counts and run metadata. Those fields are not billable input/output usage and
  cannot replace it.
- The acknowledged model selection is now captured. `Auto`/`default` remains
  unknown because a routing policy does not identify the internally served
  model. ACP's omitted internal reroute events also limit this evidence.

These conclusions were checked against the installed implementation without
redistributing vendor source. An upstream fix could forward the internal native
usage into ACP updates/result metadata, or wire the lifecycle completion hooks.

The public SDK has native usage events, but its documented local headless mode
does not preserve this adapter's interactive approvals/questions. MemCode keeps
ACP's working controls rather than silently changing execution behavior for a
token number. No global histories are scanned, and context occupancy is never
presented as token consumption.

Cursor profiles now keep native ACP session stores, project data and caches
private to the worker. Authentication, rules and user settings remain inherited.
An existing exact inherited session-store link is detached without deleting its
target data.

## Validation performed

Before the final full-app QA pass, four bounded real Cursor ACP coding probes
implemented a small parser. All four passed an independent edge-case oracle;
none reported native usage. Two additional tiny `READY` inference diagnostics
also produced no usage. They were diagnostics, not additional coding-quality
samples. Local request-ID commands then verified configuration loading and the
new acknowledged-model capture without another model call.

The failed hook approach and its temporary project-hook machinery were removed.
The production adapter does not install an unproved usage observer or wait for a
missing hook. Model selection, approvals, questions, cancellation and MCP behavior
remain covered by the adapter tests. Full-app QA must report Cursor usage as
unknown until a supported native source is available.

## Primary references

- [Cursor ACP](https://cursor.com/docs/cli/acp)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor TypeScript SDK and usage semantics](https://cursor.com/docs/sdk/typescript)
- [Claude Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Codex app-server](https://developers.openai.com/codex/app-server/)

Official documentation describes the public interfaces. The specific Cursor ACP
omissions above were established through local implementation inspection and
real probes; they are not claims that the public docs promise those omissions.
