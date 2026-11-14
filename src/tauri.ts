import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppState, MemCodeAPI } from "./shared";

const call = <T = void>(method: string, input: unknown = null) =>
  invoke<T>("rpc", { method, input });
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
  await listen<AppState>("workspace:state", (event) =>
    states.forEach((listener) => listener(event.payload)),
  );
  await listen<Parameters<Parameters<MemCodeAPI["onPreview"]>[0]>[0]>(
    "preview:event",
    (event) => previews.forEach((listener) => listener(event.payload)),
  );
  const api: MemCodeAPI = {
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
    addMessage: (id, text) => call("task:message", { id, text }),
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
