import { harnessNames } from "../shared";
import { Select } from "./Select";
import { StoryMetadata, WorkerAssignment } from "./WorkerAssignment";
import { PlanningProperties } from "./PlanningProperties";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  ExternalLink,
  FileCode2,
  Files,
  GitBranch,
  Globe2,
  Image,
  ListChecks,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type {
  Artifact,
  Project,
  RuntimeInfo,
  Stage,
  WorkItem,
  Message,
  Epic,
  FleetConflict,
  AppState,
} from "../shared";
import { stages } from "../shared";
import { isActive, progress, stageLabel } from "../domain";
import { useDictation } from "../useDictation";
import {
  Empty,
  HarnessMark,
  WorkerMark,
  Mark,
  PriorityMark,
  Spinner,
  StageIcon,
  Time,
} from "./UI";

type Act = (action: () => Promise<unknown>) => Promise<void>;
type Tab = "conversation" | "runbook" | "changes" | "artifacts" | "browser";
interface Props {
  state: AppState;
  task: WorkItem;
  project: Project;
  artifacts: Artifact[];
  runtime: RuntimeInfo;
  epics: Epic[];
  conflicts: FleetConflict[];
  onDecisions: () => void;
  tasks: WorkItem[];
  onClose: () => void;
  onOpenTask: (task: WorkItem) => void;
  onCreateChild: () => void;
  notify: (s: string) => void;
  act: Act;
  obscured?: boolean;
}

export function WorkDetail({
  state,
  task,
  project,
  artifacts,
  runtime,
  epics,
  conflicts,
  onDecisions,
  tasks,
  onClose,
  onOpenTask,
  onCreateChild,
  notify,
  act,
  obscured = false,
}: Props) {
  const [tab, setTab] = useState<Tab>("conversation");
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  const plan = () =>
    void act(async () => {
      setBusy(true);
      try {
        if (project.analysis !== "ready")
          await window.memcode.analyzeProject(project.id);
        await window.memcode.qualifyTask(task.id);
      } finally {
        setBusy(false);
      }
    });
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [text, setText] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const dictation = useDictation(
    (text) => setDraft((value) => [value, text].filter(Boolean).join("\n")),
    notify,
  );
  useEffect(() => {
    setTab("conversation");
    setDraft("");
    setArtifact(null);
  }, [task.id]);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.messages.length, task.id, tab]);
  const run = async () => {
    setBusy(true);
    try {
      if (draft.trim()) {
        await window.memcode.addMessage(task.id, draft.trim());
        setDraft("");
      }
      await window.memcode.startWorker(task.id);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!draft.trim()) return;
    await act(async () => {
      await window.memcode.addMessage(task.id, draft.trim());
      setDraft("");
      if (isActive(task))
        notify(
          "Note saved for the next worker pass. The current run continues with its existing brief.",
        );
    });
  };
  const toggle = (id: string) =>
    void act(() =>
      window.memcode.updateTask(task.id, {
        checklist: task.checklist.map((item) =>
          item.id === id ? { ...item, done: !item.done } : item,
        ),
      }),
    );
  const addCheck = async () => {
    if (!check.trim()) return;
    await act(async () => {
      await window.memcode.updateTask(task.id, {
        checklist: [
          ...task.checklist,
          { id: crypto.randomUUID(), text: check.trim(), done: false },
        ],
      });
      setCheck("");
    });
  };
  const openArtifact = async (item: Artifact) => {
    setArtifact(item);
    if (item.kind === "text")
      await act(async () =>
        setText(await window.memcode.readArtifact(item.id)),
      );
    setTab("artifacts");
  };
  const available = runtime.harnesses.find(
    (h) => h.id === task.harness,
  )?.available;
  const active = isActive(task);
  const tabs: Array<{
    id: Tab;
    label: string;
    icon: typeof MessageSquare;
    count?: number;
  }> = [
    { id: "conversation", label: "Conversation", icon: MessageSquare },
    { id: "runbook", label: "Runbook", icon: ListChecks },
    { id: "changes", label: "Changes", icon: Code2 },
    {
      id: "artifacts",
      label: "Artifacts",
      icon: Files,
      count: artifacts.length,
    },
    { id: "browser", label: "Browser", icon: Globe2 },
  ];
  return (
    <div
      className="detail-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="work-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <header className="detail-topbar">
          <div>
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Back to workspace"
            >
              <ArrowLeft size={16} />
            </button>
            <LayersIcon />
            <span>{project.name}</span>
            <ChevronRight size={12} />
            <span className="detail-identifier">{task.identifier}</span>
          </div>
          <div>
            {task.example && (
              <span className="detail-example">Example session</span>
            )}
            <button
              className="icon-button"
              title="Open epic workspace"
              disabled={!task.run.workspace && !task.run.worktree}
              onClick={() =>
                void act(() => window.memcode.openWorkerWorkspace(task.id))
              }
            >
              <ExternalLink size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="Close work item"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          </div>
        </header>
        <div className="detail-heading">
          <div className="detail-heading-label">
            <span className="category">
              <i />
              {task.category}
            </span>
            <span className="detail-heading-dot" />
            <span>{task.identifier}</span>
          </div>
          <h2 id="detail-title">{task.title}</h2>
          <div className="detail-properties">
            <label className={"status-select " + task.stage}>
              <StageIcon stage={task.stage} />
              <Select
                aria-label="Work item status"
                value={task.stage}
                onValueChange={(e) =>
                  void act(() =>
                    window.memcode.updateTask(task.id, {
                      stage: e as Stage,
                    }),
                  )
                }
              >
                {stages.map((stage) => (
                  <option key={stage} value={stage}>
                    {stageLabel(stage)}
                  </option>
                ))}
              </Select>
              <ChevronDown size={10} />
            </label>
            <span className="property-divider" />
            <label className="property-select">
              <PriorityMark value={task.priority} />
              <Select
                aria-label="Work item priority"
                value={task.priority}
                onValueChange={(e) =>
                  void act(() =>
                    window.memcode.updateTask(task.id, {
                      priority: e as WorkItem["priority"],
                    }),
                  )
                }
              >
                <option value="high">High priority</option>
                <option value="medium">Medium priority</option>
                <option value="low">Low priority</option>
              </Select>
            </label>
            <span className="property-divider" />
            <span className="detail-local">
              <span />
              Local execution
            </span>
          </div>
        </div>
        <div className="detail-tabs">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              onClick={() => {
                if (item.id !== "artifacts") setArtifact(null);
                setTab(item.id);
              }}
            >
              <item.icon size={13} />
              {item.label}
              {item.count ? <small>{item.count}</small> : null}
            </button>
          ))}
        </div>
        <div className="detail-body">
          <div className="detail-content">
            {tab === "conversation" && (
              <>
                <div className="conversation-scroll" ref={messagesRef}>
                  <div className="session-start">
                    <span>THE WORK STARTS WITH A CLEAR BRIEF</span>
                    <i />
                  </div>
                  {task.messages.map((message) => (
                    <MessageBlock
                      key={message.id}
                      message={message}
                      harness={task.harness}
                    />
                  ))}
                  {task.run.state === "preparing" && (
                    <div className="worker-thinking">
                      <Spinner />
                      <span>Connecting source context and the epic Fleet…</span>
                    </div>
                  )}
                  {task.run.state === "running" && (
                    <div className="worker-thinking">
                      <div className="thinking-dots">
                        <i />
                        <i />
                        <i />
                      </div>
                      <span>Worker is continuing the implementation</span>
                    </div>
                  )}
                  {task.run.error && (
                    <div className="run-error">
                      <Terminal size={14} />
                      <div>
                        <strong>The worker needs attention.</strong>
                        <p>{task.run.error}</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="conversation-composer">
                  <div
                    className={
                      "composer-box " +
                      (dictation.phase === "recording" ? "recording" : "")
                    }
                  >
                    <textarea
                      aria-label="Message to worker"
                      placeholder={
                        task.example
                          ? "Explore the conversation, or add a note…"
                          : active
                            ? "Save context for the next worker pass…"
                            : "Add context, ask a follow-up, or describe the next step…"
                      }
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="composer-controls">
                      <div>
                        <WorkerMark task={task} small />
                        <span>
                          {task.assignment === "auto" && !task.route
                            ? "Automatic assignment"
                            : harnessNames[task.harness]}
                        </span>
                        {dictation.phase !== "idle" && (
                          <span className="recording-label">
                            {dictation.phase === "recording"
                              ? "Listening…"
                              : "Transcribing locally…"}
                          </span>
                        )}
                      </div>
                      <div>
                        <button
                          className={"dictation-button " + dictation.phase}
                          title="Dictate a note locally"
                          aria-label="Dictate a note"
                          onClick={() => void dictation.toggle()}
                          disabled={dictation.phase === "transcribing"}
                        >
                          {dictation.phase === "transcribing" ? (
                            <Spinner />
                          ) : dictation.phase === "recording" ? (
                            <Square size={11} />
                          ) : (
                            <AudioLines size={16} />
                          )}
                        </button>
                        <button
                          className="send-button"
                          title="Save message · Ctrl+Enter"
                          aria-label="Save message"
                          disabled={!draft.trim()}
                          onClick={() => void send()}
                        >
                          <ArrowUp size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="composer-hint">
                    <span>
                      <ShieldCheck size={10} />
                      Your conversation stays in this workspace.
                    </span>
                    <span>
                      <kbd>ctrl</kbd>
                      <kbd>↵</kbd> to save
                    </span>
                  </div>
                </div>
              </>
            )}
            {tab === "runbook" && (
              <div className="runbook-view">
                <div className="runbook-intro">
                  <div className="eyebrow">
                    <span />
                    THE OUTCOME
                  </div>
                  <h3>A clear brief. A focused path.</h3>
                  <p>
                    {task.description ||
                      "Add context to the conversation to help the worker understand the outcome."}
                  </p>
                </div>
                <div className="runbook-heading">
                  <h4>Implementation runbook</h4>
                  <span>
                    {task.checklist.filter((item) => item.done).length} of{" "}
                    {task.checklist.length} complete
                  </span>
                </div>
                <div className="runbook-progress">
                  <i style={{ width: progress(task) + "%" }} />
                </div>
                <div className="checklist">
                  {task.checklist.map((item) => (
                    <button
                      key={item.id}
                      className={item.done ? "checked" : ""}
                      onClick={() => toggle(item.id)}
                    >
                      <span className="check-box">
                        {item.done && <Check size={12} />}
                      </span>
                      <span>{item.text}</span>
                    </button>
                  ))}
                </div>
                <form
                  className="add-check"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addCheck();
                  }}
                >
                  <Plus size={14} />
                  <input
                    aria-label="New runbook step"
                    placeholder="Add the next step…"
                    value={check}
                    onChange={(e) => setCheck(e.target.value)}
                  />
                  {check && (
                    <button className="text-button" type="submit">
                      Add
                      <ArrowRight size={12} />
                    </button>
                  )}
                </form>
                <div className="runbook-note">
                  <GitBranch size={15} />
                  <p>
                    This runbook accompanies the worker’s brief. Checked steps
                    reflect workspace progress; review the actual result before
                    accepting a change.
                  </p>
                </div>
              </div>
            )}
            {tab === "changes" &&
              (task.diff ? (
                <div className="diff-view">
                  <p className="shared-diff-note">
                    Combined changes on the epic branch. Other Fleet workers may
                    have contributed to this diff; per-worker attribution has
                    not been verified.
                  </p>
                  <div className="diff-summary">
                    <GitBranch size={14} />
                    <span>{task.run.branch}</span>
                    <span className="diff-review-label">Review candidate</span>
                  </div>
                  <pre>
                    {task.diff.split("\n").map((line, index) => (
                      <span
                        className={
                          line.startsWith("+")
                            ? "added"
                            : line.startsWith("-")
                              ? "removed"
                              : line.startsWith("@@")
                                ? "hunk"
                                : ""
                        }
                        key={index}
                      >
                        <small>{index + 1}</small>
                        {line || " "}
                        <br />
                      </span>
                    ))}
                  </pre>
                </div>
              ) : (
                <Empty
                  icon={<Code2 size={27} />}
                  title="The change will tell its story."
                  description={
                    task.example
                      ? "In a real session, the epic branch’s combined diff appears here for review."
                      : "When the worker finishes, its tracked and new-file changes appear here. A successful exit alone never marks the work done."
                  }
                />
              ))}
            {tab === "artifacts" &&
              (artifact ? (
                artifact.kind === "text" ? (
                  <div className="text-artifact">
                    <button
                      className="text-button"
                      onClick={() => setArtifact(null)}
                    >
                      <ArrowLeft size={12} />
                      All artifacts
                    </button>
                    <h3>{artifact.name}</h3>
                    <pre>{text}</pre>
                  </div>
                ) : (
                  <PreviewPane
                    artifact={artifact}
                    taskId={task.id}
                    obscured={obscured}
                    notify={notify}
                  />
                )
              ) : artifacts.length ? (
                <div className="detail-artifacts">
                  <div className="eyebrow">
                    <span />
                    BUILT ALONG THE WAY
                  </div>
                  <h3>Something you can open.</h3>
                  <p>Output stays connected to the worker that produced it.</p>
                  {artifacts.map((item) => (
                    <button
                      key={item.id}
                      className="artifact-row"
                      onClick={() => void openArtifact(item)}
                    >
                      <span className={"artifact-kind " + item.kind}>
                        {item.kind === "html" ? (
                          <Globe2 size={19} />
                        ) : item.kind === "image" ? (
                          <Image size={19} />
                        ) : (
                          <FileCode2 size={19} />
                        )}
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.source} · {item.kind.toUpperCase()}
                        </small>
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<Files size={27} />}
                  title="Keep the output close."
                  description="Reports, images and HTML files saved by the worker under .memcode/workers/<story-id>/artifacts/ will appear here."
                />
              ))}
            {tab === "browser" && (
              <PreviewPane
                taskId={task.id}
                artifact={artifacts.find((a) => a.kind === "html")}
                obscured={obscured}
                notify={notify}
              />
            )}
          </div>
          <aside className="work-inspector">
            {conflicts.length > 0 && (
              <div className="fleet-paused-banner">
                <span>Fleet paused for your decision</span>
                <button onClick={onDecisions}>
                  Review
                  <ArrowUpRight size={12} />
                </button>
              </div>
            )}
            <section className="inspector-section">
              <div className="inspector-label">
                WORKER ASSIGNMENT
                <span>
                  {task.example ? "PREVIEW" : active ? "ACTIVE" : "LOCAL"}
                </span>
              </div>
              <div className="assigned-worker">
                <WorkerMark task={task} />
                <div>
                  <strong>
                    {task.assignment === "auto" && !task.route
                      ? "Automatic"
                      : harnessNames[task.harness]}
                  </strong>
                  <span>
                    {task.example
                      ? "Example conversation"
                      : active
                        ? "Working on the shared epic branch"
                        : task.assignment === "auto" && !task.route
                          ? "Selected from measured source scope"
                          : available
                            ? "Installed and available"
                            : "Harness not detected"}
                  </span>
                </div>
                <span className={active ? "live-dot" : "quiet-dot"} />
              </div>
              <WorkerAssignment
                task={task}
                runtime={runtime}
                busy={busy}
                plan={plan}
                update={(patch) =>
                  void act(() => window.memcode.updateTask(task.id, patch))
                }
              />
              {active ? (
                <button
                  className="button stop-worker"
                  onClick={() =>
                    void act(() => window.memcode.stopWorker(task.id))
                  }
                  disabled={task.run.state === "stopping"}
                >
                  {task.run.state === "stopping" ? (
                    <Spinner />
                  ) : (
                    <Square size={11} />
                  )}
                  Stop worker
                </button>
              ) : (
                <button
                  className="button start-worker"
                  onClick={() => void run()}
                  disabled={busy || conflicts.length > 0}
                >
                  {busy ? <Spinner /> : <Play size={12} />}{" "}
                  {task.run.workspace ? "Resume story" : "Start worker"}
                  <ArrowUpRight size={12} />
                </button>
              )}
              {task.example && (
                <p className="inspector-caption">
                  Connect a local project to run real work.
                </p>
              )}
            </section>
            <StoryMetadata
              task={task}
              epics={epics}
              tasks={tasks}
              update={(patch) =>
                void act(() => window.memcode.updateTask(task.id, patch))
              }
            />
            <PlanningProperties
              state={state}
              task={task}
              update={(patch) =>
                void act(() => window.memcode.updateTask(task.id, patch))
              }
              open={onOpenTask}
              createChild={onCreateChild}
            />
            <section className="inspector-section context-section">
              <div className="inspector-label">
                CODE CONTEXT
                <GitBranch size={12} />
              </div>
              {task.evidence ? (
                <>
                  <div className="evidence-status">
                    <span
                      className={
                        task.evidence.state === "measured"
                          ? "live-dot"
                          : "quiet-dot"
                      }
                    />
                    {task.evidence.state === "measured"
                      ? "Measured context"
                      : task.evidence.state === "partial"
                        ? "Partial context"
                        : "Not connected"}
                  </div>
                  <p className="context-note">{task.evidence.note}</p>
                  <div className="evidence-counts">
                    <div>
                      <strong>{task.evidence.symbols.length}</strong>
                      <span>Source anchors</span>
                    </div>
                    <div>
                      <strong>
                        {task.evidence.affected === undefined
                          ? "—"
                          : `${task.evidence.affected}${task.evidence.incomplete ? "+" : ""}`}
                      </strong>
                      <span>Observed impact</span>
                    </div>
                  </div>
                  {task.evidence.symbols.slice(0, 3).map((symbol, index) => (
                    <div
                      className="source-anchor"
                      key={symbol.file + symbol.name + index}
                    >
                      <Code2 size={11} />
                      <span>
                        <strong>{symbol.name}</strong>
                        <small>
                          {symbol.file.split(/[\\/]/).slice(-2).join("/")}:
                          {symbol.line}
                        </small>
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <div className="context-empty">
                  <span className="context-glyph">
                    <GitBranch size={20} />
                  </span>
                  <h4>Context before code.</h4>
                  <p>
                    Bring the relevant symbols, relationships and decisions into
                    this work.
                  </p>
                </div>
              )}
              <button
                className="context-action"
                disabled={
                  busy ||
                  project.example ||
                  ["connecting", "indexing"].includes(project.analysis)
                }
                onClick={() =>
                  void act(async () => {
                    setBusy(true);
                    try {
                      if (project.analysis !== "ready")
                        await window.memcode.analyzeProject(project.id);
                      await window.memcode.qualifyTask(task.id);
                    } finally {
                      setBusy(false);
                    }
                  })
                }
              >
                {busy ||
                ["connecting", "indexing"].includes(project.analysis) ? (
                  <Spinner size={12} />
                ) : (
                  <GitBranch size={12} />
                )}{" "}
                {project.analysis === "ready"
                  ? "Refresh work context"
                  : "Connect Memtrace"}
                <ArrowRight size={12} />
              </button>
            </section>
            <section className="inspector-section">
              <div className="inspector-label">
                WORKING AGREEMENT
                <ShieldCheck size={12} />
              </div>
              <div className="agreement-row">
                <Check size={12} />
                <span>Local project and artifact storage</span>
              </div>
              <div className="agreement-row">
                <Check size={12} />
                <span>Shared epic branch with Fleet coordination</span>
              </div>
              <div className="agreement-row">
                <Check size={12} />
                <span>Review before marking done</span>
              </div>
              {task.run.branch && (
                <div className="branch-card">
                  <GitBranch size={12} />
                  <span>{task.run.branch}</span>
                  <button
                    title="Open epic workspace"
                    className="icon-button"
                    onClick={() =>
                      void act(() =>
                        window.memcode.openWorkerWorkspace(task.id),
                      )
                    }
                  >
                    <ArrowUpRight size={12} />
                  </button>
                </div>
              )}
            </section>
            <div className="inspector-footnote">
              <Mark small />
              <span>
                Memtrace provides the context.
                <br />
                You stay in the loop.
              </span>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function LayersIcon() {
  return (
    <span className="detail-folder">
      <Files size={13} />
    </span>
  );
}

function MessageBlock({
  message,
  harness,
}: {
  message: Message;
  harness: WorkItem["harness"];
}) {
  if (message.role === "tool")
    return (
      <details className="tool-message">
        <summary>
          <span className="tool-icon">
            <Terminal size={12} />
          </span>
          <span>{message.text.split("\n")[0].slice(0, 100)}</span>
          <ChevronRight size={12} />
        </summary>
        <pre>
          {message.text.split("\n").slice(1).join("\n") || message.text}
        </pre>
      </details>
    );
  if (message.role === "system")
    return (
      <div className="system-message">
        <span />
        <p>{message.text}</p>
      </div>
    );
  return (
    <article className={"message-block " + message.role}>
      <header>
        {message.role === "user" ? (
          <span className="message-avatar">A</span>
        ) : (
          <HarnessMark id={harness} small />
        )}
        <strong>
          {message.role === "user" ? "You" : harnessNames[harness]}
        </strong>
        <Time at={message.at} />
        {message.role === "assistant" && (
          <span className="message-role">WORKER</span>
        )}
      </header>
      <div className="message-body">{message.text}</div>
    </article>
  );
}

function PreviewPane({
  artifact,
  taskId,
  obscured,
  notify,
}: {
  artifact?: Artifact;
  taskId: string;
  obscured: boolean;
  notify: (s: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("http://localhost:3000");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState(artifact?.name ?? "Local browser");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(!!artifact);
  const [popover, setPopover] = useState(false);
  useEffect(() => {
    const changed = (event: Event) =>
      setPopover((event as CustomEvent<boolean>).detail);
    window.addEventListener("memcode:popover", changed);
    return () => window.removeEventListener("memcode:popover", changed);
  }, []);
  useEffect(() => {
    if (artifact) setLoaded(true);
  }, [artifact?.id]);
  useEffect(
    () =>
      window.memcode.onPreview((event) => {
        setTitle(event.title || "Local preview");
        if (event.error) setError(event.error);
        else setError("");
      }),
    [],
  );
  useEffect(() => {
    if (!loaded || obscured || popover) {
      void window.memcode.hidePreview();
      return;
    }
    const show = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width < 10 || rect.height < 10) return;
      void window.memcode
        .showPreview({
          taskId,
          ...(artifact ? { artifactId: artifact.id } : { url }),
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        })
        .catch((e) => setError(e.message));
    };
    const observer = new ResizeObserver(show);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", show);
    window.addEventListener("scroll", show, true);
    show();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", show);
      window.removeEventListener("scroll", show, true);
      void window.memcode.hidePreview();
    };
  }, [loaded, url, artifact?.id, obscured, popover]);
  const action = async (value: "back" | "forward" | "reload" | "capture") => {
    try {
      await window.memcode.previewAction(value);
      if (value === "capture")
        notify("Screenshot saved to this work item’s artifacts.");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!address.trim()) return;
    setError("");
    setUrl(address.trim());
    setLoaded(true);
  };
  return (
    <div className="browser-pane">
      <div className="browser-tabline">
        <Globe2 size={12} />
        <span>{title}</span>
        <span className="browser-local-badge">LOCAL PREVIEW</span>
      </div>
      <form className="browser-controls" onSubmit={navigate}>
        <button
          type="button"
          className="icon-button"
          title="Back"
          onClick={() => void action("back")}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Forward"
          onClick={() => void action("forward")}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Reload preview"
          onClick={() => void action("reload")}
        >
          <RefreshCw size={12} />
        </button>
        <div className="browser-address">
          <ShieldCheck size={12} />
          <input
            aria-label="Local preview address"
            value={artifact ? artifact.name : address}
            readOnly={!!artifact}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
          />
          {!artifact && (
            <button type="submit" title="Open local address">
              <ArrowRight size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          title="Save screenshot"
          disabled={!loaded}
          onClick={() => void action("capture")}
        >
          <Image size={14} />
        </button>
      </form>
      {error && (
        <div className="browser-error">
          <Circle size={12} />
          {error}
        </div>
      )}
      <div className="browser-content" ref={ref}>
        {!loaded && (
          <Empty
            icon={<Globe2 size={28} />}
            title="Your browser, beside the work."
            description="Open a development server on localhost, or preview an HTML artifact produced by the worker."
            action={
              <button
                className="button secondary"
                onClick={() => {
                  setUrl(address);
                  setLoaded(true);
                }}
              >
                Open localhost:3000
                <ArrowUpRight size={13} />
              </button>
            }
          />
        )}
      </div>
      <footer className="browser-footer">
        <ShieldCheck size={10} />
        Separate browser context. No access to the desktop bridge.
        <span>{artifact?.source ?? "Local development"}</span>
      </footer>
    </div>
  );
}
