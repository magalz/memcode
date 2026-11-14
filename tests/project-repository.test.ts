import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectRepository } from "../runtime/project-repository";
import { git } from "../runtime/local";
import type { Project } from "../src/shared";
const project = (path: string): Project => ({
  id: "fixture",
  name: "First project",
  description: "A useful website",
  path,
  branch: "main",
  analysis: "idle",
  createdAt: new Date().toISOString(),
});

test("an empty selected project receives a clean Git baseline and can enter an epic", async () => {
  const path = await mkdtemp(join(tmpdir(), "memcode-empty-project-")),
    item = project(path);
  await ensureProjectRepository(item);
  assert.match(
    await readFile(join(path, "README.md"), "utf8"),
    /A useful website/,
  );
  assert.equal(await git(path, ["status", "--porcelain"]), "");
  assert.ok(await git(path, ["rev-parse", "HEAD"]));
  await git(path, ["switch", "-c", "epic/first"]);
  assert.equal(await git(path, ["branch", "--show-current"]), "epic/first");
});
test("nonempty folders and nested repository selections are preserved rather than adopted", async () => {
  const path = await mkdtemp(join(tmpdir(), "memcode-existing-project-"));
  await writeFile(join(path, "notes.txt"), "Existing user file");
  await assert.rejects(
    ensureProjectRepository(project(path)),
    /not a Git repository/,
  );
  assert.deepEqual(await readdir(path), ["notes.txt"]);
  await git(path, ["init", "--initial-branch=main"]);
  await ensureProjectRepository(project(path));
  assert.equal(
    await readFile(join(path, "notes.txt"), "utf8"),
    "Existing user file",
  );
  assert.match(await git(path, ["status", "--porcelain"]), /notes.txt/);
  const nested = join(path, "nested");
  await mkdir(nested);
  await assert.rejects(
    ensureProjectRepository(project(nested)),
    /repository root/,
  );
  assert.deepEqual(await readdir(nested), []);
});
