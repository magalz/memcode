# Private macOS desktop candidate

The declared minimum is **macOS 13.5 on Apple Silicon**. The bundled Node
24.22.3 [release build requirements](https://github.com/nodejs/node/blob/v24.22.3/BUILDING.md#platform-list)
set that minimum. Packaging records the actual Mach-O minimum versions of both
MemCode and bundled Node, compares them with Tauri's configuration and the app's
Info.plist, and fails if the declared support is older than either binary needs.
This static compatibility check does not replace physical Mac acceptance.

The `Private macOS desktop candidate` workflow builds an Apple Silicon app,
DMG and version-bound Tauri updater. It uploads a private Actions artifact;
it does not create a release, change repository visibility, update the download
catalog or publish the updater feed.

Before running it, review and commit the complete candidate to
`beta/memcode-desktop-candidate` in the private `syncable-dev/memcode` repository.
The workflow accepts pushes to that branch or a manual dispatch on that branch.
It rejects other repositories, public repositories and other refs. Nothing in
this workflow runs for pull requests.

The first reviewed push can trigger the workflow directly. GitHub's manual
dispatch UI also requires the workflow to be registered on the repository's
default branch; do not assume a new workflow exists there before review.

Configure `TAURI_SIGNING_PRIVATE_KEY` as a protected repository secret using the
existing MemCode updater key; configure `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if
the key has a password. Do not generate a different key per run: the app trusts
the public key already embedded in its configuration. Never commit the private
key or include it in the artifact. The build fails if the key is missing.

The workflow uses native ARM64 `macos-15`, Rust 1.97.1, and the Node version and
checksums recorded in `scripts/desktop-node.json`. It checks types, behavior and
third-party notices before packaging. It verifies the app signature, directly
runs its bundled Node with global Node lookup disabled, and uses the actual
Tauri updater verifier against the configured public key before collecting
files. These checks do not launch the app or establish a successful account or
engine connection.

The shared live worker browser currently depends on Windows WebView2. This
macOS packaging workflow does not provide or establish full live-browser or
computer-use parity. Local artifact readers and the desktop shell have separate
platform acceptance checks.

The uploaded artifact contains:

- The DMG installer.
- The `.app.tar.gz` updater and its `.sig` file.
- `candidate.json` with version, source commit, target, runtime provenance,
  signing limitations, file sizes and hashes.
- `SHA256SUMS` for these files and the metadata.

No proprietary Memtrace engine or engine source is added to this artifact by
the workflow. MemCode downloads its separately licensed engine after explicit
beta approval. Normal project data and credentials do not exist in this clean
CI checkout.

## Explicit distribution modes

`scripts/tauri-package.mjs` defaults to **public-release** on macOS. Missing Apple
credentials fail before compilation; there is no silent downgrade to ad-hoc
signing. The private workflow's automatic branch pushes explicitly select
**private-candidate**. Manual dispatch also offers **manual-approval-beta** and
**public-release**.

- **private-candidate** creates a private Actions review artifact. It is ad-hoc
  signed, not notarized, and never qualifies as a trusted public release.
- **manual-approval-beta** also uses ad-hoc signing. Its metadata explicitly says
  `manualApprovalRequired: true`, `notarized: false` and `publicReady: false`.
  A release owner may offer it to the account-gated beta audience only with the
  upfront Mac warning and Apple's per-app approval instructions. It must not be
  advertised as a normal verified Mac installation or silently auto-promoted.
- **public-release** requires a Developer ID Application certificate, complete
  notarization authentication, app and DMG stapled tickets, accepted Gatekeeper
  assessments and an independently checked updater archive containing the
  already-stapled app. A Tauri updater signature alone is insufficient.

For trusted public mode, add protected GitHub secrets `APPLE_CERTIFICATE`
(base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
(`Developer ID Application: … (TEAMID)`) and `APPLE_TEAM_ID`. Notarization uses
either `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_P8` (the `.p8` file
contents), or `APPLE_ID` and an **app-specific** `APPLE_PASSWORD`. Never put
certificate/key material in source, chat, artifacts or log output. The temporary
CI signing keychain and key files are removed after packaging.

Bundled Node is a resource, not a Tauri `externalBin`. Public mode explicitly
signs it before the enclosing app, with only the `allow-jit` entitlement. It
checks every nested Mach-O signature/team and runs the signed Node's JIT smoke.
The runtime provenance retains the original official Node archive/executable
hash; `macOS.signedRuntime.signedExecutableSha256` separately identifies the
post-signing executable. Signing changes bytes: do not compare the signed hash
directly with the original vendor executable hash or rewrite vendor provenance.

Before trusted public promotion run
`node scripts/verify-macos-public-candidate.mjs <candidate.json>`. It rejects
both ad-hoc modes. Actual artifact hashes and the native updater verifier still
need independent review; this policy check does not replace them.

## Installation visuals and cold start

The DMG uses a branded 720×480-point background with 1440×960 pixels at 144 dpi.
AppKit verifies that logical/pixel relationship on the Mac runner. The outer
window includes title-bar space, with the app on the left and Applications on
the right. `TAURI_BUNDLER_DMG_IGNORE_CI=true` enables Tauri's hosted-runner Finder
customization; a blank CI fallback is rejected by mounting the finished DMG and
checking its background and Finder metadata. Finder backgrounds are static;
the app's first-launch welcome provides motion and the product introduction.

The workflow also launches the actual packaged native app in a fresh profile,
with global Node lookup removed and no account/model/engine started. It observes
the bundled Node child, completion of `workspace:load` and the renderer's existing
onboarding continuation (which runs only after loading valid state/runtime).
The transport's `rpc-end` alone cannot prove success, because it also logs failed
replies. After that continuation, the smoke waits two seconds for rendering and
captures a screen image when the runner permits it. This catches
native/JIT/runtime startup failures, but **does not establish physical Mac UI
usability or Gatekeeper acceptance for an ad-hoc beta**. Those limits are recorded
in the candidate.

Test the downloaded DMG on a separate Mac/profile, including normal Gatekeeper
handling, launch, browser consent, Keychain persistence, managed engine and a
local project analysis. A release-to-release updater restart is a separate gate.

The workflow source has been prepared on Windows. A successful macOS build,
installer and cold-start test must be recorded from the actual workflow and Mac;
their success is not implied by the existence of this file.

Reference behavior: [GitHub's runner architecture table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and
[Tauri signed updates](https://v2.tauri.app/plugin/updater/). See also
[Apple Developer ID](https://developer.apple.com/developer-id/),
[Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow),
[Apple's narrow JIT entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)
and the [current Tauri DMG implementation](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.4/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs).
