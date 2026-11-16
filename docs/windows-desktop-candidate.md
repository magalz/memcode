# Private Windows desktop candidate

Build with a reviewed source snapshot and the existing updater key outside Git:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "<absolute path to protected updater key>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
node scripts/tauri-package.mjs
```

The packaging script verifies dependency/license material, prepares the
checksum-pinned bundled Node runtime, builds the renderer/runtime and creates
the Windows NSIS installer plus its version-bound Tauri updater signature.
The same setup executable serves as both installer and updater payload.

Verify actual release bytes without installing them:

```powershell
node scripts/verify-desktop-candidate.mjs "<absolute path to setup.exe>"
```

This uses the real Tauri updater verifier with the configured production public
key and package version. It must accept the actual bytes and reject modified
bytes, an unrelated key and a relabelled version. Its explicit native test does
not download, execute or install the payload.

The current candidate is updater-signed but **not Windows Authenticode signed**.
Updater authenticity does not establish a trusted Windows publisher or remove
SmartScreen warnings. The candidate report records this distinction.

## Isolated packaged-runtime acceptance

Extract the generated installer into a fresh review directory, without running
the installer, then use its actual executable:

```powershell
$env:MEMCODE_NATIVE_BINARY = "<absolute path to extracted memcode.exe>"
$env:MEMCODE_TEST_BUNDLED_RUNTIME = "1"
$env:MEMCODE_SMOKE_SCOPE = "packaging"
$env:MEMCODE_NATIVE_DEBUG_PORT = "9459"
node scripts/tauri-smoke.mjs
```

The test creates a separate temporary profile. It removes Node/service/app
overrides and Node lookup paths, and verifies that the child process is the
extracted `desktop-runtime/node.exe`. It exercises actual workspace IPC, local
artifact rendering, guest access denial, preview capture and graceful shutdown.
It does not connect a worker or sign a user into beta. The packaging scope is
explicitly narrower than the complete planning smoke; omit that scope to run
the full native suite.

Do not run a silent/passive NSIS installer alongside a user's live MemCode
session: installer process checks can close an existing application. Actual
installer registration, cold beta consent/managed-engine preparation and a
release-to-release updater restart belong in separate OS/profile acceptance.
An extracted-payload smoke does not claim those steps happened.

Keep candidate installers, hashes, signatures and acceptance reports under the
ignored `release/` directory until reviewed. Tie the final build to its source
commit before publishing a catalog entry. No build or verification command
publishes files, changes repository visibility or replaces the global CLI.

Reference: [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/)
and [Tauri signed updates](https://v2.tauri.app/plugin/updater/).
