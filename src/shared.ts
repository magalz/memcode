import type {
  Cycle,
  CreateCycle,
  CustomField,
  PlanningHistory,
  SavedView,
  TaskPlanningFields,
  WorkflowState,
} from "./planning/types";
import type { QualitySnapshot } from "./intelligence";
import type { ContextAssistantSettings } from "./context-settings";
export type { ContextAssistantSettings } from "./context-settings";
export type { QualitySnapshot, IntelligenceDetail } from "./intelligence";
export type {
  Cycle,
  CreateCycle,
  CustomField,
  PlanningHistory,
  SavedView,
  TaskPlanningFields,
  WorkflowState,
  ViewConfig,
  ViewMode,
  GroupBy,
  WorkFilters,
} from "./planning/types";
export const stages = ["planned", "working", "review", "done"] as const;
export type Stage = (typeof stages)[number];
export type Harness = "codex" | "claude" | "cursor";
export const harnessNames: Record<Harness, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
};
export type ModelTier = "fast" | "balanced" | "frontier" | "extreme";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export interface ModelOption {
  id: string;
  label: string;
  tier: ModelTier;
  source: "cache" | "cli" | "alias";
  efforts?: string[];
}
export interface HarnessRuntime {
  id: Harness;
  name: string;
  available: boolean;
  path: string | null;
  models: ModelOption[];
  note?: string;
}
export interface RouteDecision {
  policyVersion: "memcode-envelope-v2";
  tier: ModelTier;
  harness: Harness;
  model: string;
  effort: ReasoningEffort;
  mode: "automatic" | "manual";
  status: "measured" | "provisional";
  reasons: string[];
  plannedAt: string;
  inputs: {
    cognitive: number | null;
    cyclomatic: number | null;
    nesting: number | null;
    affected: number | null;
    processes: number | null;
    moduleRoots: number;
    incomplete: boolean;
    sourceRevision?: string;
    graphRevision?: string;
  };
}
export type Priority = "high" | "medium" | "low";
export type RunState =
  | "idle"
  | "preparing"
  | "running"
  | "stopping"
  | "stopped"
  | "blocked"
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
    nodeId?: string;
    cognitive?: number;
    cyclomatic?: number;
    nesting?: number;
    metricSource?: "ast" | "estimated";
  }>;
  affected?: number;
  affectedProcesses?: number;
  affectedFiles?: number;
  sourceRevision?: string;
  graphRevision?: string;
  incomplete: boolean;
  note: string;
  measuredAt: string;
}
export interface WorkItem extends TaskPlanningFields {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  stage: Stage;
  priority: Priority;
  category: string;
  harness: Harness;
  assignment?: "auto" | "manual";
  modelOverride?: string | null;
  route?: RouteDecision;
  epicId?: string | null;
  dependsOn?: string[];
  scope?: string[];
  sourceKey?: string;
  kind?: "feature" | "fix" | "refactor" | "research" | "test";
  checklist: ChecklistItem[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  run: {
    state: RunState;
    startedAt?: string;
    finishedAt?: string;
    worktree?: string;
    workspace?: string;
    baseline?: string;
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
  contextAssistant?: ContextAssistantSettings;
  memtracePath: string;
  speechEndpoint: string;
  defaultHarness: Harness;
  model: string;
  localModel: boolean;
  maxWorkers: number;
}
export interface Epic {
  branch?: string;
  baseRevision?: string;
  id: string;
  projectId: string;
  identifier: string;
  title: string;
  description: string;
  phase: "now" | "next" | "later";
  color: "mint" | "cyan" | "lavender" | "amber";
  order: number;
  sourceKey?: string;
}
export interface CreateEpic {
  projectId: string;
  title: string;
  description: string;
  phase: Epic["phase"];
}
export interface AppState {
  qualitySnapshots: QualitySnapshot[];
  cycles: Cycle[];
  savedViews: SavedView[];
  workflowStates: WorkflowState[];
  customFields: CustomField[];
  planning: PlanningHistory;
  version: 1;
  projects: Project[];
  tasks: WorkItem[];
  epics: Epic[];
  fleetConflicts: FleetConflict[];
  artifacts: Artifact[];
  activeProjectId: string;
  settings: Settings;
}
export interface RuntimeInfo {
  appVersion: string;
  harnesses: HarnessRuntime[];
  memtraceAvailable: boolean;
  dataPath: string;
}
export interface CreateTask extends TaskPlanningFields {
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  harness: Harness;
  assignment?: "auto" | "manual";
  epicId?: string | null;
  kind?: WorkItem["kind"];
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
  refreshIntelligence(
    projectId: string,
    refreshIndex?: boolean,
  ): Promise<QualitySnapshot>;
  queryIntelligence(
    projectId: string,
    section: string,
    input?: Record<string, unknown>,
  ): Promise<unknown>;
  createCycle(input: CreateCycle): Promise<Cycle>;
  updateCycle(
    id: string,
    patch: Partial<Omit<CreateCycle, "projectId">>,
  ): Promise<void>;
  startCycle(id: string): Promise<void>;
  completeCycle(
    id: string,
    targetCycleId?: string | null,
  ): Promise<{ moved: number }>;
  saveView(input: Omit<SavedView, "id"> & { id?: string }): Promise<SavedView>;
  deleteView(id: string): Promise<void>;
  saveWorkflow(projectId: string, states: WorkflowState[]): Promise<void>;
  saveCustomFields(projectId: string, fields: CustomField[]): Promise<void>;
  bulkUpdateTasks(ids: string[], patch: TaskPatch): Promise<void>;
  refreshFleet(projectId: string): Promise<void>;
  resolveFleetConflict(
    id: string,
    resolution: string,
    winnerTaskId?: string,
  ): Promise<void>;
  load(): Promise<{ state: AppState; runtime: RuntimeInfo }>;
  onState(listener: (state: AppState) => void): () => void;
  selectFolder(): Promise<string | null>;
  createProject(input: ProjectInput): Promise<Project>;
  selectProject(id: string): Promise<void>;
  analyzeProject(id: string): Promise<void>;
  createTask(input: CreateTask): Promise<WorkItem>;
  createEpic(input: CreateEpic): Promise<Epic>;
  updateEpic(
    id: string,
    patch: Partial<Pick<Epic, "title" | "description" | "phase">>,
  ): Promise<void>;
  installDogfoodBacklog(
    projectId: string,
  ): Promise<{ epics: number; stories: number }>;
  updateTask(id: string, patch: TaskPatch): Promise<void>;
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
  openWorkerWorkspace(id: string): Promise<void>;
  transcribe(wav: ArrayBuffer): Promise<string>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
}
export type TaskPatch = Partial<
  Pick<
    WorkItem,
    | "title"
    | "description"
    | "stage"
    | "priority"
    | "harness"
    | "checklist"
    | "assignment"
    | "modelOverride"
    | "epicId"
    | "dependsOn"
    | "scope"
    | "kind"
  > &
    TaskPlanningFields
>;

export interface FleetConflict {
  id: string;
  projectId: string;
  epicId?: string;
  branch: string;
  taskIds: string[];
  agentIds: string[];
  scope: string[];
  severity: "B" | "C" | "unknown";
  source: "preflight" | "publish" | "episode" | "remote" | "runtime";
  summary: string;
  status: "open" | "resolved";
  createdAt: string;
  escalationId?: string;
  resolution?: string;
  winnerTaskId?: string;
  resolvedAt?: string;
}

declare global {
  interface Window {
    memcode: MemCodeAPI;
  }
}
