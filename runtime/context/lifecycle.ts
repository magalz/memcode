import { randomUUID } from "node:crypto";
import type {
  ContextBinding,
  ContextPack,
  ContextRequest,
  SourceRevision,
} from "./contracts";
import type { RetrievalAssistant } from "./local-model";
import type { Query, Row } from "./query";
import { hash, sourceRevision } from "./source";
import { evidenceFiles, loadConstraints } from "./constraints";
import { fitPack, type PendingPage } from "./budget";

export function initialPack(
  binding: ContextBinding,
  request: ContextRequest,
  source: SourceRevision,
  before: Row | null,
  calls: string[],
  coverage: ContextPack["coverage"],
  assistant?: RetrievalAssistant,
): ContextPack {
  const graph = before?.token ?? before?._meta?.graph_revision?.token ?? null;
  if (!before?.ready)
    coverage.unknown.push(
      "Graph/source alignment is unverified; live excerpts are authoritative for text, indexed relationships may be stale or missing.",
    );
  return {
    version: 1,
    capability: request.capability,
    requestId: randomUUID(),
    binding: {
      repoId: binding.project.repoId!,
      workerId: binding.workerId,
      branch: binding.branch,
      scope: binding.scope,
    },
    revision: {
      ...source,
      graph,
      graphSource: before?.source_revision ?? null,
      graphReady: before?.ready === true,
      stable: false,
      constraintsDigest: "",
    },
    constraints: [],
    evidence: [],
    candidates: [],
    coverage,
    telemetry: {
      cacheHit: false,
      durationMs: 0,
      backendCalls: calls,
      fallback: null,
      localModel: { state: assistant ? "not-requested" : "disabled" },
      responseChars: 0,
      estimatedTokens: 0,
      tokenMethod: "ceil(characters/4), not provider usage",
    },
  };
}
export async function finishPack(
  binding: ContextBinding,
  pack: ContextPack,
  query: Query,
  ambiguous: boolean,
  started: number,
): Promise<void> {
  const { graph, fingerprint } = pack.revision;
  const after = await query("get_query_revision", {
    repo_id: binding.project.repoId,
    ...(graph ? { expected_revision: graph } : {}),
  });
  const source = await sourceRevision(binding.project.path!);
  pack.revision.stable =
    source.fingerprint === fingerprint &&
    source.branch === binding.branch &&
    !!graph &&
    after?.token === graph &&
    after?.requested_revision_matches !== false &&
    after?.source_unchanged_during_observation !== false;
  const { coverage } = pack;
  if (!pack.revision.stable) {
    coverage.unknown.push(
      "Source or graph changed during retrieval, or revision is unknown. Refresh before acting.",
    );
    coverage.canAct = false;
  }
  coverage.status = coverageStatus(ambiguous, coverage);
  if (
    ambiguous ||
    coverage.unknown.some((reason) =>
      /^(governing_rules:|Source not verified|Target unresolved)/.test(reason),
    )
  )
    coverage.canAct = false;
  pack.evidence.sort(
    (a, b) => Number(b.kind === "source") - Number(a.kind === "source"),
  );
  pack.telemetry.durationMs = Math.round(performance.now() - started);
}
function coverageStatus(
  ambiguous: boolean,
  coverage: ContextPack["coverage"],
): ContextPack["coverage"]["status"] {
  if (ambiguous) return "ambiguous";
  return coverage.unknown.length || coverage.truncated.length
    ? "partial"
    : "observed";
}
export async function resumePack(
  binding: ContextBinding,
  request: ContextRequest,
  pack: ContextPack,
  pages: Map<string, PendingPage>,
  query: Query,
): Promise<ContextPack> {
  const page = pages.get(request.continuation!);
  pages.delete(request.continuation!);
  validatePage(page, request, pack);
  const readyPage = page!;
  const files = [
    ...new Set(
      readyPage.pack.candidates
        .map((c) => c.file)
        .concat(evidenceFiles(readyPage.pack)),
    ),
  ];
  const current = await loadConstraints(binding, files, query);
  if (
    hash(JSON.stringify(current)) !== readyPage.pack.revision.constraintsDigest
  )
    throw new Error(
      "Governance changed during continuation; repeat the original request to refresh every constraint.",
    );
  await verifyPageRevision(binding, pack, query);
  readyPage.pack.telemetry.cacheHit = false;
  readyPage.pack.telemetry.backendCalls = pack.telemetry.backendCalls;
  return fitPack(readyPage.pack, request.budgetChars, pages, readyPage.offset);
}
function validatePage(
  page: PendingPage | undefined,
  request: ContextRequest,
  pack: ContextPack,
): void {
  if (
    !page ||
    page.expires < Date.now() ||
    page.fingerprint !== pack.revision.fingerprint ||
    page.graph !== pack.revision.graph
  )
    throw new Error(
      "Continuation expired or source/graph changed; repeat the original request to refresh constraints.",
    );
  if (page.pack.capability !== request.capability)
    throw new Error("Continuation capability mismatch");
}
async function verifyPageRevision(
  binding: ContextBinding,
  pack: ContextPack,
  query: Query,
): Promise<void> {
  const { graph, fingerprint } = pack.revision;
  const end = await query("get_query_revision", {
    repo_id: binding.project.repoId,
    ...(graph ? { expected_revision: graph } : {}),
  });
  const source = await sourceRevision(binding.project.path!);
  if (
    source.fingerprint !== fingerprint ||
    (end?.token ?? null) !== graph ||
    pack.coverage.unknown.some((x) => x.startsWith("governing_rules:"))
  )
    throw new Error(
      "Source, graph or governance coverage changed during continuation; refresh the original request.",
    );
}
