import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { initialState } from "../src/seed";
import { findCommand } from "../runtime/commands";
import {
  bindRepository,
  checkRepositoryAccess,
  cloneRepository,
  findExistingRepositories,
  GitHubRepositorySignIn,
  inspectRepository,
  repositoryAccessFailure,
  sanitizeRepositoryURL,
  type RepositoryOptions,
  type RepositoryRunner,
} from "../runtime/repository-onboarding";

const execute = promisify(execFile);
const repository = sanitizeRepositoryURL(
  "https://github.com/studio/product.git",
);
const reply = (stdout = "") => ({ stdout, stderr: "" });
const failure = (stderr: string) =>
  Object.assign(Error("Git failed"), { stderr });
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "memcode-repository-test-")),
  );
  t.after(async () => {
    assert.ok(basename(root).startsWith("memcode-repository-test-"));
    assert.ok(root.startsWith((await realpath(tmpdir())) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const command = await findCommand("git");
  assert.ok(command, "Git is required for repository tests");
  const global = join(root, "gitconfig");
  await writeFile(global, "");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: global,
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args: string[], cwd = root) =>
    (
      await execute(command.command, [...command.prefix, ...args], {
        cwd,
        env,
        windowsHide: true,
        encoding: "utf8",
      })
    ).stdout;
  const options: RepositoryOptions = {
    commandFor: async (name) =>
      name === "git"
        ? {
            ...command,
            env: {
              ...command.env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: global,
            },
          }
        : null,
  };
  const source = join(root, "source");
  await mkdir(source);
  await git(["init", "--initial-branch=main"], source);
  await writeFile(join(source, "README.md"), "Original source\n");
  await git(["add", "README.md"], source);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Fixture",
    ],
    source,
  );
  await git(
    [
      "remote",
      "add",
      "origin",
      "https://credential:DO-NOT-SHARE@github.com/studio/product.git?token=PRIVATE",
    ],
    source,
  );
  return { root, source, git, options, global };
}

test("portable source metadata strips secrets and agrees across HTTPS and SSH", () => {
  const https = sanitizeRepositoryURL(
    "https://person:private-token@github.com/Studio/Product.git?token=SECRET#private",
    "epic/team",
  );
  assert.deepEqual(https, {
    url: "https://github.com/Studio/Product.git",
    identity: "github.com/studio/product",
    provider: "github",
    name: "Product",
    defaultBranch: "epic/team",
  });
  assert.equal(
    sanitizeRepositoryURL("git@github.com:Studio/Product.git").identity,
    https.identity,
  );
  assert.equal(
    sanitizeRepositoryURL("ssh://git@github.com/Studio/Product.git").identity,
    https.identity,
  );
  assert.equal(
    sanitizeRepositoryURL("https://gitlab.com/department/group/product.git")
      .provider,
    "gitlab",
  );
  assert.equal(
    sanitizeRepositoryURL("ssh://git@git.example.org:2222/Studio/Product.git")
      .identity,
    "git.example.org:2222/Studio/Product",
  );
  assert.doesNotMatch(JSON.stringify(https), /private|SECRET/);
  for (const value of [
    "file:///private/repository",
    "ext::bad command",
    "-uhttps://example.org/repo",
    "http://github.com/org/repo",
    "https://github.com/org/../repo",
    "https://github.com/org/%2e%2e/repo",
    "https://github.com/org/repo/tree/main",
    "ssh://git:secret@example.org/org/repo",
    "https://example.org/one/%5csecret",
  ])
    assert.throws(() => sanitizeRepositoryURL(value), value);
  for (const branch of [
    "-unsafe",
    "../main",
    "main.lock",
    "main@{0}",
    "refs//main",
  ])
    assert.throws(() => sanitizeRepositoryURL(repository.url, branch));
});

test("real checkout inspection and binding preserve dirty source, verify identity, and reuse known clones", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.source, "README.md"),
    "Uncommitted work must survive\n",
  );
  const inspected = await inspectRepository(f.source, f.options);
  assert.equal(inspected.branch, "main");
  assert.equal(inspected.dirty, true);
  assert.equal(inspected.repository?.identity, repository.identity);
  assert.doesNotMatch(JSON.stringify(inspected), /DO-NOT-SHARE|PRIVATE/);
  const state = initialState(),
    project = {
      ...state.projects[0],
      id: "joined",
      path: null,
      example: false,
    };
  state.projects = [
    project,
    { ...project, id: "private-clone", path: f.source },
  ];
  state.tasks = [];
  assert.equal(
    (await findExistingRepositories(state, repository, f.options)).length,
    1,
  );
  const approvedFolders = new Set([f.source]);
  await assert.rejects(
    bindRepository(state, project.id, f.source, {
      ...f.options,
      approvedFolders: new Set(),
      expected: repository,
    }),
    /folder picker/,
  );
  await assert.rejects(
    bindRepository(state, project.id, f.source, {
      ...f.options,
      approvedFolders,
      expected: sanitizeRepositoryURL("https://github.com/other/repo"),
    }),
    /different repository/,
  );
  assert.equal(project.path, null);
  const bound = await bindRepository(state, project.id, f.source, {
    ...f.options,
    approvedFolders,
    expected: repository,
  });
  assert.equal(bound.path, f.source);
  assert.equal(bound.analysis, "idle");
  assert.equal(
    await readFile(join(f.source, "README.md"), "utf8"),
    "Uncommitted work must survive\n",
  );
  state.tasks = [
    {
      ...initialState().tasks[0],
      projectId: "private-clone",
      run: { state: "running" },
    },
  ];
  await assert.rejects(
    bindRepository(state, project.id, f.source, {
      ...f.options,
      approvedFolders,
      expected: repository,
    }),
    /Stop the active workers/,
  );
});

test("access respects working Git credentials before requiring a provider connection", async () => {
  const calls: string[] = [];
  const run: RepositoryRunner = async (program) => {
    calls.push(program);
    return reply("ref: refs/heads/main\tHEAD\n123\tHEAD\n");
  };
  const access = await checkRepositoryAccess(repository, { run });
  assert.equal(access.state, "ready");
  assert.equal(access.method, "git");
  assert.deepEqual(calls, ["git"]);
  const branch = await checkRepositoryAccess(
    { ...repository, defaultBranch: "epic/not-pushed" },
    { run },
  );
  assert.equal(branch.state, "unknown");
  assert.match(branch.message, /push that branch/);
});

test("access diagnoses auth, missing permission and offline without exposing subprocess output", async () => {
  for (const [error, expected] of [
    [
      "Permission denied (publickey) TOKEN=SECRET\nfatal: Could not read from remote repository.",
      "needs-sign-in",
    ],
    ["repository not found SECRET", "no-access"],
    ["Could not resolve host SECRET", "offline"],
    ["Unexpected SECRET", "unknown"],
  ]) {
    const access = repositoryAccessFailure(failure(error), repository);
    assert.equal(access.state, expected);
    assert.doesNotMatch(JSON.stringify(access), /SECRET/);
  }
  const cli: RepositoryRunner = async (program, args) => {
    if (program === "git")
      throw failure("could not read Username: terminal prompts disabled");
    if (args[1] === "user")
      return reply('{"login":"teammate","token":"NEVER-RETURN"}');
    if (args[1].includes("/branches/")) throw failure("HTTP 404");
    return reply('{"full_name":"studio/product","permissions":{"push":false}}');
  };
  const access = await checkRepositoryAccess(repository, { run: cli });
  assert.equal(access.state, "ready");
  assert.equal(access.accountLabel, "teammate");
  assert.equal(access.writeAccess, false);
  assert.doesNotMatch(JSON.stringify(access), /NEVER-RETURN/);
  assert.equal(
    (
      await checkRepositoryAccess(
        { ...repository, defaultBranch: "missing" },
        { run: cli },
      )
    ).state,
    "unknown",
  );
  const offline: RepositoryRunner = async () => {
    throw failure("ETIMEDOUT");
  };
  assert.equal(
    (await checkRepositoryAccess(repository, { run: offline })).state,
    "offline",
  );
});

test("real HTTP clone produces readable files while suppressing hooks, filters and project scripts", async (t) => {
  const f = await fixture(t),
    remote = join(f.root, "product.git");
  await writeFile(
    join(f.source, ".gitattributes"),
    "README.md filter=danger\n",
  );
  await writeFile(
    join(f.source, "package.json"),
    '{"scripts":{"postinstall":"DO-NOT-RUN"}}',
  );
  await f.git(["add", "."], f.source);
  await f.git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Attributes",
    ],
    f.source,
  );
  await f.git(["clone", "--bare", "--", f.source, remote]);
  await f.git(["update-server-info"], remote);
  const template = join(f.root, "templates"),
    hook = join(template, "hooks");
  await mkdir(hook, { recursive: true });
  const marker = join(f.root, "HOOK-RAN");
  await writeFile(
    join(hook, "post-checkout"),
    `#!/bin/sh\necho forbidden > '${marker.replace(/\\/g, "/")}'\n`,
    { mode: 0o755 },
  );
  await f.git(["config", "--file", f.global, "init.templateDir", template]);
  await f.git([
    "config",
    "--file",
    f.global,
    "filter.danger.smudge",
    "DO-NOT-RUN-UNKNOWN-FILTER",
  ]);
  await f.git(["config", "--file", f.global, "filter.danger.required", "true"]);
  const server = createServer(async (req, res) => {
    const path = resolve(
      f.root,
      "." + decodeURIComponent(new URL(req.url!, "http://localhost").pathname),
    );
    if (!path.startsWith(f.root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(path);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveServer) =>
    server.listen(0, "127.0.0.1", resolveServer),
  );
  t.after(
    () =>
      new Promise<void>((resolveServer) => server.close(() => resolveServer())),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const source = sanitizeRepositoryURL(
    `http://127.0.0.1:${address.port}/product.git`,
    "main",
  );
  const phases: string[] = [];
  const cloned = await cloneRepository(
    {
      repository: source,
      parent: f.root,
      name: "my code",
      approvedFolders: new Set([f.root]),
      onProgress: (progress) => phases.push(progress.phase),
    },
    f.options,
  );
  assert.equal(cloned.repository?.identity, source.identity);
  assert.equal(cloned.branch, "main");
  assert.equal(
    await readFile(join(cloned.path, "README.md"), "utf8"),
    "Original source\n",
  );
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.equal(phases[0], "checking");
  assert.equal(phases.at(-1), "ready");
  assert.ok(phases.includes("cloning"));
  await writeFile(join(cloned.path, "keep.txt"), "Do not overwrite");
  await assert.rejects(
    cloneRepository(
      {
        repository: source,
        parent: f.root,
        name: "my code",
        approvedFolders: new Set([f.root]),
      },
      f.options,
    ),
    /already exists/,
  );
  assert.equal(
    await readFile(join(cloned.path, "keep.txt"), "utf8"),
    "Do not overwrite",
  );
});

test("failed and cancelled clone preserve partial folders and cannot adopt them as success", async (t) => {
  const f = await fixture(t),
    events: string[] = [];
  const run: RepositoryRunner = async (_program, args) => {
    if (args.includes("ls-remote")) return reply("123\tHEAD\n");
    const destination = args.at(-1)!;
    await writeFile(join(destination, "partial.txt"), "Preserve partial work");
    throw failure("unexpected TOKEN=SECRET");
  };
  await assert.rejects(
    cloneRepository(
      {
        repository,
        parent: f.root,
        name: "partial",
        approvedFolders: new Set([f.root]),
        onProgress: (event) => events.push(event.phase),
      },
      { run },
    ),
    /folder is preserved/,
  );
  assert.equal(
    await readFile(join(f.root, "partial", "partial.txt"), "utf8"),
    "Preserve partial work",
  );
  assert.deepEqual(events, ["checking", "cloning", "failed"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cloneRepository(
      {
        repository,
        parent: f.root,
        name: "cancelled",
        approvedFolders: new Set([f.root]),
        signal: controller.signal,
      },
      { run },
    ),
    /cancelled/,
  );
  await assert.rejects(stat(join(f.root, "cancelled")), { code: "ENOENT" });
});

test("GitHub CLI access is actually used for cloning without exporting provider tokens", async (t) => {
  const f = await fixture(t);
  let ghClone = false;
  const run: RepositoryRunner = async (program, args, settings) => {
    if (program === "git" && args.includes("ls-remote"))
      throw failure("could not read Username: terminal prompts disabled");
    if (program === "gh" && args[0] === "api")
      return reply(
        args[1] === "user"
          ? '{"login":"teammate"}'
          : '{"full_name":"studio/product"}',
      );
    if (program === "gh" && args[0] === "repo") {
      ghClone = true;
      assert.equal(args[2], "https://github.com/studio/product.git");
      assert.ok(args.includes("--no-upstream"));
      assert.ok(args.includes("--no-checkout"));
      assert.ok(args.some((arg) => arg.startsWith("core.hooksPath=")));
      const destination = args[3];
      await f.git(["clone", "--no-checkout", "--", f.source, destination]);
      await f.git(["remote", "set-url", "origin", repository.url], destination);
      return reply();
    }
    assert.equal(program, "git");
    return reply(await f.git(args, settings?.cwd));
  };
  const cloned = await cloneRepository(
    {
      repository,
      parent: f.root,
      name: "github-clone",
      approvedFolders: new Set([f.root]),
    },
    { run },
  );
  assert.equal(ghClone, true);
  assert.equal(cloned.repository?.identity, repository.identity);
  assert.equal(
    await readFile(join(cloned.path, "README.md"), "utf8"),
    "Original source\n",
  );
});

test("cancelling an active clone ends its subprocess tree and preserves its partial files", async (t) => {
  const f = await fixture(t),
    script = join(f.root, "slow-git.cjs"),
    controller = new AbortController();
  await writeFile(
    script,
    'const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");if(process.argv.includes("ls-remote")){console.log("123\\tHEAD");}else{const dir=process.argv.at(-1);const child=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(path.join(dir,"partial.json"),JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},1000);}',
  );
  t.after(() => controller.abort());
  const result = cloneRepository(
    {
      repository,
      parent: f.root,
      name: "active-cancel",
      approvedFolders: new Set([f.root]),
      signal: controller.signal,
    },
    {
      commandFor: async () => ({ command: process.execPath, prefix: [script] }),
    },
  ).then(
    () => null,
    (error) => error as Error,
  );
  const partial = join(f.root, "active-cancel", "partial.json"),
    deadline = Date.now() + 5000;
  let pids: { pid: number; child: number } | undefined;
  while (!pids && Date.now() < deadline) {
    try {
      pids = JSON.parse(await readFile(partial, "utf8"));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 15));
    }
  }
  assert.ok(pids, "Clone started before cancellation");
  controller.abort();
  const error = await result;
  assert.ok(error);
  assert.match(error.message, /cancelled.*preserved/);
  assert.ok(await readFile(partial, "utf8"));
  for (const pid of [pids.pid, pids.child])
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("explicit GitHub browser flow exposes only device instructions and supports cancellation", async (t) => {
  const f = await fixture(t),
    script = join(f.root, "fake-gh.cjs");
  await writeFile(
    script,
    'console.error("First copy your one-time code: ABCD-1234\\nhttps://github.com/login/device\\nTOKEN=DO-NOT-SHOW https://evil.test");setInterval(()=>{},1000);',
  );
  const signin = new GitHubRepositorySignIn(async () => ({
    command: process.execPath,
    prefix: [script],
  }));
  t.after(() => signin.close());
  assert.equal(signin.status().state, "idle");
  assert.equal((await signin.start()).state, "waiting");
  const deadline = Date.now() + 3000;
  while (!signin.status().userCode && Date.now() < deadline)
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  const state = signin.status();
  assert.equal(state.userCode, "ABCD-1234");
  assert.equal(state.verificationUrl, "https://github.com/login/device");
  assert.doesNotMatch(JSON.stringify(state), /DO-NOT-SHOW|evil/);
  assert.equal((await signin.cancel()).state, "cancelled");
});
