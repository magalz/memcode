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

This candidate has **ad-hoc macOS signing**, not an Apple Developer ID signature,
and it is **not notarized**. A valid Tauri updater signature authenticates the
update payload; it does not establish Apple's trust or remove Gatekeeper
warnings. Do not label the candidate as an unrestricted public macOS release.
Test the downloaded DMG on a separate Mac/profile, including normal Gatekeeper
handling, app launch, browser consent, Keychain persistence, managed engine
preparation and a local project analysis. A release-to-release updater restart
is a separate acceptance check.

The workflow source has been prepared on Windows. A successful macOS build,
installer and cold-start test must be recorded from the actual workflow and Mac;
their success is not implied by the existence of this file.

Reference behavior: [GitHub's runner architecture table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and
[Tauri signed updates](https://v2.tauri.app/plugin/updater/).
