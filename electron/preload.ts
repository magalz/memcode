import { contextBridge, ipcRenderer } from "electron";
import type { MemCodeAPI } from "../src/shared";

const api: MemCodeAPI = {
  load: () => ipcRenderer.invoke("workspace:load"),
  onState: (listener) => {
    const fn = (_event: unknown, state: Parameters<typeof listener>[0]) =>
      listener(state);
    ipcRenderer.on("workspace:state", fn);
    return () => ipcRenderer.removeListener("workspace:state", fn);
  },
  selectFolder: () => ipcRenderer.invoke("project:select-folder"),
  createProject: (input) => ipcRenderer.invoke("project:create", input),
  selectProject: (id) => ipcRenderer.invoke("project:select", id),
  analyzeProject: (id) => ipcRenderer.invoke("project:analyze", id),
  createTask: (input) => ipcRenderer.invoke("task:create", input),
  updateTask: (id, patch) => ipcRenderer.invoke("task:update", { id, patch }),
  addMessage: (id, text) => ipcRenderer.invoke("task:message", { id, text }),
  qualifyTask: (id) => ipcRenderer.invoke("task:qualify", id),
  startWorker: (id) => ipcRenderer.invoke("worker:start", id),
  stopWorker: (id) => ipcRenderer.invoke("worker:stop", id),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  showPreview: (input) => ipcRenderer.invoke("preview:show", input),
  hidePreview: () => ipcRenderer.invoke("preview:hide"),
  previewAction: (action) => ipcRenderer.invoke("preview:action", action),
  onPreview: (listener) => {
    const fn = (_event: unknown, result: Parameters<typeof listener>[0]) =>
      listener(result);
    ipcRenderer.on("preview:event", fn);
    return () => ipcRenderer.removeListener("preview:event", fn);
  },
  readArtifact: (id) => ipcRenderer.invoke("artifact:read", id),
  openWorktree: (id) => ipcRenderer.invoke("worker:open-folder", id),
  transcribe: (wav) => ipcRenderer.invoke("speech:transcribe", wav),
  windowAction: (action) => ipcRenderer.invoke("window:action", action),
};
contextBridge.exposeInMainWorld("memcode", api);
