import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, realpath, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AppState, Project } from "../src/shared";
import type {
  RepositoryAccess,
  RepositoryDescriptor,
  RepositoryGitHubSignIn,
  RepositoryInspection,
  RepositoryProgress,
} from "../src/repository";
import { childEnv, findCommand, type Command } from "./commands";
import { isActive } from "../src/domain";

const execute = promisify(execFile);
export interface RepositoryRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  onProgress?: (message: string) => void;
}
export type RepositoryRunner = (
  program: "git" | "gh",
  args: string[],
  options?: RepositoryRunOptions,
) => Promise<{ stdout: string; stderr: string }>;
export interface RepositoryOptions {
  run?: RepositoryRunner;
  commandFor?: typeof findCommand;
}
const pathKey = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const clean = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const output = (error: unknown) => {
  const value = error as { stdout?: string; stderr?: string; message?: string };
  return `${value.stdout ?? ""}\n${value.stderr ?? ""}\n${value.message ?? ""}`;
};

/** This is metadata only: HTTPS credentials/query strings never leave the device. */
export function sanitizeRepositoryURL(
  value: string,
  defaultBranch?: string,
): RepositoryDescriptor {
  if (
    !value ||
    value.length > 3000 ||
    /[\x00-\x20\x7f]/.test(value) ||
    value.startsWith("-")
  )
    throw Error("Use a Git HTTPS or SSH repository URL.");
  // URL normalizes dot segments, so reject them before parsing as well.
  const rawPath = value.includes("://")
    ? value.replace(/^[^:]+:\/\/[^/]+/, "").split(/[?#]/, 1)[0]
    : value.slice(value.indexOf(":") + 1);
  try {
    if (
      decodeURIComponent(rawPath)
        .split("/")
        .some((part) => part === "." || part === "..")
    )
      throw Error();
  } catch {
    throw Error(
      "Use a repository URL without relative or invalid path segments.",
    );
  }
  let url: URL,
    scp = false;
  const shorthand = value.match(
    /^(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9.-]+):([^/].*)$/,
  );
  try {
    if (!value.includes("://") && shorthand) {
      scp = true;
      url = new URL(
        `ssh://${shorthand[1] ? encodeURIComponent(shorthand[1]) + "@" : ""}${shorthand[2]}/${shorthand[3]}`,
      );
    } else url = new URL(value);
  } catch {
    throw Error("Use a valid Git HTTPS or SSH repository URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["https:", "ssh:"].includes(url.protocol) &&
    !(url.protocol === "http:" && loopback)
  )
    throw Error("Use HTTPS or SSH for a remote repository.");
  if (
    !url.hostname ||
    url.hostname.startsWith("-") ||
    url.hostname.includes("..") ||
    !url.pathname ||
    url.pathname === "/"
  )
    throw Error(
      "The repository URL must include its host and repository path.",
    );
  if (url.protocol === "ssh:" && url.password)
    throw Error("Use an SSH key instead of a password in the repository URL.");
  if (url.protocol !== "ssh:") {
    url.username = "";
    url.password = "";
  }
  url.search = "";
  url.hash = "";
  let sourcePath: string;
  try {
    sourcePath = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "");
  } catch {
    throw Error("The repository URL contains an invalid path.");
  }
  if (
    !sourcePath ||
    sourcePath
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\x00-\x20\x7f\\]/.test(part),
      )
  )
    throw Error(
      "Use a repository URL without relative or invalid path segments.",
    );
  const host = url.hostname.toLowerCase();
  const provider =
    host === "github.com"
      ? "github"
      : host === "gitlab.com"
        ? "gitlab"
        : host === "bitbucket.org"
          ? "bitbucket"
          : "git";
  if (
    (provider === "github" || provider === "bitbucket") &&
    sourcePath.split("/").length !== 2
  )
    throw Error(
      "Use the repository’s clone URL, rather than a file, issue or branch URL.",
    );
  const identity = `${host}${url.port ? ":" + url.port : ""}/${provider === "git" ? sourcePath : sourcePath.toLowerCase()}`;
  const name = sourcePath.split("/").at(-1)!;
  const branch = defaultBranch?.trim();
  if (
    branch &&
    (branch.length > 250 ||
      branch.startsWith("-") ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch
        .split("/")
        .some(
          (part) =>
            !part ||
            part.startsWith(".") ||
            part.endsWith(".") ||
            part.endsWith(".lock"),
        ))
  )
    throw Error("Choose a valid shared Git branch.");
  return {
    url: scp
      ? `${url.username ? decodeURIComponent(url.username) + "@" : ""}${url.hostname}:${url.pathname.slice(1)}`
      : url.href.replace(/\/$/, ""),
    identity,
    provider,
    name,
    ...(branch ? { defaultBranch: branch } : {}),
  };
}

const noninteractiveEnv = () => ({
  ...childEnv(),
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "",
  GIT_PAGER: "cat",
});
async function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      await execute(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 3000 },
      );
      return;
    } catch {
      /* The child may already have exited. */
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      /* Fall back to the owned child only. */
    }
  }
  child.kill();
}
function defaultRunner(options: RepositoryOptions): RepositoryRunner {
  return async (program, args, settings = {}) => {
    const command = await (options.commandFor ?? findCommand)(program);
    if (!command)
      throw Object.assign(
        Error(
          `Install ${program === "git" ? "Git" : "GitHub CLI"} before continuing.`,
        ),
        { code: "COMMAND_NOT_FOUND" },
      );
    return runStreaming(command, args, {
      timeout: settings.onProgress ? 180000 : 20000,
      ...settings,
    });
  };
}
function runStreaming(
  command: Command,
  args: string[],
  options: RepositoryRunOptions,
) {
  return new Promise<{ stdout: string; stderr: string }>(
    (resolveRun, reject) => {
      if (options.signal?.aborted) {
        reject(
          options.signal.reason ?? Error("Repository setup was cancelled."),
        );
        return;
      }
      const child = spawn(command.command, [...command.prefix, ...args], {
        cwd: options.cwd,
        env: { ...noninteractiveEnv(), ...command.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let stdout = "",
        stderr = "",
        timedOut = false;
      const cancel = () => {
        void terminate(child);
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        void terminate(child);
      }, options.timeout ?? 180000);
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-1_000_000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-64000);
        // Never stream arbitrary remote stderr (which can contain credentials).
        const line = clean(chunk.toString());
        if (/Receiving objects|Resolving deltas|Updating files/.test(line))
          options.onProgress?.(
            /Resolving deltas/.test(line)
              ? "Preparing repository history…"
              : /Updating files/.test(line)
                ? "Preparing local files…"
                : "Receiving repository files…",
          );
      });
      child.once("error", (error) => {
        finish();
        reject(error);
      });
      child.once("close", (code) => {
        finish();
        if (options.signal?.aborted)
          reject(
            options.signal.reason ?? Error("Repository setup was cancelled."),
          );
        else if (timedOut)
          reject(
            Object.assign(Error("Repository setup timed out."), {
              code: "ETIMEDOUT",
            }),
          );
        else if (code === 0) resolveRun({ stdout, stderr });
        else
          reject(
            Object.assign(Error("Git could not complete repository setup."), {
              stdout,
              stderr,
              code,
            }),
          );
      });
    },
  );
}
const gitSafety = [
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "core.fsmonitor=false",
];
async function filterSafety(
  run: RepositoryRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // Even git status can execute a repository-selected clean/process filter.
  // Inspection is read-only and must not start those project-specific helpers.
  const filters = await run(
    "git",
    [
      ...gitSafety,
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    { cwd, signal },
  ).catch((error) => {
    if ((error as { code?: unknown }).code === 1)
      return { stdout: "", stderr: "" }; // No configured filters.
    throw error;
  });
  if (signal?.aborted) throw Error("Repository setup was cancelled.");
  return filters.stdout
    .split(/\r?\n/)
    .filter((key) =>
      /^filter\.[^\x00-\x1f]+\.(?:clean|smudge|process|required)$/.test(key),
    )
    .flatMap((key) => [
      "-c",
      `${key}=${key.endsWith(".required") ? "false" : ""}`,
    ]);
}
export async function inspectRepository(
  path: string,
  options: RepositoryOptions & {
    remoteName?: string;
    signal?: AbortSignal;
  } = {},
): Promise<RepositoryInspection> {
  const run = options.run ?? defaultRunner(options),
    canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory())
    throw Error("Choose a local repository folder.");
  const call = (args: string[]) =>
    run("git", [...gitSafety, ...args], {
      cwd: canonical,
      signal: options.signal,
    });
  let root: string;
  try {
    root = await realpath(
      (await call(["rev-parse", "--show-toplevel"])).stdout.trim(),
    );
  } catch {
    throw Error(
      "This folder is not an accessible Git repository. Choose its repository root.",
    );
  }
  if (pathKey(root) !== pathKey(canonical))
    throw Error(
      "Choose the Git repository root, rather than a folder inside it.",
    );
  const filters = await filterSafety(run, canonical, options.signal);
  const [branch, revision, changes, names] = await Promise.all([
    call(["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
      (value) => value.stdout.trim(),
      () => "detached HEAD",
    ),
    call(["rev-parse", "--verify", "HEAD"]).then(
      (value) => value.stdout.trim(),
      () => undefined,
    ),
    call([...filters, "status", "--porcelain=v1", "--untracked-files=normal"]),
    call(["remote"]),
  ]);
  const remotes: RepositoryInspection["remotes"] = [];
  for (const name of names.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 30)) {
    try {
      const raw = (
        await call(["config", "--get", `remote.${name}.url`])
      ).stdout.trim();
      remotes.push({ name, repository: sanitizeRepositoryURL(raw) });
    } catch {
      /* A local-only or unsupported remote is not shared as source metadata. */
    }
  }
  const chosen = options.remoteName
    ? remotes.find((remote) => remote.name === options.remoteName)
    : (remotes.find((remote) => remote.name === "origin") ??
      (remotes.length === 1 ? remotes[0] : undefined));
  return {
    path: canonical,
    repositoryRoot: root,
    branch,
    revision,
    dirty: !!changes.stdout.trim(),
    remotes,
    ...(chosen ? { repository: chosen.repository } : {}),
  };
}

/** Pure classification: never return Git stderr, secrets, URLs or subprocess commands. */
export function repositoryAccessFailure(
  error: unknown,
  repository: RepositoryDescriptor,
  accountLabel?: string,
  method: RepositoryAccess["method"] = "git",
): RepositoryAccess {
  const text = output(error);
  if (
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Could not resolve|Failed to connect|Network is unreachable|Connection timed out|TLS handshake timeout|unable to access.*(?:503|502)/i.test(
      text,
    )
  )
    return {
      state: "offline",
      repository,
      accountLabel,
      method,
      message:
        "The repository host could not be reached. Check the connection and retry.",
    };
  if (
    /authentication failed|could not read Username|terminal prompts disabled|permission denied \(publickey\)|host key verification failed|gh auth login|not logged|HTTP\s*401|bad credentials/i.test(
      text,
    )
  )
    return {
      state: "needs-sign-in",
      repository,
      accountLabel,
      method,
      message:
        repository.url.startsWith("ssh:") || /^[\w.-]+@/.test(repository.url)
          ? "Git SSH authentication or host verification needs setup on this computer. Use an existing authorized SSH setup, or connect GitHub and use HTTPS."
          : "Connect an account with repository access, then retry. Existing Git credentials can also be used.",
    };
  if (
    /repository not found|project.*not found|HTTP\s*404|status code:?\s*404|could not read from remote repository|access denied|not permitted|HTTP\s*403/i.test(
      text,
    )
  )
    return {
      state: "no-access",
      repository,
      accountLabel,
      method,
      message: accountLabel
        ? `The current account (${accountLabel}) could not access this repository. Check the URL or ask its owner for access.`
        : "This repository could not be accessed. Check its URL, connected account and repository permissions.",
    };
  return {
    state: "unknown",
    repository,
    accountLabel,
    method,
    message:
      "Repository access could not be confirmed. Check the local Git setup and retry.",
  };
}

export async function checkRepositoryAccess(
  descriptor: RepositoryDescriptor,
  options: RepositoryOptions & { signal?: AbortSignal } = {},
): Promise<RepositoryAccess> {
  const repository = sanitizeRepositoryURL(
      descriptor.url,
      descriptor.defaultBranch,
    ),
    run = options.run ?? defaultRunner(options);
  let gitFailure: unknown;
  try {
    const args = [
      ...gitSafety,
      "ls-remote",
      "--symref",
      "--",
      repository.url,
      "HEAD",
      ...(repository.defaultBranch
        ? [`refs/heads/${repository.defaultBranch}`]
        : []),
    ];
    const remote = await run("git", args, {
      signal: options.signal,
      timeout: 20000,
    });
    if (
      repository.defaultBranch &&
      !remote.stdout
        .split(/\r?\n/)
        .some((line) =>
          line.endsWith(`\trefs/heads/${repository.defaultBranch}`),
        )
    )
      return {
        state: "unknown",
        repository,
        method: "git",
        message:
          "The repository is readable, but the shared branch is not on the remote yet. Ask its owner to push that branch before cloning it.",
      };
    return {
      state: "ready",
      repository,
      method: "git",
      message:
        "Repository read access is ready using this computer’s Git credentials. Push permission and branch rules are checked separately.",
    };
  } catch (error) {
    gitFailure = error;
  }
  if (repository.provider !== "github" || options.signal?.aborted)
    return repositoryAccessFailure(gitFailure, repository);
  let accountLabel: string | undefined;
  try {
    const user = JSON.parse(
      (
        await run("gh", ["api", "user", "--hostname", "github.com"], {
          signal: options.signal,
        })
      ).stdout,
    );
    if (
      typeof user.login === "string" &&
      /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(user.login)
    )
      accountLabel = user.login;
  } catch (error) {
    const primary = repositoryAccessFailure(gitFailure, repository);
    if (primary.state === "offline") return primary;
    const cliFailure = repositoryAccessFailure(
      error,
      repository,
      undefined,
      "github-cli",
    );
    if (cliFailure.state === "offline") return cliFailure;
    return {
      ...cliFailure,
      state: "needs-sign-in",
      message:
        "Git access was not confirmed. Connect GitHub with an account that has repository access, or use your existing Git authentication setup.",
    };
  }
  try {
    const fullName = repository.identity.slice("github.com/".length);
    const data = JSON.parse(
      (
        await run(
          "gh",
          ["api", `repos/${fullName}`, "--hostname", "github.com"],
          { signal: options.signal },
        )
      ).stdout,
    );
    if (
      typeof data.full_name !== "string" ||
      `github.com/${data.full_name.toLowerCase()}` !== repository.identity
    )
      throw Error("Repository identity mismatch");
    if (repository.defaultBranch) {
      try {
        await run(
          "gh",
          [
            "api",
            `repos/${fullName}/branches/${encodeURIComponent(repository.defaultBranch)}`,
            "--hostname",
            "github.com",
          ],
          { signal: options.signal },
        );
      } catch (error) {
        const failure = repositoryAccessFailure(
          error,
          repository,
          accountLabel,
          "github-cli",
        );
        return failure.state === "no-access"
          ? {
              ...failure,
              state: "unknown",
              message:
                "The repository is readable, but the shared branch could not be found. Ask its owner to push that branch before cloning it.",
            }
          : failure;
      }
    }
    return {
      state: "ready",
      repository,
      method: "github-cli",
      accountLabel,
      ...(typeof data.permissions?.push === "boolean"
        ? { writeAccess: data.permissions.push }
        : {}),
      message: `Repository read access is ready as ${accountLabel ?? "the connected GitHub account"}. Protected branches may still restrict pushes.`,
    };
  } catch (error) {
    return repositoryAccessFailure(
      error,
      repository,
      accountLabel,
      "github-cli",
    );
  }
}

export async function findExistingRepositories(
  state: AppState,
  repository: RepositoryDescriptor,
  options: RepositoryOptions = {},
): Promise<RepositoryInspection[]> {
  const expected = sanitizeRepositoryURL(repository.url).identity,
    paths = new Set<string>(),
    results: RepositoryInspection[] = [];
  for (const project of state.projects) {
    if (!project.path || paths.has(pathKey(project.path))) continue;
    paths.add(pathKey(project.path));
    try {
      const inspected = await inspectRepository(project.path, options);
      if (
        inspected.remotes.some(
          (remote) => remote.repository.identity === expected,
        )
      )
        results.push(inspected);
    } catch {
      /* Missing and non-Git local folders remain the user’s private projects. */
    }
  }
  return results;
}

export async function bindRepository(
  state: AppState,
  projectId: string,
  path: string,
  options: RepositoryOptions & {
    approvedFolders: ReadonlySet<string>;
    expected?: RepositoryDescriptor;
  },
): Promise<Project> {
  const item = state.projects.find(
    (project) => project.id === projectId && !project.example,
  );
  if (!item) throw Error("Choose a real project to connect to local code.");
  const canonical = await realpath(path);
  if (
    ![...options.approvedFolders].some(
      (approved) => pathKey(approved) === pathKey(canonical),
    )
  )
    throw Error(
      "Choose this folder with the local folder picker before connecting it.",
    );
  if (
    state.tasks.some(
      (task) =>
        isActive(task) &&
        (task.projectId === projectId ||
          state.projects.some(
            (project) =>
              project.id === task.projectId &&
              project.path &&
              pathKey(project.path) === pathKey(canonical),
          )),
    )
  )
    throw Error(
      "Stop the active workers using this project or folder before changing its local connection.",
    );
  const inspected = await inspectRepository(canonical, options);
  if (
    options.expected &&
    !inspected.remotes.some(
      (remote) =>
        remote.repository.identity ===
        sanitizeRepositoryURL(options.expected!.url).identity,
    )
  )
    throw Error(
      "This folder belongs to a different repository. Choose the project’s existing checkout, or clone its repository.",
    );
  Object.assign(item, {
    path: canonical,
    branch: inspected.branch,
    repoId: undefined,
    analysis: "idle",
    analysisNote:
      "Local repository connected. Refresh code context before starting a worker.",
  });
  return item;
}

export async function cloneRepository(
  input: {
    repository: RepositoryDescriptor;
    parent: string;
    name: string;
    approvedFolders: ReadonlySet<string>;
    signal?: AbortSignal;
    onProgress?: (progress: RepositoryProgress) => void;
  },
  options: RepositoryOptions = {},
): Promise<RepositoryInspection> {
  const repository = sanitizeRepositoryURL(
      input.repository.url,
      input.repository.defaultBranch,
    ),
    run = options.run ?? defaultRunner(options);
  const parent = await realpath(input.parent);
  if (
    ![...input.approvedFolders].some(
      (approved) => pathKey(approved) === pathKey(parent),
    )
  )
    throw Error(
      "Choose the clone destination with the local folder picker first.",
    );
  if (
    !(await lstat(parent)).isDirectory() ||
    !/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,99}$/u.test(input.name) ||
    /[. ]$/.test(input.name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(input.name)
  )
    throw Error("Use a new folder name inside the selected destination.");
  if (input.signal?.aborted) throw Error("Repository setup was cancelled.");
  input.onProgress?.({
    phase: "checking",
    message: "Checking repository access on this computer…",
  });
  const access = await checkRepositoryAccess(repository, {
    ...options,
    signal: input.signal,
  });
  if (input.signal?.aborted) throw Error("Repository setup was cancelled.");
  if (access.state !== "ready") throw Error(access.message);
  const destination = join(parent, input.name);
  try {
    await mkdir(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Error(
        "A folder with that name already exists. Choose it as an existing checkout, or choose a different clone location.",
      );
    throw error;
  }
  const hooks = await mkdtemp(join(tmpdir(), "memcode-clone-hooks-"));
  const safety = [
    ...gitSafety,
    "-c",
    `core.hooksPath=${hooks}`,
    "-c",
    `init.templateDir=${hooks}`,
    "-c",
    "submodule.recurse=false",
  ];
  try {
    input.onProgress?.({
      phase: "cloning",
      message: "Cloning the repository into your selected folder…",
    });
    const cloneFlags = [
      "--no-checkout",
      "--no-recurse-submodules",
      "--progress",
      ...(repository.defaultBranch
        ? ["--branch", repository.defaultBranch]
        : []),
    ];
    const command: "git" | "gh" = access.method === "github-cli" ? "gh" : "git";
    // gh injects its own host-scoped credential helper for this clone only. No
    // token is retrieved by MemCode and no global Git configuration is changed.
    const cloneArgs =
      command === "gh"
        ? [
            "repo",
            "clone",
            `https://${repository.identity}.git`,
            destination,
            "--no-upstream",
            "--",
            ...cloneFlags,
            ...safety
              .filter((_, index) => index % 2 === 1)
              .flatMap((config) => ["--config", config]),
          ]
        : [
            ...safety,
            "clone",
            ...cloneFlags,
            "--",
            repository.url,
            destination,
          ];
    await run(command, cloneArgs, {
      signal: input.signal,
      timeout: 180000,
      onProgress: (message) =>
        input.onProgress?.({ phase: "cloning", message }),
    });
    const disabled = await filterSafety(run, destination, input.signal);
    const head = await run(
      "git",
      [...safety, "rev-parse", "--verify", "HEAD"],
      { cwd: destination, signal: input.signal },
    ).catch(() => undefined);
    // Force is confined to the fresh directory reserved above; existing folders
    // are rejected before Git starts. Hooks and configured filters are disabled.
    if (head)
      await run(
        "git",
        [
          ...safety,
          ...disabled,
          "checkout",
          "--quiet",
          "--force",
          "HEAD",
          "--",
          ".",
        ],
        { cwd: destination, signal: input.signal, timeout: 120000 },
      );
    const inspected = await inspectRepository(destination, {
      ...options,
      signal: input.signal,
    });
    input.onProgress?.({
      phase: "ready",
      message: "Local repository ready. No project setup scripts were run.",
    });
    return inspected;
  } catch (error) {
    const cancelled = input.signal?.aborted;
    input.onProgress?.({
      phase: cancelled ? "cancelled" : "failed",
      message: cancelled
        ? "Clone cancelled. Its partial folder was preserved."
        : "Clone did not finish. Its folder was preserved; check repository access before retrying.",
    });
    if (cancelled)
      throw Error(
        "Repository setup was cancelled. The partial folder is preserved.",
      );
    throw Error(
      repositoryAccessFailure(error, repository).message +
        " The selected folder is preserved.",
    );
  } finally {
    await rmdir(hooks).catch(() => {});
  }
}

/** Official GitHub CLI flow, initiated only by an explicit Connect action. */
export class GitHubRepositorySignIn {
  private child?: ChildProcess;
  private timeout?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private current: RepositoryGitHubSignIn = {
    state: "idle",
    message: "Connect GitHub when repository access needs it.",
  };
  constructor(private readonly commandFor: typeof findCommand = findCommand) {}
  status() {
    return { ...this.current };
  }
  async start(): Promise<RepositoryGitHubSignIn> {
    if (this.child) return this.status();
    const generation = ++this.generation;
    const command = await this.commandFor("gh");
    if (generation !== this.generation) return this.status();
    if (!command)
      throw Error(
        "Install GitHub CLI to use its browser sign-in, or configure your existing Git authentication and retry.",
      );
    const child = spawn(
      command.command,
      [
        ...command.prefix,
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--skip-ssh-key",
      ],
      {
        env: {
          ...childEnv(),
          ...command.env,
          GH_PROMPT_DISABLED: "1",
          GH_PAGER: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    this.child = child;
    this.current = {
      state: "waiting",
      message:
        "Continue in your browser to connect GitHub. GitHub CLI manages this computer’s provider credentials.",
    };
    let buffer = "";
    const consume = (chunk: Buffer) => {
      if (this.child !== child) return;
      buffer = (buffer + clean(chunk.toString())).slice(-8000);
      const raw = buffer.match(
        /https:\/\/github\.com\/login\/device(?:\b|\/)/,
      )?.[0];
      const code = buffer.match(
        /(?:code|enter)[^A-Z0-9]{0,20}([A-Z0-9]{4}-[A-Z0-9]{4})\b/i,
      )?.[1];
      this.current = {
        ...this.current,
        ...(raw ? { verificationUrl: "https://github.com/login/device" } : {}),
        ...(code ? { userCode: code.toUpperCase() } : {}),
      };
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const finish = (ok: boolean) => {
      if (this.child !== child) return;
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.child = undefined;
      this.current = {
        state: ok ? "signed-in" : "failed",
        message: ok
          ? "GitHub sign-in completed. Check the project’s repository access next."
          : "GitHub sign-in did not complete. Retry when ready; existing project files were not changed.",
      };
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    this.timeout = setTimeout(() => {
      finish(false);
      void terminate(child);
    }, 600000);
    this.timeout.unref();
    return this.status();
  }
  async cancel() {
    this.generation++;
    const child = this.child;
    this.child = undefined;
    clearTimeout(this.timeout);
    this.timeout = undefined;
    if (child) await terminate(child);
    this.current = {
      state: "cancelled",
      message:
        "GitHub sign-in cancelled. Existing project files were not changed.",
    };
    return this.status();
  }
  async close() {
    if (this.child) await this.cancel();
  }
}
