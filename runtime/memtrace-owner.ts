import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Command } from "./commands";
import type { projectMcpWorkspace } from "./memtrace-workspace";

type ProjectScope = Awaited<ReturnType<typeof projectMcpWorkspace>>;
type OwnedProcess = {
  child: ChildProcess;
  failed?: Error;
  exited?: number | null;
};
const execute = promisify(execFile);

/** A cold stdio session is healthy but cannot query until start publishes an owner. */
export function pendingMemtraceOwner(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /no workspace owner is attached yet|this session attaches when memtrace start publishes one/i.test(
    text,
  );
}

export function disconnectedMemtraceClient(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /connection closed|not connected|transport (?:is )?closed/i.test(text);
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    // Includes the npm shim's native child, and only this spawned process tree.
    // Never use `memtrace stop`: it could stop an owner borrowed from the user.
    await execute(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 5000, maxBuffer: 16000 },
    ).catch(() => {
      child.kill();
    });
  } else {
    const exited = new Promise<void>((done) =>
      child.once("close", () => done()),
    );
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}

interface OwnerOptions {
  spawn?: typeof spawn;
  stop?: (child: ChildProcess) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/** Only owns children it spawned; an already reachable owner is always borrowed. */
export class ManagedMemtraceOwners {
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly abort = new AbortController();
  constructor(private readonly options: OwnerOptions = {}) {}

  async ready(
    scope: ProjectScope,
    command: Command,
    env: Record<string, string>,
    probe: () => Promise<void>,
  ): Promise<void> {
    if (this.abort.signal.aborted)
      throw Error("The Memtrace connection is closing.");
    try {
      await probe();
      return; // Reuse the live owner without spawning or taking ownership.
    } catch (error) {
      if (!pendingMemtraceOwner(error) && !disconnectedMemtraceClient(error))
        throw error;
    }
    if (this.abort.signal.aborted)
      throw Error("The Memtrace connection is closing.");
    let owned = this.owned.get(scope.dataDirectory);
    if (!owned) {
      const child = (this.options.spawn ?? spawn)(
        command.command,
        [
          ...command.prefix,
          "start",
          "--headless",
          "--workspace-file",
          scope.workspaceFile,
        ],
        {
          cwd: scope.directory,
          env: {
            ...env,
            MEMTRACE_MEMDB_DATA_DIR: scope.dataDirectory,
            MEMTRACE_DATA_DIR: scope.jobDirectory,
            MEMTRACE_NO_WATCH_RESTORE: "1",
            MEMTRACE_UI_PORT: "0",
          },
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      owned = { child };
      this.owned.set(scope.dataDirectory, owned);
      const record = owned;
      child.once("error", (error) => {
        record.failed = error;
      });
      child.once("close", (code) => {
        record.exited = code;
        if (this.owned.get(scope.dataDirectory) === record)
          this.owned.delete(scope.dataDirectory);
      });
      // Owner output is not MCP and must never block a long-running child.
      child.stdout?.resume();
      child.stderr?.resume();
    }
    const deadline = Date.now() + (this.options.timeoutMs ?? 90_000);
    try {
      while (!this.abort.signal.aborted) {
        if (owned.failed)
          throw new Error(
            "Memtrace could not launch this project's local engine.",
            { cause: owned.failed },
          );
        if (owned.exited !== undefined && owned.exited !== 0)
          throw Error(
            `Memtrace could not start this project's local engine (exit ${owned.exited ?? "signal"}).`,
          );
        try {
          await probe();
          return;
        } catch (error) {
          if (
            !pendingMemtraceOwner(error) &&
            !disconnectedMemtraceClient(error)
          )
            throw error;
        }
        if (Date.now() >= deadline)
          throw Error(
            "Memtrace is taking too long to prepare this project's local engine. Reconnect to try again.",
          );
        await pause(this.options.pollMs ?? 500, undefined, {
          signal: this.abort.signal,
        });
      }
      throw Error("The Memtrace connection is closing.");
    } catch (error) {
      if (this.owned.get(scope.dataDirectory) === owned) {
        this.owned.delete(scope.dataDirectory);
        await (this.options.stop ?? stopOwnedProcess)(owned.child);
      }
      if (this.abort.signal.aborted)
        throw Error("The Memtrace connection is closing.");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    const owned = [...this.owned.values()];
    this.owned.clear();
    await Promise.allSettled(
      owned.map((record) =>
        (this.options.stop ?? stopOwnedProcess)(record.child),
      ),
    );
  }
}
