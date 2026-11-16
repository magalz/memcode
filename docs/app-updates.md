# App updates

Installed MemCode releases use Tauri's signed updater. Open **Settings → MemCode updates** to check for a release, read its notes, and choose **Update MemCode**. The final confirmation shows running workers and the number of local terminal sessions that restarting will close. Running workers prevent installation. Queued follow-ups are retained.

Development checkouts use Git and `npm run dev`; the updater does not replace a running development build.

## Release contract

The native app checks `https://www.memtrace.io/api/memcode/updates/{{target}}/{{arch}}/{{current_version}}`. The endpoint returns HTTP 204 when no newer release exists, or Tauri's dynamic response with `version`, `pub_date`, `notes`, `url` and `signature`. The signed version must match the announced version. HTTPS and signature checks are required.

Settings loads published history from `https://www.memtrace.io/api/memcode/releases` only when **Release notes** is opened. It renders bounded text and Markdown; it does not load remote images or execute embedded HTML. A failed request is not reported as “up to date.”

Release publication uses the shared release manifest described by the Memtrace web service. Windows NSIS installers can also be updater payloads; macOS uses a DMG for installation and the signed `.app.tar.gz` for updates. Publish platform entries only after their actual artifacts, SHA-256 values and updater signatures exist at publicly reachable HTTPS addresses.

## Build and signing

- The public updater key is in `src-tauri/tauri.conf.json`. The private release key belongs outside Git and outside distributable resources. On this Windows release machine it is protected under `%LOCALAPPDATA%/MemCode/release/`; its contents must never appear in logs.
- CI supplies `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through protected secrets. Tauri's bundler generates updater artifacts and version-bound `.sig` files when `createUpdaterArtifacts` is enabled. A manual `tauri signer sign` must include `--app-version`.
- Local `build:native` keeps `--no-bundle`; a release pipeline must explicitly enable platform bundles and provide signing credentials. Installer code signing/notarization is separate from the mandatory updater signature.
- MemCode's source license is **PolyForm Noncommercial 1.0.0**. Its separately licensed Memtrace engine is not part of this source distribution. Provider model accounts and usage limits remain separate.

## Failure and verification behavior

Downloads and signatures are verified before reserving the idle runtime for installation. The final reservation saves local state and blocks new or automatically queued worker starts. A failed download or invalid signature leaves the runtime running. On Windows, Tauri's installer hook closes the runtime before launching the installer; if launch fails after that close, MemCode records a local failure and reopens its current version rather than leaving a stopped sidecar behind.

Checks:

```text
npm run typecheck
npm test
npm run build
node scripts/app-updates-smoke.mjs
cargo test --manifest-path src-tauri/Cargo.toml updates::tests:: -- --nocapture
```

The Rust test uses the real Tauri signer/verifier protocol with a discarded test key. It accepts the signed fixture and rejects altered bytes, a different key and an announced version that differs from the signed version. The UI smoke uses a clearly isolated backend fixture and never installs an update. A release-to-release installer/restart test on each supported OS is a separate release acceptance step; these tests do not claim that installation happened.
