import type { ContextBinding, ContextPack, GraphClient } from "./contracts";

export type Row = Record<string, any>;
export type Query = (name: string, args: Row) => Promise<Row | null>;

export function scopedQuery(
  engine: GraphClient,
  binding: ContextBinding,
  calls: string[],
  coverage: ContextPack["coverage"],
): Query {
  return async (name, args) => {
    calls.push(name);
    try {
      const result = await engine.call(binding.project, name, args);
      checkAdmission(result);
      recordCoverage(name, result, coverage);
      return result ?? null;
    } catch (error) {
      coverage.unknown.push(`${name}: ${(error as Error).message}`);
      return null;
    }
  };
}
function checkAdmission(result: Row | null): void {
  if (
    result?.status === "repo_not_in_store" ||
    result?.error === "repo_not_in_store" ||
    result?.diagnostic?.repo_lives_in
  )
    throw new Error(
      "Repository is not admitted by this Memtrace runtime; route to its verified owner.",
    );
}
function recordCoverage(
  name: string,
  result: Row | null,
  coverage: ContextPack["coverage"],
): void {
  if (!result) return;
  if (
    result.truncated ||
    result.graph_truncated ||
    result.graph_incomplete ||
    result.total_affected_is_lower_bound
  )
    coverage.truncated.push(
      `${name}: backend reports incomplete or truncated graph coverage.`,
    );
  if (
    result.status &&
    !["complete", "ok", "current", "observed"].includes(result.status)
  )
    coverage.unknown.push(`${name}: ${result.status}`);
  if (result.incomplete_reasons?.length)
    coverage.unknown.push(
      `${name}: ${JSON.stringify(result.incomplete_reasons)}`,
    );
}
