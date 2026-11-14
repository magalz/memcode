# Account and worker connections

MemCode uses the session managed by the installed Memtrace CLI. It does not
create a second account, read or copy the Memtrace credential file, or expose
license keys and session tokens to the renderer.

The host reads `memtrace status --json`. A running owner's session state can
establish an existing Memtrace connection; a standalone default `Valid` state
without an owner does not establish a user identity. Explicit sign-in delegates
to `memtrace auth login`, accepts only its official HTTPS `/claim?code=...` URL,
and opens that claim in the system browser through a narrow native action. The
user completes Memtrace's existing sign-in flow. A successful official login
fast path also works before a local owner has started.

There is no `memtrace auth status` command: in the current CLI it falls through
to login. MemCode never calls it. It also never runs global `auth logout` as a
side effect of disconnecting a worker.

## Identity boundary

The current Memtrace `AuthState` and stored credential shape contain session,
edition and optional organization/seat principal fields. The current public
status interface does not expose a general signed-in person's account ID,
display name or email. A valid license/session must not be labelled as a verified
person. MemCode shows that distinction in account details, and only supplies a
Memtrace author principal when the CLI actually reports one. Otherwise comments
use an honest local author. Future multiplayer needs a supported authenticated
Memtrace principal interface; local consent receipts are not multiplayer auth.

## Worker approval

An installed or signed-in provider is not automatically connected to MemCode.
The user opens Connect, reviews the execution and context scope, checks the
approval box and explicitly approves. The host validates an existing sign-in
using read-only commands:

| Adapter      | Read-only check              |
| ------------ | ---------------------------- |
| Codex        | `codex login status`         |
| Claude Code  | `claude auth status`         |
| Cursor Agent | `agent status --format json` |

Configured local Codex inference does not require a cloud login. The consent
receipt contains only adapter, executable path, approval time, auth category,
optional harmless account label and scope version. No provider token is stored
in the receipt. Changing the runtime path requires a new approval. Automatic
routing considers only approved installed runtimes; manual starts validate their
specific adapter and path.

Connecting does not start a coding task. Sending a task authorizes work. To
disconnect an adapter, first stop its active workers; disconnect then prevents
future starts without signing the user out of their provider. Local Fleet
coordination and provider permission rules still apply; these consent records
are not hard filesystem write fencing.

The connection tests use real short fixture processes to verify that only the
documented status commands run, approval is explicit, paths are bound, secrets
are omitted and Memtrace sign-in opens only the official claim host. Actual
installed status checks on the Windows development machine confirmed all three
CLIs had existing provider authentication, without granting production consent.
