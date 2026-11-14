import { harnessNames } from "../shared";
import {
  Plus,
  MoreHorizontal,
  ArrowUpRight,
  Check,
  GitBranch,
  MessageSquare,
  Files,
  SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";
import type { Stage, WorkItem } from "../shared";
import { stages } from "../shared";
import { isActive, progress, stageLabel } from "../domain";
import { Empty, WorkerMark, PriorityMark, StageIcon } from "./UI";

interface Props {
  tasks: WorkItem[];
  mode: "board" | "list";
  open: (task: WorkItem) => void;
  create: () => void;
  move: (id: string, stage: Stage) => void;
}

export function WorkBoard({ tasks, mode, open, create, move }: Props) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const ordered = [...tasks].sort(
    (a, b) =>
      ["high", "medium", "low"].indexOf(a.priority) -
      ["high", "medium", "low"].indexOf(b.priority),
  );
  const actions = (task: WorkItem) => (
    <div className="card-menu" role="menu">
      {stages
        .filter((s) => s !== task.stage)
        .map((stage) => (
          <button
            role="menuitem"
            key={stage}
            onClick={(event) => {
              event.stopPropagation();
              move(task.id, stage);
              setMenu(null);
            }}
          >
            <StageIcon stage={stage} />
            {stageLabel(stage)}
          </button>
        ))}
    </div>
  );
  if (mode === "list")
    return (
      <div className="work-list">
        <div className="list-head">
          <span>Work item</span>
          <span>Worker</span>
          <span>Priority</span>
          <span>Runbook</span>
        </div>
        {stages.map((stage) => (
          <section className="list-section" key={stage}>
            <div className="list-section-heading">
              <StageIcon stage={stage} />
              <strong>{stageLabel(stage)}</strong>
              <span>{ordered.filter((t) => t.stage === stage).length}</span>
              <button
                className="icon-button"
                title="Create work item"
                onClick={create}
              >
                <Plus size={14} />
              </button>
            </div>
            {ordered
              .filter((t) => t.stage === stage)
              .map((task) => (
                <button
                  className="work-row"
                  key={task.id}
                  onClick={() => open(task)}
                >
                  <span className="row-title">
                    <small>{task.identifier}</small>
                    <span>{task.title}</span>
                  </span>
                  <span className="row-harness">
                    <WorkerMark task={task} small />
                    {task.assignment === "auto" && !task.route
                      ? "Automatic"
                      : harnessNames[task.harness]}
                  </span>
                  <span>
                    <PriorityMark value={task.priority} />
                    <small className="capitalize">{task.priority}</small>
                  </span>
                  <span className="row-progress">
                    {task.checklist.filter((c) => c.done).length}
                    <span>/ {task.checklist.length}</span>
                    <ArrowUpRight size={14} />
                  </span>
                </button>
              ))}
          </section>
        ))}
      </div>
    );
  return (
    <div className="work-board" onClick={() => menu && setMenu(null)}>
      {stages.map((stage) => {
        const items = ordered.filter((task) => task.stage === stage);
        return (
          <section
            key={stage}
            className={`board-column ${over === stage ? "drop-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(stage);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged) move(dragged, stage);
              setDragged(null);
              setOver(null);
            }}
          >
            <div className="column-heading">
              <div>
                <StageIcon stage={stage} />
                <h3>{stageLabel(stage)}</h3>
                <span className="column-count">{items.length}</span>
              </div>
              <button
                className="icon-button"
                title={`Add work item to ${stageLabel(stage)}`}
                onClick={create}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="column-track" />
            <div className="column-cards">
              {items.map((task) => (
                <article
                  key={task.id}
                  className={`work-card ${dragged === task.id ? "dragging" : ""}`}
                  draggable={!isActive(task)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    setDragged(task.id);
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                  onClick={() => open(task)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") open(task);
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${task.identifier}: ${task.title}`}
                >
                  <div className="card-topline">
                    <span className="card-identifier">{task.identifier}</span>
                    <div className="card-actions">
                      <PriorityMark value={task.priority} />
                      <button
                        className="icon-button card-more"
                        aria-label={`Move ${task.identifier}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenu(menu === task.id ? null : task.id);
                        }}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                    {menu === task.id && actions(task)}
                  </div>
                  <h4>{task.title}</h4>
                  <p className="card-description">{task.description}</p>
                  <div className="card-tags">
                    <span className={`category ${task.category.toLowerCase()}`}>
                      <i />
                      {task.category}
                    </span>
                    {task.evidence?.symbols.length ? (
                      <span className="context-tag">
                        <GitBranch size={11} />
                        {task.evidence.symbols.length} symbols
                      </span>
                    ) : null}
                  </div>
                  <div className="card-runbook">
                    <div className="tiny-track">
                      <i style={{ width: `${progress(task)}%` }} />
                    </div>
                    <span>
                      {task.checklist.filter((c) => c.done).length}/
                      {task.checklist.length}
                    </span>
                  </div>
                  <div className="card-footer">
                    <div className="worker-identity">
                      <WorkerMark task={task} small />
                      <span>
                        {task.assignment === "auto" && !task.route
                          ? "Automatic"
                          : harnessNames[task.harness]}
                      </span>
                      {isActive(task) && <span className="live-dot" />}
                    </div>
                    <div className="card-meta">
                      {task.messages.length > 0 && (
                        <span>
                          <MessageSquare size={11} />
                          {
                            task.messages.filter(
                              (m) => m.role !== "tool" && m.role !== "system",
                            ).length
                          }
                        </span>
                      )}
                      {stage === "done" ? (
                        <Check size={13} className="mint-ink" />
                      ) : (
                        <ArrowUpRight size={13} />
                      )}
                    </div>
                  </div>
                </article>
              ))}
              {!items.length && (
                <button className="empty-column" onClick={create}>
                  <Plus size={16} />
                  <span>Add a work item</span>
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
