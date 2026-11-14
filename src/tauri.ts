import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppState, MemCodeAPI } from "./shared";
import { errorMessage } from "./errors";

const call = async <T = void>(
  method: string,
  input: unknown = null,
): Promise<T> => {
  try {
    return await invoke<T>("rpc", { method, input });
  } catch (error) {
    // Native Tauri rejects with strings; renderer actions expect Error.message.
    throw new Error(errorMessage(error), { cause: error });
  }
};
function wavBase64(wav: ArrayBuffer): string {
  const bytes = new Uint8Array(wav);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
export async function installNativeBridge(): Promise<void> {
  if (!isTauri())
    throw new Error("Open MemCode through its Tauri desktop app.");
  const states = new Set<(state: AppState) => void>();
  const previews = new Set<Parameters<MemCodeAPI["onPreview"]>[0]>();
  const terminals = new Set<Parameters<MemCodeAPI["onTerminal"]>[0]>();
  const reviews = new Set<Parameters<MemCodeAPI["onReview"]>[0]>();
  await listen<import("./review").ReviewEvent>("review:event", (event) =>
    reviews.forEach((listener) => listener(event.payload)),
  );
  await listen<import("./terminal").TerminalOutput>(
    "terminal:output",
    (event) => terminals.forEach((listener) => listener(event.payload)),
  );
  await listen<AppState>("workspace:state", (event) =>
    states.forEach((listener) => listener(event.payload)),
  );
  await listen<Parameters<Parameters<MemCodeAPI["onPreview"]>[0]>[0]>(
    "preview:event",
    (event) => previews.forEach((listener) => listener(event.payload)),
  );
  const api: MemCodeAPI = {
    updateOnboarding: (patch) => call("onboarding:update", patch),
    updateQueuedFollowup: (taskId, messageId, text, commentEdits) =>
      call("review:queue-update", { taskId, messageId, text, commentEdits }),
    cancelQueuedFollowup: (taskId, messageId) =>
      call("review:queue-cancel", { taskId, messageId }),
    storyCommentIdentity: () => call("story-comment:identity"),
    addStoryComment: (taskId, text, parentId) =>
      call("story-comment:add", { taskId, text, parentId }),
    editStoryComment: (taskId, id, text) =>
      call("story-comment:edit", { taskId, id, text }),
    deleteStoryComment: (taskId, id) =>
      call("story-comment:delete", { taskId, id }),
    workerConnectionStatus: () => call("connection:status"),
    connectWorker: (harness, approved) =>
      call("connection:approve", { harness, approved }),
    disconnectWorker: (harness) => call("connection:disconnect", { harness }),
    accountStatus: () => call("account:status"),
    signInMemtrace: () => call("account:sign-in"),
    speechStatus: () => call("speech:status"),
    prepareSpeech: () => call("speech:prepare"),
    installSpeech: () => call("speech:install"),
    stopSpeech: () => call("speech:stop"),
    sendFollowup: (taskId, text, ids) =>
      call("review:send", { taskId, text, ids }),
    saveReviewComment: (input) => call("review:save", input),
    deleteReviewComment: (taskId, id) => call("review:delete", { taskId, id }),
    shareReviewComments: (taskId, ids, text) =>
      call("review:share", { taskId, ids, text }),
    resolveFile: (taskId, href, basePath) =>
      call("file:resolve", { taskId, href, basePath }),
    onReview: (listener) => {
      reviews.add(listener);
      return () => {
        reviews.delete(listener);
      };
    },
    workerChanges: (taskId) => call("worker:changes", taskId),
    terminal: (taskId, request) =>
      call("terminal:request", { taskId, request }),
    onTerminal: (listener) => {
      terminals.add(listener);
      return () => {
        terminals.delete(listener);
      };
    },
    load: () => call("workspace:load"),
    onState: (listener) => {
      states.add(listener);
      return () => {
        states.delete(listener);
      };
    },
    onPreview: (listener) => {
      previews.add(listener);
      return () => {
        previews.delete(listener);
      };
    },
    selectFolder: () => call("project:select-folder"),
    createProject: (input) => call("project:create", input),
    selectProject: (id) => call("project:select", id),
    analyzeProject: (id) => call("project:analyze", id),
    createTask: (input) => call("task:create", input),
    updateTask: (id, patch) => call("task:update", { id, patch }),
    bulkUpdateTasks: (ids, patch) => call("task:bulk-update", { ids, patch }),
    refreshIntelligence: (projectId, refreshIndex) =>
      call("intelligence:refresh", { projectId, refreshIndex }),
    queryIntelligence: (projectId, section, input) =>
      call("intelligence:query", { projectId, section, input }),
    addMessage: (id, text, references) =>
      call("task:message", { id, text, references }),
    qualifyTask: (id) => call("task:qualify", id),
    startWorker: (id) => call("worker:start", id),
    stopWorker: (id) => call("worker:stop", id),
    createEpic: (input) => call("epic:create", input),
    updateEpic: (id, patch) => call("epic:update", { id, patch }),
    installDogfoodBacklog: (id) => call("roadmap:install", id),
    refreshFleet: (id) => call("fleet:refresh", id),
    resolveFleetConflict: (id, resolution, winnerTaskId) =>
      call("fleet:resolve", { id, resolution, winnerTaskId }),
    createCycle: (input) => call("cycle:create", input),
    updateCycle: (id, patch) => call("cycle:update", { id, patch }),
    startCycle: (id) => call("cycle:start", id),
    completeCycle: (id, targetCycleId) =>
      call("cycle:complete", { id, targetCycleId }),
    saveView: (input) => call("view:save", input),
    deleteView: (id) => call("view:delete", id),
    saveWorkflow: (projectId, states) =>
      call("workflow:save", { projectId, states }),
    saveCustomFields: (projectId, fields) =>
      call("fields:save", { projectId, fields }),
    saveSettings: (settings) => call("settings:save", settings),
    showPreview: (input) => call("preview:show", input),
    browser: (taskId, request) => call("browser:request", { taskId, request }),
    hidePreview: () => call("preview:hide"),
    previewAction: (action) => call("preview:action", action),
    readArtifact: (id) => call("artifact:read", id),
    openWorkerWorkspace: (id) => call("worker:open-folder", id),
    transcribe: (wav) => call("speech:transcribe", wavBase64(wav)),
    windowAction: (action) => call("window:action", action),
  };
  window.memcode = api;
  document.addEventListener("mousedown", (event) => {
    if (
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.target.closest(".desktop-titlebar") ||
      event.target.closest("button,input,textarea,a")
    )
      return;
    void getCurrentWindow().startDragging();
  });
}
