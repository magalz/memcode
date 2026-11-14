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
