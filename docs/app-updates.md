# App updates

Installed MemCode releases use Tauri's signed updater. Verified updates download in the background by default. Keep working, then choose **Restart to update** in the app header when ready. An idle workspace restarts directly; active workers prevent installation, and open terminal sessions get a clear review before restart. Queued follow-ups are retained. To control downloads yourself, turn off **Download updates automatically** in **Settings → MemCode updates** and save.

Updates keep the same local profile, approved Memtrace account and projects. A routine app or bundled-engine update does not require another browser approval. An already-running account refresh finishes saving its replacement credential during shutdown.

The same profile also retains worker approvals, permission defaults, onboarding progress, dictation language and local retrieval preferences. Downloaded models live in the profile cache, outside the replaced application. A provider approval follows its supported installation identity, not MemCode's bundled Node launcher. A genuinely different provider installation still requires approval; a temporarily unavailable sign-in check preserves the existing receipt and shows **Connection saved**.

On macOS, drag MemCode from the downloaded disk image into Applications, eject the image and open the installed app. A focused installation guide appears when MemCode runs from a read-only image or AppTranslocation; in-place updates are blocked there. This does not bypass Gatekeeper. The manual-approval beta is ad-hoc signed: removing Apple's warning for new releases requires a Developer ID signature and notarization, independently of the updater's cryptographic signature.

On Windows, run the downloaded `MemCode_<version>_x64-setup.exe` and complete
setup. The default per-user location is `%LOCALAPPDATA%\MemCode\memcode.exe`.
Setup creates a Start menu shortcut and a **MemCode** entry in **Settings →
Apps → Installed apps**. No administrator account or separately installed Node,
Memtrace or WebView2 download is needed: setup includes the signed Microsoft
WebView2 Runtime offline installer. The runtime's own Windows installation
requirements still apply. Setup checks essential files before offering to launch.

An interrupted installation can be repaired by running setup again; uninstalling
first is unnecessary. The program and the profile are separate. Saved projects,
settings and models are under `%APPDATA%\MemCode`, and a routine uninstall or
replacement does not delete them. If Windows Security has removed a file, inspect
**Protection history** for the reported reason before retrying; disabling security
software is not part of installation. Native window failures now produce an error
dialog and a local `%APPDATA%\MemCode\diagnostics\native-startup.json` report.
These reports are never uploaded automatically. Admin download events alone do
not establish a successful installation or explain a failure before sign-in.

The updater keeps a prepared download while the app stays open, including when Settings closes. Download persistence across a full quit is not established by this implementation.

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

The private **Windows installer lifecycle** workflow downloads the exact published
installer, verifies its SHA-256, and actually installs it into a disposable path
containing spaces and Unicode. It checks both shortcut targets, the Windows Apps
registration and uninstaller, opens the installed native app without a CLI on
PATH, then tests restart, NSIS update mode, uninstall and reinstall with saved
work. It refuses to replace an existing registered installation or shortcut and
never opens the normal profile. This checks the real installer rather than only
its extracted payload. The hosted runner already has WebView2; embedded-runtime
signature/presence and failed-WebView startup are verified separately.

## Reference behavior

The implementation follows the stable launcher/background-update approach documented by [Claude Code](https://code.claude.com/docs/en/setup), the [Cursor CLI update flow](https://cursor.com/docs/cli/installation), and Tauri's [DMG](https://v2.tauri.app/distribute/dmg/) and [signed updater](https://v2.tauri.app/plugin/updater/) contracts. GUI-launched Mac apps search bounded standard provider/package-manager locations instead of assuming Finder inherits a terminal's PATH. An editor being present is distinguished from its worker CLI being available.
