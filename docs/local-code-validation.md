# Validate local code intelligence on both computers

Team sync and code intelligence have separate acceptance checks. Sharing a board does not share a MemDB, local source folder, graph, index status or agent session.

Each computer builds or reuses its own local Memtrace index of the checkout connected on that computer. A shared project initially has no local folder. In **Team → Work on this computer**, reuse a matching existing checkout or clone into a destination you choose, then finish local analysis. An existing local workspace index may be reused; otherwise MemCode prepares a private project store under `.memcode/memtrace`.

## First check

On **each computer**, open **Insights → Code intelligence → Record checkpoint → Evidence & coverage**. Record the local branch, Git commit, source fingerprint, graph publication, store scope/path, watcher status and capture time.

A passing fresh capture needs all of:

- The expected local checkout and Git branch.
- Source/index readiness confirmed, with zero mismatched files.
- A stable graph publication across the capture.
- A verified local watcher on that checkout and branch.
- Real AST measurements; unknown values stay unknown.

A saved “connected” badge, an old checkpoint or a successful comment sync is insufficient. If a publication is partial, use **Refresh analysis** and inspect its resulting checkpoint. Do not compare quality across unverified captures.

## Prove live updates

1. Record a passing checkpoint A.
2. Save a small, reversible code change in a supported source file that is not Git-ignored. Keep other workers away from that test file.
3. Record checkpoint B using **Record checkpoint**, without forcing a reindex. The source fingerprint must change; the graph must catch up and pass the readiness checks. Verify the changed symbol through a normal MemCode code-exploration request too.
4. Transfer the source change through the team's normal Git workflow. The other computer must pull or merge it before its graph can see it. Repeat the checkpoint and symbol checks there.
5. Restart MemCode and repeat the save/checkpoint check. The selected local project's watch should reattach; a fresh checkpoint explicitly verifies it again.
6. Revert the probe change and verify the graph catches up to the reverted source.

Graph publication tokens are local to each store and need not match between computers. Compare the intended Git commit/source state and measured facts, and verify freshness separately on both.

## Scope of the guarantee

The watcher tracks supported, included source files in the local checkout. It cannot see unpulled changes on someone else's computer. Card complexity and routing measurements refresh on planning, measurement and worker start; they are not continuously pushed from every watcher event.

Team story claims coordinate who may start the shared story. Semantic Fleet coordination remains within each local engine and checkout in this pilot. Runtime stores are excluded through Git-local metadata before MemCode creates them, including when connecting an existing repository.

Official background: [Memtrace indexing and watcher tools](https://memtrace.io/docs/mcp/tools).
