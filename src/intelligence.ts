export interface CodeFinding {
  id: string;
  key: string;
  name: string;
  file: string;
  line: number | null;
  nodeId?: string;
  kind: string;
  signal: "complexity" | "unreachable" | "churn";
  cognitive: number | null;
  cyclomatic: number | null;
  nesting: number | null;
  metricSource: "ast" | "unknown";
  confidence?: string;
  reason?: string;
}
export interface ComplexityDistribution {
  simple: number;
  moderate: number;
  high: number;
  critical: number;
}
export interface QualityMetrics {
  nodes: number | null;
  edges: number | null;
  symbols: number | null;
  files: number | null;
  communities: number | null;
  processes: number | null;
  measuredFunctions: number | null;
  estimatedFunctions: number | null;
  distribution: ComplexityDistribution | null;
  deadCodeCandidates: number | null;
  importCycles: number | null;
}
export interface QualitySnapshot {
  id: string;
  projectId: string;
  repoId: string;
  branch: string;
  capturedAt: string;
  basis: "memtrace-ast-distribution-v1";
  status: "current" | "partial" | "stale";
  measurementVersion: string | null;
  source: {
    commit: string | null;
    revision: string | null;
    dirty: boolean | null;
    indexReady: boolean | null;
    files: number | null;
    mismatchedFiles: number | null;
  };
  graph: {
    revision: string | null;
    stable: boolean;
    indexedAt: string | null;
    dataDirectory: string | null;
    scope: "workspace" | "project" | "unknown";
  };
  metrics: QualityMetrics;
  hotspots: CodeFinding[];
  deadCode: CodeFinding[];
  limitations: string[];
  tools: string[];
}
export type IntelligenceSection =
  | "architecture"
  | "flows"
  | "flow"
  | "api"
  | "history"
  | "style"
  | "governance"
  | "impact";
export interface IntelligenceItem {
  id: string;
  title: string;
  description: string;
  file?: string;
  line?: number;
  badge?: string;
  value?: string;
  action?: "flow";
  group?: string;
}
export interface IntelligenceDetail {
  section: IntelligenceSection;
  title: string;
  summary: string;
  items: IntelligenceItem[];
  notes: string[];
  capturedAt: string;
  graphRevision: string | null;
}
export type QualityMetric =
  | "elevated"
  | "elevatedRate"
  | "deadCode"
  | "importCycles"
  | "measuredFunctions";
export const qualityMetricLabels: Record<QualityMetric, string> = {
  elevated: "Elevated-complexity functions",
  elevatedRate: "Elevated-complexity share",
  deadCode: "Dead-code candidates",
  importCycles: "Import cycles",
  measuredFunctions: "AST-measured functions",
};

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function relativeFile(file: string, root?: string): string {
  const path = file.replaceAll("\\", "/"),
    base = (root ?? "")
      .replace(/^\\\\\?\\/, "")
      .replaceAll("\\", "/")
      .replace(/\/$/, "");
  return base && path.toLowerCase().startsWith(base.toLowerCase() + "/")
    ? path.slice(base.length + 1)
    : path;
}
export function findingFromRow(
  row: Record<string, any>,
  signal: CodeFinding["signal"],
  root?: string,
): CodeFinding {
  const file = relativeFile(String(row.file_path ?? row.file ?? ""), root),
    name = String(row.name ?? row.function_name ?? "Unnamed symbol");
  const ast = row.complexity_source === "ast";
  const key = `${file}::${row.scope_path ?? name}`;
  return {
    id: String(row.node_id ?? row.id ?? key),
    key,
    name,
    file,
    line: numberOrNull(row.start_line ?? row.line),
    nodeId: typeof row.node_id === "string" ? row.node_id : undefined,
    kind: String(row.kind ?? "Function"),
    signal,
    cognitive: ast ? numberOrNull(row.cognitive_complexity) : null,
    cyclomatic: ast
      ? numberOrNull(row.complexity ?? row.cyclomatic_complexity)
      : null,
    nesting: ast ? numberOrNull(row.max_nesting) : null,
    metricSource: ast ? "ast" : "unknown",
    confidence: typeof row.confidence === "string" ? row.confidence : undefined,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}
export function qualityValue(
  snapshot: QualitySnapshot,
  metric: QualityMetric,
): number | null {
  const distribution = snapshot.metrics.distribution;
  if (metric === "elevated")
    return distribution ? distribution.high + distribution.critical : null;
  if (metric === "elevatedRate") {
    const count = snapshot.metrics.measuredFunctions;
    return distribution && count !== null && count > 0
      ? ((distribution.high + distribution.critical) / count) * 100
      : null;
  }
  if (metric === "deadCode") return snapshot.metrics.deadCodeCandidates;
  if (metric === "importCycles") return snapshot.metrics.importCycles;
  return snapshot.metrics.measuredFunctions;
}
export function comparableSnapshots(
  snapshots: QualitySnapshot[],
  latest: QualitySnapshot,
  metric: QualityMetric,
): QualitySnapshot[] {
  return snapshots
    .filter(
      (snapshot) =>
        snapshot.projectId === latest.projectId &&
        snapshot.repoId === latest.repoId &&
        snapshot.branch === latest.branch &&
        snapshot.basis === latest.basis &&
        snapshot.measurementVersion === latest.measurementVersion &&
        snapshot.graph.dataDirectory === latest.graph.dataDirectory &&
        (snapshot.measurementVersion !== null ||
          metric === "deadCode" ||
          metric === "importCycles") &&
        snapshot.source.indexReady === true &&
        snapshot.graph.stable &&
        qualityValue(snapshot, metric) !== null,
    )
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
export function compareFindings(
  before: QualitySnapshot,
  after: QualitySnapshot,
) {
  if (
    before.projectId !== after.projectId ||
    before.repoId !== after.repoId ||
    before.branch !== after.branch ||
    before.basis !== after.basis ||
    before.measurementVersion !== after.measurementVersion ||
    before.graph.dataDirectory !== after.graph.dataDirectory ||
    before.measurementVersion === null ||
    !before.graph.stable ||
    !after.graph.stable ||
    before.source.indexReady !== true ||
    after.source.indexReady !== true
  )
    return [];
  const previous = new Map(
    before.hotspots.map((finding) => [finding.key, finding]),
  );
  return after.hotspots
    .flatMap((finding) => {
      const old = previous.get(finding.key);
      return old &&
        old.metricSource === "ast" &&
        finding.metricSource === "ast" &&
        old.cognitive !== null &&
        finding.cognitive !== null
        ? [{ finding, before: old, delta: finding.cognitive - old.cognitive }]
        : [];
    })
    .sort((a, b) => a.delta - b.delta);
}
