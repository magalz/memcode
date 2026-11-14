import { harnessNames } from "../shared";
import { Select } from "./Select";
import { StoryMetadata, WorkerAssignment } from "./WorkerAssignment";
import { PlanningProperties } from "./PlanningProperties";
import { WorkerBrowser } from "./WorkerBrowser";
import { ArtifactPreview } from "./ArtifactPreview";
import { artifactTypeLabel } from "../artifact-format";
import { isWebLink, type FileReference } from "../file-reference";
import { reviewLocation } from "../review-labels";
import type { ReviewReference, ReviewComment } from "../review";
import { ReviewComposer } from "./ReviewComposer";
import { ReviewNotes } from "./ReviewNotes";
import "../styles-review.css";
import "../styles-annotations.css";
import { WorkerChanges } from "./WorkerChanges";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
const WorkerTerminal = lazy(() =>
  import("./WorkerTerminal").then((module) => ({
    default: module.WorkerTerminal,
  })),
);
const MessageMarkdown = lazy(() => import("./MessageMarkdown"));
type Tab =
  | "conversation"
  | "runbook"
  | "changes"
  | "artifacts"
  | "browser"
  | "terminal"
  | "file";
interface Props {
  state: AppState;
  task: WorkItem;
  project: Project;
  artifacts: Artifact[];
  initialArtifact?: Artifact;
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
  initialArtifact,
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
  const [commentFocus, setCommentFocus] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false),
    [focusedCommentId, setFocusedCommentId] = useState<string>(),
    [editingComment, setEditingComment] = useState<ReviewComment>(),
    [attachedComments, setAttachedComments] = useState<string[]>([]);
  const comments = (state.reviewComments ?? []).filter(
    (comment) => comment.taskId === task.id,
  );
  const [browserLink, setBrowserLink] = useState<{ url: string; id: string }>();
  const [file, setFile] = useState<FileReference>(),
    [references, setReferences] = useState<ReviewReference[]>([]);
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
  const [selectedArtifact, setArtifact] = useState<Artifact | null>(null);
  const artifact =
    artifacts.find((item) => item.id === selectedArtifact?.id) ??
    selectedArtifact;
  const messagesRef = useRef<HTMLDivElement>(null);
  const dictation = useDictation(
    (text) => setDraft((value) => [value, text].filter(Boolean).join("\n")),
    notify,
  );
  useEffect(() => {
    setTab("conversation");
    setDraft("");
    setCommentsOpen(false);
    setFocusedCommentId(undefined);
    setEditingComment(undefined);
    setAttachedComments([]);
    setBrowserLink(undefined);
    setArtifact(null);
    setFile(undefined);
    setReferences([]);
  }, [task.id]);
  useEffect(() => {
    if (initialArtifact) {
      setArtifact(initialArtifact);
      setTab("artifacts");
    }
  }, [initialArtifact?.id, task.id]);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.messages.length, task.id, tab]);
  const run = async () => {
    setBusy(true);
    try {
      if (draft.trim()) {
        if (attachedComments.length)
          await window.memcode.shareReviewComments(
            task.id,
            attachedComments,
            draft.trim(),
          );
        else await window.memcode.addMessage(task.id, draft.trim());
        setDraft("");
        setAttachedComments([]);
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
      if (attachedComments.length)
        await window.memcode.shareReviewComments(
          task.id,
          attachedComments,
          draft.trim(),
        );
      else await window.memcode.addMessage(task.id, draft.trim());
      setDraft("");
      setAttachedComments([]);
      if (isActive(task))
        notify(
          "Follow-up saved. Resume this worker after its current run finishes to apply it.",
        );
      else if (!task.example) await window.memcode.startWorker(task.id);
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
    setTab("artifacts");
  };
  const comment = (reference: ReviewReference) => {
    if (reference.taskId !== task.id) return;
    setReferences([reference]);
    setEditingComment(undefined);
    setCommentsOpen(false);
  };
  const focusComment = async (note: ReviewComment) => {
    void window.memcode.previewAction("clear-selection").catch(() => {});
    setCommentFocus((value) => value + 1);
    setFocusedCommentId(note.id);
    setCommentsOpen(true);
    setReferences([]);
    if (note.reference.kind === "changes") setTab("changes");
    else if (note.reference.kind === "terminal") setTab("terminal");
    else if (note.reference.path)
      await openLink(
        note.reference.path +
          (note.reference.kind === "file" && note.reference.lineStart
            ? ":" + note.reference.lineStart
            : ""),
      );
  };
  const openLink = async (href: string, basePath?: string) => {
    try {
      if (isWebLink(href)) {
        setBrowserLink({ url: href, id: crypto.randomUUID() });
        setTab("browser");
        return;
      }
      const target = await window.memcode.resolveFile(task.id, href, basePath);
      const saved = artifacts.find((item) => item.id === target.artifactId);
      if (saved) {
        setArtifact(saved);
        setTab("artifacts");
      } else {
        setFile(target);
        setTab("file");
      }
    } catch (error) {
      notify((error as Error).message);
    }
  };
  useEffect(
    () =>
      window.memcode.onReview((event) => {
        if (event.action === "comment") comment(event.reference);
        else if (event.action === "focus-comment" && event.taskId === task.id) {
          const note = comments.find((c) => c.id === event.commentId);
          if (note) void focusComment(note);
        } else if (event.action === "link" && event.taskId === task.id)
          void openLink(event.href, event.basePath);
      }),
    [task.id, artifacts, state.reviewComments],
  );
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
    { id: "terminal", label: "Terminal", icon: Terminal },
    ...(file
      ? [{ id: "file" as const, label: file.name, icon: FileCode2 }]
      : []),
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
            {tab === "terminal" && (
              <Suspense fallback={<Spinner />}>
                <WorkerTerminal
                  task={task}
                  onComment={comment}
                  comments={comments.filter(
                    (comment) => comment.reference.kind === "terminal",
                  )}
                  focusedCommentId={focusedCommentId}
                  focusVersion={commentFocus}
                  onFocusComment={(id) => {
                    const note = comments.find((c) => c.id === id);
                    if (note) void focusComment(note);
                  }}
                  onBrowser={(url) => {
                    void openLink(url);
                  }}
                />
              </Suspense>
            )}
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
                      onOpenLink={(href) => void openLink(href)}
                      comments={comments}
                      onOpenReference={(reference, id) => {
                        const note = comments.find((c) => c.id === id);
                        if (note) void focusComment(note);
                        else if (reference.path) void openLink(reference.path);
                      }}
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
                    {attachedComments.length > 0 && (
                      <div className="followup-comment-chips">
                        {attachedComments.map((id) => {
                          const note = comments.find((c) => c.id === id);
                          return note ? (
                            <span key={id}>
                              <MessageSquare size={11} />
                              {note.reference.name} ·{" "}
                              {reviewLocation(note.reference)}
                              <button
                                className="icon-button"
                                aria-label="Remove attached comment"
                                onClick={() =>
                                  setAttachedComments((values) =>
                                    values.filter((value) => value !== id),
                                  )
                                }
                              >
                                <X size={10} />
                              </button>
                            </span>
                          ) : null;
                        })}
                      </div>
                    )}
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
                          title={
                            active
                              ? "Save follow-up for resume · Ctrl+Enter"
                              : "Send follow-up · Ctrl+Enter"
                          }
                          aria-label={
                            active
                              ? "Save follow-up for resume"
                              : "Send follow-up"
                          }
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
            {tab === "changes" && (
              <WorkerChanges
                task={task}
                onComment={comment}
                comments={comments.filter(
                  (comment) => comment.reference.kind === "changes",
                )}
                focusedCommentId={focusedCommentId}
                focusVersion={commentFocus}
                onFocusComment={(id) => {
                  const note = comments.find((c) => c.id === id);
                  if (note) void focusComment(note);
                }}
              />
            )}
            {tab === "file" && file && (
              <ArtifactPreview
                key={file.path}
                file={file}
                commentId={focusedCommentId}
                commentFocus={commentFocus}
                taskId={task.id}
                obscured={obscured}
                onBack={() => setTab("conversation")}
              />
            )}
            {tab === "artifacts" &&
              (artifact ? (
                <ArtifactPreview
                  key={artifact.id}
                  artifact={artifact}
                  commentId={focusedCommentId}
                  commentFocus={commentFocus}
                  taskId={task.id}
                  obscured={obscured}
                  onBack={() => setArtifact(null)}
                />
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
                          {item.source} · {artifactTypeLabel(item.name)}
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
              <WorkerBrowser
                key={task.id}
                task={task}
                obscured={obscured}
                notify={notify}
                opening={browserLink}
                onOpeningConsumed={() => setBrowserLink(undefined)}
              />
            )}
            {comments.length > 0 && !references.length && !commentsOpen && (
              <div className="review-attachment-bar">
                <MessageSquare size={12} />
                {comments.some((comment) => comment.status === "saved")
                  ? comments.filter((comment) => comment.status === "saved")
                      .length + " comments saved locally"
                  : comments.length + " comments on this card"}
                <button onClick={() => setCommentsOpen(true)}>
                  Review comments
                  <ArrowUpRight size={11} />
                </button>
              </div>
            )}
            {commentsOpen && !references.length && (
              <ReviewNotes
                comments={comments}
                focusedId={focusedCommentId}
                onFocus={(note) => void focusComment(note)}
                onClose={() => setCommentsOpen(false)}
                onEdit={(note) => {
                  setEditingComment(note);
                  setReferences([note.reference]);
                  setCommentsOpen(false);
                }}
                onDelete={(note) =>
                  void act(() =>
                    window.memcode.deleteReviewComment(task.id, note.id),
                  )
                }
                onAttach={(ids) => {
                  setAttachedComments(ids);
                  setCommentsOpen(false);
                  setTab("conversation");
                  setDraft(
                    (value) =>
                      value || "Please address the selected review comments.",
                  );
                }}
              />
            )}
            {references.length > 0 && (
              <ReviewComposer
                references={references}
                onRemove={(index) =>
                  setReferences((value) => value.filter((_, i) => i !== index))
                }
                editing={editingComment}
                onClose={() => {
                  setReferences([]);
                  setEditingComment(undefined);
                  void window.memcode
                    .previewAction("clear-selection")
                    .catch(() => {});
                }}
                onSave={async (text, refs) => {
                  for (const reference of refs) {
                    const saved = await window.memcode.saveReviewComment({
                      taskId: task.id,
                      reference,
                      text,
                      id: editingComment?.id,
                    });
                    setFocusedCommentId(saved.id);
                  }
                  notify(
                    "Comment saved on the selection. Add it to a follow-up when you’re ready.",
                  );
                }}
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
  onOpenLink,
  comments,
  onOpenReference,
}: {
  message: Message;
  harness: WorkItem["harness"];
  onOpenLink: (href: string) => void;
  comments: ReviewComment[];
  onOpenReference: (reference: ReviewReference, id?: string) => void;
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
      <div className="message-body">
        {message.references?.length ? (
          <>
            <p>
              {message.reviewText ?? message.text.split("\n\nReference 1:")[0]}
            </p>
            {message.references.map((reference, index) => {
              const note = comments.find(
                (c) => c.id === message.commentIds?.[index],
              );
              return (
                <button
                  key={index}
                  className="message-review-ref"
                  onClick={() => onOpenReference(reference, note?.id)}
                >
                  <strong>{reference.name}</strong>
                  <small>{reviewLocation(reference)}</small>
                  {note &&
                    note.text !==
                      (message.reviewText ??
                        message.text.split("\n\nReference 1:")[0]) && (
                      <p>{note.text}</p>
                    )}
                  <blockquote>{reference.quote}</blockquote>
                </button>
              );
            })}
          </>
        ) : message.role === "assistant" ? (
          <Suspense fallback={message.text}>
            <MessageMarkdown text={message.text} onOpenLink={onOpenLink} />
          </Suspense>
        ) : (
          message.text
        )}
      </div>
    </article>
  );
}
