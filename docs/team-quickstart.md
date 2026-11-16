# Your first shared project

MemCode shares the plan and the results. Each developer keeps their own source checkout, Memtrace analysis and coding workers on their computer.

MemCode is source-available for noncommercial work. Company-internal and commercial use require separate permission; see the [license](../LICENSE). Team collaboration follows the same terms as individual use.

## Invite your team

1. Open an existing project. In **Team**, choose **Create a team**, name it and approve your Memtrace account in the browser.
2. Choose **Share with your team**. Check the project and repository. Its current stories, epics, cycles, comments and activity become the shared starting point.
3. Choose **Invite teammate**, optionally restrict the invitation to their verified email, then copy the link and send it privately.

MemCode discovers the official Team service when it is enabled. You do not set up a server or receive a setup secret. If Team creation is not available yet, keep working locally and retry after service activation. Invitations include the service address automatically; private service operation is an advanced option.

## Accept an invitation

1. In your existing MemCode installation, choose **Join with invitation** in Team or the project selector.
2. Paste the link, review the team and project, then choose **Accept and open** with the intended Memtrace account.
3. Start planning, commenting and reviewing the project's existing work. Your personal projects remain separate.

You do not need to create an empty project or download MemCode again. Accepting a Team invitation does not grant access to the source repository or start a worker.

## Start coding on your computer

1. Choose **Work on this computer** in the shared project.
2. Reuse a matching checkout, or select where to clone the repository. Git access is checked separately. Existing local changes are preserved; unrelated folders are not adopted.
3. Let Memtrace analyze the checkout. If setup needs attention, use **Check local engine** to inspect this computer's branch, source/index alignment and watch state.
4. In **Workers**, explicitly connect and approve your installed coding tool. MemCode currently supports Codex, Claude Code and Cursor; more adapters can be added. Set its default permissions once.
5. Open a focused story, confirm the brief and start its worker. MemCode confirms your shared story claim before starting work.

Use an epic for a coherent outcome and its Git branch; use stories for focused tasks with a clear result and a way to check it. Cycles can wait until your team wants a delivery rhythm.

## Share a result

Review the worker's changes and checks. Publish selected reports or artifacts through Team when ready, up to **5 MiB per file**. Teammates receive that saved file. A published HTML file does not include its linked assets or running development server.

Story discussion belongs in **Comments**. Instructions for a worker belong in **Conversation**; follow-ups sent while it is busy appear in **Queue**, where you can edit or cancel them before pickup. Saving a selected-text review comment does not send it to a worker until you explicitly send the follow-up.

## Know what is synchronized

| Shared with the team | Kept on this computer |
| --- | --- |
| Stories, epics, cycles, authored comments and activity | Source files, local paths and Memtrace graph |
| Confirmed story claims | Coding-provider credentials and approvals |
| Files you explicitly publish | Full agent conversations, browser sessions and terminal processes |

**Git still carries the code.** Fetch, review and integrate teammates' changes using your epic-branch workflow. A current board does not mean your checkout is current. Each computer analyzes its own checkout.

Claims prevent a second official worker from starting the same story. Different stories can still edit the same files. Local Fleet coordinates local workers; this beta does not provide cross-computer Fleet coordination or live shared-file editing.

Planning edits can queue offline; starting a new shared worker requires an online claim. Removing Team access blocks future service requests, but cannot erase downloaded files, change Git permissions or stop another computer's processes.

For service operation, recovery and detailed limits, see [Team Sync](team-sync-preview.md). Application updates are separate from joining a project or fetching its source.
