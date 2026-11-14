import { realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { AppState } from "../src/shared";
import { artifactFormat } from "../src/artifact-format";
import { fileLink, type FileReference } from "../src/file-reference";
import { within } from "./local";

export function outputRoots(dataDir: string, task: AppState["tasks"][number]) {
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
export async function resolveFile(
  state: AppState,
  dataDir: string,
  taskId: string,
  href: string,
  basePath?: string,
): Promise<FileReference> {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) throw Error("Work item not found.");
  const project = state.projects.find((p) => p.id === task.projectId),
    root = task.run.workspace ?? task.run.worktree ?? project?.path,
    link = fileLink(href),
    artifacts = state.artifacts.filter((a) => a.taskId === task.id);
  const allowed = [...(root ? [root] : []), ...outputRoots(dataDir, task)];
  const roots = (
    await Promise.all(allowed.map((p) => realpath(p).catch(() => null)))
  ).filter((p): p is string => !!p);
  const named =
    !link.path.includes("/") && !link.path.includes("\\")
      ? artifacts.filter((a) => a.name === link.path)
      : [];
  // A basename from a worker response refers to its saved output when unambiguous.
  const candidate =
    named.length === 1
      ? named[0].path
      : isAbsolute(link.path)
        ? link.path
        : root
          ? resolve(root, link.path)
          : "";
  let path = candidate ? await realpath(candidate).catch(() => null) : null;
  if (!path && basePath && !isAbsolute(link.path))
    path = await realpath(resolve(dirname(basePath), link.path)).catch(
      () => null,
    );
  if (!path)
    throw Error(
      "This file is no longer available in the project or this worker’s saved outputs.",
    );
  if (!roots.some((root) => within(root, path!)))
    throw Error(
      "This file is outside the project and this worker’s output folders.",
    );
  const info = await stat(path);
  if (!info.isFile()) throw Error("Choose a file to preview.");
  const artifact = artifacts.find((a) => resolve(a.path) === resolve(path!));
  let format = artifactFormat(path);
  // Opening source HTML does not execute it. Saved HTML artifacts remain interactive.
  if (!artifact && format === "html") format = "text";
  return {
    path,
    name: basename(path),
    relativePath:
      root && within(root, path)
        ? relative(root, path).replaceAll("\\", "/")
        : basename(path),
    format,
    revision: `${info.mtimeMs}:${info.size}`,
    size: info.size,
    line: link.line,
    ...(artifact ? { artifactId: artifact.id } : {}),
  };
}
