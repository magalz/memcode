import { BrowserWindow, WebContentsView, session } from "electron";
import { realpath, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { AppState, PreviewInput } from "../src/shared";
import { now, within } from "./local";
import { localURL } from "./urls";

export class PreviewManager {
  private view: WebContentsView | null = null;
  private loaded = "";
  private taskId = "";
  private allowedFileRoot = "";
  constructor(
    private readonly window: BrowserWindow,
    private readonly state: () => AppState,
    private readonly dataDir: string,
    private readonly changed: () => Promise<void>,
  ) {}
  async show(input: PreviewInput): Promise<void> {
    let url: string;
    if (!this.state().tasks.some((t) => t.id === input.taskId))
      throw new Error("Work item not found.");
    if (input.artifactId) {
      const artifact = this.state().artifacts.find(
        (a) => a.id === input.artifactId && a.taskId === input.taskId,
      );
      if (!artifact) throw new Error("Artifact not found in this work item.");
      const path = await realpath(artifact.path);
      const task = this.state().tasks.find((t) => t.id === artifact.taskId);
      const roots = [
        join(this.dataDir, "examples"),
        join(this.dataDir, "captures"),
        ...(task?.run.worktree
          ? [join(task.run.worktree, ".memcode", "artifacts")]
          : []),
      ];
      const root = roots.find((root) => within(root, path));
      if (!root)
        throw new Error(
          "The artifact is outside the permitted output folders.",
        );
      this.allowedFileRoot = root;
      url = pathToFileURL(path).href;
    } else {
      url = localURL(input.url ?? "").href;
      this.allowedFileRoot = "";
    }
    this.taskId = input.taskId;
    if (!this.view) {
      const isolated = session.fromPartition("memcode-preview");
      isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      isolated.setPermissionCheckHandler(() => false);
      isolated.webRequest.onBeforeRequest((details, callback) => {
        try {
          const request = new URL(details.url);
          if (["data:", "blob:", "devtools:"].includes(request.protocol)) {
            callback({ cancel: false });
            return;
          }
          if (request.protocol === "file:") {
            callback({
              cancel:
                !this.allowedFileRoot ||
                !within(this.allowedFileRoot, fileURLToPath(request)),
            });
            return;
          }
          localURL(details.url);
          callback({ cancel: false });
        } catch {
          callback({ cancel: true });
        }
      });
      this.view = new WebContentsView({
        webPreferences: {
          session: isolated,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      const contents = this.view.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      const notify = (error?: string) => {
        if (!this.window.isDestroyed())
          this.window.webContents.send("preview:event", {
            url: contents.getURL(),
            title: contents.getTitle(),
            error,
          });
      };
      contents.on("did-finish-load", () => notify());
      contents.on(
        "did-fail-load",
        (_event, code, description, _url, isMainFrame) => {
          if (isMainFrame && code !== -3)
            notify(
              `Preview could not load: ${description}. Check that the local server is running.`,
            );
        },
      );
      contents.on("will-navigate", (event, target) => {
        try {
          if (target.startsWith("file:")) {
            if (
              !this.allowedFileRoot ||
              !within(this.allowedFileRoot, fileURLToPath(target))
            )
              event.preventDefault();
          } else localURL(target);
        } catch {
          event.preventDefault();
        }
      });
    }
    this.window.contentView.addChildView(this.view);
    const [width, height] = this.window.getContentSize();
    const x = Math.max(0, Math.min(width, input.bounds.x)),
      y = Math.max(36, Math.min(height, input.bounds.y));
    this.view.setBounds({
      x,
      y,
      width: Math.max(1, Math.min(width - x, input.bounds.width)),
      height: Math.max(1, Math.min(height - y, input.bounds.height)),
    });
    if (url !== this.loaded) {
      this.loaded = url;
      await this.view.webContents.loadURL(url).catch(() => {});
    }
  }
  hide(): void {
    if (this.view && !this.window.isDestroyed())
      this.window.contentView.removeChildView(this.view);
  }
  async action(
    action: "back" | "forward" | "reload" | "capture",
  ): Promise<void> {
    if (!this.view) throw new Error("Open a preview first.");
    const contents = this.view.webContents;
    if (action === "back" && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    if (action === "forward" && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    if (action === "reload") contents.reload();
    if (action === "capture") {
      const task = this.state().tasks.find((t) => t.id === this.taskId);
      if (!task) throw new Error("Work item not found.");
      const root = join(this.dataDir, "captures", task.id);
      await mkdir(root, { recursive: true });
      const name = `preview-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      const path = join(root, name);
      await writeFile(path, (await contents.capturePage()).toPNG());
      this.state().artifacts.push({
        id: randomUUID(),
        name,
        kind: "image",
        path,
        taskId: task.id,
        projectId: task.projectId,
        createdAt: now(),
        source: "Local browser",
      });
      await this.changed();
    }
  }
  close(): void {
    this.hide();
    this.view?.webContents.close();
    this.view = null;
  }
}
