# Third-party distribution material

This directory accompanies the desktop app and website demo. It contains
original upstream notices, source-access information, and corresponding source
for the separately licensed PDF-viewer fonts. It contains no proprietary
Memtrace or MemDB implementation.

Start with [SOURCE_ACCESS.md](SOURCE_ACCESS.md) and the root
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Each entry in
[inventory.json](inventory.json) records its original license expression,
source URL, notice files and SHA-256 hashes. Build-only and platform-specific
dependencies remain listed; this is broader than any one installer.

To regenerate after a dependency change:

```sh
cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml > .memcode/cargo-license-metadata.json
node scripts/third-party-notices.mjs
node scripts/verify-third-party-notices.mjs
```

Review missing upstream notices rather than inventing copyright holders or
years. `scripts/resolve-license-notices.mjs` retrieves license files from pinned
upstream package commits. `scripts/complete-license-notices.mjs` documents the
reviewed exceptions where an archive omits its project's license or uses a
source-file/manifest declaration instead. Neither script executes downloaded
code. Their provenance is in [upstream-notices.json](upstream-notices.json).

The Liberation 1.07.4 source archive is unmodified. Its hash matches the
upstream-original archive in the linked Debian source descriptor. Its SFD
files, build scripts and original GPL font terms remain available to recipients.
Do not apply MemCode's noncommercial restriction to these fonts or to other
independently licensed components.

Node's complete bundled license is supplied separately as `NODE-LICENSE` in
the installed `desktop-runtime` directory. System browser and credential
services are not relicensed by MemCode.
