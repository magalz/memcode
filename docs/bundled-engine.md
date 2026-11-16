# Memtrace included with MemCode

The Mac and Windows installers include a tested Memtrace engine bundle and Node.js.
Install MemCode, approve your Memtrace beta account, and choose a project. MemCode
prepares the engine in its private app storage and analyzes that project. Approve
your installed coding tool in Workers before starting a story.

## Existing Memtrace CLI installations

Both can coexist. MemCode does not replace a global `memtrace` executable or
rewrite the CLI's settings and credentials. Its managed engine is pinned to the
desktop release. Each project's local graph and watch state use
`.memcode/memtrace`, separate from the global CLI's default store.

To deliberately use your existing CLI account and plan instead, choose **Existing
Memtrace CLI setup → Use existing CLI setup**. That choice disconnects beta
access; sign-out or a failed beta renewal never silently selects it.

## Local startup

MemCode verifies its private cached engine first. When no valid copy exists, it
verifies and extracts the bundle supplied by the installer. Source checkouts
without that resource can download the exact reviewed engine from the official
release service. Archive and file checksums, platform and architecture must
match the release pin. Invalid content cannot become an active engine.

This removes an engine-download dependency from installer first use and cached
startup. First analysis can still download its local embedding model; later use
reuses that model cache. Sign-in, account renewal, cloud coding models and initial
model setup need network access. MemCode reuses a current project graph and
starts an incremental watch rather than rebuilding every time.

The managed Mac engine uses CPU embeddings by default to avoid a lengthy first
CoreML compilation. The model and semantic search remain enabled. Advanced users
can explicitly set `MEMTRACE_ENABLE_COREML` or `MEMTRACE_DISABLE_COREML` before
launching MemCode; those choices are respected. This policy is passed only to
the managed engine, without changing the global CLI or coding workers.

## Distribution boundary

Only compiled, separately licensed Memtrace release files are packaged. The
Memtrace backend source is not part of this repository. Engine licenses and
third-party notices travel inside the bundle. Updating MemCode can supply a new
tested engine without changing a separately installed CLI.
