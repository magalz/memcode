import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  Code2,
  GitBranch,
  Layers3,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { IntelligenceDetail, IntelligenceSection } from "../intelligence";
import { qualityValue } from "../intelligence";
import { Empty, Spinner } from "./UI";
import {
  CaptureButtons,
  countLabel,
  DetailResults,
  Distribution,
  FindingList,
  MetricTile,
  projectCheckpoints,
  SnapshotEvidence,
  useCapture,
  type IntelligenceProps,
} from "./IntelligenceUI";

const tabs = [
  { id: "quality", label: "Quality", icon: ShieldCheck },
  { id: "architecture", label: "Architecture", icon: Boxes },
  { id: "flows", label: "Flows", icon: Network },
  { id: "api", label: "API surface", icon: GitBranch },
  { id: "history", label: "Changes", icon: Activity },
  { id: "style", label: "Style", icon: Code2 },
  { id: "governance", label: "Rules", icon: Layers3 },
] as const;
type Tab = (typeof tabs)[number]["id"];

export function CodeInsights(props: IntelligenceProps) {
  const { state, project, notify } = props,
    snapshots = projectCheckpoints(state, project),
    snapshot = snapshots.at(-1);
  const [tab, setTab] = useState<Tab>("quality"),
    [detail, setDetail] = useState<IntelligenceDetail | null>(null),
    [loading, setLoading] = useState(false),
    [file, setFile] = useState("src/shared.ts");
  const { busy, capture } = useCapture(project, notify);
  const request = useRef(0);
  const load = async (
    section: IntelligenceSection,
    input?: Record<string, unknown>,
  ) => {
    const currentRequest = ++request.current;
    setLoading(true);
    setDetail(null);
    try {
      const result = (await window.memcode.queryIntelligence(
        project.id,
        section,
        input,
      )) as IntelligenceDetail;
      if (currentRequest === request.current) setDetail(result);
    } catch (error) {
      if (currentRequest === request.current) notify((error as Error).message);
    } finally {
      if (currentRequest === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    request.current++;
    setDetail(null);
    setTab("quality");
    setLoading(false);
    return () => {
      request.current++;
    };
  }, [project.id]);
  useEffect(() => {
    if (tab !== "quality" && project.analysis === "ready" && !project.example)
      void load(tab, tab === "governance" ? { file } : undefined);
  }, [tab, project.id, project.analysis]);
  if (!snapshot)
    return (
      <div className="code-insights-view">
        <section className="intelligence-intro">
          <div className="intelligence-intro-icon">
            <Network size={24} />
          </div>
          <div>
            <span className="intelligence-kicker">
              MEMTRACE CODE INTELLIGENCE
            </span>
            <h2>Understand what you’re about to change.</h2>
            <p>
              Source relationships, measured complexity and recorded history in
              one considered view.
            </p>
          </div>
        </section>
        <Empty
          icon={<Sparkles size={29} />}
          title={
            project.example
              ? "Your code deserves real evidence."
              : "Start with a measured checkpoint."
          }
          description={
            project.example
              ? "Choose a local project from the project selector to inspect its actual source. Example work items are not measured code."
              : "Connect Memtrace, read the source graph, and capture the first quality checkpoint. Future checkpoints will make change visible."
          }
          action={
            !project.example ? (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void capture(true)}
              >
                {busy ? <Spinner size={14} /> : <RefreshCw size={14} />}Analyze
                codebase
              </button>
            ) : undefined
          }
        />
      </div>
    );
  const elevated = qualityValue(snapshot, "elevated");
  return (
    <div className="code-insights-view">
      <div className="intelligence-toolbar">
        <span className="intelligence-kicker">
          <span />
          MEMTRACE / SOURCE INTELLIGENCE
        </span>
        <CaptureButtons project={project} busy={busy} capture={capture} />
      </div>
      <section className="intelligence-overview">
        <div className="intelligence-overview-copy">
          <span>THE CODE, IN CONTEXT</span>
          <h2>
            A clearer view.
            <br />
            <em>A better next move.</em>
          </h2>
          <p>
            {countLabel(snapshot.metrics.symbols)} source symbols connected by{" "}
            {countLabel(snapshot.metrics.edges)} structural relationships.
          </p>
          <div>
            <span>
              <GitBranch size={12} />
              {snapshot.branch}
            </span>
            <span>{countLabel(snapshot.metrics.files)} indexed files</span>
          </div>
        </div>
        <div className="intelligence-overview-data">
          <div className="intelligence-overview-metrics">
            <MetricTile
              label="AST-measured"
              value={countLabel(snapshot.metrics.measuredFunctions)}
              caption="Function and method records"
            />
            <MetricTile
              label="Elevated complexity"
              value={countLabel(elevated)}
              caption="High + critical engine bands"
              accent="amber"
            />
            <MetricTile
              label="Cleanup candidates"
              value={countLabel(snapshot.metrics.deadCodeCandidates)}
              caption="Verify reachability before removal"
              accent="cyan"
            />
          </div>
          <Distribution snapshot={snapshot} />
        </div>
      </section>
      <SnapshotEvidence snapshot={snapshot} />
      <div
        className="intelligence-tabs"
        role="tablist"
        aria-label="Code intelligence views"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={13} />
            {item.label}
          </button>
        ))}
      </div>
      {tab === "quality" ? (
        <>
          <div className="intelligence-quality-notes">
            <div>
              <ShieldCheck size={17} />
              <span>
                <strong>
                  {countLabel(snapshot.metrics.importCycles)} import cycles
                </strong>
                <small>Complete enumeration when available</small>
              </span>
            </div>
            <div>
              <Layers3 size={17} />
              <span>
                <strong>
                  {countLabel(snapshot.metrics.communities)} modules
                </strong>
                <small>Detected source communities</small>
              </span>
            </div>
            <div>
              <Network size={17} />
              <span>
                <strong>
                  {countLabel(snapshot.metrics.processes)} process records
                </strong>
                <small>Static entry-point neighborhoods</small>
              </span>
            </div>
          </div>
          <FindingList
            {...props}
            snapshot={snapshot}
            title="Complexity hotspots"
            description="A bounded list ranked by the engine, with AST cognitive, cyclomatic and nesting measurements."
            findings={snapshot.hotspots}
          />
          <FindingList
            {...props}
            snapshot={snapshot}
            title="Reachability candidates"
            description="These are investigation leads. Dynamic calls and framework conventions can change the conclusion."
            findings={snapshot.deadCode}
          />
        </>
      ) : (
        <section className="intelligence-panel intelligence-explorer">
          <div className="intelligence-explorer-toolbar">
            {tab === "governance" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void load("governance", { file });
                }}
              >
                <label>
                  <Code2 size={13} />
                  <input
                    aria-label="Source file for governing rules"
                    value={file}
                    onChange={(event) => setFile(event.target.value)}
                    placeholder="src/shared.ts"
                  />
                </label>
                <button
                  className="button secondary"
                  type="submit"
                  disabled={loading}
                >
                  Read rules
                  <ArrowUpRight size={12} />
                </button>
              </form>
            ) : (
              <span>Read from the selected repository and branch</span>
            )}
            <button
              className="icon-button"
              title="Refresh intelligence detail"
              disabled={loading}
              onClick={() =>
                void load(
                  tab as IntelligenceSection,
                  tab === "governance" ? { file } : undefined,
                )
              }
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {loading ? (
            <div className="intelligence-loading">
              <Spinner size={20} />
              <p>Reading source-backed context…</p>
            </div>
          ) : detail ? (
            <DetailResults
              detail={detail}
              selectFlow={(id) => void load("flow", { process: id })}
            />
          ) : (
            <div className="intelligence-small-empty">
              <Network size={20} />
              <p>Use refresh to read this part of the graph.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
