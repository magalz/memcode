# Team Sync preview

Team Sync shares a project's board, epics, cycles, story comments, activity and deliberately published results. Each developer keeps a separate local checkout, Memtrace index, model configuration and worker processes. Git exchanges source changes.

This preview uses private invitation capabilities and display names. These are not verified Memtrace team identities. It does not yet connect a Memtrace organization, offer live collaborative source editing, or coordinate Fleet across different computers.

## Try it with a teammate

1. Both developers open their own local clone of the same Git repository in MemCode. Use the same epic branch when exchanging that epic's code.
2. The first developer selects **Team → Share this project**, enters a display name and chooses how the relay is reachable. The default is a private relay on this computer. For a second computer, explicitly enable local-network sharing or use a reachable private relay.
3. Copy a fresh invitation and send it privately to the teammate. Invitations grant access to this workspace; keep them out of public issues and screenshots.
4. The teammate uses **Open existing project** to select their local clone, then selects **Team → Join** and pastes the invitation. Its MemCode board must be empty. The new-project wizard creates a starter story, so opening an existing clone is the direct route. Existing personal project cards are preserved; joining does not merge or export them.
5. Move a story or add a comment. Check the connection indicator and queued-change count. The Team activity feed shows accepted changes and lets you mark them as read.
6. Start a story worker. MemCode confirms one claim for that story before launching the local harness. Another developer sees who holds it and cannot start a second official worker for the same story.
7. Publish a saved report or artifact from Team when it is ready. A teammate can click the published result to download and view that exact saved file locally. The preview limit is 5 MiB per file.

Receiving a story, comment or result never starts a worker on the receiving computer. Harness connections and approvals remain that developer's choice.

Publishing uploads one selected file. Markdown, PDF, images and self-contained Office documents are useful first tests. Linked website assets and a running development server are not bundled or shared with that file.

## Relay hosting

The embedded relay runs with the host's MemCode runtime. Keep that application open for live synchronization. Other clients retain queued metadata changes while it is unavailable. New team workers require a reachable relay so ownership can be checked.

For an independently running relay, build the runtime and run:

```powershell
npm run build
npm run team:relay -- --data-dir C:\private\memcode-team --port 9331
```

The command prints the endpoint and the location of its private setup capability file. In **Advanced connection**, the workspace creator supplies the relay address and setup capability. Teammates use invitations instead of the setup capability.

An explicitly shared local-network relay can bind to all interfaces and advertise a reachable address:

```powershell
npm run team:relay -- --data-dir C:\private\memcode-team --port 9331 --host 0.0.0.0 --advertise-url http://YOUR-PRIVATE-IP:9331
```

Use this HTTP option only on a trusted private network or private tunnel. For a remote pilot, put the loopback relay behind HTTPS and configure its advertised URL. The relay must accept that configured host. No public relay is deployed automatically.

## Ownership and reconnects

- Claims belong to one member, device and attempt. Disconnecting does not silently hand them to another worker.
- Routine completion and explicit Stop release the local claim. If an application crashes, its owning device can release the saved claim after checking that its worker has stopped.
- An accepted mutation is journaled before it is acknowledged. Retried operations use their operation IDs to avoid duplicate changes.
- Connection state, pending changes and unread activity are separate concepts. “Registered device” does not mean “currently online.”
- Two different stories can still change the same source files. Review and integrate those changes through Git. A story claim is not a cross-computer source lock or a proof of semantic agreement.

## What is shared

Shared fields are explicitly selected: planning text and fields, relative scope hints, authored story comments, accepted activity, claim metadata and published file contents. Publish only outputs intended for the team; descriptions and comments are shared text too.

Device-local credentials, absolute repository bindings, CLI approvals, permission defaults, Memtrace graph IDs and analysis state, terminal sessions, browser cookies, conversation drafts and worker process state stay local. Full agent conversations and uncommitted source files are outside this preview.

## Architecture

The prototype has one small authoritative relay per shared workspace service. Clients keep a private durable outbox and catch up from ordered events using a received cursor. Read activity uses a separate cursor. The relay stores a durable journal and content-addressed published files; it does not host a Memtrace engine or require a managed database.

This implementation uses typed HTTP commands and long polling. It is not DeltaDB, an Automerge integration or a peer-to-peer replicated filesystem. Richer collaborative text, verified Memtrace membership, revocation and cross-device execution handoffs remain follow-up work.
