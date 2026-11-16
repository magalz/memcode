import { stat, realpath, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function isKind(path: string, kind: "file" | "directory") {
  try {
    const entry = await stat(path);
    return kind === "file" ? entry.isFile() : entry.isDirectory();
  } catch {
    return false;
  }
}

/**
 * An existing Folder Group claims normal Git repos directly beneath its marker.
 * This selects the MCP store/discovery owner only; indexing still uses project.path.
 * Do not infer scope from an unmarked ancestor, a nested repo, or a .git file
 * (linked worktree/submodule membership requires the engine's own explicit scope).
 */
export async function resolveMcpWorkspace(
  projectPath: string,
): Promise<{ directory: string; workspace?: string }> {
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return { directory: projectPath };
  }
  if (await isKind(join(root, ".memtrace-workspace"), "file"))
    return { directory: root, workspace: root };
  const parent = dirname(root);
  if (
    parent !== root &&
    (await isKind(join(root, ".git"), "directory")) &&
    (await isKind(join(parent, ".memtrace-workspace"), "file"))
  )
    return { directory: parent, workspace: parent };
  return { directory: root };
}

export interface MemtraceScopeBinding {
  mode: "workspace" | "project";
  dataDirectory: string;
  workspaceFile?: string;
}

export async function projectMcpWorkspace(projectPath: string) {
  const directory = await realpath(projectPath),
    anchor = join(directory, ".memcode", "memtrace"),
    workspaceFile = join(anchor, "workspace.toml");
  const expected = `version = 1\nname = "MemCode project"\nmembers = [${JSON.stringify(directory.replaceAll("\\", "/"))}]\n`;
  await mkdir(anchor, { recursive: true });
  let existing: string | null = null;
  try {
    existing = await readFile(workspaceFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== null && existing !== expected)
    throw new Error(
      "The MemCode project workspace manifest has changed. Review its repository membership before reconnecting.",
    );
  if (existing === null)
    await writeFile(workspaceFile, expected, { flag: "wx" });
  return {
    directory,
    workspaceFile,
    dataDirectory: join(anchor, ".memdb"),
    jobDirectory: join(anchor, ".memtrace"),
  };
}

export class MemtraceAdmissionError extends Error {}

const admissionPath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/** A native owner can publish an Episode before its Repository/path row exists. */
export async function admitPrivateEpisodeRepository(
  repos: unknown[],
  scope: Awaited<ReturnType<typeof projectMcpWorkspace>> | null,
  branch: string,
  read: (
    name: "get_repository_stats" | "get_query_revision",
    args: { repo_id: string; branch: string },
  ) => Promise<Record<string, any>>,
): Promise<Record<string, any> | null> {
  // This exception is confined to the app-created, exact one-member private
  // workspace. Never adopt an arbitrary pathless row or infer membership by name.
  if (!scope || !branch || repos.length !== 1) return null;
  const repo = repos[0] as Record<string, any> | null;
  if (!repo || typeof repo !== "object" || repo.ingestion_path !== "episode_only" ||
      repo.path != null || repo.repo_path != null || typeof repo.repo_id !== "string" ||
      !repo.repo_id.trim() || repo.repo_id.length > 500) return null;
  const args = { repo_id: repo.repo_id, branch };
  const stats = await read("get_repository_stats", args);
  if (stats?.repo_in_store !== true || stats?.diagnostic?.kind === "wrong_store" ||
      (stats.repo_id != null && stats.repo_id !== repo.repo_id)) return null;
  for (const path of [stats.path, stats.repo_path]) {
    if (path != null && (typeof path !== "string" || admissionPath(path) !== admissionPath(scope.directory))) return null;
  }
  const revision = await read("get_query_revision", args);
  if (typeof revision?.worktree !== "string" || admissionPath(revision.worktree) !== admissionPath(scope.directory) ||
      revision.branch !== branch || (revision.repo_id != null && revision.repo_id !== repo.repo_id)) return null;
  // A partial revision proves only the selected source binding, never index
  // readiness. analyze() must still verify the complete source/index certificate.
  return repo;
}

/** The SDK merges an inherited uppercase PATH; Windows must receive one spelling. */
export function normalizeMcpEnvironment(
  input: Record<string, string>,
): Record<string, string> {
  const env = { ...input };
  const key =
    Object.keys(env).find((key) => key === "PATH") ??
    Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const value = key ? env[key] : undefined;
  for (const key of Object.keys(env))
    if (key.toUpperCase() === "PATH") delete env[key];
  if (value !== undefined) env.PATH = value;
  return env;
}
