import { collectEvidence } from "./qualification";
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

export class MemtraceEngine {
  private opening = new Map<string, Promise<Client>>();
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
  async connect(project: Project): Promise<Client> {
    const existing = this.clients.get(project.id);
    if (existing) return existing.client;
    const pending = this.opening.get(project.id);
    if (pending) return pending;
    const connection = this.open(project).finally(() =>
      this.opening.delete(project.id),
    );
    this.opening.set(project.id, connection);
    return connection;
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
      { name: "memcode", version: "0.2.0" },
      { capabilities: {} },
    );
    const timer = setTimeout(() => void transport.close(), 30_000);
    try {
      await client.connect(transport);
      const discovered = unwrap(
        await client.callTool(
          { name: "list_indexed_repositories", arguments: {} },
          undefined,
          { timeout: 30_000 },
        ),
      );
      const repos: Json[] = Array.isArray(discovered)
        ? discovered
        : (discovered?.repos ?? []);
      const pathKey = (value: string) =>
        value
          .replace(/^\\\\\?\\/, "")
          .replaceAll("\\", "/")
          .replace(/\/$/, "")
          .toLowerCase();
      const admitted = repos.find(
        (repo) =>
          pathKey(repo.repo_path ?? repo.path ?? "") === pathKey(project.path!),
      );
      if (!admitted)
        throw new MemtraceAdmissionError(
          `Memtrace's workspace does not include ${project.name}. Reconnect to a workspace that includes this project.`,
        );
      const repoId = project.repoId ?? admitted.repo_id;
      if (repoId) {
        const admission = unwrap(
          await client.callTool(
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
      await client.close().catch(() => {});
      if (error instanceof MemtraceAdmissionError && !privateProject) {
        clearTimeout(timer);
        return this.open(project, true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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
    this.clients.set(project.id, { client, transport });
    return client;
  }
  async call(project: Project, name: string, args: Json): Promise<any> {
    const client = await this.connect(project);
    return unwrap(
      await client.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000,
      }),
    );
  }
  async analyze(
    project: Project,
    update: (note: string) => void,
    force = false,
  ): Promise<string> {
    update("Connecting to the local Memtrace engine…");
    const result = await this.call(project, "list_indexed_repositories", {});
    const repos: Json[] = Array.isArray(result) ? result : (result.repos ?? []);
    const normalize = (s: string) =>
      s
        .replace(/^\\\\\?\\/, "")
        .replaceAll("\\", "/")
        .replace(/\/$/, "")
        .toLowerCase();
    const match = repos.find(
      (repo) =>
        normalize(repo.repo_path ?? repo.path ?? "") ===
        normalize(project.path!),
    );
    if (!force && match?.index_state === "current") return match.repo_id;
    update("Reading the project structure and building its code graph…");
    const queueIndex = () =>
      this.call(project, "index_directory", {
        path: project.path,
        repo_id: match?.repo_id ?? project.repoId,
        incremental: !!match,
        skip_embed: false,
      });
    let job = await queueIndex();
    // A cold standalone MCP may be admitting its first index under the same
    // process's peer lease. Keep that client alive and let it publish readiness.
    for (
      let attempt = 0;
      job.skipped && job.reason === "peer_indexing" && attempt < 6;
      attempt++
    ) {
      update("Memtrace is preparing this project's code index…");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const binding = await this.call(project, "get_query_revision", {
        repo_id: match?.repo_id ?? project.repoId,
      }).catch(() => null);
      if (
        binding?.ready === true &&
        binding.branch === project.branch &&
        typeof (match?.repo_id ?? project.repoId) === "string"
      )
        return match?.repo_id ?? project.repoId!;
      job = await queueIndex();
    }
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
          : (indexed.repos ?? []);
        const admitted = current.find(
          (repo) =>
            normalize(repo.repo_path ?? repo.path ?? "") ===
            normalize(project.path!),
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
        return repoId;
      }
    }
    throw new Error(
      "Analysis is still running. Reconnect to inspect its progress.",
    );
  }
  async qualify(project: Project, task: WorkItem): Promise<Evidence> {
    return collectEvidence(this, project, task);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled(
      [...this.clients.values()].map((c) => c.client.close()),
    );
    this.clients.clear();
    this.scopes.clear();
  }
}
