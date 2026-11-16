import { spawn } from "node:child_process";
import { appVersion } from "../../src/version";
import { createInterface } from "node:readline";
import type { AgentSession, AgentSessionOptions } from "./types";
import { withoutPermissionArgs } from "./permissions";
import type {
  WorkerInputOption,
  WorkerInputPrompt,
  WorkerInputQuestion,
} from "../../src/worker-input";

type Json = Record<string, any>;
type Id = string | number;

/** One native Codex turn, with the app-server transport kept open for human replies. */
export function startCodexSession(options: AgentSessionOptions): AgentSession {
  const mode = options.permissionMode ?? "review";
  const policy = mode === "full-access" ? "never" : "on-request";
  const reviewer = mode === "auto" ? "auto_review" : "user";
  const child = spawn(
    options.command.command,
    [
      ...options.command.prefix,
      "app-server",
      "--stdio",
      "-c",
      `model_reasoning_effort=${JSON.stringify(options.effort)}`,
      "-c",
      "features.default_mode_request_user_input=true",
      ...withoutPermissionArgs("codex", options.toolArgs),
    ],
    {
      cwd: options.cwd,
      env: { ...options.env, ...options.command.env },
      windowsHide: true,
      stdio: "pipe",
    },
  );
  let nextId = 1,
    threadId = "",
    turnId = "",
    finished = false,
    stopped = false;
  let stderr = "",
    shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      resolve(value: Json): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const inputs = new Map<Id, AbortController>();
  const resolvedInputs = new Set<Id>();
  const messageText = new Map<string, string>();
  let settle!: (result: { exitCode: number | null; error?: string }) => void;
  const completion = new Promise<{ exitCode: number | null; error?: string }>(
    (resolve) => {
      settle = resolve;
    },
  );
  const emit = options.onEvent;
  const write = (packet: Json) => {
    if (child.stdin?.writable && !child.stdin.destroyed)
      child.stdin.write(JSON.stringify(packet) + "\n");
  };
  const finish = (result: { exitCode: number | null; error?: string }) => {
    if (finished) return;
    finished = true;
    for (const controller of inputs.values()) controller.abort();
    inputs.clear();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(result.error || "Codex turn ended."));
    }
    pending.clear();
    child.stdin?.end();
    if (child.exitCode === null) {
      shutdownTimer = setTimeout(() => {
        child.kill();
      }, 1500);
      shutdownTimer.unref();
    }
    settle(result);
  };
  const request = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve, reject) => {
      if (finished) {
        reject(new Error("Codex session has ended."));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex did not respond to ${method}.`));
      }, 45_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  const input = async (id: Id, prompt: WorkerInputPrompt) => {
    const controller = new AbortController();
    inputs.set(id, controller);
    emit({ type: "activity", phase: "waiting", label: prompt.title });
    try {
      return await options.requestInput(prompt, controller.signal);
    } finally {
      if (inputs.get(id) === controller) inputs.delete(id);
    }
  };
  const approval = async (id: Id, params: Json, file: boolean) => {
    const decisions: unknown[] =
      Array.isArray(params.availableDecisions) &&
      params.availableDecisions.length
        ? params.availableDecisions
        : ["accept", "acceptForSession", "decline", "cancel"];
    const labels: Record<string, [string, WorkerInputOption["kind"]]> = {
      accept: ["Allow once", "allow-once"],
      acceptForSession: ["Allow for this session", "allow-session"],
      decline: ["Deny", "deny"],
      cancel: ["Deny and stop turn", "deny"],
    };
    const choices = decisions.map((decision, index): WorkerInputOption => {
      const known = typeof decision === "string" ? labels[decision] : undefined;
      const amendment =
        typeof decision === "object" && decision ? (decision as Json) : {};
      return {
        id: `decision:${index}`,
        label:
          known?.[0] ||
          (amendment.acceptWithExecpolicyAmendment
            ? "Allow and save this command rule"
            : "Apply the proposed network rule"),
        kind: known?.[1] || "other",
        ...(!known ? { description: JSON.stringify(decision) } : {}),
      };
    });
    const response = await input(id, {
      kind: "approval",
      title: file
        ? "Codex wants to change files"
        : "Codex wants to run a command",
      toolName: file ? "fileChange" : "commandExecution",
      description: params.reason || undefined,
      details: [
        params.command,
        params.cwd && `Directory: ${params.cwd}`,
        params.grantRoot && `Write access: ${params.grantRoot}`,
      ]
        .filter(Boolean)
        .join("\n"),
      options: choices,
    });
    const selected = response.cancelled
      ? undefined
      : choices.findIndex((choice) => choice.id === response.optionId);
    // Unknown, cancelled, or stale UI choices never become an approval.
    const decision =
      selected !== undefined && selected >= 0
        ? decisions[selected]
        : decisions.includes("cancel")
          ? "cancel"
          : "decline";
    return { decision };
  };
  const questions = async (id: Id, params: Json) => {
    const source: Json[] = Array.isArray(params.questions)
      ? params.questions
      : [];
    const questions: WorkerInputQuestion[] = source.map((q) => ({
      id: q.id,
      question: q.question,
      options: (q.options || []).map((option: Json, index: number) => ({
        id: `answer:${index}`,
        label: option.label,
        description: option.description,
      })),
      allowText: q.isOther === true || !q.options?.length,
      multiple: q.multiple === true,
      secret: q.isSecret === true,
    }));
    const response = await input(id, {
      kind: "question",
      title: "Codex needs your input",
      questions,
    });
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const value = response.cancelled
        ? []
        : (response.answers?.[question.id] ?? []);
      const values = Array.isArray(value) ? value : [value];
      answers[question.id] = {
        answers: values
          .map(
            (value) =>
              question.options.find((option) => option.id === value)?.label ??
              value,
          )
          .filter(
            (value) =>
              question.allowText ||
              question.options.some((option) => option.label === value),
          ),
      };
    }
    return { answers };
  };
  const elicit = async (id: Id, params: Json) => {
    if (params.mode === "url") {
      const response = await input(id, {
        kind: "approval",
        title: "Codex needs an external action",
        description: params.message,
        details: params.url,
        options: [
          { id: "done", label: "I completed this action", kind: "allow-once" },
          { id: "decline", label: "Decline", kind: "deny" },
        ],
      });
      return {
        action: response.cancelled
          ? "cancel"
          : response.optionId === "done"
            ? "accept"
            : "decline",
        content: null,
      };
    }
    const schema = params.requestedSchema;
    const entries = Object.entries(schema?.properties || {}) as [
      string,
      Json,
    ][];
    if (
      !schema ||
      schema.type !== "object" ||
      !entries.length ||
      entries.some(
        ([, field]) =>
          !["string", "boolean", "integer", "number"].includes(field.type),
      )
    ) {
      emit({
        type: "error",
        message:
          "Codex requested an unsupported input form. The form was declined; no permission was granted.",
      });
      return { action: "decline", content: null };
    }
    const questions = entries.map(([name, field]): WorkerInputQuestion => ({
      id: name,
      question: field.title || field.description || name,
      allowText: !field.enum && field.type !== "boolean",
      secret: field.format === "password",
      options: (
        field.enum || (field.type === "boolean" ? [true, false] : [])
      ).map((value: unknown, index: number) => ({
        id: `field:${index}`,
        label: String(value),
      })),
    }));
    const response = await input(id, {
      kind: "question",
      title: "Codex needs your input",
      description: params.message,
      questions,
    });
    if (response.cancelled) return { action: "cancel", content: null };
    const content: Json = {};
    for (const [name, field] of entries) {
      const answer = response.answers?.[name];
      const value = Array.isArray(answer) ? answer[0] : answer;
      if (value === undefined || value === "") {
        if (schema.required?.includes(name))
          return { action: "decline", content: null };
        continue;
      }
      const question = questions.find((q) => q.id === name)!;
      const text =
        question.options.find((option) => option.id === value)?.label ?? value;
      if (field.type === "boolean") {
        if (!["true", "false"].includes(text))
          return { action: "decline", content: null };
        content[name] = text === "true";
      } else if (field.type === "number" || field.type === "integer") {
        const number = Number(text);
        if (
          !Number.isFinite(number) ||
          (field.type === "integer" && !Number.isInteger(number))
        )
          return { action: "decline", content: null };
        content[name] = number;
      } else content[name] = text;
      if (field.enum && !field.enum.includes(content[name]))
        return { action: "decline", content: null };
    }
    return { action: "accept", content };
  };
  const serverRequest = async (packet: Json) => {
    const id = packet.id as Id,
      params = packet.params || {};
    if (params.threadId && threadId && params.threadId !== threadId) {
      write({
        id,
        error: {
          code: -32602,
          message: "Request belongs to a different worker thread.",
        },
      });
      return;
    }
    try {
      let result: Json;
      switch (packet.method) {
        case "item/commandExecution/requestApproval":
          result = await approval(id, params, false);
          break;
        case "item/fileChange/requestApproval":
          result = await approval(id, params, true);
          break;
        case "item/tool/requestUserInput":
          result = await questions(id, params);
          break;
        case "mcpServer/elicitation/request":
          result = await elicit(id, params);
          break;
        case "item/permissions/requestApproval": {
          const response = await input(id, {
            kind: "approval",
            title: "Codex requests additional permissions",
            description: params.reason,
            details: JSON.stringify(params.permissions, null, 2),
            options: [
              { id: "once", label: "Allow for this turn", kind: "allow-once" },
              { id: "deny", label: "Deny", kind: "deny" },
            ],
          });
          result = {
            permissions:
              !response.cancelled && response.optionId === "once"
                ? params.permissions
                : {},
            scope: "turn",
          };
          break;
        }
        default:
          write({
            id,
            error: {
              code: -32601,
              message: `MemCode does not support ${packet.method}.`,
            },
          });
          return;
      }
      if (!finished && !stopped && !resolvedInputs.has(id))
        write({ id, result });
    } catch (error) {
      if (!finished && !stopped && !resolvedInputs.has(id))
        write({
          id,
          error: {
            code: -32603,
            message:
              error instanceof Error
                ? error.message
                : "Human input could not be collected.",
          },
        });
    }
  };
  const notification = (method: string, params: Json) => {
    if (params.threadId && threadId && params.threadId !== threadId) return;
    if (method === "thread/started" && params.thread?.id) {
      threadId = params.thread.id;
      emit({ type: "session", sessionId: threadId });
    } else if (method === "turn/started") turnId = params.turn?.id || turnId;
    else if (method === "serverRequest/resolved") {
      resolvedInputs.add(params.requestId);
      inputs.get(params.requestId)?.abort();
      inputs.delete(params.requestId);
    } else if (method === "item/agentMessage/delta" && params.delta) {
      const id = params.itemId || "assistant";
      messageText.set(id, (messageText.get(id) || "") + params.delta);
      emit({
        type: "message",
        role: "assistant",
        text: params.delta,
        delta: true,
        messageId: id,
      });
    } else if (
      method === "item/completed" &&
      params.item?.type === "agentMessage"
    ) {
      const item = params.item,
        seen = messageText.get(item.id) || "";
      if (!seen && item.text)
        emit({
          type: "message",
          role: "assistant",
          text: item.text,
          messageId: item.id,
        });
      else if (item.text?.startsWith(seen) && item.text.length > seen.length)
        emit({
          type: "message",
          role: "assistant",
          text: item.text.slice(seen.length),
          delta: true,
          messageId: item.id,
        });
    } else if (method === "item/started" && params.item) {
      const item = params.item;
      if (!["reasoning", "agentMessage", "userMessage"].includes(item.type))
        emit({
          type: "activity",
          toolId: item.id,
          phase: "tool",
          label: item.command || item.tool || item.type,
        });
    } else if (method === "turn/plan/updated") {
      const text = (params.plan || [])
        .map(
          (step: Json) =>
            `${step.status === "completed" ? "[x]" : "[ ]"} ${step.step}`,
        )
        .join("\n");
      if (text)
        emit({ type: "message", role: "system", text: `Plan\n${text}` });
    } else if (method === "error") {
      const message =
        params.error?.message || params.message || "Codex reported an error.";
      emit({ type: "error", message, fatal: params.willRetry === false });
    } else if (
      method === "turn/completed" &&
      (!turnId || params.turn?.id === turnId)
    ) {
      const turn = params.turn || {},
        error = turn.error?.message;
      finish(
        turn.status === "completed"
          ? { exitCode: 0 }
          : {
              exitCode: turn.status === "interrupted" ? 130 : 1,
              error: error || `Codex turn ${turn.status || "failed"}.`,
            },
      );
    }
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (finished || !line.trim()) return;
    let packet: Json;
    try {
      packet = JSON.parse(line);
    } catch {
      finish({
        exitCode: 1,
        error: "Codex app-server returned an invalid protocol message.",
      });
      return;
    }
    if (packet.method && packet.id !== undefined) void serverRequest(packet);
    else if (packet.method) notification(packet.method, packet.params || {});
    else if (packet.id !== undefined) {
      const item = pending.get(packet.id);
      if (item) {
        pending.delete(packet.id);
        clearTimeout(item.timer);
        packet.error
          ? item.reject(
              new Error(packet.error.message || "Codex request failed."),
            )
          : item.resolve(packet.result || {});
      }
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-6000);
  });
  child.stdin?.on("error", (error) => {
    if (!finished)
      finish({
        exitCode: 1,
        error: `Codex input transport failed: ${error.message}`,
      });
  });
  child.on("error", (error) => {
    emit({ type: "error", message: error.message, fatal: true });
    finish({ exitCode: 1, error: error.message });
  });
  child.on("close", (code) => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    lines.close();
    finish({
      exitCode: code === 0 ? 1 : code,
      error: stopped
        ? "Codex worker stopped."
        : stderr.trim() || "Codex app-server exited before the turn completed.",
    });
  });
  void (async () => {
    try {
      await request("initialize", {
        clientInfo: { name: "memcode", title: "MemCode", version: appVersion },
        capabilities: {
          experimentalApi: true,
          requiredHumanApproval: true,
          mcpServerOpenaiFormElicitation: true,
        },
      });
      write({ method: "initialized", params: {} });
      const thread = await request("thread/start", {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.localModel ? { modelProvider: "ollama" } : {}),
        sandbox:
          mode === "full-access" ? "danger-full-access" : "workspace-write",
        approvalPolicy: policy,
        approvalsReviewer: reviewer,
        allowProviderModelFallback: false,
      });
      if (
        mode !== "review" &&
        (thread.approvalPolicy !== policy ||
          thread.approvalsReviewer !== reviewer ||
          thread.sandbox?.type !==
            (mode === "full-access" ? "dangerFullAccess" : "workspaceWrite"))
      )
        throw Error(
          `Codex did not activate the selected ${mode} permission mode. The worker was not prompted; choose a supported mode or check administrator policy.`,
        );
      threadId = thread.thread?.id;
      if (!threadId) throw new Error("Codex did not return a thread ID.");
      emit({ type: "session", sessionId: threadId });
      emit({ type: "prompted" });
      const turn = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.prompt }],
        ...(options.model ? { model: options.model } : {}),
        effort: options.effort,
        approvalPolicy: policy,
        approvalsReviewer: reviewer,
        cwd: options.cwd,
      });
      turnId = turn.turn?.id || turnId;
    } catch (error) {
      if (!finished) {
        const message =
          error instanceof Error ? error.message : "Codex could not start.";
        emit({ type: "error", message, fatal: true });
        finish({ exitCode: 1, error: message });
      }
    }
  })();
  return {
    child,
    completion,
    stop() {
      if (finished) return;
      stopped = true;
      if (threadId && turnId)
        write({
          id: nextId++,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
      finish({ exitCode: 130, error: "Codex worker stopped." });
    },
  };
}
