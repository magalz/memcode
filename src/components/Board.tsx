import { useState } from "react";
import { ArrowUpRight, Check, Clock3, MessageSquare, Plus } from "lucide-react";
import type { Cycle, Stage, WorkItem } from "../shared";
import { harnessNames, stages } from "../shared";
import { isActive, stageLabel } from "../domain";
import { dateLabel, dayAt } from "../planning/dates";
import { PriorityMark, StageIcon, WorkerMark } from "./UI";
import { Select } from "./Select";

export interface BoardGroup {
  id: string;
  name: string;
  stage?: Stage;
  color?: string;
  wipLimit?: number | null;
  tasks: WorkItem[];
}
interface Props {
  tasks: WorkItem[];
  mode: "board" | "list";
  groups?: BoardGroup[];
  cycles?: Cycle[];
  open: (task: WorkItem) => void;
  create: () => void;
  move: (id: string, group: string) => void;
  selected?: Set<string>;
  toggle?: (id: string) => void;
}
export function WorkBoard({
  tasks,
  mode,
  groups,
  cycles = [],
  open,
  create,
  move,
  selected = new Set(),
  toggle,
}: Props) {
  const [dragged, setDragged] = useState<string | null>(null),
    [over, setOver] = useState<string | null>(null);
  const lanes: BoardGroup[] =
    groups ??
    stages.map((stage) => ({
      id: stage,
      name: stageLabel(stage),
      stage,
      tasks: tasks.filter((task) => task.stage === stage),
    }));
  const checkbox = (task: WorkItem) => (
    <input
      type="checkbox"
      className="selection-checkbox"
      aria-label={`Select ${task.identifier}`}
      checked={selected.has(task.id)}
      onClick={(event) => event.stopPropagation()}
      onChange={() => toggle?.(task.id)}
    />
  );
  const assignment = (task: WorkItem) =>
    task.assignment === "auto" && !task.route
      ? "Automatic"
      : harnessNames[task.harness];
  if (mode === "list")
    return (
      <div
        className="work-list planning-list"
        role="table"
        aria-label="Work items"
      >
        <div className="list-head planning-list-head" role="row">
          <span />
          <span role="columnheader">Work item</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Priority</span>
          <span role="columnheader">Points</span>
          <span role="columnheader">Cycle</span>
          <span role="columnheader">Worker</span>
          <span role="columnheader">Due</span>
        </div>
        {lanes.map((group) => (
          <section className="list-section" key={group.id} role="rowgroup">
            <div className="list-section-heading">
              <span
                className="group-color"
                style={{ background: group.color ?? "#9aaf9e" }}
              />
              <strong>{group.name}</strong>
              <span>{group.tasks.length}</span>
              <button
                className="icon-button"
                title="Create work item"
                onClick={create}
              >
                <Plus size={14} />
              </button>
            </div>
            {group.tasks.map((task) => (
              <div
                className={
                  "work-row planning-row " +
                  (selected.has(task.id) ? "selected" : "")
                }
                role="row"
                key={task.id}
              >
                <span role="cell">{checkbox(task)}</span>
                <span role="cell">
                  <button className="row-title" onClick={() => open(task)}>
                    <small>{task.identifier}</small>
                    <span>{task.title}</span>
                    {task.parentId && (
                      <span className="sub-story-tag">sub</span>
                    )}
                  </button>
                </span>
                <span className="row-status" role="cell">
                  <StageIcon stage={task.stage} />
                  {stageLabel(task.stage)}
                </span>
                <span role="cell">
                  <PriorityMark value={task.priority} />
                  <small className="capitalize">{task.priority}</small>
                </span>
                <span role="cell" className="row-points">
                  {task.estimate ?? "—"}
                </span>
                <span role="cell" className="row-cycle">
                  {cycles.find((cycle) => cycle.id === task.cycleId)?.name ??
                    "Backlog"}
                </span>
                <span className="row-harness" role="cell">
                  <WorkerMark task={task} small />
                  {assignment(task)}
                </span>
                <span
                  role="cell"
                  className={
                    task.dueDate &&
                    task.dueDate < dayAt() &&
                    task.stage !== "done"
                      ? "overdue"
                      : ""
                  }
                >
                  {task.dueDate ? dateLabel(task.dueDate) : "—"}
                </span>
              </div>
            ))}
          </section>
        ))}
        {!tasks.length && (
          <div className="filtered-empty">
            No stories match this view. Adjust the filters or create a work
            item.
          </div>
        )}
      </div>
    );
  return (
    <div
      className="work-board"
      style={{
        gridTemplateColumns: `repeat(${lanes.length},minmax(245px,1fr))`,
      }}
    >
      {lanes.map((group) => (
        <section
          className={"board-column " + (over === group.id ? "drop-over" : "")}
          key={group.id}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(group.id);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(event) => {
            event.preventDefault();
            if (dragged) move(dragged, group.id);
            setDragged(null);
            setOver(null);
          }}
        >
          <div className="column-heading">
            <div>
              {group.stage ? (
                <StageIcon stage={group.stage} />
              ) : (
                <span
                  className="group-color"
                  style={{ background: group.color ?? "#9aaf9e" }}
                />
              )}
              <h3>{group.name}</h3>
              <span
                className={
                  "column-count " +
                  (group.wipLimit && group.tasks.length > group.wipLimit
                    ? "over-limit"
                    : "")
                }
              >
                {group.tasks.length}
                {group.wipLimit ? ` / ${group.wipLimit}` : ""}
              </span>
            </div>
            <button
              className="icon-button"
              title={`Add work item to ${group.name}`}
              onClick={create}
            >
              <Plus size={15} />
            </button>
          </div>
          <div
            className="column-track"
            style={group.color ? { background: group.color + "70" } : undefined}
          />
          <div
            className="column-cards"
            tabIndex={0}
            aria-label={`${group.name} lane`}
          >
            {group.tasks.map((task) => (
              <article
                className={
                  "work-card " +
                  (dragged === task.id ? "dragging " : "") +
                  (selected.has(task.id) ? "selected" : "")
                }
                key={task.id}
                role="button"
                tabIndex={0}
                aria-label={`${task.identifier}: ${task.title}`}
                draggable={!isActive(task)}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", task.id);
                  event.dataTransfer.effectAllowed = "move";
                  setDragged(task.id);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setOver(null);
                }}
                onClick={() => open(task)}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    ["Enter", " "].includes(event.key)
                  ) {
                    event.preventDefault();
                    open(task);
                  }
                }}
              >
                <div className="card-topline">
                  <span className="card-identifier card-selection">
                    {toggle && checkbox(task)}
                    <span>{task.identifier}</span>
                  </span>
                  <div className="card-actions">
                    <PriorityMark value={task.priority} />
                    <span
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Select
                        aria-label={`Move ${task.identifier}`}
                        className="card-move-select"
                        value="none"
                        disabled={isActive(task)}
                        onValueChange={(value) => {
                          if (value !== "none") move(task.id, value);
                        }}
                      >
                        <option value="none">•••</option>
                        {lanes.map((lane) => (
                          <option key={lane.id} value={lane.id}>
                            Move to {lane.name}
                          </option>
                        ))}
                      </Select>
                    </span>
                  </div>
                </div>
                <h4>{task.title}</h4>
                <p className="card-description">{task.description}</p>
                <div className="card-tags">
                  <span className={`category ${task.category.toLowerCase()}`}>
                    <i />
                    {task.category}
                  </span>
                  {task.labels?.slice(0, 2).map((label) => (
                    <span className="story-label" key={label}>
                      {label}
                    </span>
                  ))}
                </div>
                {(task.estimate != null || task.dueDate || task.parentId) && (
                  <div className="card-planning">
                    {task.estimate != null && <span>{task.estimate} pts</span>}
                    {task.dueDate && (
                      <span
                        className={
                          task.dueDate < dayAt() && task.stage !== "done"
                            ? "overdue"
                            : ""
                        }
                      >
                        <Clock3 size={10} />
                        {dateLabel(task.dueDate)}
                      </span>
                    )}
                    {task.parentId && (
                      <span className="sub-story-tag">Child story</span>
                    )}
                  </div>
                )}
                <div className="card-runbook">
                  <div className="tiny-track">
                    <i
                      style={{
                        width: task.checklist.length
                          ? `${(task.checklist.filter((item) => item.done).length / task.checklist.length) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <span>
                    {task.checklist.filter((item) => item.done).length}/
                    {task.checklist.length}
                  </span>
                </div>
                <div className="card-footer">
                  <div className="worker-identity">
                    <WorkerMark task={task} small />
                    <span>{assignment(task)}</span>
                    {isActive(task) && <span className="live-dot" />}
                  </div>
                  <div className="card-meta">
                    {task.messages.length > 0 && (
                      <span>
                        <MessageSquare size={11} />
                        {task.messages.length}
                      </span>
                    )}
                    {task.stage === "done" ? (
                      <Check size={13} className="mint-ink" />
                    ) : (
                      <ArrowUpRight size={13} />
                    )}
                  </div>
                </div>
              </article>
            ))}
            {!group.tasks.length && (
              <button className="empty-column" onClick={create}>
                <Plus size={16} />
                <span>Add a work item</span>
              </button>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
