import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  AppState,
  WorkItem,
  Project,
  Message,
  Artifact,
} from "../src/shared";
import { isActive } from "../src/domain";
import { childEnv, findCommand, git, now, exists, within } from "./local";
import type { Command } from "./local";
import type { MemtraceEngine } from "./memtrace";

export function harnessArgs(
  id: WorkItem["harness"],
  cwd: string,
  prompt: string,
  model: string,
  local: boolean,
): { args: string[]; stdin?: string } {
  if (id === "codex")
    return {
      args: [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "-C",
        cwd,
        ...(model ? ["-m", model] : []),
        ...(local ? ["--oss", "--local-provider", "ollama"] : []),
        "-",
      ],
      stdin: prompt,
    };
  if (local)
    throw new Error(
      "The local-model option currently supports Codex with Ollama. Choose Codex or disable local-model mode.",
    );
  if (id === "claude")
    return {
      args: [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        ...(model ? ["--model", model] : []),
      ],
    };
  return {
    args: [
      "--execute",
      prompt,
      "--stream-json",
      ...(model ? ["--model", model] : []),
    ],
  };
}

export function eventMessage(
  event: Record<string, any>,
): Pick<Message, "role" | "text"> | null {
  const item = event.item;
  if (event.type === "item.completed" && item) {
    if (item.type === "agent_message")
      return { role: "assistant", text: item.text ?? "" };
    if (item.type === "command_execution")
      return {
        role: "tool",
        text: `${item.command ?? "Command"}\n${(item.aggregated_output ?? "").slice(-10000)}`,
      };
    if (item.type === "file_change")
      return {
        role: "tool",
        text:
          "Files updated\n" +
          (item.changes ?? [])
            .map(
              (x: Record<string, any>) => `${x.kind ?? "modified"} · ${x.path}`,
            )
            .join("\n"),
      };
  }
  if (event.type === "assistant" && event.message?.content) {
    const text = event.message.content
      .filter((x: Record<string, any>) => x.type === "text")
      .map((x: Record<string, any>) => x.text)
      .join("\n");
    if (text) return { role: "assistant", text };
  }
  if (event.type === "result" && event.result)
    return { role: "assistant", text: String(event.result) };
  if (event.type === "error")
    return {
      role: "system",
      text:
        typeof event.error === "string"
          ? event.error
          : (event.error?.message ?? "The harness reported an error."),
    };
  return null;
}

export class WorkerManager {
  private children = new Map<
    string,
    { child: ChildProcess; heartbeat?: NodeJS.Timeout; done: Promise<void> }
  >();
  constructor(
    private readonly state: () => AppState,
    private readonly changed: () => Promise<void>,
    private readonly engine: MemtraceEngine,
    private readonly dataDir: string,
    private readonly resolveCommand: (
      name: string,
    ) => Promise<Command | null> = findCommand,
  ) {}
  private message(task: WorkItem, role: Message["role"], text: string): void {
    task.messages.push({
      id: randomUUID(),
      role,
      text: text.slice(0, 30000),
      at: now(),
    });
    if (task.messages.length > 250)
      task.messages.splice(1, task.messages.length - 250);
    task.updatedAt = now();
  }
  async start(task: WorkItem, project: Project): Promise<void> {
    if (task.example || !project.path)
      throw new Error(
        "Connect a local project to start real workers. The example workspace never runs agents.",
      );
    if (isActive(task) || this.children.has(task.id))
      throw new Error("This worker is already active.");
    const active = this.state().tasks.filter(
      (t) => !t.example && isActive(t),
    ).length;
    if (active >= this.state().settings.maxWorkers)
      throw new Error(
        "All worker slots are occupied. Wait for a worker or increase the limit in Settings.",
      );
    if (active > 0 && project.analysis !== "ready")
      throw new Error(
        "Connect Memtrace before starting concurrent workers. A single isolated worker can run without shared context.",
      );
    const command = await this.resolveCommand(task.harness);
    if (!command)
      throw new Error(
        `${task.harness} is not installed or is not on PATH. Choose an available harness in the work item.`,
      );
    task.run = {
      ...task.run,
      state: "preparing",
      error: undefined,
      startedAt: now(),
      finishedAt: undefined,
    };
    await this.changed();
    try {
      if (project.analysis === "ready") {
        task.evidence = await this.engine.qualify(project, task);
        await this.engine.preflight(project, task, `memcode:${task.id}`);
      }
      if (!task.run.worktree || !(await exists(task.run.worktree))) {
        if (await git(project.path, ["status", "--porcelain"]))
          throw new Error(
            "The project has uncommitted changes. Commit or stash them before starting an isolated worker. Your files have not been changed.",
          );
        await git(project.path, ["rev-parse", "--verify", "HEAD"]);
        const runId = randomUUID().slice(0, 8);
        const worktree = join(
          this.dataDir,
          "worktrees",
          project.id,
          `${task.identifier}-${runId}`,
        );
        await mkdir(join(this.dataDir, "worktrees", project.id), {
          recursive: true,
        });
        const branch = `memcode/${task.identifier.toLowerCase()}-${runId}`;
        await git(project.path, [
          "worktree",
          "add",
          "-b",
          branch,
          worktree,
          "HEAD",
        ]);
        task.run.worktree = worktree;
        task.run.branch = branch;
      }
      const agentId = `memcode:${task.id}`;
      if (project.analysis === "ready")
        await this.engine.publish(project, task, agentId);
      const worktree = task.run.worktree!;
      await mkdir(join(worktree, ".memcode", "artifacts"), { recursive: true });
      const prompt = [
        "You are implementing a work item in MemCode, a local coding-worker suite.",
        `Project: ${project.name}\nProject purpose: ${project.description}`,
        `Work item ${task.identifier}: ${task.title}\n${task.description}`,
        "Work only in this private worktree. Do not commit, push, deploy, or modify other checkouts. Preserve user work. Follow repository AGENTS.md. Run checks appropriate to the change and state which checks actually ran. Return a review candidate, not a claim of guaranteed correctness.",
        "Put shareable HTML reports, screenshots and other artifacts under .memcode/artifacts/.",
        task.checklist.length
          ? "Runbook:\n" +
            task.checklist
              .map((c) => `- [${c.done ? "x" : " "}] ${c.text}`)
              .join("\n")
          : "",
        task.evidence
          ? "Memtrace evidence (may be incomplete):\n" +
            JSON.stringify(task.evidence)
          : "Memtrace context is not attached. Read and qualify the relevant source before changing it.",
        "Conversation:\n" +
          task.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-15)
            .map((m) => `${m.role}: ${m.text}`)
            .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");
      const invocation = harnessArgs(
        task.harness,
        worktree,
        prompt,
        this.state().settings.model,
        this.state().settings.localModel,
      );
      const child = spawn(
        command.command,
        [...command.prefix, ...invocation.args],
        {
          cwd: worktree,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          env: { ...childEnv(), ...command.env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entry = {
        child,
        done,
        heartbeat: undefined as NodeJS.Timeout | undefined,
      };
      this.children.set(task.id, entry);
      task.run.state = "running";
      task.stage = "working";
      this.message(
        task,
        "system",
        `Worker started in an isolated worktree.\n${task.run.branch}\n${project.analysis === "ready" ? "Memtrace context attached. Fleet intents are cooperative; changes stay private until you review them." : "Memtrace context is not attached. This run uses a single isolated worker."}`,
      );
      if (project.analysis === "ready" && task.evidence?.symbols.length) {
        entry.heartbeat = setInterval(
          () =>
            void this.engine
              .publish(project, task, agentId)
              .catch(async (error) => {
                this.message(
                  task,
                  "system",
                  `Fleet heartbeat failed: ${error.message}. Stopping the worker to preserve coordination.`,
                );
                await this.stop(task.id);
              }),
          40_000,
        );
      }
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started")
            task.run.sessionId = event.thread_id;
          const message = eventMessage(event);
          if (message?.text) {
            this.message(task, message.role, message.text);
            void this.changed();
          }
        } catch {
          if (line.trim()) {
            this.message(task, "tool", line);
            void this.changed();
          }
        }
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16000);
      });
      let settled = false;
      const settle = async (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(entry.heartbeat);
        lines.close();
        this.children.delete(task.id);
        const stopped = task.run.state === "stopping";
        task.run.state = stopped
          ? "stopped"
          : error || code !== 0
            ? "failed"
            : "finished";
        task.run.exitCode = code ?? undefined;
        task.run.finishedAt = now();
        task.stage = "review";
        if (error || (!stopped && code !== 0))
          task.run.error =
            error?.message || stderr || `Harness exited with code ${code}`;
        if (stderr) this.message(task, "tool", stderr);
        try {
          task.diff = await this.diff(worktree);
          await this.collectArtifacts(task, project);
          if (project.analysis === "ready" && task.diff)
            await this.engine.episode(project, task, agentId);
        } catch (e) {
          this.message(
            task,
            "system",
            `Result collection needs attention: ${(e as Error).message}`,
          );
        }
        this.message(
          task,
          "system",
          stopped
            ? "Worker stopped. The worktree and any partial changes are preserved."
            : task.run.state === "finished"
              ? "Worker finished. Review the actual changes and checks before marking this work done."
              : "Worker needs attention. Logs and the worktree have been preserved.",
        );
        try {
          await this.changed();
        } finally {
          finish();
        }
      };
      child.once("error", (error) => void settle(null, error));
      child.once("close", (code) => void settle(code));
      child.stdin!.on("error", () => {});
      child.stdin!.end(invocation.stdin ?? undefined);
      await this.changed();
    } catch (error) {
      task.run.state = "failed";
      task.run.error = (error as Error).message;
      this.message(task, "system", (error as Error).message);
      await this.changed();
      throw error;
    }
  }
  async stop(id: string): Promise<void> {
    const entry = this.children.get(id);
    if (!entry) return;
    const task = this.state().tasks.find((t) => t.id === id)!;
    task.run.state = "stopping";
    await this.changed();
    if (entry.child.pid) {
      if (process.platform === "win32") {
        const killer = spawn(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(entry.child.pid), "/T", "/F"],
          { shell: false, windowsHide: true },
        );
        await new Promise<void>((resolve) => {
          killer.once("close", () => resolve());
          killer.once("error", () => resolve());
        });
      } else {
        try {
          process.kill(-entry.child.pid, "SIGTERM");
        } catch {
          entry.child.kill();
        }
      }
    }
    await Promise.race([
      entry.done,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Stop requested, but termination is not confirmed. The worker remains blocked from new runs.",
              ),
            ),
          15_000,
        ),
      ),
    ]);
  }
  private async diff(cwd: string): Promise<string> {
    let diff = await git(cwd, ["diff", "--no-ext-diff", "--no-color", "HEAD"]);
    const untracked = (
      await git(cwd, ["ls-files", "--others", "--exclude-standard"])
    )
      .split("\n")
      .filter((p) => p && !p.startsWith(".memcode/"))
      .slice(0, 25);
    for (const file of untracked) {
      const target = await realpath(join(cwd, file));
      if (!within(cwd, target)) continue;
      const body = await readFile(target, "utf8").catch(() => "(binary file)");
      diff += `\n\n+++ New file: ${file}\n${body.slice(0, 20000)}`;
    }
    return diff.slice(0, 120000);
  }
  private async collectArtifacts(
    task: WorkItem,
    project: Project,
  ): Promise<void> {
    const root = join(task.run.worktree!, ".memcode", "artifacts");
    const entries = await readdir(root, { withFileTypes: true });
    for (const file of entries.slice(0, 50)) {
      if (!file.isFile()) continue;
      const path = await realpath(join(root, file.name));
      if (
        !within(root, path) ||
        this.state().artifacts.some((a) => a.path === path)
      )
        continue;
      const ext = extname(file.name).toLowerCase();
      const kind: Artifact["kind"] = [".html", ".htm"].includes(ext)
        ? "html"
        : [".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)
          ? "image"
          : "text";
      this.state().artifacts.push({
        id: randomUUID(),
        name: file.name,
        kind,
        path,
        taskId: task.id,
        projectId: project.id,
        createdAt: now(),
        source: task.harness,
      });
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.children.keys()].map((id) => this.stop(id)),
    );
  }
}
