import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AppState, Artifact } from "../src/shared";
import { supportingArtifactFolders } from "../src/artifact-purpose";
import { outputRoots } from "./files";
import { within } from "./local";

type FileProbe = (
  path: string,
) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
interface ReconcileOptions {
  taskIds?: ReadonlySet<string>;
  probe?: FileProbe;
  settle?: () => Promise<void>;
}
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Remove catalog records only after confirming absence inside an accessible output location. */
export async function reconcileArtifacts(
  state: AppState,
  dataDir: string,
  options: ReconcileOptions = {},
) {
  const probe: FileProbe = options.probe ?? ((path) => stat(path));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const projects = new Map(
    state.projects.map((project) => [project.id, project]),
  );
  const anchors = new Map<string, Promise<boolean>>();
  const accessible = (path: string) => {
    let result = anchors.get(path);
    if (!result) {
      result = probe(path).then(
        (info) => info.isDirectory(),
        () => false,
      );
      anchors.set(path, result);
    }
    return result;
  };
  const absent = async (artifact: Artifact) => {
    const task = tasks.get(artifact.taskId);
    if (!task) return false;
    const project = projects.get(task.projectId);
    const workspaces = [
      task.run.workspace,
      task.run.worktree,
      project?.path,
    ].filter((path): path is string => !!path);
    const roots = [
      ...outputRoots(dataDir, task),
      ...workspaces.map((path) =>
        join(path, ".memcode", "workers", task.id, "artifacts"),
      ),
    ];
    if (!roots.some((root) => within(root, artifact.path))) return false;
    const anchor = within(dataDir, artifact.path)
      ? dataDir
      : workspaces.find((path) => within(path, artifact.path));
    if (!anchor || !(await accessible(anchor))) return false;
    try {
      return !(await probe(artifact.path)).isFile();
    } catch (error) {
      return missing(error);
    }
  };
  const snapshot = state.artifacts
    .filter(
      (artifact) => !options.taskIds || options.taskIds.has(artifact.taskId),
    )
    .map((artifact) => ({ ...artifact }));
  const candidates: Artifact[] = [];
  for (let offset = 0; offset < snapshot.length; offset += 8) {
    const chunk = snapshot.slice(offset, offset + 8);
    const results = await Promise.all(chunk.map(absent));
    candidates.push(...chunk.filter((_, index) => results[index]));
  }
  if (!candidates.length) return [];
  await (
    options.settle ?? (() => new Promise((resolve) => setTimeout(resolve, 30)))
  )();
  // A second observation protects atomic replacements and brief output rewrites.
  anchors.clear();
  const removed: Artifact[] = [];
  for (const artifact of candidates)
    if (await absent(artifact)) removed.push(artifact);
  const stale = new Map(
    removed.map((artifact) => [
      artifact.id,
      { path: artifact.path, revision: artifact.revision },
    ]),
  );
  const actuallyRemoved: Artifact[] = [];
  state.artifacts = state.artifacts.filter((artifact) => {
    const prior = stale.get(artifact.id);
    if (
      !prior ||
      prior.path !== artifact.path ||
      prior.revision !== artifact.revision
    )
      return true;
    actuallyRemoved.push(artifact);
    return false;
  });
  // Review notes retain their saved quotes, file paths and revisions independently.
  return actuallyRemoved;
}

/** Discover output files and explicit evidence folders, not embedded app assets/dependencies. */
export async function collectedArtifactFiles(root: string) {
  const result: Array<Pick<Artifact, "name" | "path" | "kind" | "revision">> =
    [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (missing(error)) return result;
    throw error;
  }
  const visit = async (directory: string, supporting = false) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          !["node_modules", ".git"].includes(entry.name) &&
          (supporting ||
            supportingArtifactFolders.some(
              (name) => name === entry.name.toLowerCase(),
            ))
        )
          await visit(join(directory, entry.name), true);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const path = await realpath(join(directory, entry.name));
        if (!within(canonicalRoot, path)) continue;
        const info = await stat(path);
        if (!info.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        result.push({
          name: basename(path),
          path,
          revision: `${info.mtimeMs}:${info.size}`,
          kind: [".html", ".htm"].includes(ext)
            ? "html"
            : [".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"].includes(ext)
              ? "image"
              : "text",
        });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  };
  await visit(canonicalRoot);
  return result;
}
