import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Project } from "../src/shared";
import { git } from "./local";

/** Empty folders opened as projects need the same foundation as a new project. */
export async function ensureProjectRepository(project: Project): Promise<void> {
  if (!project.path) throw Error("Choose a local project folder first.");
  const path = project.path;
  let root: string | undefined;
  try {
    root = await git(path, ["rev-parse", "--show-toplevel"]);
  } catch {
    // A genuinely empty folder can be safely initialized without adopting files.
  }
  if (root) {
    if (resolve(root).toLowerCase() !== resolve(path).toLowerCase())
      throw Error(
        `Select the Git repository root (${root}) to connect this project.`,
      );
    return;
  }
  if ((await readdir(path)).length)
    throw Error(
      "This folder is not a Git repository. Initialize Git in it, then refresh code context, or select an existing repository.",
    );
  await git(path, ["init", "--initial-branch=main"]);
  await writeFile(
    join(path, "README.md"),
    `# ${project.name}\n\n${project.description || "A new project, started in MemCode."}\n`,
    { flag: "wx" },
  );
  await writeFile(
    join(path, ".gitignore"),
    ".memcode/\n.memdb/\n.memtrace/\nnode_modules/\n.env\n",
    { flag: "wx" },
  );
  await git(path, ["add", "--", "README.md", ".gitignore"]);
  await git(path, [
    "-c",
    "user.name=MemCode",
    "-c",
    "user.email=local@memcode.invalid",
    "commit",
    "-m",
    "Start project from MemCode brief",
  ]);
  project.branch = "main";
}
