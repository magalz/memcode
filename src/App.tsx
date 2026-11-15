import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CalendarDays,
  ChartNoAxesCombined,
  FileCode2,
  Files,
  Folder,
  GitBranch,
  Layers3,
  LayoutGrid,
  MessageSquare,
  Minus,
  PanelLeft,
  Plus,
  Radio,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  X,
} from "lucide-react";
import type { AppState, RuntimeInfo, WorkItem, Artifact } from "./shared";
import { isActive, tasksForProject } from "./domain";
import {
  Empty,
  HarnessMark,
  Mark,
  Spinner,
  StageIcon,
  Time,
} from "./components/UI";
import { Workspace } from "./components/Workspace";
import { Conversations } from "./components/Conversations";
import { ArtifactThumbnail } from "./components/ArtifactThumbnail";
import { artifactTypeLabel } from "./artifact-format";
import { WorkDetail } from "./components/WorkDetail";
import { Roadmap } from "./components/Roadmap";
import { FleetDecisions } from "./components/FleetDecisions";
import { Cycles } from "./components/Cycles";
import { InsightsPage } from "./components/InsightsPage";
import { Improve } from "./components/Improve";
import { Onboarding } from "./components/Onboarding";
import {
  firstRunGuide,
  type OnboardingPatch,
  type GuideAction,
} from "./onboarding";
import type { GuideDestination } from "./guide-content";
import { WorkerConnections } from "./components/WorkerConnections";
import { AccountConnections } from "./components/AccountConnections";
import type { MemtraceAccount } from "./connections";
import { approvedRuntime } from "./worker-availability";
import { useRuntimeHealth } from "./useRuntimeHealth";
import "./styles-runtime-health.css";
const Docs = lazy(() =>
  import("./components/Docs").then((module) => ({ default: module.Docs })),
);
import {
  NewProjectDialog,
  NewTaskDialog,
  SearchDialog,
  SettingsDialog,
} from "./components/Dialogs";

type View =
  | "board"
  | "roadmap"
  | "cycles"
  | "insights"
  | "improve"
  | "fleet"
  | "workers"
  | "conversations"
  | "artifacts"
  | "activity"
  | "docs";
const pageCopy: Record<View, [string, string, string]> = {
  docs: [
    "A CLEAR PLACE TO BEGIN",
    "The MemCode guide.",
    "Start with the essentials. Find the details when you need them.",
  ],
  cycles: [
    "A RHYTHM FOR THE WORK",
    "Clear cycles. Steady progress.",
    "Plan a focused window, track the scope, and carry the right work forward.",
  ],
  insights: [
    "UNDERSTAND THE MOMENTUM",
    "The work, understood.",
    "See recorded progress and the evidence behind the next decision.",
  ],
  improve: [
    "MEASURE THE CHANGE",
    "Better code, with evidence.",
    "Turn source findings into focused work, then see how the code improves.",
  ],
  fleet: [
    "HUMAN IN THE LOOP",
    "A clear decision. A moving fleet.",
    "Resolve the overlaps, preserve the work, and choose what continues.",
  ],
  board: [
    "THE BIG PICTURE",
    "Your fleet, in focus.",
    "Ideas become clear work. Your agents take it from there.",
  ],
  roadmap: [
    "FROM IDEA TO IMPLEMENTATION",
    "A direction for every story.",
    "Shape the epics. Bank the work. Build it with your fleet.",
  ],
  workers: [
    "YOUR LOCAL FLEET",
    "A place for every worker.",
    "Follow the work, the context, and what needs you next.",
  ],
  conversations: [
    "THINK TOGETHER",
    "Good work starts here.",
    "Pick up the thread without losing the bigger picture.",
  ],
  artifacts: [
    "THE WORK, MADE VISIBLE",
    "From work to something real.",
    "Interactive artifacts, images and reports, ready to open.",
  ],
  activity: [
    "WORKSPACE PULSE",
    "Every step, connected.",
    "A local history of the work moving through your fleet.",
  ],
};

export function App() {
  const runtimeHealth = useRuntimeHealth();
  const [state, setState] = useState<AppState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [view, setView] = useState<View>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(
    null,
  );
  const [storyEpic, setStoryEpic] = useState<string | undefined>();
  const [storyParent, setStoryParent] = useState<string | undefined>();
  const [dialog, setDialog] = useState<
    "task" | "project" | "settings" | "search" | null
  >(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [docsArticle, setDocsArticle] = useState("start");
  const [createEpicRequest, setCreateEpicRequest] = useState(0);
  const [account, setAccount] = useState<MemtraceAccount>();
  const [toast, setToast] = useState("");
  const [fatal, setFatal] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const notify = useCallback((message: string) => {
    setToast(message);
  }, []);
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        notify((error as Error).message);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!window.memcode) {
      setFatal("Open this workspace through the MemCode desktop app.");
      return;
    }
    void window.memcode
      .load()
      .then((result) => {
        setState(result.state);
        setRuntime(result.runtime);
        if (firstRunGuide(result.state))
          void window.memcode.updateOnboarding({
            step: "welcome",
            dismissed: false,
          });
        if (
          result.state.epics.some(
            (epic) => epic.projectId === result.state.activeProjectId,
          )
        )
          setView("roadmap");
      })
      .catch((error) => setFatal(error.message));
    return window.memcode.onState(setState);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector(
          ".modal-backdrop, .connection-consent-backdrop",
        ) ||
        document.querySelector('[data-memcode-select-open="true"]')
      )
        return;
      const input =
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog("search");
      }
      if (event.key === "Escape") {
        setDialog(null);
        setProjectMenu(false);
        if (!dialog) setSelectedId(null);
      }
      if (
        !input &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === "c"
      ) {
        setStoryEpic(undefined);
        setStoryParent(undefined);
        setDialog("task");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dialog]);
  useEffect(() => {
    if (dialog === "settings" && docsArticle === "dictation")
      document
        .querySelector("[data-guide=dictation-settings]")
        ?.scrollIntoView({ block: "center" });
  }, [dialog, docsArticle]);
  if (fatal)
    return (
      <div className="boot-screen">
        <Mark />
        <h1>MemCode needs a moment.</h1>
        <p>{fatal}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!state || !runtime)
    return (
      <div className="boot-screen">
        <Mark />
        <Spinner size={20} />
        <p>Opening your workspace</p>
      </div>
    );
  const project =
    state.projects.find((p) => p.id === state.activeProjectId) ??
    state.projects[0];
  const guideProject =
    state.projects.find((p) => p.id === state.onboarding?.projectId) ?? project;
  const tasks = tasksForProject(state, project.id);
  const epics = state.epics.filter((epic) => epic.projectId === project.id);
  const selected = state.tasks.find((task) => task.id === selectedId);
  const active = runtimeHealth.available
    ? tasks.filter((task) => isActive(task))
    : [];
  const working = tasks.filter((task) => task.stage === "working");
  const artifacts = state.artifacts.filter((a) => a.projectId === project.id);
  const open = (task: WorkItem) => {
    setSelectedArtifact(null);
    setSelectedId(task.id);
    setDialog(null);
  };
  const create = (epicId?: string, parentId?: string) => {
    setStoryEpic(epicId);
    setStoryParent(parentId);
    setDialog("task");
  };
  const updateGuide = (patch: OnboardingPatch) => {
    void act(() => window.memcode.updateOnboarding(patch));
  };
  const startGuide = (restart = false) => {
    setSelectedId(null);
    setDialog(null);
    setProjectMenu(false);
    const progress = state.onboarding;
    updateGuide(
      restart || !progress || progress.completedAt
        ? { restart: true, step: "welcome", dismissed: false }
        : { dismissed: false },
    );
    const step = restart ? "welcome" : progress?.step;
    setView(
      step === "worker"
        ? "workers"
        : step === "epic" || step === "story"
          ? "roadmap"
          : "board",
    );
  };
  const guideAction = (action: GuideAction) => {
    if (action === "project") {
      setDialog("project");
      return;
    }
    if (action === "worker") {
      setView("workers");
      return;
    }
    if (action === "account") {
      setView("workers");
      return;
    }
    const progress = state.onboarding;
    void act(async () => {
      if (progress?.projectId && progress.projectId !== project.id) {
        await window.memcode.selectProject(progress.projectId);
        setState((await window.memcode.load()).state);
      }
      if (action === "epic") {
        setView("roadmap");
        setCreateEpicRequest((value) => value + 1);
      }
      if (action === "story") {
        setView("roadmap");
        create(progress?.epicId);
      }
      if (action === "open-story" && progress?.storyId) {
        const story = state.tasks.find((t) => t.id === progress.storyId);
        if (story) open(story);
      }
    });
  };
  const guideGo = (destination: GuideDestination) => {
    if (destination === "project") {
      setDialog("project");
      return;
    }
    if (destination === "settings") {
      setDocsArticle("dictation");
      setDialog("settings");
      return;
    }
    if (destination === "account") {
      setDialog("settings");
      return;
    }
    setView(destination);
  };
  const navItems: Array<{
    id: View;
    label: string;
    icon: typeof LayoutGrid;
    count?: number;
  }> = [
    { id: "board", label: "Workspace", icon: LayoutGrid },
    { id: "roadmap", label: "Roadmap", icon: Route, count: epics.length },
    {
      id: "cycles",
      label: "Cycles",
      icon: CalendarDays,
      count: state.cycles.filter(
        (cycle) => cycle.projectId === project.id && cycle.state === "active",
      ).length,
    },
    { id: "insights", label: "Insights", icon: ChartNoAxesCombined },
    { id: "improve", label: "Improve", icon: Sparkles },
    {
      id: "fleet",
      label: "Decisions",
      icon: ShieldCheck,
      count: state.fleetConflicts.filter(
        (item) => item.projectId === project.id && item.status === "open",
      ).length,
    },
    {
      id: "workers",
      label: "Workers",
      icon: Workflow,
      count:
        (state.workerInputs ?? []).filter((input) => input.status === "pending")
          .length || active.length,
    },
    { id: "conversations", label: "Conversations", icon: MessageSquare },
    {
      id: "artifacts",
      label: "Artifacts",
      icon: Files,
      count: artifacts.length,
    },
    { id: "activity", label: "Activity", icon: Radio },
    { id: "docs", label: "Docs", icon: BookOpen },
  ];
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="desktop-titlebar" data-tauri-drag-region>
        <div className="titlebar-left">
          <button
            className="icon-button"
            title="Toggle sidebar"
            onClick={() => setCollapsed(!collapsed)}
          >
            <PanelLeft size={14} />
          </button>
          <span>MemCode</span>
          <ChevronRight size={11} />
          <span>{project.name}</span>
        </div>
        <div className="titlebar-center">
          <span className="tiny-local-dot" />
          {import.meta.env.DEV ? "Development · live UI" : "Local workspace"}
        </div>
        <div className="window-controls">
          <button
            aria-label="Minimize"
            onClick={() => void window.memcode.windowAction("minimize")}
          >
            <Minus size={13} />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => void window.memcode.windowAction("maximize")}
          >
            <Square size={10} />
          </button>
          <button
            aria-label="Close"
            onClick={() => void window.memcode.windowAction("close")}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Mark />
          <span>
            MemCode<span className="brand-product">FLEET WORKER SUITE</span>
          </span>
          <span className="alpha-tag">α</span>
        </div>
        <div className="project-picker-wrap">
          <button
            className={"project-picker " + (projectMenu ? "selected" : "")}
            data-guide="project-picker"
            onClick={() => setProjectMenu(!projectMenu)}
          >
            <span className="project-avatar">
              <Layers3 size={17} />
            </span>
            <span>
              <strong>{project.name}</strong>
              <small>
                {project.example ? "Example project" : project.branch}
              </small>
            </span>
            <ChevronDown size={13} />
          </button>
          {projectMenu && (
            <div className="project-menu">
              <span className="menu-eyebrow">YOUR PROJECTS</span>
              {state.projects.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    void act(() => window.memcode.selectProject(item.id));
                    setSelectedId(null);
                    setProjectMenu(false);
                  }}
                >
                  <span className="project-avatar small">
                    <Folder size={14} />
                  </span>
                  <span>
                    {item.name}
                    {item.example && <small>Example</small>}
                  </span>
                  {project.id === item.id && <Check size={13} />}
                </button>
              ))}
              <div className="menu-divider" />
              <button
                onClick={() => {
                  setDialog("project");
                  setProjectMenu(false);
                }}
              >
                <Plus size={16} />
                Add a project
              </button>
            </div>
          )}
        </div>
        <button className="sidebar-search" onClick={() => setDialog("search")}>
          <Search size={14} />
          <span>Search anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={"nav-item " + (view === item.id ? "active" : "")}
              onClick={() => setView(item.id)}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
              {item.count ? <small>{item.count}</small> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-card">
            <span
              className={`engine-orb ${project.analysis === "ready" ? "connected" : ""}`}
            >
              <GitBranch size={15} />
            </span>
            <div>
              <strong>Powered by Memtrace</strong>
              <small>
                {project.analysis === "ready"
                  ? "Code context connected"
                  : project.example
                    ? "Your code. Understood."
                    : "Connect your code context"}
              </small>
            </div>
            {project.analysis === "ready" ? (
              <span className="live-dot" />
            ) : (
              <ArrowUpRight size={13} />
            )}
          </div>
          <div className="sidebar-footer">
            <button onClick={() => setDialog("settings")}>
              <Settings2 size={15} />
              <span>Settings</span>
            </button>
            <span className="version">v{runtime.appVersion}</span>
            <button
              title="Open product guide"
              onClick={() => {
                setDocsArticle("start");
                setView("docs");
              }}
            >
              <CircleHelp size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="workspace-topbar">
          <div>
            <span className="breadcrumb-project">{project.name}</span>
            <ChevronRight size={12} />
            <span>
              {view === "board"
                ? "Workspace"
                : navItems.find((n) => n.id === view)?.label}
            </span>
          </div>
          <div>
            <span
              className={
                "local-pill " +
                (!runtimeHealth.available ? "runtime-offline" : "")
              }
            >
              <span />
              {runtimeHealth.available ? "Local execution" : "Runtime stopped"}
            </span>
            <button
              className="icon-button"
              title="Search workspace"
              onClick={() => setDialog("search")}
            >
              <Search size={16} />
            </button>
            <AccountConnections compact notify={notify} onStatus={setAccount} />
          </div>
        </header>
        {(!runtimeHealth.available || runtimeHealth.saveError) && (
          <div className="runtime-notice" role="alert">
            <Radio size={15} />
            <div>
              <strong>
                {runtimeHealth.available
                  ? "Workspace changes are not saved"
                  : "Runtime disconnected"}
              </strong>
              {runtimeHealth.available
                ? runtimeHealth.saveError
                : "Live worker status is unavailable. Reopen MemCode to reconnect; the last saved workspace is preserved."}
            </div>
          </div>
        )}
        <div className="workspace-scroll">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span />
                {pageCopy[view][0]}
              </div>
              <h1>{pageCopy[view][1]}</h1>
              <p>{pageCopy[view][2]}</p>
            </div>
            {view !== "docs" && (
              <button
                className="button primary"
                data-guide="new-story"
                onClick={() => create()}
              >
                <Plus size={15} />
                {view === "roadmap" ? "New story" : "New work item"}
                <kbd>C</kbd>
              </button>
            )}
          </div>
          {view === "docs" && (
            <Suspense fallback={<Spinner />}>
              <Docs
                initialArticle={docsArticle}
                onStartGuide={startGuide}
                onGo={guideGo}
              />
            </Suspense>
          )}
          {view === "cycles" && (
            <Cycles
              state={state}
              project={project}
              open={open}
              notify={notify}
            />
          )}
          {view === "insights" && (
            <InsightsPage
              state={state}
              project={project}
              open={open}
              notify={notify}
            />
          )}
          {view === "improve" && (
            <Improve
              state={state}
              project={project}
              open={open}
              notify={notify}
            />
          )}
          {view === "roadmap" && (
            <Roadmap
              key={project.id}
              project={project}
              epics={epics}
              tasks={tasks}
              open={open}
              addStory={create}
              notify={notify}
              createRequest={createEpicRequest}
              onCreateRequestConsumed={() => setCreateEpicRequest(0)}
              onEpicCreated={(epic) => {
                if (
                  state.onboarding?.step === "epic" &&
                  !state.onboarding.dismissed
                )
                  updateGuide({ epicId: epic.id, step: "story" });
              }}
            />
          )}
          {view === "fleet" && (
            <FleetDecisions
              project={project}
              conflicts={state.fleetConflicts.filter(
                (item) => item.projectId === project.id,
              )}
              tasks={tasks}
              open={open}
              notify={notify}
            />
          )}
          {view === "board" && (
            <Workspace
              state={state}
              project={project}
              runtime={runtime}
              open={open}
              create={() => create()}
              notify={notify}
              act={act}
              addProject={() => setDialog("project")}
            />
          )}
          {view === "workers" && (
            <section className="workers-view">
              {(state.workerInputs ?? [])
                .filter((input) => input.status === "pending")
                .map((input) => {
                  const task = state.tasks.find(
                    (task) => task.id === input.taskId,
                  );
                  return (
                    task && (
                      <button
                        key={input.id}
                        className="worker-attention-link"
                        onClick={() => open(task)}
                      >
                        <ShieldCheck size={17} />
                        <span>
                          <strong>
                            {input.kind === "approval"
                              ? "Approval needed"
                              : "Waiting for your answer"}
                          </strong>
                          <small>
                            {task.identifier} · {task.title} · {input.title}
                          </small>
                        </span>
                        <ArrowUpRight size={15} />
                      </button>
                    )
                  );
                })}
              <WorkerConnections
                runtime={runtime}
                state={state}
                notify={notify}
                onCreateWork={() => create()}
                onConnected={() => {
                  if (
                    state.onboarding?.step === "worker" &&
                    !state.onboarding.dismissed &&
                    (account?.status === "connected" ||
                      guideProject.analysis === "ready")
                  ) {
                    updateGuide({ step: "epic" });
                    setView("roadmap");
                  }
                }}
              />
              <div className="section-heading">
                <h2>Work in progress</h2>
                <span>
                  {project.example
                    ? "Example project · no live agents"
                    : !runtimeHealth.available
                      ? "Live status unavailable"
                      : `${active.length} active sessions`}
                </span>
              </div>
              {working.length ? (
                <div className="worker-session-list">
                  {working.map((task) => (
                    <button key={task.id} onClick={() => open(task)}>
                      <HarnessMark id={task.harness} />
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {task.identifier} ·{" "}
                          {task.run.workspace
                            ? "Shared epic branch"
                            : task.example
                              ? "Example session"
                              : "Ready to start a worker"}
                        </small>
                      </span>
                      <span className="session-status">
                        <span
                          className={
                            runtimeHealth.available && isActive(task)
                              ? "live-dot"
                              : "quiet-dot"
                          }
                        />
                        {task.example
                          ? "Preview"
                          : !runtimeHealth.available && isActive(task)
                            ? "Connection lost"
                            : isActive(task)
                              ? "Running"
                              : "Not running"}
                      </span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<Workflow size={27} />}
                  title="A clear space to get started."
                  description="Connect a worker, then give it a focused story. Its session will appear here."
                  action={
                    <button className="button primary" onClick={() => create()}>
                      <Plus size={14} />
                      Create work item
                    </button>
                  }
                />
              )}
            </section>
          )}
          {view === "conversations" && (
            <Conversations key={project.id} tasks={tasks} open={open} />
          )}
          {view === "artifacts" &&
            (artifacts.length ? (
              <div className="artifact-library">
                {artifacts.map((artifact) => (
                  <button
                    className={"artifact-tile " + artifact.kind}
                    key={artifact.id}
                    onClick={() => {
                      const task = tasks.find((t) => t.id === artifact.taskId);
                      if (task) {
                        open(task);
                        setSelectedArtifact(artifact);
                      }
                    }}
                  >
                    <ArtifactThumbnail artifact={artifact} />
                    <div>
                      <span className="artifact-extension">
                        {artifactTypeLabel(artifact.name)}
                      </span>
                      <h3>{artifact.name}</h3>
                      <p>
                        {artifact.source}
                        <span>·</span>
                        {
                          tasks.find((t) => t.id === artifact.taskId)
                            ?.identifier
                        }
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                icon={<Files size={27} />}
                title="The output belongs with the work."
                description="When a harness produces a report, image or preview in its artifact folder, you can open it here and in the work item."
                action={
                  <button className="button primary" onClick={() => create()}>
                    <Plus size={14} />
                    Create work item
                  </button>
                }
              />
            ))}
          {view === "activity" && (
            <div className="activity-feed">
              {tasks
                .flatMap((task) =>
                  task.messages.map((message) => ({ task, message })),
                )
                .sort((a, b) => b.message.at.localeCompare(a.message.at))
                .slice(0, 35)
                .map(({ task, message }) => (
                  <button key={message.id} onClick={() => open(task)}>
                    <span className={"activity-marker " + message.role}>
                      {message.role === "tool" ? (
                        <GitBranch size={13} />
                      ) : message.role === "assistant" ? (
                        <Sparkles size={13} />
                      ) : (
                        <MessageSquare size={13} />
                      )}
                    </span>
                    <div>
                      <span className="activity-line">
                        <strong>{task.identifier}</strong>
                        <span>
                          {message.role === "assistant"
                            ? "Worker update"
                            : message.role === "tool"
                              ? "Context or tool output"
                              : message.role === "system"
                                ? "Session update"
                                : "Brief or note"}
                        </span>
                        <Time at={message.at} />
                      </span>
                      <p>{message.text}</p>
                    </div>
                    <ArrowUpRight size={13} />
                  </button>
                ))}
            </div>
          )}
        </div>
      </main>
      {selected && (
        <WorkDetail
          state={state}
          task={selected}
          project={state.projects.find((p) => p.id === selected.projectId)!}
          artifacts={state.artifacts.filter((a) => a.taskId === selected.id)}
          initialArtifact={
            selectedArtifact?.taskId === selected.id
              ? selectedArtifact
              : undefined
          }
          runtime={runtime}
          conflicts={state.fleetConflicts.filter(
            (item) =>
              item.projectId === selected.projectId &&
              item.status === "open" &&
              (item.taskIds.includes(selected.id) ||
                item.epicId === selected.epicId),
          )}
          onDecisions={() => {
            setSelectedId(null);
            setView("fleet");
          }}
          onConnections={() => {
            setSelectedId(null);
            setView("workers");
          }}
          epics={state.epics.filter(
            (epic) => epic.projectId === selected.projectId,
          )}
          tasks={state.tasks.filter(
            (task) => task.projectId === selected.projectId,
          )}
          onClose={() => setSelectedId(null)}
          onOpenTask={open}
          onCreateChild={() =>
            create(selected.epicId ?? undefined, selected.id)
          }
          notify={notify}
          act={act}
          obscured={!!dialog}
        />
      )}
      {dialog === "task" && (
        <NewTaskDialog
          project={project}
          defaultHarness={state.settings.defaultHarness}
          epics={epics}
          initialEpicId={storyEpic}
          cycles={state.cycles.filter(
            (cycle) => cycle.projectId === project.id,
          )}
          parent={state.tasks.find(
            (task) => task.id === storyParent && task.projectId === project.id,
          )}
          onClose={() => setDialog(null)}
          onCreated={(task) => {
            setDialog(null);
            setSelectedId(task.id);
            if (
              state.onboarding?.step === "story" &&
              !state.onboarding.dismissed
            )
              updateGuide({
                storyId: task.id,
                epicId: task.epicId ?? undefined,
                step: "ready",
              });
          }}
          notify={notify}
        />
      )}
      {dialog === "project" && (
        <NewProjectDialog
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            setView("board");
            setSelectedId(null);
            if (
              state.onboarding?.step === "project" &&
              !state.onboarding.dismissed
            )
              void act(async () => {
                const current = await window.memcode.load();
                await window.memcode.updateOnboarding({
                  projectId: current.state.activeProjectId,
                  step: "worker",
                });
                setView("workers");
              });
          }}
          notify={notify}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          settings={state.settings}
          runtime={runtime}
          onClose={() => setDialog(null)}
          onSaved={setRuntime}
          notify={notify}
          onAccountStatus={setAccount}
        />
      )}
      {dialog === "search" && (
        <SearchDialog
          tasks={tasks}
          onClose={() => setDialog(null)}
          open={open}
          create={create}
        />
      )}
      {state.onboarding &&
        !state.onboarding.dismissed &&
        !state.onboarding.completedAt && (
          <Onboarding
            progress={state.onboarding}
            state={state}
            project={guideProject}
            epics={state.epics.filter(
              (e) =>
                e.projectId === (state.onboarding?.projectId ?? project.id),
            )}
            connected={
              runtime.harnesses.some((adapter) =>
                approvedRuntime(adapter, state.workerConnections),
              ) &&
              (account?.status === "connected" ||
                guideProject.analysis === "ready")
            }
            hidden={!!dialog}
            onUpdate={updateGuide}
            onAction={guideAction}
            onDocs={() => {
              updateGuide({ dismissed: true });
              setSelectedId(null);
              setDocsArticle("start");
              setView("docs");
            }}
          />
        )}
      {toast && (
        <div className="toast" role="status">
          <span className="toast-dot" />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
