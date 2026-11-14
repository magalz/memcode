import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  GitBranch,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { FleetConflict, Project, WorkItem } from "../shared";
import { Select } from "./Select";
import { Empty, Spinner } from "./UI";

export function FleetDecisions({
  project,
  conflicts,
  tasks,
  open,
  notify,
}: {
  project: Project;
  conflicts: FleetConflict[];
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await window.memcode.refreshFleet(project.id);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pending = conflicts.filter((item) => item.status === "open"),
    resolved = conflicts.filter((item) => item.status === "resolved");
  return (
    <div className="fleet-decisions">
      <section className="fleet-explainer">
        <span className="fleet-explainer-icon">
          <ShieldCheck size={23} />
        </span>
        <div>
          <h2>One epic branch. A coordinated fleet.</h2>
          <p>
            Story workers share the branch. Memtrace tracks intent, scope
            reservations and shared plans. Workers adhere to the first published
            plan or propose an alternative. Unresolved semantic disagreements
            need your decision.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy || project.example || project.analysis !== "ready"}
          onClick={() => void refresh()}
        >
          {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}Refresh Fleet
        </button>
      </section>
      <div className="section-heading">
        <h2>
          Needs your decision{" "}
          <span className="decision-count">{pending.length}</span>
        </h2>
        <span>Workers stay paused until you decide</span>
      </div>
      {pending.length ? (
        pending.map((item) => (
          <Decision
            key={item.id}
            conflict={item}
            tasks={tasks}
            open={open}
            notify={notify}
          />
        ))
      ) : (
        <Empty
          icon={<ShieldCheck size={28} />}
          title="The fleet has a clear path."
          description="Unresolved semantic disagreements and Class C escalations appear here. Ordinary overlaps, edit reservations and source refreshes are coordinated by the workers."
        />
      )}
      {resolved.length > 0 && (
        <details className="decision-history">
          <summary>Decision history · {resolved.length}</summary>
          {resolved.map((item) => (
            <Decision
              key={item.id}
              conflict={item}
              tasks={tasks}
              open={open}
              notify={notify}
            />
          ))}
        </details>
      )}
    </div>
  );
}
function Decision({
  conflict,
  tasks,
  open,
  notify,
}: {
  conflict: FleetConflict;
  tasks: WorkItem[];
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}) {
  const [resolution, setResolution] = useState(conflict.resolution ?? ""),
    [winner, setWinner] = useState(conflict.winnerTaskId ?? "review"),
    [busy, setBusy] = useState(false);
  const affected = tasks.filter((task) => conflict.taskIds.includes(task.id));
  const resolve = async () => {
    setBusy(true);
    try {
      await window.memcode.resolveFleetConflict(
        conflict.id,
        resolution,
        winner === "review" ? undefined : winner,
      );
      notify(
        "Decision recorded. Review the shared source, then explicitly resume the selected work.",
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={"decision-card " + conflict.status}>
      <header>
        <span className="decision-icon">
          {conflict.status === "resolved" ? (
            <Check size={17} />
          ) : (
            <AlertTriangle size={17} />
          )}
        </span>
        <div>
          <span className="decision-kicker">
            {conflict.status === "resolved"
              ? "DECISION RECORDED"
              : "FLEET PAUSED"}{" "}
            ·{" "}
            {conflict.severity === "unknown"
              ? "Coordination check"
              : `Class ${conflict.severity}`}
          </span>
          <h3>{conflict.summary}</h3>
        </div>
        <span className="decision-branch">
          <GitBranch size={12} />
          {conflict.branch}
        </span>
      </header>
      <div className="decision-body">
        <div className="decision-workers">
          {affected.map((task) => (
            <button key={task.id} onClick={() => open(task)}>
              <span>{task.identifier}</span>
              {task.title}
              <ArrowUpRight size={12} />
            </button>
          ))}
        </div>
        <details className="decision-scope">
          <summary>Declared scope · {conflict.scope.length} resources</summary>
          {conflict.scope.map((scope) => (
            <code key={scope}>{scope}</code>
          ))}
        </details>
        <label className="field">
          <span>Your resolution</span>
          <textarea
            aria-label={`Resolution for ${conflict.id}`}
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            placeholder="What should the workers preserve, re-read, change or defer?"
            maxLength={10000}
          />
        </label>
        <footer>
          <Select
            aria-label={`Who continues for ${conflict.id}`}
            value={winner}
            onValueChange={setWinner}
          >
            <option value="review">Review and reconcile before resuming</option>
            {affected.map((task) => (
              <option key={task.id} value={task.id}>
                {task.identifier} proceeds · others defer
              </option>
            ))}
          </Select>
          <button
            className="button primary"
            disabled={!resolution.trim() || busy}
            onClick={() => void resolve()}
          >
            {busy ? <Spinner size={13} /> : <Check size={13} />}{" "}
            {conflict.status === "resolved"
              ? "Update decision"
              : "Record decision"}
          </button>
        </footer>
        <p className="decision-note">
          Recording a decision preserves the shared files. It does not undo
          edits, merge changes or automatically restart workers.
        </p>
      </div>
    </article>
  );
}
