import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Code2,
  GitBranch,
  Layers3,
  Plus,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { AppState, Project, WorkItem } from "../shared";
import type {
  CodeFinding,
  IntelligenceDetail,
  QualitySnapshot,
} from "../intelligence";
import { Spinner } from "./UI";

export interface IntelligenceProps {
  state: AppState;
  project: Project;
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}
export const countLabel = (value: number | null) =>
  value === null ? "—" : value.toLocaleString();
export const checkpointLabel = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export function projectCheckpoints(
  state: AppState,
  project: Project,
): QualitySnapshot[] {
  return (state.qualitySnapshots ?? [])
    .filter((snapshot) => snapshot.projectId === project.id)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
export function useCapture(
  project: Project,
  notify: (message: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const capture = async (refreshIndex = false) => {
    setBusy(true);
    try {
      const snapshot = await window.memcode.refreshIntelligence(
        project.id,
        refreshIndex,
      );
      notify(
        snapshot.status === "current"
          ? "Measured checkpoint recorded."
          : `Checkpoint recorded with ${snapshot.status} coverage. Review its evidence notes.`,
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, capture };
}
export function CaptureButtons({
  project,
  busy,
  capture,
}: {
  project: Project;
  busy: boolean;
  capture: (refresh: boolean) => Promise<void>;
}) {
  return (
    <div className="intelligence-actions">
      <button
        className="button secondary"
        disabled={
          busy ||
          project.example ||
          ["connecting", "indexing"].includes(project.analysis)
        }
        onClick={() => void capture(false)}
      >
        {busy ? <Spinner size={13} /> : <Plus size={13} />}Record checkpoint
      </button>
      <button
        className="button primary"
        disabled={
          busy ||
          project.example ||
          ["connecting", "indexing"].includes(project.analysis)
        }
        onClick={() => void capture(true)}
      >
        {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}Refresh analysis
      </button>
    </div>
  );
}
export function SnapshotEvidence({ snapshot }: { snapshot: QualitySnapshot }) {
  return (
    <div className="snapshot-evidence">
      <div>
        <span className={"evidence-tag " + snapshot.status}>
          {snapshot.status === "current" ? (
            <ShieldCheck size={12} />
          ) : (
            <TriangleAlert size={12} />
          )}{" "}
          {snapshot.status === "current"
            ? "Aligned at capture"
            : snapshot.status === "stale"
              ? "Index needs refresh"
              : "Partial evidence"}
        </span>
        <span>
          <GitBranch size={12} />
          {snapshot.branch}
        </span>
        <span>{checkpointLabel(snapshot.capturedAt)}</span>
        {snapshot.source.commit && (
          <code>
            {snapshot.source.commit.slice(0, 8)}
            {snapshot.source.dirty ? " · uncommitted source" : ""}
          </code>
        )}
      </div>
      <details>
        <summary>Evidence & coverage</summary>
        <dl>
          <div>
            <dt>Code index</dt>
            <dd>
              {snapshot.graph.scope === "project"
                ? "Project-local Memtrace index"
                : snapshot.graph.scope === "workspace"
                  ? "Shared Memtrace workspace"
                  : "Scope unavailable"}
              {snapshot.graph.dataDirectory && (
                <code>{snapshot.graph.dataDirectory}</code>
              )}
            </dd>
          </div>
          <div>
            <dt>Source fingerprint</dt>
            <dd>{snapshot.source.revision?.slice(0, 20) ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Graph publication</dt>
            <dd>{snapshot.graph.revision?.slice(0, 25) ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Metric basis</dt>
            <dd>
              AST complexity distribution ·{" "}
              {snapshot.measurementVersion ?? "schema unknown"}
            </dd>
          </div>
          <div>
            <dt>Source files</dt>
            <dd>
              {countLabel(snapshot.source.files)} observed ·{" "}
              {countLabel(snapshot.source.mismatchedFiles)} mismatched
            </dd>
          </div>
        </dl>
        {snapshot.limitations.length ? (
          <ul>
            {snapshot.limitations.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : (
          <p>
            Queries completed against stable source and graph bindings. Static
            analysis still cannot prove runtime behavior or correctness.
          </p>
        )}
      </details>
    </div>
  );
}
export function MetricTile({
  label,
  value,
  caption,
  accent = "mint",
}: {
  label: string;
  value: string;
  caption: string;
  accent?: string;
}) {
  return (
    <div className={"intelligence-metric " + accent}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{caption}</small>
    </div>
  );
}
export function Distribution({ snapshot }: { snapshot: QualitySnapshot }) {
  const bands = snapshot.metrics.distribution,
    total = snapshot.metrics.measuredFunctions;
  const values = bands
    ? [
        { name: "Simple", value: bands.simple, color: "simple" },
        { name: "Moderate", value: bands.moderate, color: "moderate" },
        { name: "High", value: bands.high, color: "high" },
        { name: "Critical", value: bands.critical, color: "critical" },
      ]
    : [];
  return (
    <div className="complexity-distribution">
      <div className="distribution-heading">
        <span>AST COMPLEXITY BANDS</span>
        <span>{countLabel(total)} measured functions</span>
      </div>
      <div
        className="distribution-track"
        role="img"
        aria-label={
          bands
            ? values.map((band) => `${band.name}: ${band.value}`).join(", ")
            : "Complexity distribution unavailable"
        }
      >
        {values.map((band) => (
          <i
            key={band.name}
            className={band.color}
            style={{ width: total ? `${(band.value / total) * 100}%` : "0%" }}
          />
        ))}
      </div>
      <div className="distribution-legend">
        {values.map((band) => (
          <span key={band.name}>
            <i className={band.color} />
            {band.name}
            <strong>{band.value.toLocaleString()}</strong>
          </span>
        ))}
      </div>
      {!bands && (
        <p>Refresh source analysis to read measured complexity bands.</p>
      )}
    </div>
  );
}
export function FindingList({
  title,
  description,
  findings,
  snapshot,
  state,
  project,
  open,
  notify,
}: {
  title: string;
  description: string;
  findings: CodeFinding[];
  snapshot: QualitySnapshot;
} & IntelligenceProps) {
  const [busy, setBusy] = useState<string | null>(null),
    [impact, setImpact] = useState<IntelligenceDetail | null>(null);
  const request = useRef(0);
  useEffect(() => {
    request.current++;
    setImpact(null);
    setBusy(null);
    return () => {
      request.current++;
    };
  }, [project.id, snapshot.id]);
  const create = async (finding: CodeFinding) => {
    const title = (
      finding.signal === "unreachable"
        ? `Investigate reachability of ${finding.name}`
        : `Reduce complexity in ${finding.name}`
    ).slice(0, 160);
    const existing = state.tasks.find(
      (task) =>
        task.projectId === project.id &&
        !task.archivedAt &&
        task.scope?.includes(finding.file) &&
        task.title === title,
    );
    if (existing) {
      open(existing);
      return;
    }
    setBusy(finding.id);
    try {
      const investigate = finding.signal === "unreachable";
      const description = [
        `Source: ${finding.file}${finding.line ? ":" + finding.line : ""}.`,
        investigate
          ? "Memtrace reported an unreachable-code candidate. This is not proof that the symbol is unused. Verify dynamic entry points, framework hooks and callers before deleting or changing it."
          : `AST evidence: cognitive ${finding.cognitive ?? "unknown"}, cyclomatic ${finding.cyclomatic ?? "unknown"}, maximum nesting ${finding.nesting ?? "unknown"}.`,
        `Checkpoint ${snapshot.capturedAt}; source ${snapshot.source.commit ?? snapshot.source.revision ?? "unknown"}; graph ${snapshot.graph.revision ?? "unknown"}.`,
        "Read the current source and decision context, inspect blast radius, make a focused change, run appropriate checks, then record another quality checkpoint. Preserve behavior and shared Fleet work.",
      ].join("\n\n");
      const task = await window.memcode.createTask({
        projectId: project.id,
        title,
        description,
        priority: investigate ? "medium" : "high",
        harness: "codex",
        assignment: "auto",
        kind: investigate ? "research" : "refactor",
      });
      await window.memcode.updateTask(task.id, { scope: [finding.file] });
      open({ ...task, scope: [finding.file] });
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const inspect = async (finding: CodeFinding) => {
    const currentRequest = ++request.current;
    setBusy(finding.id);
    try {
      const result = (await window.memcode.queryIntelligence(
        project.id,
        "impact",
        {
          symbol: finding.nodeId ?? finding.name,
          file: finding.file,
        },
      )) as IntelligenceDetail;
      if (currentRequest === request.current) setImpact(result);
    } catch (error) {
      if (currentRequest === request.current) notify((error as Error).message);
    } finally {
      if (currentRequest === request.current) setBusy(null);
    }
  };
  return (
    <section className="intelligence-panel">
      <header>
        <div>
          <h3>
            {title}
            <span className="intelligence-panel-count">{findings.length}</span>
          </h3>
          <p>{description}</p>
        </div>
        <Code2 size={17} />
      </header>
      {findings.length ? (
        <div className="finding-table">
          <div className="finding-table-head">
            <span>Source symbol</span>
            <span>Cognitive</span>
            <span>Cyclomatic</span>
            <span>Nesting</span>
            <span>Next step</span>
          </div>
          {findings.map((finding) => (
            <div className="finding-row" key={finding.key}>
              <div>
                <strong>{finding.name}</strong>
                <code title={finding.file}>
                  {finding.file}
                  {finding.line ? ":" + finding.line : ""}
                </code>
                {finding.signal === "unreachable" && (
                  <small>
                    {finding.confidence ?? "Unknown confidence"} · candidate
                  </small>
                )}
              </div>
              <span>{countLabel(finding.cognitive)}</span>
              <span>{countLabel(finding.cyclomatic)}</span>
              <span>{countLabel(finding.nesting)}</span>
              <div className="finding-actions">
                <button
                  title={`Inspect impact of ${finding.name}`}
                  disabled={busy === finding.id}
                  onClick={() => void inspect(finding)}
                >
                  <GitBranch size={13} />
                  <span>Impact</span>
                </button>
                <button
                  title={`Create work for ${finding.name}`}
                  disabled={busy === finding.id}
                  onClick={() => void create(finding)}
                >
                  {busy === finding.id ? (
                    <Spinner size={12} />
                  ) : (
                    <Plus size={13} />
                  )}
                  <span>Plan work</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="intelligence-small-empty">
          <Check size={18} />
          <div>
            <strong>No candidates returned in this checkpoint.</strong>
            <p>
              That describes this query’s observed scope, not a guarantee that
              every issue has been found.
            </p>
          </div>
        </div>
      )}
      {impact && (
        <div className="inline-intelligence-detail">
          <button className="text-button" onClick={() => setImpact(null)}>
            Close impact detail
          </button>
          <DetailResults detail={impact} />
        </div>
      )}
    </section>
  );
}
export function DetailResults({
  detail,
  selectFlow,
}: {
  detail: IntelligenceDetail;
  selectFlow?: (id: string) => void;
}) {
  const groups = [
    ...new Set(detail.items.map((item) => item.group ?? "Source evidence")),
  ];
  return (
    <div className="intelligence-detail-results">
      <div className="intelligence-detail-heading">
        <h3>{detail.title}</h3>
        <p>{detail.summary}</p>
      </div>
      {groups.map((group) => (
        <section className="intelligence-detail-group" key={group}>
          <h4>
            {group}
            <span>
              {
                detail.items.filter(
                  (item) => (item.group ?? "Source evidence") === group,
                ).length
              }
            </span>
          </h4>
          {detail.items
            .filter((item) => (item.group ?? "Source evidence") === group)
            .map((item) => (
              <div key={item.id} className="intelligence-detail-row">
                <span className="intelligence-detail-glyph">
                  {item.action === "flow" ? (
                    <ArrowRight size={15} />
                  ) : group === "Modules" ? (
                    <Layers3 size={15} />
                  ) : (
                    <Code2 size={15} />
                  )}
                </span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                  {item.file && (
                    <code>
                      {item.file}
                      {item.line ? ":" + item.line : ""}
                    </code>
                  )}
                </div>
                {item.badge && (
                  <span className="detail-data-badge">{item.badge}</span>
                )}
                {item.value && (
                  <span className="detail-data-value">{item.value}</span>
                )}
                {item.action === "flow" && selectFlow && (
                  <button
                    title={`Inspect ${item.title}`}
                    onClick={() => selectFlow(item.id)}
                  >
                    <ArrowUpRight size={15} />
                  </button>
                )}
              </div>
            ))}
        </section>
      ))}
      {detail.notes.length > 0 && (
        <div className="intelligence-detail-notes">
          <ShieldCheck size={14} />
          <div>
            {detail.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      )}
      <footer className="intelligence-detail-footer">
        Observed {checkpointLabel(detail.capturedAt)}
        {detail.graphRevision && (
          <code>Graph {detail.graphRevision.slice(0, 18)}</code>
        )}
      </footer>
    </div>
  );
}
