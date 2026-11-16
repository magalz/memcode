# Measuring routing outcomes

The question is: **which model requests produce accepted work for a comparable,
measured scope, and how much execution and rework do they require?** These are
observational product records. They do not establish that a model is the best
choice, or prove that accepted code is correct.

## Outcomes have different meanings

- An attempt begins when a coding harness actually launches. Preparation failures
  must not become model-performance samples.
- A process finishing records an execution outcome. Exit zero is not human
  acceptance or a successful test suite.
- Human acceptance is an explicit local Done action linked to a recorded attempt
  and its corresponding change revision. Unlinked completions remain separate.
- Reopening accepted work is a later rework signal. It does not identify the cause
  of the rework, and should retain the original accepted-attempt relationship.
- A follow-up can add new requirements. It is not automatically a rejection.
- First-attempt acceptance requires complete captured attempt history. Enabling
  reporting on an existing story cannot establish its earlier history.

Accepted shares must show their denominator and pending/unlinked review counts.
Unknown outcomes are not successes or failures. Structured verification and token
counts are usable only when the adapter actually reports them; prose such as
“tests passed” is not structured verification.

## Compare scope, not just the selected tier

Freeze source measurements at attempt start: scoped AST cognitive and cyclomatic
maxima, nesting, observed impact and process counts, scope size and index-alignment
state. Preserve partial coverage, unknowns and lower bounds. Do not substitute a
repository-wide hotspot or a post-edit measurement for the planned scope.

The `memcode-envelope-v2` tier is a routing policy output with provisional
thresholds. Incomplete evidence can still select a balanced-or-higher model, so
that selection is not proof of measured complexity. Partial and unknown evidence
need their own cohorts. Source paths, symbol names, branches and revision hashes
are unnecessary for these comparisons and must not be transmitted.

Distinguish requested models from models confirmed by structured harness output.
Keep manual versus automatic selection, policy version and originating app
version. Queueing across an upgrade must not relabel old events as the new build.
Custom or unrecognized model names use a fixed non-content bucket.

Show sample counts and measurement/model coverage beside comparisons. Wall-clock
duration includes machine, tool and human waits; it is not pure model latency.
Router selection, task mix and review delays can bias comparisons. This feature
collects evidence for later investigation; it does not automatically alter routing
policy or declare a winning model.

## Planning and privacy

Locally authored entity transitions measure creation, deletion, completion and
reopening. Incoming Team synchronization must not count as another locally
authored transition. Workspace snapshots describe the reporting local replica;
summing replicas does not yield globally unique Team stories or projects.

Reporting is optional and off until explicitly enabled. Ordinary local use and
worker execution remain available without reporting. Disabling it discards
pending local records. Example projects and QA traffic stay out of production
aggregates, and historical outcomes are not fabricated or backfilled.

The transport accepts a versioned allowlist of numeric values, enums and opaque
reporting references. It must never receive story/epic/cycle text, prompts,
conversations, code, file paths, branches, commands, raw errors, provider-session
identifiers, artifact content or arbitrary metadata objects. Reporting references
are separate from the original work-item identifiers.

Authenticated reporting is content-free and pseudonymous, not a promise of
anonymity from the service operator. Its write permission has its own token
purpose; engine and Team identity proofs cannot substitute for it. Credentials
remain in the host runtime and must not reach renderers, harnesses or terminals.
