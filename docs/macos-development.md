# Run MemCode from source on macOS

This is the developer preview route. There is no signed macOS download in this checkout, and macOS execution has not yet been validated on a real Mac. The current acceptance evidence is from Windows.

## Install the prerequisites once

- Git and Node.js **22.12 or newer**. Check `git --version` and `node --version`.
- Rust with Cargo, **Rust 1.88 or newer**, using [rustup](https://rustup.rs/). Check `rustc --version` and `cargo --version`.
- Xcode Command Line Tools. Desktop development does not require the complete Xcode app:

```bash
xcode-select --install
```

Finish the installer before building. See [Tauri's macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos).

## Get the current source and open the app

Authenticate Git with the GitHub account that has access to the private [syncable-dev/memcode repository](https://github.com/syncable-dev/memcode), then run:

```bash
git clone https://github.com/syncable-dev/memcode.git
cd memcode
npm ci
npm run dev
```

The first command installs the lockfile's dependencies. The second builds the renderer, local Node runtime and native Rust shell, then opens MemCode. The first native build downloads and compiles Rust dependencies, so it can take considerably longer than later starts. Keep that Terminal open while using development mode.

For an existing clone, finish/stop any local workers, preserve your own source edits, and pull the current `main` branch before installing dependencies. The private repository's published revision is the source of truth; uncommitted changes on another developer's computer are not included in a pull.

UI edits hot-reload. Runtime/Rust edits require finishing or stopping active workers, closing MemCode and rerunning `npm run dev`. The current app does not detach and reattach running workers across a desktop restart.

## Connect Memtrace and a worker

Install Memtrace separately, then use its existing account:

```bash
npm install -g memtrace
memtrace auth login
```

Open a real local project in MemCode. It discovers `memtrace` on PATH and can start the selected project's local owner when needed. If it is not found, choose the installed executable in Settings. See [Memtrace getting started](https://memtrace.io/docs/getting-started).

Install and sign in to at least one supported coding CLI using that provider's official instructions. Then approve its connection in **Workers**. The Cursor desktop editor alone is not a substitute for its Agent CLI. Provider credentials and model configuration stay on the Mac.

You can inspect the board and use Team Sync without starting a coding worker. Team Sync preview invitations use display names and private access capabilities; they are not yet verified Memtrace organization membership.

## Join a team

1. Clone the source repository you will work on to the Mac using Git.
2. In MemCode, choose **Open existing project** for that clone. Its MemCode board must be empty before joining.
3. Open **Team**, paste a workspace invitation and enter a display name.
4. For a remote teammate, the invitation must contain a reachable HTTPS relay address. `localhost` or `127.0.0.1` refers to the Mac itself and cannot connect to another developer's relay.
5. Check synchronized stories and comments, then connect a worker when ready. Git exchanges source; Team Sync exchanges planning, claims and explicitly published files.

See [the Team Sync guide](team-sync-preview.md) for hosting and sharing boundaries.

## Current platform limits

- The shared live agent browser currently uses Windows WebView2. It reports unsupported on macOS. Do not use that feature as a claimed macOS acceptance test yet.
- Native visible-preview screenshot capture is currently implemented for Windows. This is separate from ordinary saved-document rendering.
- Managed local dictation setup currently targets Windows x64. macOS needs an independently installed local Whisper runtime/server; microphone and transcription behavior still need Mac acceptance testing.
- `npm run build:native` currently uses `--no-bundle`. It does not produce a signed/notarized `.app` or `.dmg` installer. Use `npm run dev` for this source preview.

If a build fails, share the command, macOS version, Apple Silicon/Intel architecture, Node/Rust versions and the first actual error from Terminal. Keep credentials and private project text out of the shared log.
