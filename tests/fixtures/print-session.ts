import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Harness } from "../../src/shared";
import { eventMessage, harnessArgs } from "../../runtime/workers";
import type {
  AgentSession,
  AgentSessionOptions,
} from "../../runtime/agents/types";

/** Explicit legacy protocol fixture. Production always uses native interactive sessions. */
export function startPrintFixtureSession(
  harness: Harness,
  options: AgentSessionOptions,
): AgentSession {
  const invocation = harnessArgs(
    harness,
    options.cwd,
    options.prompt,
    options.model,
    options.localModel ?? false,
    options.effort,
    options.briefPath,
    options.contextConfig,
    options.toolArgs,
  );
  const child = spawn(
    options.command.command,
    [...options.command.prefix, ...invocation.args],
    {
      cwd: options.cwd,
      env: { ...options.env, ...options.command.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let error: string | undefined;
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      options.onEvent({ type: "raw", event });
      if (event.type === "thread.started")
        options.onEvent({ type: "session", sessionId: event.thread_id });
      const message = eventMessage(event);
      if (message?.text && message.role !== "user")
        options.onEvent({
          type: "message",
          role: message.role,
          text: message.text,
        });
      options.onEvent({
        type: "activity",
        label: "Fixture is working",
        phase: "working",
      });
    } catch {
      if (line.trim())
        options.onEvent({ type: "message", role: "tool", text: line });
    }
  });
  child.stderr!.on("data", (data) => {
    options.onEvent({ type: "message", role: "tool", text: String(data) });
  });
  child.stdin!.on("error", () => {});
  const completion = new Promise<{ exitCode: number | null; error?: string }>(
    (resolve) => {
      child.once("error", (failure) => {
        error = failure.message;
      });
      child.once("close", (exitCode) => {
        lines.close();
        resolve({ exitCode, ...(error ? { error } : {}) });
      });
    },
  );
  child.once("spawn", () => {
    options.onEvent({ type: "prompted" });
    child.stdin!.end(invocation.stdin ?? undefined);
  });
  return {
    child,
    completion,
    stop: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") child.kill();
      else {
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
      }
    },
  };
}
