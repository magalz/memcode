import { readFile } from "node:fs/promises";
import type { ContextRequest } from "./contracts";
import {
  checkedPath,
  literalSource,
  normalizedPath,
  repoFiles,
  visible,
} from "./source";
import { queryScope, rowVisible, type Workflow } from "./workflow";
import type { Row } from "./query";
import { recordSavedReadEvidence, savedDeclarationRows } from "./saved-read";

type FindRequest = Extract<ContextRequest, { capability: "find" }>;
export async function searchRows(
  request: FindRequest,
  context: Workflow,
): Promise<Row[]> {
  const rows: Row[] = [],
    queries = await planQueries(request.query, context);
  for (const terms of queries) {
    const result = await context.query("find_code", {
      ...queryScope(context.binding),
      query: terms,
      ...(request.scope ? { file_path: request.scope } : {}),
      limit: 8,
      include_context: false,
      include_diagnostics: true,
      include_dependency_checks: false,
      strict_scope: true,
    });
    recordSavedReadEvidence(result, context.binding, context.pack, "find_code");
    for (const row of [
      ...savedDeclarationRows(result, context.binding),
      ...(result?.results ?? []),
    ])
      if (
        rowVisible(context.binding, row) &&
        !rows.some((r) => r.file_path === row.file_path && r.name === row.name)
      )
        rows.push(row);
  }
  await rankRows(request.query, rows, context);
  if (!rows.length)
    context.pack.coverage.unknown.push(
      "No indexed match observed. Use find mode=text with a narrow scope and an explicit fallbackReason if needed.",
    );
  return rows;
}
async function planQueries(
  query: string,
  { assistant, pack }: Workflow,
): Promise<string[]> {
  if (!assistant) return [query];
  const at = performance.now();
  try {
    const plan = await assistant.plan(query);
    if (
      typeof plan.query !== "string" ||
      !plan.query.trim() ||
      plan.query.length > 300
    )
      throw new Error("Local plan failed validation");
    pack.telemetry.localModel = {
      state: "used",
      model: assistant.model,
      durationMs: performance.now() - at,
      usage: plan.usage,
      planQuery: plan.query,
    };
    return [...new Set([query, plan.query])];
  } catch (error) {
    pack.telemetry.localModel = {
      state: "fallback",
      model: assistant.model,
      note: (error as Error).message,
      durationMs: performance.now() - at,
    };
    return [query];
  }
}
async function rankRows(
  query: string,
  rows: Row[],
  { assistant, pack }: Workflow,
): Promise<void> {
  if (!assistant || rows.length < 2) return;
  const at = performance.now();
  try {
    const ranking = await assistant.rank(
      query,
      rows.map((r, i) => ({
        id: String(i),
        symbol: r.name,
        file: r.file_path,
      })),
    );
    validateRanking(ranking.ids, rows.length);
    const indices = [
      ...ranking.ids.map(Number),
      ...rows.map((_, i) => i).filter((i) => !ranking.ids.includes(String(i))),
    ];
    const reordered = indices.map((i) => rows[i]);
    rows.splice(0, rows.length, ...reordered);
    pack.telemetry.localModel.usage = {
      planning: pack.telemetry.localModel.usage,
      ranking: ranking.usage,
    };
    pack.telemetry.localModel.rankedIds = ranking.ids;
  } catch (error) {
    pack.telemetry.localModel.note = `Ranking ignored: ${(error as Error).message}`;
  }
  pack.telemetry.localModel.durationMs =
    (pack.telemetry.localModel.durationMs ?? 0) + performance.now() - at;
}
function validateRanking(ids: string[], count: number): void {
  if (
    !Array.isArray(ids) ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) => !Array.from({ length: count }, (_, i) => String(i)).includes(id),
    )
  )
    throw new Error("Local ranking returned unknown candidate IDs");
}
export async function textFallback(
  request: FindRequest,
  context: Workflow,
): Promise<void> {
  if (!request.scope || !request.fallbackReason)
    throw new Error(
      "Text fallback requires a narrow scope and explicit fallbackReason",
    );
  const { binding, pack } = context;
  const files = (await repoFiles(binding.project.path!)).filter((f) =>
    visible(f, [normalizedPath(request.scope!)]),
  );
  pack.telemetry.fallback = {
    reason: request.fallbackReason,
    scope: request.scope,
    filesScanned: 0,
  };
  for (const file of files.slice(0, 250)) {
    const matches = await fileMatches(file, request.query, context);
    pack.evidence.push(...matches);
    if (pack.evidence.length >= 8) {
      pack.evidence = pack.evidence.slice(0, 8);
      break;
    }
  }
  if (files.length > 250 || pack.evidence.length >= 8)
    pack.coverage.truncated.push(
      "Scoped text fallback stopped at 250 files or 8 matches.",
    );
  pack.coverage.unknown.push(
    "Text fallback is literal substring evidence; it does not prove callers, semantic equivalence or reachability.",
  );
}
async function fileMatches(
  file: string,
  query: string,
  { binding, pack }: Workflow,
) {
  const path = await checkedPath(binding, file),
    text = await readFile(path.absolute, "utf8");
  pack.telemetry.fallback!.filesScanned++;
  if (Buffer.byteLength(text) > 1024 * 1024 || text.includes("\0")) {
    pack.coverage.truncated.push(
      `Text fallback skipped binary/oversized ${file}`,
    );
    return [];
  }
  const lines = text.split(/\r?\n/),
    matches = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].toLowerCase().includes(query.toLowerCase())) {
      matches.push(
        await literalSource(
          binding,
          file,
          Math.max(1, i - 2),
          i + 4,
          "text match",
        ),
      );
      if (matches.length >= 8) break;
    }
  return matches;
}
