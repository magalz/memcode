import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commandIdentity,
  findCommand,
  findDesktopApp,
} from "../runtime/commands";
import type { MacCommandOptions } from "../runtime/mac-commands";
import { cursorInstallationIdentity } from "../runtime/mac-commands";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "memcode-mac-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"),
    apps = join(root, "Applications"),
    system = join(root, "homebrew", "bin");
  await mkdir(home, { recursive: true });
  const options: MacCommandOptions & { platform: "darwin" } = {
    platform: "darwin",
    home,
    environment: { PATH: "/usr/bin:/bin" },
    systemDirectories: [system],
    applicationDirectories: [apps],
  };
  const executable = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "#!/bin/sh\nprintf 'fixture-only\\n'\n", {
      mode: 0o755,
    });
    await chmod(path, 0o755);
    return path;
  };
  const app = async (name: string) => {
    const path = join(apps, name, "Contents");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "Info.plist"),
      '<?xml version="1.0"?><plist><dict/></plist>',
    );
    return join(apps, name);
  };
  return { root, home, apps, system, options, executable, app };
}

test("Mac GUI discovery finds existing Codex and Cursor agent in ~/.local/bin without terminal PATH", async (t) => {
  const f = await fixture(t);
  const codex = await f.executable(join(f.home, ".local", "bin", "codex"));
  const cursor = await f.executable(
    join(f.home, ".local", "bin", "cursor-agent"),
  );
  assert.equal((await findCommand("codex", "", f.options))?.command, codex);
  assert.equal((await findCommand("cursor", "", f.options))?.command, cursor);
  assert.equal(
    (await findCommand("cursor", "", f.options))?.env?.CURSOR_INVOKED_AS,
    "agent",
  );
});

test("an unrelated executable named agent is never mistaken for Cursor", async (t) => {
  const f = await fixture(t);
  await f.executable(join(f.home, ".local", "bin", "agent"));
  assert.equal(await findCommand("cursor", "", f.options), null);
  const root = join(f.home, ".local", "share", "cursor-agent");
  assert.equal(
    cursorInstallationIdentity(
      join(root, "versions", "2026.11.13-build", "cursor-agent"),
      f.home,
    ),
    "cursor-agent-install:" + root,
  );
  assert.equal(
    cursorInstallationIdentity(
      join(root, "versions", "..", "unrelated", "agent"),
      f.home,
    ),
    undefined,
  );
});

test("Mac GUI discovery supports Homebrew and nvm installations without launching a login shell", async (t) => {
  const f = await fixture(t);
  const brew = await f.executable(join(f.system, "codex"));
  assert.equal((await findCommand("codex", "", f.options))?.command, brew);
  await rm(brew);
  const nvm = await f.executable(
    join(f.home, ".nvm", "versions", "node", "v24.2.0", "bin", "codex"),
  );
  const selected = await findCommand("codex", "", f.options);
  assert.equal(selected?.command, nvm);
  assert.ok(
    selected?.env?.PATH?.includes(dirname(nvm)),
    "The CLI's Node/tool directory reaches its child processes.",
  );
});

test("Codex bundled agent is found without confusing the desktop UI executable for a worker", async (t) => {
  const f = await fixture(t);
  const app = await f.app("Codex.app");
  await f.executable(join(app, "Contents", "MacOS", "Codex"));
  assert.equal(
    await findCommand("codex", "", f.options),
    null,
    "A GUI application executable alone is not a CLI worker.",
  );
  const native = await f.executable(
    join(app, "Contents", "Resources", "codex"),
  );
  const found = await findCommand("codex", "", f.options);
  assert.equal(found?.command, native);
  assert.equal(commandIdentity(found!), native);
  assert.equal(await findDesktopApp("codex", f.options), app);
});

test("Cursor editor presence stays distinct from availability of its standalone Agent CLI", async (t) => {
  const f = await fixture(t);
  const app = await f.app("Cursor.app");
  await f.executable(join(app, "Contents", "MacOS", "Cursor"));
  assert.equal(await findDesktopApp("cursor", f.options), app);
  assert.equal(await findCommand("cursor", "", f.options), null);
});

test("npm provider identity is its script rather than MemCode's changing Node executable", async (t) => {
  const f = await fixture(t);
  const entry = join(
    f.system,
    "..",
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "// Synthetic provider entry; never executed.\n");
  const found = await findCommand("codex", "", f.options);
  assert.equal(found?.command, process.execPath);
  assert.deepEqual(found?.prefix, [entry]);
  assert.equal(commandIdentity(found!), entry);
  assert.notEqual(commandIdentity(found!), found?.command);
});

test("known Cursor versioned installations retain a stable provider identity across CLI updates", async (t) => {
  const f = await fixture(t);
  const root = join(f.home, ".local", "share", "cursor-agent");
  const older = await f.executable(
    join(root, "versions", "2026.11.12-aa", "cursor-agent"),
  );
  const first = await findCommand("cursor", "", f.options);
  assert.equal(first?.command, older);
  const newer = await f.executable(
    join(root, "versions", "2026.11.13-bb", "cursor-agent"),
  );
  const second = await findCommand("cursor", "", f.options);
  assert.equal(second?.command, newer);
  assert.equal(commandIdentity(first!), commandIdentity(second!));
  assert.equal(commandIdentity(second!), "cursor-agent-install:" + root);
});

test("discovery ignores directories masquerading as commands and does not require or install missing tools", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".local", "bin", "codex"), { recursive: true });
  assert.equal(await findCommand("codex", "", f.options), null);
  assert.equal(await findDesktopApp("codex", f.options), null);
});
