import { createServer, type Server } from "node:http";
import { realpath, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname, basename, extname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AppState, PreviewInput, WorkItem } from "../src/shared";
import type { NativeHost, Emit } from "./host";
import { within, now } from "./local";
import { localURL } from "./urls";

export function artifactRoots(dataDir: string, task: WorkItem): string[] {
  return [
    join(dataDir, "examples"),
    join(dataDir, "captures", task.id),
    ...(task.run.workspace
      ? [join(task.run.workspace, ".memcode", "workers", task.id, "artifacts")]
      : []),
    ...(task.run.worktree
      ? [join(task.run.worktree, ".memcode", "artifacts")]
      : []),
  ];
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const localSources =
  "http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* http://[::1]:* https://[::1]:*";
const policy = `default-src 'self' data: blob: ${localSources}; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${localSources}; style-src 'self' 'unsafe-inline' ${localSources}; connect-src 'self' ${localSources} ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self' ${localSources}`;
interface Resource {
  token: string;
  root?: string;
  entry?: string;
  target?: URL;
}

export class PreviewManager {
  private server?: Server;
  private origin = "";
  private resource?: Resource;
  private owner = "";
  private visible = false;
  private bounds?: PreviewInput["bounds"];
  private key = "";
  constructor(
    private host: NativeHost,
    private state: () => AppState,
    private dataDir: string,
    private changed: () => Promise<void>,
    private emit: Emit,
  ) {}
  async show(input: PreviewInput): Promise<void> {
    const task = this.state().tasks.find((task) => task.id === input.taskId);
    if (!task) throw new Error("Story not found.");
    const key = input.taskId + ":" + (input.artifactId ?? input.url ?? "");
    if (key !== this.key) {
      let resource: Resource = { token: randomBytes(20).toString("hex") };
      if (input.artifactId) {
        const artifact = this.state().artifacts.find(
          (artifact) =>
            artifact.id === input.artifactId && artifact.taskId === task.id,
        );
        if (!artifact) throw new Error("Artifact not found in this story.");
        const path = await realpath(artifact.path);
        const root = artifactRoots(this.dataDir, task).find((root) =>
          within(root, path),
        );
        if (!root)
          throw new Error(
            "The artifact is outside this worker’s output folders.",
          );
        resource = { ...resource, root: dirname(path), entry: basename(path) };
      } else resource.target = localURL(input.url ?? "");
      this.resource = resource;
      this.key = key;
    }
    await this.listen();
    this.owner = task.id;
    this.bounds = input.bounds;
    this.visible = true;
    const resource = this.resource!;
    const suffix = resource.entry
      ? encodeURIComponent(resource.entry)
      : resource.target!.pathname.slice(1) + resource.target!.search;
    const url = `${this.origin}/p/${resource.token}/${suffix}`;
    await this.host.call("preview_show", { url, bounds: input.bounds });
    this.emit("preview:event", {
      url: input.url ?? "",
      title: input.artifactId
        ? this.state().artifacts.find((a) => a.id === input.artifactId)?.name
        : "Local preview",
    });
  }
  async hide(): Promise<void> {
    this.visible = false;
    await this.host.call("preview_hide", {});
  }
  async action(
    action: "back" | "forward" | "reload" | "capture",
  ): Promise<void> {
    if (!this.visible || !this.resource)
      throw new Error("Open a preview first.");
    if (action !== "capture") {
      await this.host.call("preview_action", { action });
      return;
    }
    const task = this.state().tasks.find((task) => task.id === this.owner);
    if (!task) throw new Error("Story not found.");
    const result = await this.host.call<{ pngBase64: string }>(
      "preview_capture",
      { bounds: this.bounds },
    );
    const bytes = Buffer.from(result.pngBase64, "base64");
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("The native preview did not return a PNG capture.");
    const root = join(this.dataDir, "captures", task.id);
    if (!within(join(this.dataDir, "captures"), root))
      throw new Error("Invalid capture owner.");
    await mkdir(root, { recursive: true });
    const name = `preview-${now().replace(/[:.]/g, "-")}.png`,
      path = join(root, name);
    await writeFile(path, bytes);
    this.state().artifacts.push({
      id: randomUUID(),
      name,
      kind: "image",
      path,
      taskId: task.id,
      projectId: task.projectId,
      createdAt: now(),
      source: "Visible local preview",
    });
    await this.changed();
  }
  private async listen() {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void (async () => {
        const resource = this.resource;
        if (!resource) throw new Error("No preview selected.");
        const url = new URL(request.url ?? "/", this.origin);
        const prefix = `/p/${resource.token}/`;
        const relative = url.pathname.startsWith(prefix)
          ? url.pathname.slice(prefix.length)
          : url.pathname.startsWith("/p/")
            ? null
            : url.pathname.slice(1);
        if (relative === null) throw new Error("Preview token expired.");
        response.setHeader("Content-Security-Policy", policy);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        if (resource.root) {
          if (!["GET", "HEAD"].includes(request.method ?? "GET"))
            throw new Error("Static previews are read-only.");
          const path = await realpath(
            resolve(
              resource.root,
              decodeURIComponent(relative || resource.entry!),
            ),
          );
          if (!within(resource.root, path))
            throw new Error("Preview path is outside the artifact folder.");
          if ((await stat(path)).size > 25_000_000)
            throw new Error(
              "This artifact is too large for a browser preview.",
            );
          response.setHeader(
            "Content-Type",
            mime[extname(path).toLowerCase()] ?? "application/octet-stream",
          );
          response.end(
            request.method === "HEAD" ? undefined : await readFile(path),
          );
          return;
        }
        let target = localURL(
          new URL("/" + relative + url.search, resource.target!.origin).href,
        );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 10_000_000)
            throw new Error("Preview request is too large.");
          chunks.push(chunk);
        }
        let upstream: Response | undefined;
        for (let count = 0; count < 6; count++) {
          upstream = await fetch(target, {
            method: request.method,
            body: ["GET", "HEAD"].includes(request.method ?? "GET")
              ? undefined
              : Buffer.concat(chunks),
            headers: request.headers["content-type"]
              ? { "content-type": request.headers["content-type"] }
              : undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
          });
          if (
            upstream.status >= 300 &&
            upstream.status < 400 &&
            upstream.headers.get("location")
          ) {
            target = localURL(
              new URL(upstream.headers.get("location")!, target).href,
            );
            continue;
          }
          break;
        }
        if (!upstream) throw new Error("Local server returned no response.");
        response.statusCode = upstream.status;
        response.setHeader(
          "Content-Type",
          upstream.headers.get("content-type") ?? "text/html; charset=utf-8",
        );
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > 25_000_000)
          throw new Error("Local preview response is too large.");
        response.end(body);
      })().catch((error) => {
        response.statusCode = 400;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(error.message);
        this.emit("preview:event", {
          url: "",
          title: "Preview needs attention",
          error: error.message,
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Local preview did not acquire a port.");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    await this.hide().catch(() => {});
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
    this.server = undefined;
  }
}
