import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
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
import type { AppState, RuntimeInfo, WorkItem } from "./shared";
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
import { WorkDetail } from "./components/WorkDetail";
import { Roadmap } from "./components/Roadmap";
import { FleetDecisions } from "./components/FleetDecisions";
import { Cycles } from "./components/Cycles";
import { InsightsPage } from "./components/InsightsPage";
import { Improve } from "./components/Improve";
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
  | "activity";
const pageCopy: Record<View, [string, string, string]> = {
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
    "Browser previews, reports and files, right where the work happened.",
  ],
  activity: [
    "WORKSPACE PULSE",
    "Every step, connected.",
    "A local history of the work moving through your fleet.",
  ],
};

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [view, setView] = useState<View>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storyEpic, setStoryEpic] = useState<string | undefined>();
  const [storyParent, setStoryParent] = useState<string | undefined>();
  const [dialog, setDialog] = useState<
    "task" | "project" | "settings" | "search" | null
  >(null);
  const [projectMenu, setProjectMenu] = useState(false);
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
  const tasks = tasksForProject(state, project.id);
  const epics = state.epics.filter((epic) => epic.projectId === project.id);
  const selected = state.tasks.find((task) => task.id === selectedId);
  const active = tasks.filter((task) => isActive(task));
  const working = tasks.filter((task) => task.stage === "working");
  const artifacts = state.artifacts.filter((a) => a.projectId === project.id);
  const open = (task: WorkItem) => {
    setSelectedId(task.id);
    setDialog(null);
  };
  const create = (epicId?: string, parentId?: string) => {
    setStoryEpic(epicId);
    setStoryParent(parentId);
    setDialog("task");
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
    { id: "workers", label: "Workers", icon: Workflow, count: active.length },
    { id: "conversations", label: "Conversations", icon: MessageSquare },
    {
      id: "artifacts",
      label: "Artifacts",
      icon: Files,
      count: artifacts.length,
    },
    { id: "activity", label: "Activity", icon: Radio },
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
          Local workspace
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
              onClick={() =>
                notify(
                  "Start with a project folder, describe a work item, then launch a worker. Your runbook, conversation, changes and artifacts stay together.",
                )
              }
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
            <span className="local-pill">
              <span />
              Local execution
            </span>
            <button
              className="icon-button"
              title="Search workspace"
              onClick={() => setDialog("search")}
            >
              <Search size={16} />
            </button>
            <button className="user-avatar" title="Your local workspace">
              A
            </button>
          </div>
        </header>
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
            <button className="button primary" onClick={() => create()}>
              <Plus size={15} />
              {view === "roadmap" ? "New story" : "New work item"}
              <kbd>C</kbd>
            </button>
          </div>
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
              project={project}
              epics={epics}
              tasks={tasks}
              open={open}
              addStory={create}
              notify={notify}
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
              <div className="section-heading">
                <h2>Connected harnesses</h2>
                <span>Run locally · models follow your configuration</span>
              </div>
              <div className="harness-grid">
                {runtime.harnesses.map((harness) => (
                  <article key={harness.id} className="harness-card">
                    <div>
                      <HarnessMark id={harness.id} />
                      <span
                        className={
                          "connection-label " +
                          (harness.available ? "available" : "")
                        }
                      >
                        <span />
                        {harness.available ? "Installed" : "Not detected"}
                      </span>
                    </div>
                    <h3>{harness.name}</h3>
                    <p>
                      {harness.id === "codex"
                        ? "Focused implementation with streamed conversation and changes."
                        : harness.id === "claude"
                          ? "Claude Code, coordinated with the other workers on your epic branch."
                          : "Cursor Agent, with measured model routing and shared-branch Fleet coordination."}
                    </p>
                    <div>
                      <span>
                        {
                          tasks.filter(
                            (t) =>
                              t.harness === harness.id &&
                              !t.example &&
                              isActive(t),
                          ).length
                        }{" "}
                        active workers
                      </span>
                      <button className="text-button" onClick={() => create()}>
                        Create work
                        <ArrowUpRight size={12} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="section-heading">
                <h2>Work in progress</h2>
                <span>
                  {project.example
                    ? "Example project · no live agents"
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
                          className={isActive(task) ? "live-dot" : "quiet-dot"}
                        />
                        {task.example
                          ? "Preview"
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
                  description="Create a work item and choose an installed harness. Its session will appear here."
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
            <div className="conversations-grid">
              {tasks
                .filter((t) => t.messages.length)
                .map((task) => (
                  <button
                    className="conversation-card"
                    key={task.id}
                    onClick={() => open(task)}
                  >
                    <div>
                      <HarnessMark id={task.harness} small />
                      <span>{task.identifier}</span>
                      <StageIcon stage={task.stage} />
                    </div>
                    <h3>{task.title}</h3>
                    <p>
                      {task.messages
                        .filter((m) => m.role === "assistant")
                        .at(-1)?.text ?? task.description}
                    </p>
                    <footer>
                      {task.example
                        ? "Example conversation"
                        : new Date(task.updatedAt).toLocaleDateString()}
                      <ArrowUpRight size={14} />
                    </footer>
                  </button>
                ))}
            </div>
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
                      if (task) open(task);
                    }}
                  >
                    <div className="artifact-tile-preview">
                      {artifact.kind === "html" ? (
                        <>
                          <div className="mini-browser-dots">
                            <i />
                            <i />
                            <i />
                          </div>
                          <Mark small />
                          <span>Ideas, made real.</span>
                          <div className="mini-preview-lines">
                            <i />
                            <i />
                            <i />
                          </div>
                        </>
                      ) : (
                        <FileCode2 size={36} />
                      )}
                    </div>
                    <div>
                      <span className="artifact-extension">
                        {artifact.kind.toUpperCase()}
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
