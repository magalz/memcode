import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Command,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  Layers3,
  LayoutGrid,
  List,
  LoaderCircle,
  MessageSquare,
  Minus,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Radio,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Workflow,
  X,
} from "lucide-react";
import type { AppState, RuntimeInfo, WorkItem, Stage } from "./shared";
import { isActive, stageLabel, tasksForProject } from "./domain";
import {
  Empty,
  HarnessMark,
  Mark,
  PriorityMark,
  Spinner,
  StageIcon,
  Time,
} from "./components/UI";
import { WorkBoard } from "./components/Board";
import { WorkDetail } from "./components/WorkDetail";
import {
  NewProjectDialog,
  NewTaskDialog,
  SearchDialog,
  SettingsDialog,
} from "./components/Dialogs";

type View = "board" | "workers" | "conversations" | "artifacts" | "activity";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [view, setView] = useState<View>("board");
  const [mode, setMode] = useState<"board" | "list">("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "task" | "project" | "settings" | "search" | null
  >(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
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
        setFilterOpen(false);
        if (!dialog) setSelectedId(null);
      }
      if (
        !input &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === "c"
      )
        setDialog("task");
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
  const filtered = tasks.filter(
    (task) =>
      (priority === "all" || task.priority === priority) &&
      (!search ||
        `${task.title} ${task.identifier} ${task.description}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const selected = state.tasks.find((task) => task.id === selectedId);
  const active = tasks.filter((task) => isActive(task));
  const working = tasks.filter((task) => task.stage === "working");
  const reviewing = tasks.filter((task) => task.stage === "review");
  const done = tasks.filter((task) => task.stage === "done");
  const artifacts = state.artifacts.filter((a) => a.projectId === project.id);
  const completion = tasks.length
    ? Math.round((done.length / tasks.length) * 100)
    : 0;
  const open = (task: WorkItem) => {
    setSelectedId(task.id);
    setDialog(null);
  };
  const create = () => setDialog("task");
  const move = (id: string, stage: Stage) =>
    void act(() => window.memcode.updateTask(id, { stage }));
  const navItems: Array<{
    id: View;
    label: string;
    icon: typeof LayoutGrid;
    count?: number;
  }> = [
    { id: "board", label: "Workspace", icon: LayoutGrid },
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
      <div className="desktop-titlebar">
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
        <div className="nav-label project-label">
          PROJECTS
          <button
            className="icon-button"
            title="Add project"
            onClick={() => setDialog("project")}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="sidebar-projects">
          {state.projects.map((item) => (
            <button
              key={item.id}
              className={project.id === item.id ? "active" : ""}
              onClick={() => {
                void act(() => window.memcode.selectProject(item.id));
                setView("board");
                setSelectedId(null);
              }}
            >
              <span className="project-dot" />
              {item.name}
              {item.example && <span className="example-mini">preview</span>}
            </button>
          ))}
        </div>
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
            <span className="version">v0.1</span>
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
                {view === "board"
                  ? "THE BIG PICTURE"
                  : view === "workers"
                    ? "YOUR LOCAL FLEET"
                    : view === "conversations"
                      ? "THINK TOGETHER"
                      : view === "artifacts"
                        ? "THE WORK, MADE VISIBLE"
                        : "WORKSPACE PULSE"}
              </div>
              <h1>
                {view === "board"
                  ? "Your fleet, in focus."
                  : view === "workers"
                    ? "A place for every worker."
                    : view === "conversations"
                      ? "Good work starts here."
                      : view === "artifacts"
                        ? "From work to something real."
                        : "Every step, connected."}
              </h1>
              <p>
                {view === "board"
                  ? "Ideas become clear work. Your agents take it from there."
                  : view === "workers"
                    ? "Follow the work, the context, and what needs you next."
                    : view === "conversations"
                      ? "Pick up the thread without losing the bigger picture."
                      : view === "artifacts"
                        ? "Browser previews, reports and files, right where the work happened."
                        : "A local history of the work moving through your fleet."}
              </p>
            </div>
            <button className="button primary" onClick={create}>
              <Plus size={15} />
              New work item<kbd>C</kbd>
            </button>
          </div>
          {view === "board" && (
            <>
              <section className="focus-panel">
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
                    onClick={() =>
                      project.example
                        ? setDialog("project")
                        : void act(() =>
                            window.memcode.analyzeProject(project.id),
                          )
                    }
                  >
                    {project.example
                      ? "Connect your first project"
                      : project.analysis === "ready"
                        ? "Refresh code context"
                        : ["connecting", "indexing"].includes(project.analysis)
                          ? "Analyzing your project"
                          : "Understand this codebase"}
                    {["connecting", "indexing"].includes(project.analysis) ? (
                      <Spinner size={13} />
                    ) : (
                      <ArrowRight size={14} />
                    )}
                  </button>
                </div>
                <div className="focus-right">
                  <div className="cycle-header">
                    <span>WORKSPACE MOMENTUM</span>
                    {project.example ? (
                      <span className="example-pill">Example data</span>
                    ) : (
                      <span>{tasks.length} work items</span>
                    )}
                  </div>
                  <div className="focus-metrics">
                    <div>
                      <strong>
                        {tasks
                          .filter((t) => t.stage === "planned")
                          .length.toString()
                          .padStart(2, "0")}
                      </strong>
                      <span>
                        <span className="metric-dot planned" />
                        Planned
                      </span>
                    </div>
                    <div>
                      <strong>
                        {working.length.toString().padStart(2, "0")}
                      </strong>
                      <span>
                        <span className="metric-dot working" />
                        In progress
                      </span>
                    </div>
                    <div>
                      <strong>
                        {reviewing.length.toString().padStart(2, "0")}
                      </strong>
                      <span>
                        <span className="metric-dot review" />
                        In review
                      </span>
                    </div>
                  </div>
                  <div className="cycle-progress">
                    <div>
                      <i style={{ width: `${completion}%` }} />
                    </div>
                    <span>
                      {done.length} of {tasks.length} complete
                      <em>{completion}%</em>
                    </span>
                  </div>
                  <div className="focus-bottom">
                    <div className="stacked-harnesses">
                      <HarnessMark id="codex" small />
                      <HarnessMark id="claude" small />
                      <HarnessMark id="amp" small />
                    </div>
                    <span>
                      {project.example
                        ? "One workspace. Different strengths."
                        : `${runtime.harnesses.filter((h) => h.available).length} installed harnesses · ${active.length} active workers`}
                    </span>
                  </div>
                </div>
              </section>
              <div className="board-toolbar">
                <div className="board-toolbar-left">
                  <span className="section-title">
                    All work <small>{tasks.length}</small>
                  </span>
                  <span className="toolbar-divider" />
                  <div className="segmented-control">
                    <button
                      title="Board view"
                      aria-label="Board view"
                      className={mode === "board" ? "active" : ""}
                      onClick={() => setMode("board")}
                    >
                      <LayoutGrid size={13} />
                      Board
                    </button>
                    <button
                      title="List view"
                      aria-label="List view"
                      className={mode === "list" ? "active" : ""}
                      onClick={() => setMode("list")}
                    >
                      <List size={14} />
                      List
                    </button>
                  </div>
                </div>
                <div className="board-toolbar-right">
                  <label className="inline-search">
                    <Search size={13} />
                    <input
                      aria-label="Search work items"
                      placeholder="Search work"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        onClick={() => setSearch("")}
                        aria-label="Clear search"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </label>
                  <div className="filter-wrap">
                    <button
                      className={
                        "button subtle filter-button " +
                        (priority !== "all" ? "filtered" : "")
                      }
                      onClick={() => setFilterOpen(!filterOpen)}
                    >
                      <SlidersHorizontal size={13} />
                      Filter
                      {priority !== "all" && <span className="filter-dot" />}
                    </button>
                    {filterOpen && (
                      <div className="filter-menu">
                        <span className="menu-eyebrow">PRIORITY</span>
                        {["all", "high", "medium", "low"].map((value) => (
                          <button
                            key={value}
                            onClick={() => {
                              setPriority(value);
                              setFilterOpen(false);
                            }}
                          >
                            <span className="capitalize">
                              {value === "all" ? "All priorities" : value}
                            </span>
                            {priority === value && <Check size={13} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <WorkBoard
                tasks={filtered}
                mode={mode}
                open={open}
                create={create}
                move={move}
              />
              <div className="board-footnote">
                <GitBranch size={12} />
                <span>
                  {project.example
                    ? "Explore the example, or connect a folder to start your own fleet."
                    : (project.analysisNote ??
                      (project.analysis === "ready"
                        ? "Code context connected to the local Memtrace engine."
                        : "Your work stays local. Analyze the project to add Memtrace context."))}
                </span>
                <button onClick={() => setDialog("project")}>
                  {project.example ? "Open a project" : "Add project"}
                  <ArrowUpRight size={11} />
                </button>
              </div>
            </>
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
                          ? "Your Claude Code setup, in a dedicated local worktree."
                          : "Your Amp setup, with the result kept alongside the work."}
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
                      <button className="text-button" onClick={create}>
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
                          {task.run.worktree
                            ? "Isolated worktree"
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
                    <button className="button primary" onClick={create}>
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
                  <button className="button primary" onClick={create}>
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
          task={selected}
          project={state.projects.find((p) => p.id === selected.projectId)!}
          artifacts={state.artifacts.filter((a) => a.taskId === selected.id)}
          runtime={runtime}
          onClose={() => setSelectedId(null)}
          notify={notify}
          act={act}
          obscured={!!dialog}
        />
      )}
      {dialog === "task" && (
        <NewTaskDialog
          project={project}
          defaultHarness={state.settings.defaultHarness}
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
