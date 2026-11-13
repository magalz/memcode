export const stages = ["planned", "working", "review", "done"] as const;
export type Stage = (typeof stages)[number];
export type Harness = "codex" | "claude" | "amp";
export type Priority = "high" | "medium" | "low";
export type RunState =
  | "idle"
  | "preparing"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "finished";

export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at: string;
}
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
export interface Artifact {
  id: string;
  name: string;
  kind: "html" | "image" | "text";
  path: string;
  taskId: string;
  projectId: string;
  createdAt: string;
  source: string;
}
export interface Evidence {
  state: "unavailable" | "measured" | "partial";
  symbols: Array<{
    name: string;
    file: string;
    line: number;
    cognitive?: number;
    cyclomatic?: number;
  }>;
  affected?: number;
  incomplete: boolean;
  note: string;
  measuredAt: string;
}
export interface WorkItem {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  stage: Stage;
  priority: Priority;
  category: string;
  harness: Harness;
  checklist: ChecklistItem[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  run: {
    state: RunState;
    startedAt?: string;
    finishedAt?: string;
    worktree?: string;
    branch?: string;
    exitCode?: number;
    error?: string;
    sessionId?: string;
  };
  evidence?: Evidence;
  diff?: string;
  example?: boolean;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  path: string | null;
  branch: string;
  repoId?: string;
  analysis: "idle" | "connecting" | "indexing" | "ready" | "error";
  analysisNote?: string;
  createdAt: string;
  example?: boolean;
}
export interface Settings {
  memtracePath: string;
  speechEndpoint: string;
  defaultHarness: Harness;
  model: string;
  localModel: boolean;
  maxWorkers: number;
}
export interface AppState {
  version: 1;
  projects: Project[];
  tasks: WorkItem[];
  artifacts: Artifact[];
  activeProjectId: string;
  settings: Settings;
}
export interface RuntimeInfo {
  appVersion: string;
  harnesses: Array<{
    id: Harness;
    name: string;
    available: boolean;
    path: string | null;
  }>;
  memtraceAvailable: boolean;
  dataPath: string;
}
export interface CreateTask {
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  harness: Harness;
}
export interface ProjectInput {
  mode: "existing" | "new";
  parent: string;
  name: string;
  description: string;
}
export interface PreviewInput {
  taskId: string;
  url?: string;
  artifactId?: string;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface MemCodeAPI {
  load(): Promise<{ state: AppState; runtime: RuntimeInfo }>;
  onState(listener: (state: AppState) => void): () => void;
  selectFolder(): Promise<string | null>;
  createProject(input: ProjectInput): Promise<Project>;
  selectProject(id: string): Promise<void>;
  analyzeProject(id: string): Promise<void>;
  createTask(input: CreateTask): Promise<WorkItem>;
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        WorkItem,
        "title" | "description" | "stage" | "priority" | "harness" | "checklist"
      >
    >,
  ): Promise<void>;
  addMessage(id: string, text: string): Promise<void>;
  qualifyTask(id: string): Promise<void>;
  startWorker(id: string): Promise<void>;
  stopWorker(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<RuntimeInfo>;
  showPreview(input: PreviewInput): Promise<void>;
  hidePreview(): Promise<void>;
  previewAction(
    action: "back" | "forward" | "reload" | "capture",
  ): Promise<void>;
  onPreview(
    listener: (event: { url: string; title: string; error?: string }) => void,
  ): () => void;
  readArtifact(id: string): Promise<string>;
  openWorktree(id: string): Promise<void>;
  transcribe(wav: ArrayBuffer): Promise<string>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
}

declare global {
  interface Window {
    memcode: MemCodeAPI;
  }
}
