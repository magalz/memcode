import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { errorMessage } from "./errors";

export interface AppUpdateInfo {
  currentVersion: string;
  development: boolean;
  previousError?: string | null;
}
export interface AppRelease {
  version: string;
  notes: string;
  publishedAt?: string | null;
}
export interface PublishedAppRelease {
  version: string;
  title: string;
  notes: string;
  publishedAt: string;
}
export interface UpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  total?: number | null;
}
export interface AppUpdateAPI {
  info(): Promise<AppUpdateInfo>;
  context(): Promise<UpdateContext>;
  history(): Promise<PublishedAppRelease[]>;
  check(): Promise<AppRelease | null>;
  install(
    version: string,
    progress: (value: UpdateProgress) => void,
  ): Promise<void>;
}
export interface UpdateContext {
  activeWorkers: number;
  activeTerminals: number;
}
export type UpdatePhase =
  | "loading"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "error"
  | UpdateProgress["phase"];
export interface AppUpdateSnapshot {
  phase: UpdatePhase;
  info?: AppUpdateInfo;
  release?: AppRelease;
  checkedAt?: string;
  progress?: UpdateProgress;
  error?: string;
}

const nativeAPI: AppUpdateAPI = {
  info: () =>
    isTauri()
      ? invoke("app_update_info")
      : Promise.resolve({ currentVersion: "", development: true }),
  check: () => invoke("app_update_check"),
  context: () => invoke("app_update_context"),
  history: () => invoke("app_update_history"),
  install: (version, progress) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = progress;
    return invoke("app_update_install", { version, channel });
  },
};

/** Retain download progress when Settings closes; no automatic installation. */
export class AppUpdater {
  private snapshot: AppUpdateSnapshot = { phase: "loading" };
  private listeners = new Set<() => void>();
  private initialized?: Promise<void>;
  private busy = false;
  constructor(private readonly api: AppUpdateAPI = nativeAPI) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: Partial<AppUpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    this.listeners.forEach((listener) => listener());
  }
  initialize() {
    return (this.initialized ??= this.api.info().then(
      (info) => {
        this.set({
          info,
          phase: info.previousError ? "error" : "idle",
          error: info.previousError ?? undefined,
        });
      },
      (error) => {
        const message = errorMessage(error);
        this.set({
          phase: "error",
          error: /app_update_info.*not found/i.test(message)
            ? "Restart MemCode to load app-update support from this build."
            : message,
        });
        this.initialized = undefined;
      },
    ));
  }
  inspect() {
    return this.api.context();
  }
  history() {
    return this.api.history();
  }
  async check() {
    if (this.busy || this.snapshot.phase === "installing") return;
    this.busy = true;
    try {
      await this.initialize();
      if (!this.snapshot.info || this.snapshot.info.development) return;
      this.set({
        phase: "checking",
        release: undefined,
        error: undefined,
        progress: undefined,
      });
      const release = await this.api.check();
      this.set({
        phase: release ? "available" : "current",
        release: release ?? undefined,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.set({ phase: "error", error: errorMessage(error) });
    } finally {
      this.busy = false;
    }
  }
  async install() {
    if (
      this.busy ||
      updateBusy(this.snapshot.phase) ||
      !this.snapshot.release ||
      this.snapshot.info?.development
    )
      return;
    this.busy = true;
    const version = this.snapshot.release.version;
    this.set({ phase: "downloading", error: undefined, progress: undefined });
    try {
      await this.api.install(version, (progress) =>
        this.set({ phase: progress.phase, progress }),
      );
      // Native installation restarts the app. Resolving is not evidence that
      // this renderer is running the new version, so never report "installed".
      this.set({ phase: "installing" });
    } catch (error) {
      this.set({ phase: "error", error: errorMessage(error) });
    } finally {
      this.busy = false;
    }
  }
}

export const appUpdater = new AppUpdater();
export const updateBusy = (phase: UpdatePhase) =>
  ["loading", "checking", "downloading", "verifying", "installing"].includes(
    phase,
  );
export function updatePercent(progress?: UpdateProgress): number | undefined {
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.max(
    0,
    Math.min(100, Math.round((progress.downloaded / progress.total) * 100)),
  );
}
