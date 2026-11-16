import type { ContextRequest } from "./contracts";
import {
  queryScope,
  relativePath,
  rowVisible,
  scopeAllowed,
  type Workflow,
} from "./workflow";
import type { Row } from "./query";
import { recordSavedReadEvidence } from "./saved-read";

type TargetRequest = Exclude<ContextRequest, { capability: "find" }>;
export async function targetRows(
  request: TargetRequest,
  context: Workflow,
): Promise<{ rows: Row[]; ambiguous: boolean }> {
  const targets =
    request.capability === "understand" ? [request.target] : request.targets;
  const rows: Row[] = [];
  let ambiguous = false;
  for (const target of targets) {
    const result = await resolveTarget(target, context);
    if (result.ambiguous) {
      ambiguous = true;
      continue;
    }
    if (!result.symbol) continue;
    rows.push(result.symbol);
    if (request.capability === "assess")
      await assessTarget(result.symbol, context);
  }
  return { rows, ambiguous };
}
async function resolveTarget(
  target: { symbol: string; file?: string },
  context: Workflow,
): Promise<{ symbol?: Row; ambiguous?: boolean }> {
  const { binding, pack, query } = context;
  if (target.file && !scopeAllowed(binding, relativePath(binding, target.file)))
    throw new Error("Target is outside this worker's visibility");
  const result = await query("get_symbol_context", {
    ...queryScope(binding),
    symbol: target.symbol,
    ...(target.file ? { file_path: target.file } : {}),
    include_references: true,
    limit: 12,
    viewer_agent_id: binding.workerId,
  });
  recordSavedReadEvidence(result, binding, pack, "get_symbol_context");
  if (result?.ambiguous || (result?.candidates?.length && !result?.symbol)) {
    for (const c of result.candidates ?? [])
      pack.candidates.push({
        symbol: c.name ?? target.symbol,
        file: relativePath(binding, c.file_path ?? c.file ?? ""),
        line: c.start_line,
        nodeId: c.node_id,
      });
    return { ambiguous: true };
  }
  if (!result?.found || !result.symbol || !rowVisible(binding, result.symbol)) {
    pack.coverage.unknown.push(
      `Target unresolved: ${target.symbol}. Supply a find result's exact file and symbol handle.`,
    );
    return {};
  }
  recordRelationships(target.symbol, result, context);
  return { symbol: result.symbol };
}
function recordRelationships(
  symbol: string,
  result: Row,
  { pack }: Workflow,
): void {
  const relations = {
    callers: result.callers ?? [],
    callees: result.callees ?? [],
    references: result.references ?? [],
    processes: result.processes ?? [],
    callers_conclusive: result.callers_conclusive ?? false,
    pagination: result.pagination ?? null,
    omitted: result.omitted ?? null,
  };
  pack.evidence.push({
    id: `relationships:${result.symbol.node_id ?? symbol}`,
    kind: "relationships",
    text: JSON.stringify(relations),
    origin: "get_symbol_context",
  });
  pack.coverage.unknown.push(
    `${symbol}: indexed relationships are observed evidence, not complete reachability or a runtime trace.`,
  );
}
async function assessTarget(
  symbol: Row,
  { binding, pack, query }: Workflow,
): Promise<void> {
  const preflight = await query("preflight_check", {
    ...queryScope(binding),
    node_id: symbol.node_id,
    symbol: symbol.name,
    file_path: symbol.file_path,
  });
  if (preflight)
    pack.evidence.push({
      id: `assessment:${symbol.node_id ?? symbol.name}`,
      kind: "assessment",
      text: JSON.stringify(preflight),
      origin:
        "preflight_check; verification suggestions are not executed checks",
    });
}
