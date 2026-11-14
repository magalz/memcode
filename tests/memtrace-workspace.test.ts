import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveMcpWorkspace,
  projectMcpWorkspace,
  normalizeMcpEnvironment,
} from "../runtime/memtrace-workspace.ts";

test("MCP uses an existing Folder Group for an immediate normal repository, preserving the project path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memcode-workspace-owner-")),
    project = join(workspace, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  const original = project;
  assert.deepEqual(await resolveMcpWorkspace(project), {
    directory: await realpath(workspace),
    workspace: await realpath(workspace),
  });
  assert.equal(project, original);
});

test("unmarked parents and nested repositories retain their own scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memcode-workspace-scope-")),
    project = join(workspace, "project"),
    nested = join(workspace, "nested", "repo");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(nested, ".git"), { recursive: true });
  assert.deepEqual(await resolveMcpWorkspace(project), {
    directory: await realpath(project),
  });
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  assert.deepEqual(await resolveMcpWorkspace(nested), {
    directory: await realpath(nested),
  });
});

test("a .git file and a non-repository folder do not inherit a parent group", async () => {
  const workspace = await mkdtemp(
      join(tmpdir(), "memcode-workspace-membership-"),
    ),
    worktree = join(workspace, "worktree"),
    folder = join(workspace, "folder");
  await mkdir(worktree);
  await mkdir(folder);
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  await writeFile(join(worktree, ".git"), "gitdir: somewhere-else");
  assert.deepEqual(await resolveMcpWorkspace(worktree), {
    directory: await realpath(worktree),
  });
  assert.deepEqual(await resolveMcpWorkspace(folder), {
    directory: await realpath(folder),
  });
});

test("an explicitly marked project is its own discovery owner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memcode-workspace-self-")),
    project = join(workspace, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(workspace, ".memtrace-workspace"), "");
  await writeFile(join(project, ".memtrace-workspace"), "");
  assert.deepEqual(await resolveMcpWorkspace(project), {
    directory: await realpath(project),
    workspace: await realpath(project),
  });
});

test("fallback manifest admits one exact project and preserves an existing edited manifest", async () => {
  const project = await mkdtemp(join(tmpdir(), "memcode-private-scope-"));
  const scope = await projectMcpWorkspace(project);
  const text = await readFile(scope.workspaceFile, "utf8");
  assert.equal(
    text,
    `version = 1\nname = "MemCode project"\nmembers = [${JSON.stringify((await realpath(project)).replaceAll("\\", "/"))}]\n`,
  );
  assert.ok(scope.dataDirectory.startsWith(await realpath(project)));
  assert.deepEqual(await projectMcpWorkspace(project), scope);
  await writeFile(scope.workspaceFile, 'version = 1\nmembers = ["other"]\n');
  await assert.rejects(projectMcpWorkspace(project), /manifest has changed/);
  assert.equal(
    await readFile(scope.workspaceFile, "utf8"),
    'version = 1\nmembers = ["other"]\n',
  );
});

test("the MCP SDK receives a single uppercase PATH with the prepared child path preserved", () => {
  const source = {
    Path: "prepared-git;prepared-node",
    APPDATA: "fixture-data",
    MODEL_SETTING: "retained",
  };
  const result = normalizeMcpEnvironment(source);
  assert.equal(result.PATH, source.Path);
  assert.equal(result.Path, undefined);
  assert.equal(result.MODEL_SETTING, "retained");
  assert.equal(result.APPDATA, "fixture-data");
  assert.equal(source.Path, "prepared-git;prepared-node");
  assert.deepEqual(
    Object.keys(
      normalizeMcpEnvironment({ PATH: "prepared", Path: "duplicate" }),
    ).filter((key) => key.toLowerCase() === "path"),
    ["PATH"],
  );
});
