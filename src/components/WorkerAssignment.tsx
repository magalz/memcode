import { useEffect, useState } from "react";
import { ArrowUpRight, GitBranch, Layers3, Link2, X } from "lucide-react";
import type { AppState, Epic, Harness, RuntimeInfo, WorkItem } from "../shared";
import { harnessNames } from "../shared";
import { workerReadiness } from "../worker-availability";
import { isActive } from "../domain";
import { Select } from "./Select";
import { RoutingCard } from "./Routing";
import { WorkerPermissions } from "./WorkerPermissions";

type Update = (patch: Parameters<Window["memcode"]["updateTask"]>[1]) => void;

export function WorkerAssignment({
  task,
  runtime,
  busy,
  plan,
  update,
  connections,
  onConnections,
}: {
  task: WorkItem;
  runtime: RuntimeInfo;
  busy: boolean;
  plan: () => void;
  update: Update;
  connections: AppState["workerConnections"];
  onConnections: () => void;
}) {
  const automatic = task.assignment === "auto";
  const readiness = workerReadiness(task, runtime.harnesses, connections),
    displayTask =
      automatic && !readiness.routeConnected
        ? { ...task, route: undefined }
        : task;
  const catalog =
    runtime.harnesses.find((h) => h.id === task.harness)?.models ?? [];
  return (
    <>
      <label className="inspector-field">
        <span>Assignment</span>
        <Select
          aria-label="Assigned harness"
          value={automatic ? "auto" : task.harness}
          disabled={isActive(task)}
          onValueChange={(value) =>
            update(
              value === "auto"
                ? { assignment: "auto", modelOverride: null }
                : {
                    assignment: "manual",
                    harness: value as Harness,
                    modelOverride: null,
                  },
            )
          }
        >
          <option value="auto">Automatic</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="cursor">Cursor</option>
        </Select>
      </label>
      <label className="inspector-field">
        <span>Model</span>
        <Select
          aria-label="Assigned model"
          value={task.modelOverride ?? "auto"}
          disabled={isActive(task) || automatic}
          onValueChange={(value) =>
            update({ modelOverride: value === "auto" ? null : value })
          }
        >
          <option value="auto">
            {automatic ? "Memtrace chooses" : "Match task complexity"}
          </option>
          {catalog.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
          {task.modelOverride &&
            !catalog.some((model) => model.id === task.modelOverride) && (
              <option value={task.modelOverride}>{task.modelOverride}</option>
            )}
        </Select>
      </label>
      <div className="inspector-field">
        <span>Execution</span>
        <span>
          <span className="tiny-local-dot" />
          This computer
        </span>
      </div>
      <WorkerPermissions task={task} update={update} />
      {!task.example && !readiness.canStart && (
        <div className="assignment-connect" role="status">
          <span>
            <Link2 size={13} />
            Connect in Workers
          </span>
          <p>
            {automatic
              ? "Automatic assignment uses only workers you approve. Connect one to plan and start this story."
              : readiness.runtimeKnown
                ? `${harnessNames[task.harness]} is installed. Approve its connection before starting work.`
                : readiness.selectedInstalled
                  ? "The installed runtime path has not been confirmed. Check its connection in Workers."
                  : `Install the standalone ${harnessNames[task.harness]} CLI, then connect it in Workers.`}
          </p>
          <button className="secondary-button" onClick={onConnections}>
            Connect in Workers <ArrowUpRight size={12} />
          </button>
        </div>
      )}
      <RoutingCard
        task={displayTask}
        busy={busy || isActive(task)}
        disabled={!task.example && !readiness.canStart}
        plan={plan}
      />
    </>
  );
}

export function StoryMetadata({
  task,
  epics,
  tasks,
  update,
}: {
  task: WorkItem;
  epics: Epic[];
  tasks: WorkItem[];
  update: Update;
}) {
  const [scope, setScope] = useState((task.scope ?? []).join("\n"));
  useEffect(
    () => setScope((task.scope ?? []).join("\n")),
    [task.id, task.scope?.join("\n")],
  );
  const prerequisites = tasks.filter((item) =>
    task.dependsOn?.includes(item.id),
  );
  const disabled = isActive(task);
  return (
    <section className="inspector-section story-metadata">
      <details>
        <summary className="inspector-label">
          STORY DETAILS
          <Layers3 size={12} />
        </summary>
        <label className="metadata-field">
          <span>Epic</span>
          <Select
            aria-label="Work item epic"
            value={task.epicId ?? "none"}
            disabled={disabled}
            onValueChange={(value) =>
              update({ epicId: value === "none" ? null : value })
            }
          >
            <option value="none">Project work · default epic</option>
            {epics.map((epic) => (
              <option value={epic.id} key={epic.id}>
                {epic.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="metadata-field">
          <span>Type of work</span>
          <Select
            aria-label="Work item type"
            value={task.kind ?? "feature"}
            disabled={disabled}
            onValueChange={(value) =>
              update({ kind: value as WorkItem["kind"] })
            }
          >
            <option value="feature">Feature</option>
            <option value="fix">Fix</option>
            <option value="refactor">Refactor</option>
            <option value="test">Verification</option>
            <option value="research">Research</option>
          </Select>
        </label>
        <label className="metadata-field">
          <span>
            Source scope <small>One file or directory per line</small>
          </span>
          <textarea
            aria-label="Source scope"
            value={scope}
            disabled={disabled}
            placeholder="src/components/Board.tsx"
            onChange={(event) => setScope(event.target.value)}
            onBlur={() => {
              const paths = scope
                .split("\n")
                .map((path) => path.trim())
                .filter(Boolean);
              if (paths.join("\n") !== (task.scope ?? []).join("\n"))
                update({ scope: paths });
            }}
          />
        </label>
        <div className="metadata-field">
          <span>Prerequisites</span>
          {prerequisites.map((item) => (
            <div
              className={
                "prerequisite " + (item.stage === "done" ? "complete" : "")
              }
              key={item.id}
            >
              <GitBranch size={11} />
              <span>
                {item.identifier} · {item.title}
              </span>
              <button
                title="Remove prerequisite"
                disabled={disabled}
                onClick={() =>
                  update({
                    dependsOn: task.dependsOn?.filter((id) => id !== item.id),
                  })
                }
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <Select
            aria-label="Add prerequisite"
            value="none"
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== "none")
                update({ dependsOn: [...(task.dependsOn ?? []), value] });
            }}
          >
            <option value="none">Add prerequisite…</option>
            {tasks
              .filter(
                (item) =>
                  item.id !== task.id && !task.dependsOn?.includes(item.id),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.identifier} · {item.title}
                </option>
              ))}
          </Select>
        </div>
      </details>
    </section>
  );
}
