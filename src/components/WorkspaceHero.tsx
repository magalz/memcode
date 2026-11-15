import { ArrowRight } from "lucide-react";
import type { Project, RuntimeInfo, WorkItem } from "../shared";
import { isActive } from "../domain";
import { HarnessMark, Spinner } from "./UI";
import { useRuntimeHealth } from "../useRuntimeHealth";

export function WorkspaceHero({
  project,
  tasks,
  runtime,
  act,
  addProject,
}: {
  project: Project;
  tasks: WorkItem[];
  runtime: RuntimeInfo;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  addProject: () => void;
}) {
  const health = useRuntimeHealth();
  const current = tasks.filter((task) => !task.archivedAt),
    done = current.filter((task) => task.stage === "done").length;
  const completion = current.length
    ? Math.round((done / current.length) * 100)
    : 0;
  const analyzing = ["connecting", "indexing"].includes(project.analysis);
  return (
    <section className="focus-panel workspace-hero">
      <div className="focus-grid" />
      <div className="focus-copy">
        <div className="focus-kicker">
          <span />
          {project.example ? "BUILDING MEMCODE" : "PROJECT BRIEF"}
        </div>
        <h2>
          {project.example ? (
            <>
              Local by default.
              <br />
              <span>Coordinated by design.</span>
            </>
          ) : (
            project.name
          )}
        </h2>
        <p>
          {project.description ||
            "Describe what you want to build. Turn the idea into clear, focused work."}
        </p>
        <button
          className="focus-link"
          disabled={analyzing}
          onClick={() =>
            project.example
              ? addProject()
              : void act(() => window.memcode.analyzeProject(project.id))
          }
        >
          {project.example
            ? "Connect your first project"
            : analyzing
              ? "Analyzing your project"
              : project.analysis === "ready"
                ? "Refresh code context"
                : "Understand this codebase"}
          {analyzing ? <Spinner size={13} /> : <ArrowRight size={14} />}
        </button>
      </div>
      <div className="focus-right">
        <div className="cycle-header">
          <span>WORKSPACE MOMENTUM</span>
          {project.example ? (
            <span className="example-pill">Example data</span>
          ) : (
            <span>{current.length} work items</span>
          )}
        </div>
        <div className="focus-metrics">
          {(["planned", "working", "review"] as const).map((stage) => (
            <div key={stage}>
              <strong>
                {current
                  .filter((task) => task.stage === stage)
                  .length.toString()
                  .padStart(2, "0")}
              </strong>
              <span>
                <span className={"metric-dot " + stage} />
                {stage === "planned"
                  ? "Planned"
                  : stage === "working"
                    ? "In progress"
                    : "In review"}
              </span>
            </div>
          ))}
        </div>
        <div className="cycle-progress">
          <div>
            <i style={{ width: `${completion}%` }} />
          </div>
          <span>
            {done} of {current.length} complete<em>{completion}%</em>
          </span>
        </div>
        <div className="focus-bottom">
          <div className="stacked-harnesses">
            {runtime.harnesses
              .filter((harness) => harness.available)
              .map((harness) => (
                <HarnessMark key={harness.id} id={harness.id} small />
              ))}
          </div>
          <span>
            {project.example
              ? "One workspace. Different strengths."
              : !health.available
                ? "Runtime disconnected · live worker status unavailable"
                : `${runtime.harnesses.filter((harness) => harness.available).length} installed harnesses · ${current.filter(isActive).length} active workers`}
          </span>
        </div>
      </div>
    </section>
  );
}
