import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import {
  dirname,
  delimiter,
  join,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppState, Harness, RuntimeInfo } from "../src/shared";
import { initialState } from "../src/seed";
import { restartSafeState } from "../src/domain";

export const exec = promisify(execFile);
export const now = () => new Date().toISOString();

export function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (!rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
      rel !== ".." &&
      !isAbsolute(rel))
  );
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface Command {
  command: string;
  prefix: string[];
  env?: Record<string, string>;
}

export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // cmd.exe drops overlong PATH values. Keep executable discovery deterministic.
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const parts = [
    ...new Set(
      (env[pathKey] ?? "")
        .split(delimiter)
        .map((part) => part.replace(/^"|"$/g, ""))
        .filter(Boolean),
    ),
  ];
  const kept: string[] = [];
  for (const part of parts)
    if ([...kept, part].join(delimiter).length < 7000) kept.push(part);
  env[pathKey] = kept.join(delimiter);
  return env;
}

export async function findCommand(
  name: string,
  configured = "",
): Promise<Command | null> {
  if (configured) {
    if (!isAbsolute(configured) || !(await exists(configured))) return null;
    if (/\.(?:cjs|mjs|js)$/i.test(configured))
      return {
        command: process.execPath,
        prefix: [configured],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    if (process.platform === "win32" && !/\.exe$/i.test(configured))
      return null;
    return { command: configured, prefix: [] };
  }
  const dirs = [
    ...new Set(
      (process.env.PATH ?? process.env.Path ?? "")
        .split(delimiter)
        .map((x) => x.replace(/^"|"$/g, ""))
        .filter(Boolean),
    ),
  ];
  for (const dir of dirs) {
    const binary = join(
      dir,
      name + (process.platform === "win32" ? ".exe" : ""),
    );
    if ((await exists(binary)) && (await stat(binary)).isFile())
      return { command: binary, prefix: [] };
    const packageEntry =
      name === "memtrace"
        ? "memtrace/bin/memtrace.js"
        : name === "claude"
          ? "@anthropic-ai/claude-code/cli.js"
          : name === "amp"
            ? "@ampcode/cli/dist/main.js"
            : null;
    if (packageEntry) {
      for (const base of [dir, dirname(dir)]) {
        const entry = join(base, "node_modules", packageEntry);
        if (await exists(entry))
          return {
            command: process.execPath,
            prefix: [entry],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          };
      }
    }
  }
  return null;
}

export class LocalStore {
  state: AppState = initialState();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}
  async load(): Promise<AppState> {
    await mkdir(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(
        await readFile(join(this.dir, "workspace.json"), "utf8"),
      ) as AppState;
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.projects) ||
        !Array.isArray(saved.tasks)
      )
        throw new Error("Unsupported workspace data");
      this.state = restartSafeState(saved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "The local workspace could not be read. Your saved data has been preserved.",
          { cause: error },
        );
    }
    return this.state;
  }
  save(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2);
    const pending = this.writes
      .catch(() => {})
      .then(async () => {
        const path = join(this.dir, "workspace.json");
        const temp = join(this.dir, "workspace.json.next");
        await writeFile(temp, serialized, "utf8");
        await rename(temp, path);
      });
    this.writes = pending;
    return pending;
  }
  async runtime(): Promise<RuntimeInfo> {
    const harnesses = await Promise.all(
      (["codex", "claude", "amp"] as Harness[]).map(async (id) => {
        const command = await findCommand(id);
        return {
          id,
          name: { codex: "Codex", claude: "Claude Code", amp: "Amp" }[id],
          available: !!command,
          path: command?.command ?? null,
        };
      }),
    );
    return {
      appVersion: "0.1.0",
      harnesses,
      memtraceAvailable: !!(await findCommand(
        "memtrace",
        this.state.settings.memtracePath,
      )),
      dataPath: this.dir,
    };
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: childEnv(),
  });
  return stdout.trim();
}
