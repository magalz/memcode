import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  AppState,
  WorkItem,
  Project,
  Message,
  Artifact,
  HarnessRuntime,
  ReasoningEffort,
} from "../src/shared";
import { isActive } from "../src/domain";
import { childEnv, findCommand, git, now, exists, within } from "./local";
import type { Command } from "./local";
import type { MemtraceEngine } from "./memtrace";
import { discoverHarnesses } from "./catalog";
import { planRoute } from "./router";
import { EpicWorkspace } from "./epic-workspace";
import { FleetCoordinator, FleetBlocked } from "./fleet";

export function harnessArgs(
  id: WorkItem["harness"],
  cwd: string,
  prompt: string,
  model: string,
  local: boolean,
  effort: ReasoningEffort = "medium",
  briefPath = ".memcode/brief.md",
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
        "-c",
        `model_reasoning_effort="${effort}"`,
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
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--effort",
        effort,
        ...(model ? ["--model", model] : []),
      ],
      stdin: prompt,
    };
  if (id === "cursor")
    return {
      args: [
        "--print",
        "--trust",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--workspace",
        cwd,
        `Read ${briefPath} for this work item. Follow its scope and return a reviewable implementation.`,
      ],
    };
  throw new Error("Unsupported worker harness.");
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
  readonly fleet: FleetCoordinator;
  private workspaces: EpicWorkspace;
  private cancelled = new Set<string>();
  private closing = false;
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
    private readonly catalog: () => Promise<
      HarnessRuntime[]
    > = discoverHarnesses,
  ) {
    this.workspaces = new EpicWorkspace(state);
    this.fleet = new FleetCoordinator(state, engine, changed, (ids) => {
      void this.pause(ids).catch(() => {});
    });
  }
  async pause(ids: string[]): Promise<void> {
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
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
    if (this.closing) throw new Error("The workspace is closing.");
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
    const pending = (task.dependsOn ?? [])
      .map((id) => this.state().tasks.find((t) => t.id === id))
      .filter((item) => !item || item.stage !== "done");
    if (pending.length)
      throw new Error(
        "Complete the prerequisite stories before starting this worker.",
      );
    this.cancelled.delete(task.id);
    const continuing = () => {
      if (this.closing || this.cancelled.has(task.id))
        throw new Error(
          "Worker preparation was cancelled. Any checkout is preserved.",
        );
    };
    task.run = {
      ...task.run,
      state: "preparing",
      error: undefined,
      startedAt: now(),
      finishedAt: undefined,
    };
    await this.changed();
    try {
      if (project.analysis !== "ready" || !project.repoId)
        throw new Error("Connect Memtrace before starting a Fleet worker.");
      const activation = await this.workspaces.activate(task, project);
      continuing();
      if (activation.changedBranch) {
        project.analysis = "indexing";
        await this.changed();
        try {
          project.repoId = await this.engine.analyze(
            project,
            (note) => {
              project.analysisNote = note;
              void this.changed();
            },
            true,
          );
          project.analysis = "ready";
        } catch (error) {
          project.analysis = "error";
          throw error;
        }
      }
      await this.changed();
      task.evidence = await this.engine.qualify(project, task);
      continuing();
      task.route = planRoute(
        task,
        task.evidence,
        await this.catalog(),
        this.state().settings,
      );
      task.harness = task.route.harness;
      const command = await this.resolveCommand(task.harness);
      continuing();
      if (!command)
        throw new Error(
          "The selected local harness is no longer available. Refresh its runtime or choose another worker.",
        );
      await this.changed();
      await this.fleet.before(project, task);
      const workspace = task.run.workspace!;
      continuing();
      const workerRoot = join(".memcode", "workers", task.id);
      const artifactRoot = join(workerRoot, "artifacts");
      await mkdir(join(workspace, artifactRoot), { recursive: true });
      const prompt = [
        "You are implementing a work item in MemCode, a local coding-worker suite.",
        `Project: ${project.name}\nProject purpose: ${project.description}`,
        `Work item ${task.identifier}: ${task.title}\n${task.description}`,
        task.scope?.length
          ? "Declared source scope:\n" + task.scope.join("\n")
          : "",
        `You share this checkout with other Fleet story workers on epic branch ${task.run.branch}. Your agent identity is memcode:${task.id}. Never switch branches, reset, stash, commit, push, deploy, or undo another worker's changes. Follow AGENTS.md and Memtrace Fleet: read branch context, declare intent before each edit, re-read shared source, record episodes, and honor wait/defer directives. If scope expands or an overlap cannot be reconciled, stop and ask for a human decision. The host reserves the declared scope; it does not fence arbitrary filesystem writes. Run appropriate checks and report what actually ran.`,
        `Put your reports, screenshots and artifacts only under ${artifactRoot.replaceAll("\\", "/")}. Preserve other workers' output.`,
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
      const briefPath = join(workerRoot, "brief.md").replaceAll("\\", "/");
      await writeFile(join(workspace, briefPath), prompt, "utf8");
      const invocation = harnessArgs(
        task.harness,
        workspace,
        prompt,
        task.route.model,
        this.state().settings.localModel,
        task.route.effort,
        briefPath,
      );
      continuing();
      const child = spawn(
        command.command,
        [...command.prefix, ...invocation.args],
        {
          cwd: workspace,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          env: {
            ...childEnv(),
            ...command.env,
            MEMTRACE_AGENT_ID: `memcode:${task.id}`,
            MEMCODE_TASK_ID: task.id,
            MEMCODE_EPIC_BRANCH: task.run.branch,
            MEMCODE_ARTIFACT_DIR: join(workspace, artifactRoot),
          },
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
        `Story worker joined the epic Fleet.\n${task.run.branch}\nWorkers share this branch and coordinate through Memtrace. Unresolved overlaps pause the fleet for a human decision.`,
      );
      {
        let checking = false;
        entry.heartbeat = setInterval(() => {
          if (checking) return;
          checking = true;
          void (async () => {
            if (
              (await git(workspace, ["branch", "--show-current"])) !==
              task.run.branch
            )
              throw new Error(
                "The shared epic branch changed while workers were running.",
              );
            await this.fleet.heartbeat(project, task);
          })()
            .catch(async (error) => {
              if (!(error instanceof FleetBlocked))
                await this.fleet.failure(
                  project,
                  task,
                  `Fleet coordination needs attention: ${error.message}`,
                );
              this.message(
                task,
                "system",
                `Fleet heartbeat failed: ${error.message}. Stopping the worker to preserve coordination.`,
              );
              await this.pause(
                this.state()
                  .tasks.filter(
                    (other) =>
                      other.projectId === project.id &&
                      other.epicId === task.epicId &&
                      isActive(other),
                  )
                  .map((other) => other.id),
              );
            })
            .finally(() => {
              checking = false;
            });
        }, 5_000);
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
          task.diff = await this.diff(workspace, task.run.baseline);
          await this.collectArtifacts(task, project);
          if (task.diff) await this.fleet.after(project, task);
        } catch (e) {
          this.message(
            task,
            "system",
            `Result collection needs attention: ${(e as Error).message}`,
          );
        }
        await this.fleet
          .release(project, task)
          .catch((error) =>
            this.message(
              task,
              "system",
              `Fleet release needs attention: ${error.message}`,
            ),
          );
        if (
          this.state().fleetConflicts.some(
            (item) => item.status === "open" && item.taskIds.includes(task.id),
          )
        )
          task.run.state = "blocked";
        this.message(
          task,
          "system",
          stopped
            ? "Worker stopped. Shared epic changes and this worker’s output are preserved."
            : task.run.state === "finished"
              ? "Worker finished. Review the actual changes and checks before marking this work done."
              : "Worker needs attention. Shared changes and worker logs have been preserved.",
        );
        try {
          await this.changed();
        } finally {
          this.children.delete(task.id);
          finish();
        }
      };
      child.once("error", (error) => void settle(null, error));
      child.once("close", (code) => void settle(code));
      child.stdin!.on("error", () => {});
      child.stdin!.end(invocation.stdin ?? undefined);
      await this.changed();
    } catch (error) {
      const cancelled = this.cancelled.delete(task.id) || this.closing;
      task.run.state =
        error instanceof FleetBlocked
          ? "blocked"
          : cancelled
            ? "stopped"
            : "failed";
      task.run.error = cancelled ? undefined : (error as Error).message;
      if (cancelled || error instanceof FleetBlocked)
        task.stage = task.run.workspace ? "review" : "planned";
      await this.fleet.release(project, task).catch(() => {});
      this.message(task, "system", (error as Error).message);
      await this.changed();
      throw error;
    }
  }
  async stop(id: string): Promise<void> {
    const entry = this.children.get(id);
    if (!entry) {
      const preparing = this.state().tasks.find(
        (task) => task.id === id && task.run.state === "preparing",
      );
      if (preparing) {
        this.cancelled.add(id);
        preparing.run.state = "stopping";
        await this.changed();
      }
      return;
    }
    const task = this.state().tasks.find((t) => t.id === id)!;
    if (
      task.run.state === "stopping" ||
      entry.child.exitCode !== null ||
      entry.child.signalCode !== null
    )
      return;
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
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        entry.done,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Stop requested, but termination is not confirmed. The worker remains blocked from new runs.",
                ),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  private async diff(cwd: string, baseline = "HEAD"): Promise<string> {
    let diff = await git(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      baseline,
      "--",
      ".",
      ":!.memcode",
    ]);
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
    const root = join(
      task.run.workspace!,
      ".memcode",
      "workers",
      task.id,
      "artifacts",
    );
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
    this.closing = true;
    for (const task of this.state().tasks)
      if (task.run.state === "preparing") this.cancelled.add(task.id);
    await Promise.allSettled(
      [...this.children.keys()].map((id) => this.stop(id)),
    );
  }
}
