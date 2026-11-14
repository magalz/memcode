import { basename } from "node:path";
import type { Evidence, Project, WorkItem } from "../src/shared";
import { git, now } from "./local";

interface GraphClient {
  call(
    project: Project,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any>;
}
export async function collectEvidence(
  client: GraphClient,
  project: Project,
  task: WorkItem,
): Promise<Evidence> {
  const measuredAt = now();
  if (!project.repoId || project.analysis !== "ready")
    return {
      state: "unavailable",
      symbols: [],
      incomplete: true,
      note: "Analyze this project to add measured code context.",
      measuredAt,
    };
  const searches = task.scope?.length
    ? task.scope.slice(0, 3).map((file) => ({
        file_path: file,
        query: basename(file).replace(/\.[^.]+$/, ""),
      }))
    : [{ query: task.title + " " + task.description }];
  const rows = new Map<string, any>();
  let incomplete = false,
    graphRevision: string | undefined;
  for (const search of searches) {
    const result = await client.call(project, "find_code", {
      repo_id: project.repoId,
      branch: project.branch,
      ...search,
      limit: 6,
      include_context: true,
    });
    incomplete ||=
      result.status !== "complete" ||
      !!result.context?.incomplete_reasons?.length;
    graphRevision = result._meta?.graph_revision?.token ?? graphRevision;
    for (const row of result.results ?? [])
      rows.set(row.file_path + "::" + row.name, row);
  }
  const selected = [...rows.values()].slice(0, 8);
  const symbols: Evidence["symbols"] = [];
  for (const row of selected) {
    if (row.kind === "File") continue;
    symbols.push({
      name: row.name,
      file: row.file_path,
      line: row.symbol_start_line ?? row.start_line,
    });
  }
  for (const symbol of symbols.slice(0, 5)) {
    try {
      const context = await client.call(project, "get_symbol_context", {
        repo_id: project.repoId,
        branch: project.branch,
        symbol: symbol.name,
        file_path: symbol.file,
        limit: 3,
      });
      if (context.found) {
        symbol.nodeId = context.symbol.node_id;
        symbol.file = context.symbol.file_path;
        symbol.line = context.symbol.start_line;
      }
      const result = await client.call(
        project,
        "get_function_quality_metrics",
        {
          repo_id: project.repoId,
          branch: project.branch,
          function_name: symbol.name,
          file_path: symbol.file,
        },
      );
      const m = result.function;
      if (!m) {
        incomplete = true;
        continue;
      }
      symbol.metricSource = m.complexity_source === "ast" ? "ast" : "estimated";
      if (typeof m.cognitive_complexity === "number")
        symbol.cognitive = m.cognitive_complexity;
      if (typeof m.complexity === "number") symbol.cyclomatic = m.complexity;
      if (typeof m.max_nesting === "number") symbol.nesting = m.max_nesting;
      if (symbol.metricSource !== "ast") incomplete = true;
    } catch {
      incomplete = true;
    }
  }
  if (symbols.length > 5) incomplete = true;
  let affected: number | undefined,
    affectedProcesses: number | undefined,
    affectedFiles: number | undefined;
  if (symbols[0])
    try {
      const impact = await client.call(project, "get_impact", {
        repo_id: project.repoId,
        branch: project.branch,
        target: symbols[0].nodeId ?? symbols[0].name,
        file_path: symbols[0].file,
        direction: "upstream",
        depth: 3,
      });
      if (typeof impact.total_affected === "number")
        affected = impact.total_affected;
      affectedProcesses =
        impact.affected_processes_count ??
        (Array.isArray(impact.affected_processes)
          ? impact.affected_processes.length
          : undefined);
      affectedFiles =
        impact.affected_files_count ??
        (Array.isArray(impact.affected_files)
          ? impact.affected_files.length
          : undefined);
      incomplete ||=
        !impact.found ||
        !!impact.graph_incomplete ||
        !!impact.truncated ||
        impact.risk === "UNKNOWN" ||
        !!impact.total_affected_is_lower_bound;
    } catch {
      incomplete = true;
    }
  let sourceRevision: string | undefined;
  if (project.path)
    try {
      sourceRevision = await git(project.path, ["rev-parse", "HEAD"]);
      if (await git(project.path, ["status", "--porcelain"])) incomplete = true;
    } catch {
      incomplete = true;
    }
  if (!symbols.length) incomplete = true;
  return {
    state: incomplete ? "partial" : "measured",
    symbols,
    affected,
    affectedFiles,
    affectedProcesses,
    incomplete,
    sourceRevision,
    graphRevision,
    measuredAt,
    note: !symbols.length
      ? "No source anchors matched. The route remains provisional and starts above the fast tier."
      : incomplete
        ? "Source measurements are available, with incomplete scope or dependency coverage. Impact refers to the primary source anchor."
        : "AST measurements and observed primary-anchor impact are attached. Envelope thresholds remain provisional policy.",
  };
}
