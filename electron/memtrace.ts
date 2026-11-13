import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Evidence, Project, WorkItem } from "../src/shared";
import { childEnv, findCommand, now } from "./local";

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
  private clients = new Map<
    string,
    { client: Client; transport: StdioClientTransport }
  >();
  constructor(private readonly configuredPath: () => string) {}
  async connect(project: Project): Promise<Client> {
    const existing = this.clients.get(project.id);
    if (existing) return existing.client;
    if (!project.path) throw new Error("Choose a local project folder first.");
    const command = await findCommand("memtrace", this.configuredPath());
    if (!command)
      throw new Error(
        "Memtrace was not found. Install it or choose its executable in Settings.",
      );
    const env = Object.fromEntries(
      Object.entries({ ...childEnv(), ...command.env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const transport = new StdioClientTransport({
      command: command.command,
      args: [...command.prefix, "mcp"],
      cwd: project.path,
      env,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "memcode", version: "0.1.0" },
      { capabilities: {} },
    );
    const timer = setTimeout(() => void transport.close(), 30_000);
    try {
      await client.connect(transport);
    } finally {
      clearTimeout(timer);
    }
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
    if (match?.index_state === "current") return match.repo_id;
    update("Reading the project structure and building its code graph…");
    const job = await this.call(project, "index_directory", {
      path: project.path,
      repo_id: match?.repo_id ?? project.repoId,
      incremental: !!match,
      skip_embed: false,
    });
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
      if (status.status === "completed")
        return (
          status.repo_id ?? match?.repo_id ?? project.repoId ?? project.name
        );
    }
    throw new Error(
      "Analysis is still running. Reconnect to inspect its progress.",
    );
  }
  async qualify(project: Project, task: WorkItem): Promise<Evidence> {
    const measuredAt = now();
    if (!project.repoId || project.analysis !== "ready")
      return {
        state: "unavailable",
        symbols: [],
        incomplete: true,
        note: "Analyze this project to add measured code context.",
        measuredAt,
      };
    const found = await this.call(project, "find_code", {
      repo_id: project.repoId,
      query: task.title + " " + task.description,
      limit: 5,
      include_context: true,
    });
    const rows: Json[] = found.results ?? [];
    const symbols: Evidence["symbols"] = rows.map((row) => ({
      name: row.name,
      file: row.file_path,
      line: row.start_line,
    }));
    let incomplete =
      found.status !== "complete" || !!found.incomplete_reasons?.length;
    for (const symbol of symbols.slice(0, 3)) {
      try {
        const metrics = await this.call(
          project,
          "get_function_quality_metrics",
          {
            repo_id: project.repoId,
            function_name: symbol.name,
            file_path: symbol.file,
          },
        );
        const m = metrics.function ?? metrics.metrics ?? metrics;
        if (typeof m.cognitive_complexity === "number")
          symbol.cognitive = m.cognitive_complexity;
        if (typeof m.complexity === "number" && m.complexity_source === "ast")
          symbol.cyclomatic = m.complexity;
      } catch {
        incomplete = true;
      }
    }
    let affected: number | undefined;
    if (symbols[0]) {
      try {
        const impact = await this.call(project, "get_impact", {
          repo_id: project.repoId,
          target: symbols[0].name,
          file_path: symbols[0].file,
          direction: "upstream",
          depth: 2,
        });
        if (typeof impact.total_affected === "number")
          affected = impact.total_affected;
        incomplete ||=
          !!impact.graph_incomplete ||
          !!impact.truncated ||
          impact.risk === "UNKNOWN";
      } catch {
        incomplete = true;
      }
    }
    return {
      state: symbols.length ? (incomplete ? "partial" : "measured") : "partial",
      symbols,
      affected,
      incomplete,
      note: !symbols.length
        ? "No matching symbols were found. New code or broader discovery may be needed."
        : incomplete
          ? "Relevant source found. Some metrics or dependency coverage remain incomplete."
          : "Source context is ready. Measurements are evidence, not a guarantee of task difficulty.",
      measuredAt,
    };
  }
  async preflight(
    project: Project,
    task: WorkItem,
    agentId: string,
  ): Promise<void> {
    if (!project.repoId || !task.evidence?.symbols.length) return;
    const result = await this.call(project, "fleet_preflight", {
      repo_id: project.repoId,
      branch: project.branch,
      agent_id: agentId,
      touched: task.evidence.symbols.map((s) => s.name),
    });
    if (result.has_conflicts || result.active_conflicts?.length)
      throw new Error(
        "Fleet found overlapping work. Review the active workers before starting this item.",
      );
  }
  async publish(
    project: Project,
    task: WorkItem,
    agentId: string,
  ): Promise<void> {
    if (!project.repoId || !task.evidence?.symbols.length) return;
    await this.call(project, "fleet_publish_intent", {
      repo_id: project.repoId,
      branch: project.branch,
      agent_id: agentId,
      assignment: task.title + "\n" + task.description,
      intent: { feature_add: { surface: "new_symbol" } },
      touched: task.evidence.symbols.map((s) => s.name),
    });
  }
  async episode(
    project: Project,
    task: WorkItem,
    agentId: string,
  ): Promise<void> {
    if (!project.repoId || !task.evidence?.symbols.length) return;
    await this.call(project, "fleet_record_episode", {
      repo_id: project.repoId,
      branch: project.branch,
      agent_id: agentId,
      intent: { feature_add: { surface: "new_symbol" } },
      touched: task.evidence.symbols.map((s) => s.name),
      metadata: {
        source: "memcode",
        task_id: task.id,
        worktree: task.run.worktree,
        scope_basis: "qualification_seeds_only",
        declared_intent: "feature_implementation",
        actual_diff_classification: "not_performed",
      },
    });
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map((c) => c.client.close()),
    );
    this.clients.clear();
  }
}
