import {
  collectEvidence,
  refreshEvidence,
  type EvidenceRefresh,
} from "./qualification";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Evidence, Project, WorkItem } from "../src/shared";
import { childEnv, findCommand, now } from "./local";
import {
  resolveMcpWorkspace,
  projectMcpWorkspace,
  MemtraceAdmissionError,
  normalizeMcpEnvironment,
  type MemtraceScopeBinding,
} from "./memtrace-workspace";
import { join } from "node:path";
import { ensureLocalRuntimeIgnored } from "./project-repository";
import {
  ManagedMemtraceOwners,
  pendingMemtraceOwner,
  disconnectedMemtraceClient,
} from "./memtrace-owner";
import { waitForPeerIndex } from "./memtrace-peer-index";

type Json = Record<string, any>;
function unwrap(value: unknown): any {
  const result = value as Json;
  if (result.isError)
    throw new Error(
      result.content?.map((x: Json) => x.text ?? "").join("\n") ||
        "Memtrace query failed",
    );
  for (const item of [...(result.content ?? [])].reverse()) {
    if (item.type === "text") {
      try {
        return JSON.parse(item.text);
      } catch {
        /* human-readable summary */
      }
    }
  }
  return result;
}
const pathKey = (value: string) =>
  value
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "")
    .toLowerCase();

/** MemCode's record of the engine's live watch on one project folder. */
export interface MemtraceWatch {
  /** watching: the engine lists a watch on this folder. unavailable: see reason. */
  state: "watching" | "unavailable";
  path: string;
  repoId: string;
  /** The branch the engine reports for the watch. It follows the checkout. */
  branch: string;
  /**
   * memcode: this engine session created the watch, and close() stops it.
   * existing: it was already there, whoever created it, and is left alone.
   */
  origin: "memcode" | "existing";
  /**
   * When the engine process began this watch. A restarted engine restores the
   * watch with a new time, so this dates a process, not the watch.
   */
  startedAt?: string;
  verifiedAt: string;
  reason?: string;
}
const WATCH_VERIFY_MS = 30_000;

export class MemtraceEngine {
  private readonly owners = new ManagedMemtraceOwners();
  private readonly connecting = new Set<Client>();
  private watches = new Map<string, MemtraceWatch>();
  private watchChecked = new Map<string, number>();
  private watching = new Map<string, Promise<MemtraceWatch>>();
  private closing = false;
  private opening = new Map<string, Promise<Client>>();
  private connectionProgress = new Map<string, Set<(note: string) => void>>();
  private scopes = new Map<string, MemtraceScopeBinding>();
  private clients = new Map<
    string,
    { client: Client; transport: StdioClientTransport }
  >();
  constructor(private readonly configuredPath: () => string) {}
  scopeFor(projectId: string): MemtraceScopeBinding | null {
    const scope = this.scopes.get(projectId);
    return scope ? { ...scope } : null;
  }
  certificateDiagnosticsFor(projectId: string): string[] {
    const scope = this.scopes.get(projectId);
    return scope ? this.owners.certificateDiagnostics(scope.dataDirectory) : [];
  }
  watcherFor(projectId: string): MemtraceWatch | null {
    const watch = this.watches.get(projectId);
    return watch ? { ...watch } : null;
  }
  /**
   * Watcher lifecycle. One native Memtrace watch per connected project keeps
   * the index following the shared checkout while workers edit. MemCode does
   * not poll the tree or re-index the repository to stay fresh.
   *
   * 1. Start. analyze() binds a repository identity and then asks the engine
   *    to watch exactly project.path. On an unchanged branch the engine
   *    publishes saves it had missed when a watch starts. It rejects a second
   *    watch on a folder, so the watch list is read first and a watch that
   *    already exists is adopted.
   * 2. Verify. qualify() and refresh() re-read the watch list at most once per
   *    WATCH_VERIFY_MS and start the watch if the engine does not list one,
   *    which covers a project analyzed in an earlier session. The engine's
   *    list is the authority; the record kept here is only a claim about it.
   * 3. Branch change. The engine's watch follows the checkout, so it is
   *    re-verified, not restarted. Whether the new branch is indexed is the
   *    engine's answer: after a switch it can stay not ready, most often when
   *    uncommitted files came along, and neither restarting the watch nor
   *    another index job reliably changes that. MemCode therefore does not
   *    loop either one. analyze(force), run when an epic branch is activated
   *    from a clean tree, stays the single index pass, and stories on a
   *    branch the engine has not confirmed carry a stale binding
   *    (see qualification.ts).
   * 4. Owner stop or restart. The engine persists a watch and restores it
   *    when it starts again, except under MEMTRACE_NO_WATCH_RESTORE, which
   *    MemCode sets for its private project owner. Either way a dropped
   *    connection discards the verification; after reconnecting the watch
   *    list is read again and the watch is started only if it is missing.
   * 5. Stop. close() stops a watch this session created, because a watch left
   *    behind would be restored by a later engine start. A watch that already
   *    existed is left to whoever created it.
   *
   * A watch keeps the index fresh; it does not prove it. Evidence is checked
   * against get_query_revision separately. Never throws: a missing watch is
   * recorded as unavailable with the engine's reason.
   */
  async watch(
    project: Project,
    repoId = project.repoId,
  ): Promise<MemtraceWatch | null> {
    if (this.closing || !project.path || !repoId) return null;
    const claim = this.watches.get(project.id);
    if (
      claim &&
      claim.repoId === repoId &&
      claim.branch === project.branch &&
      pathKey(claim.path) === pathKey(project.path) &&
      Date.now() - (this.watchChecked.get(project.id) ?? 0) < WATCH_VERIFY_MS
    )
      return { ...claim };
    let pending = this.watching.get(project.id);
    if (!pending) {
      pending = this.bindWatch(project, repoId).finally(() =>
        this.watching.delete(project.id),
      );
      this.watching.set(project.id, pending);
    }
    return pending;
  }
  private async bindWatch(
    project: Project,
    repoId: string,
  ): Promise<MemtraceWatch> {
    const path = project.path!,
      previous = this.watches.get(project.id);
    // Ownership is "this session created the watch on this folder". It
    // survives a failed verification and an engine restart that restores it.
    let origin: MemtraceWatch["origin"] = previous?.origin ?? "existing",
      startedAt = previous?.startedAt;
    const record = (
      watch: Pick<MemtraceWatch, "state" | "branch" | "reason">,
    ) => {
      const claim: MemtraceWatch = {
        ...watch,
        path,
        repoId,
        origin,
        ...(startedAt ? { startedAt } : {}),
        verifiedAt: now(),
      };
      this.watches.set(project.id, claim);
      this.watchChecked.set(project.id, Date.now());
      return { ...claim };
    };
    const listed = async (): Promise<Json | undefined> =>
      (
        (await this.call(project, "list_watched_paths", {}))?.watches ?? []
      ).find((row: Json) => pathKey(row.path ?? "") === pathKey(path));
    try {
      let row = await listed();
      if (row && row.repo_id !== repoId) {
        if (origin !== "memcode")
          throw Error(
            `Memtrace already watches this folder as ${row.repo_id}.`,
          );
        await this.call(project, "unwatch_directory", { path });
        row = undefined;
      }
      if (!row) {
        try {
          await this.call(project, "watch_directory", {
            path,
            repo_id: repoId,
            branch: project.branch,
          });
          origin = "memcode";
        } catch (error) {
          // The watch appeared between the list and here: restored by the
          // engine, or created by another client. Ownership is unchanged.
          if (!/already watching/i.test((error as Error).message)) throw error;
        }
        startedAt = undefined;
        row = await listed();
        if (!row)
          throw Error("Memtrace accepted the watch but does not list it.");
      }
      startedAt =
        typeof row.started_at === "string" ? row.started_at : undefined;
      const branch =
        typeof row.branch === "string" ? row.branch : project.branch;
      return record({
        state: "watching",
        branch,
        ...(branch === project.branch
          ? {}
          : {
              reason: `The watch follows the checkout on ${branch}; this project is recorded on ${project.branch}.`,
            }),
      });
    } catch (error) {
      return record({
        state: "unavailable",
        branch: project.branch,
        reason: ((error as Error).message || "Memtrace did not respond.").slice(
          0,
          400,
        ),
      });
    }
  }
  async connect(
    project: Project,
    update?: (note: string) => void,
  ): Promise<Client> {
    if (this.closing) throw Error("The Memtrace connection is closing.");
    const existing = this.clients.get(project.id);
    if (existing) return existing.client;
    if (update) {
      let listeners = this.connectionProgress.get(project.id);
      if (!listeners)
        this.connectionProgress.set(project.id, (listeners = new Set()));
      listeners.add(update);
    }
    try {
      const pending = this.opening.get(project.id);
      if (pending) return await pending;
      const connection = this.open(
        project,
        this.scopes.get(project.id)?.mode === "project",
      ).finally(() => this.opening.delete(project.id));
      this.opening.set(project.id, connection);
      return await connection;
    } finally {
      if (update) {
        const listeners = this.connectionProgress.get(project.id);
        listeners?.delete(update);
        if (!listeners?.size) this.connectionProgress.delete(project.id);
      }
    }
  }
  private async open(
    project: Project,
    privateProject = false,
  ): Promise<Client> {
    if (!project.path) throw new Error("Choose a local project folder first.");
    const command = await findCommand("memtrace", this.configuredPath());
    if (!command)
      throw new Error(
        "Memtrace was not found. Install it or choose its executable in Settings.",
      );
    await ensureLocalRuntimeIgnored(project.path);
    const scope = await resolveMcpWorkspace(project.path);
    const local = privateProject
      ? await projectMcpWorkspace(project.path)
      : null;
    const env = normalizeMcpEnvironment(
      Object.fromEntries(
        Object.entries({ ...childEnv(), ...command.env }).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    );
    if (local) {
      env.MEMTRACE_MEMDB_DATA_DIR = local.dataDirectory;
      env.MEMTRACE_DATA_DIR = local.jobDirectory;
      env.MEMTRACE_NO_WATCH_RESTORE = "1";
    }
    let active: { client: Client; transport: StdioClientTransport } | undefined;
    const disconnect = async () => {
      if (!active) return;
      const previous = active;
      active = undefined;
      this.connecting.delete(previous.client);
      await previous.client.close().catch(() => {});
    };
    const attach = async () => {
      if (this.closing) throw Error("The Memtrace connection is closing.");
      await disconnect();
      const transport = new StdioClientTransport({
        command: command.command,
        args: [
          ...command.prefix,
          "mcp",
          ...(local
            ? ["--workspace-file", local.workspaceFile]
            : scope.workspace
              ? ["--workspace", scope.workspace]
              : []),
        ],
        cwd: local?.directory ?? scope.directory,
        env,
        stderr: "pipe",
      });
      const client = new Client(
        { name: "memcode", version: "0.3.0" },
        { capabilities: {} },
      );
      active = { client, transport };
      this.connecting.add(client);
      transport.stderr?.on("data", () => {});
      const timer = setTimeout(() => void transport.close(), 30_000);
      try {
        await client.connect(transport);
      } finally {
        clearTimeout(timer);
      }
    };
    const discover = async () =>
      unwrap(
        await active!.client.callTool(
          { name: "list_indexed_repositories", arguments: {} },
          undefined,
          { timeout: 15_000 },
        ),
      );
    try {
      let discovered: any;
      try {
        await attach();
        discovered = await discover();
      } catch (error) {
        if (!pendingMemtraceOwner(error) && !disconnectedMemtraceClient(error))
          throw error;
        if (!local) {
          // ClientPending is not a wrong store. Bootstrap only the selected
          // project, never the broad Folder Group or an unmarked parent.
          await disconnect();
          return this.open(project, true);
        }
        await this.owners.ready(
          local,
          command,
          env,
          async () => {
            // Pending clients can retain a stale attachment during owner election.
            await attach();
            discovered = await discover();
          },
          (note) => {
            for (const listener of this.connectionProgress.get(project.id) ??
              []) {
              try {
                listener(note);
              } catch {
                /* Keep connection ownership independent of UI. */
              }
            }
          },
        );
      }
      const repos: Json[] = Array.isArray(discovered)
        ? discovered
        : (discovered?.repos ?? []);
      const admitted = repos.find(
        (repo) =>
          pathKey(repo.repo_path ?? repo.path ?? "") === pathKey(project.path!),
      );
      // A healthy, explicit one-member private owner may have no index yet.
      // Let analyze submit its first job; unrelated/partial stores still fail.
      if (!admitted && !(local && repos.length === 0))
        throw new MemtraceAdmissionError(
          `Memtrace's workspace does not include ${project.name}. Reconnect to a workspace that includes this project.`,
        );
      const repoId =
        admitted?.repo_id ?? (admitted ? project.repoId : undefined);
      if (repoId) {
        const admission = unwrap(
          await active!.client.callTool(
            {
              name: "get_repository_stats",
              arguments: { repo_id: repoId, branch: project.branch },
            },
            undefined,
            { timeout: 30_000 },
          ),
        );
        if (
          admission?.repo_in_store === false ||
          admission?.diagnostic?.kind === "wrong_store"
        )
          throw new MemtraceAdmissionError(
            `Memtrace's workspace does not include ${project.name} (${project.repoId}). Start Memtrace with a workspace that includes this project, then reconnect. Project: ${project.path}`,
          );
      }
    } catch (error) {
      await disconnect();
      if (error instanceof MemtraceAdmissionError && !privateProject) {
        return this.open(project, true);
      }
      throw error;
    }
    if (this.closing) {
      await disconnect();
      throw Error("The Memtrace connection is closing.");
    }
    this.scopes.set(
      project.id,
      local
        ? {
            mode: "project",
            dataDirectory: local.dataDirectory,
            workspaceFile: local.workspaceFile,
          }
        : {
            mode: "workspace",
            dataDirectory:
              env.MEMTRACE_MEMDB_DATA_DIR ?? join(scope.directory, ".memdb"),
          },
    );
    const connection = active!;
    this.connecting.delete(connection.client);
    this.clients.set(project.id, connection);
    return connection.client;
  }
  async call(project: Project, name: string, args: Json): Promise<any> {
    const client = await this.connect(project);
    const query = (connection: Client) =>
      connection
        .callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
        .then(unwrap);
    try {
      return await query(client);
    } catch (error) {
      if (!pendingMemtraceOwner(error) && !disconnectedMemtraceClient(error))
        throw error;
      if (this.clients.get(project.id)?.client === client)
        this.clients.delete(project.id);
      // Watcher lifecycle step 4: verify the watch again on the next owner.
      this.watchChecked.delete(project.id);
      await client.close().catch(() => {});
      // A disconnected mutation could already have run. Reconnect reads and
      // definitely-not-executed pending-owner requests, without replaying writes.
      if (
        !pendingMemtraceOwner(error) &&
        !/^(get_|list_|find_|check_|query_)/.test(name)
      )
        throw error;
      const result = await query(await this.connect(project));
      if (this.watches.has(project.id))
        void this.watch(project).catch(() => {});
      return result;
    }
  }
  async analyze(
    project: Project,
    update: (note: string) => void,
    force = false,
  ): Promise<string> {
    const repoId = await this.index(project, update, force);
    // Watcher lifecycle step 1. Analysis is complete without waiting for it.
    void this.watch(project, repoId).catch(() => {});
    return repoId;
  }
  private async index(
    project: Project,
    update: (note: string) => void,
    force: boolean,
  ): Promise<string> {
    update("Connecting to the local Memtrace engine…");
    await this.connect(project, update);
    const result = await this.call(project, "list_indexed_repositories", {});
    const repos: Json[] = Array.isArray(result)
      ? result
      : (result.repos ?? result.repositories ?? []);
    const match = repos.find(
      (repo) =>
        pathKey(repo.repo_path ?? repo.path ?? "") === pathKey(project.path!),
    );
    if (!force && match?.index_state === "current") return match.repo_id;
    update("Reading the project structure and building its code graph…");
    const queueIndex = () =>
      this.call(project, "index_directory", {
        path: project.path,
        repo_id: match?.repo_id ?? project.repoId,
        incremental: !!match,
        skip_embed: false,
        branch: project.branch,
      });
    const job = await queueIndex();
    if (
      (job.skipped && job.reason === "peer_indexing") ||
      job.reason === "repository_busy"
    )
      return waitForPeerIndex(
        this,
        project,
        job,
        match?.repo_id ?? project.repoId,
        update,
      );
    if (job.skipped)
      throw new Error(
        "Another Memtrace index is running for this project. Reconnect when it completes.",
      );
    if (!job.job_id)
      throw new Error(
        "Memtrace did not return an indexing job. Check the engine connection.",
      );
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await this.call(project, "check_job_status", {
        job_id: job.job_id,
      });
      update(`Analyzing code · ${status.stage ?? status.status ?? "working"}`);
      if (status.status === "failed")
        throw new Error(status.error ?? "Project analysis failed");
      if (status.status === "completed") {
        const indexed = await this.call(
          project,
          "list_indexed_repositories",
          {},
        );
        const current: Json[] = Array.isArray(indexed)
          ? indexed
          : (indexed.repos ?? indexed.repositories ?? []);
        const admitted = current.find(
          (repo) =>
            pathKey(repo.repo_path ?? repo.path ?? "") ===
            pathKey(project.path!),
        );
        const repoId =
          admitted?.repo_id ??
          status.repo_id ??
          status.result?.repo_id ??
          match?.repo_id;
        if (typeof repoId !== "string")
          throw new Error(
            "The index completed without a verified repository identity. Reconnect before planning workers.",
          );
        let revision: Json | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          revision = await this.call(project, "get_query_revision", {
            repo_id: repoId,
          });
          if (revision?.ready === true && revision.branch === project.branch)
            return repoId;
          if (attempt < 2)
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(
          `Memtrace job ${job.job_id} completed, but source on branch ${project.branch} is not verified${revision?.reason ? ` (${revision.reason})` : ""}. Check local engine diagnostics before starting a worker.`,
        );
      }
    }
    throw new Error(
      "Analysis is still running. Reconnect to inspect its progress.",
    );
  }
  async qualify(project: Project, task: WorkItem): Promise<Evidence> {
    await this.watch(project);
    return collectEvidence(this, project, task);
  }
  /**
   * Re-measure only the stories a change is relevant to. Pass the files a
   * worker edited to limit the pass to stories bound to them. Returns the
   * outcome per considered story; the caller applies replacement evidence.
   */
  async refresh(
    project: Project,
    tasks: WorkItem[],
    changed?: string[],
  ): Promise<EvidenceRefresh[]> {
    await this.watch(project);
    return refreshEvidence(this, project, tasks, changed);
  }
  async close(): Promise<void> {
    this.closing = true;
    // A watch start already in flight gets a moment to finish, so it can be
    // stopped below. A hung engine call must not hold up shutdown.
    await Promise.race([
      Promise.allSettled([...this.watching.values()]),
      new Promise((resolve) => setTimeout(resolve, 3_000).unref()),
    ]);
    // Watcher lifecycle step 5. The engine reports "Not watching" for a watch
    // that is already gone, which needs no handling here.
    await Promise.allSettled(
      [...this.watches].map(([id, watch]) => {
        const client = this.clients.get(id)?.client;
        return watch.origin === "memcode" && client
          ? client.callTool(
              { name: "unwatch_directory", arguments: { path: watch.path } },
              undefined,
              { timeout: 5_000 },
            )
          : undefined;
      }),
    );
    this.watches.clear();
    this.watchChecked.clear();
    await this.owners.close();
    await Promise.allSettled(
      [...this.connecting].map((client) => client.close()),
    );
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled(
      [...this.clients.values()].map((c) => c.client.close()),
    );
    this.clients.clear();
    this.scopes.clear();
  }
}
