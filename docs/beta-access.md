# Memtrace access in MemCode beta

Choose **Connect Memtrace beta** in the welcome guide, new-project dialog,
account menu or Settings. Your default browser opens the official Memtrace
sign-in and noncommercial consent page. No coding worker is connected or started
by this action.

After approval, MemCode prepares its separately licensed local Memtrace engine.
It analyzes the local project folder and keeps the graph in that project's
private `.memcode/memtrace/.memdb` directory. Source files and graphs are not
uploaded by beta authentication. A new project can still be saved for planning
before the engine is connected.

This beta provides unlimited local Memtrace graph queries, Cortex and Improve
for noncommercial use. It does not include coding-model subscriptions or credits,
commercial/internal-company use, or an external MemDB entitlement. Coding tools
continue to use the accounts you separately approve in Workers.

Use the account menu to change accounts, refresh access or sign out. Switching
accounts requires running workers to finish or stop. Signing out preserves
projects, comments and output, clears local engine access, and revokes the beta
session. If offline, local access is cleared immediately and remote revocation
is retried later. Signing out never silently resumes a separately billed CLI
account.

Existing users can choose **Existing Memtrace CLI setup → Use existing CLI
setup**. This explicitly disconnects beta access and returns to the installed
CLI's account, plan and usage limits. The separately installed CLI and its
credentials are never overwritten by beta sign-in or engine installation.

## Credential boundary

Refresh credentials stay in the operating system's protected credential store,
scoped to this MemCode profile. The local engine receives only an owner-readable
short-lived proof file and opaque device/session identifiers. The proof file
resides outside project folders. No refresh secret or access token is sent to
the renderer, coding harnesses, terminal children, shared boards or Git.

Access is renewed every ten minutes, on app resume when needed, and before
engine use. Rotated credentials are persisted before a renewed proof becomes
available to the engine. Expiry, revocation, locked storage and missing managed
engine downloads fail closed. They do not fall back to paid CLI usage.

## Verification

`tests/beta-access.test.ts` exercises actual Ed25519 proof verification and a
real loopback PKCE callback, refresh/sign-out races, protected persistence
ordering, billing-mode recovery and worker environment isolation.
`tests/beta-first-project.test.ts` exercises actual runtime project creation
without an engine; source stays intact and no sign-in or worker starts.
`tests/memtrace-binding.test.ts` checks cached access guards and account reset.

`scripts/beta-access-smoke.mjs` renders the actual account panel, welcome guide
and new-project dialog with an isolated test backend. It exercises explicit
approval/cancellation, refresh, reviewed logout, explicit CLI switching and the
account popover. Screenshots are saved under
`.memcode/verification/beta-access/`.

Native tests cover the exact official browser authorization URL, callback
allowlist, OS-store/proof-file separation, restrictive file permissions and
signed-out recovery. A separate explicit Windows-only test uses a unique
synthetic Credential Manager entry and deletes it afterward.

These local tests do not establish production service availability, a successful
production account grant, macOS Keychain acceptance, or a published engine
download. Those require the deployed issuer, enabled beta program and validated
platform catalog; release acceptance must verify them separately.
