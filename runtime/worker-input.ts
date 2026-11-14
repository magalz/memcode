import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState, WorkItem } from "../src/shared";
import type {
  WorkerInputPrompt,
  WorkerInputRequest,
  WorkerInputResponse,
} from "../src/worker-input";
import { isActive } from "../src/domain";

export const workerResponseSchema = z
  .object({
    optionId: z.string().max(1000).optional(),
    answers: z
      .record(
        z.string().max(1000),
        z.union([
          z.string().max(20000),
          z.array(z.string().max(20000)).max(40),
        ]),
      )
      .optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();
type Waiting = {
  request: WorkerInputRequest;
  resolve(value: WorkerInputResponse): void;
  cleanup(): void;
};
export class WorkerInputs {
  private pending = new Map<string, Waiting>();
  constructor(
    private state: () => AppState,
    private changed: () => Promise<void>,
  ) {}
  async ask(
    task: WorkItem,
    prompt: WorkerInputPrompt,
    signal?: AbortSignal,
  ): Promise<WorkerInputResponse> {
    if (signal?.aborted) return { cancelled: true };
    if (!isActive(task) || !task.run.changeRunId)
      throw Error("The worker is no longer waiting for input.");
    const request: WorkerInputRequest = {
      ...prompt,
      id: randomUUID(),
      taskId: task.id,
      runId: task.run.changeRunId,
      harness: task.harness,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const inputs = (this.state().workerInputs ??= []);
    inputs.push(request);
    task.run.activity = {
      phase: "waiting_for_user",
      label: prompt.title,
      at: request.createdAt,
    };
    let cancel = () => {};
    const waiting = new Promise<WorkerInputResponse>((resolve) => {
      cancel = () => this.cancel(request.id);
      this.pending.set(request.id, {
        request,
        resolve,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });
    if (signal?.aborted) cancel();
    try {
      await this.changed();
    } catch (error) {
      this.cancel(request.id);
      throw error;
    }
    return waiting;
  }
  async respond(
    taskId: string,
    id: string,
    raw: WorkerInputResponse,
  ): Promise<void> {
    const response = workerResponseSchema.parse(raw),
      entry = this.pending.get(id),
      task = this.state().tasks.find((task) => task.id === taskId);
    if (
      !entry ||
      entry.request.status !== "pending" ||
      entry.request.taskId !== taskId ||
      !task ||
      !isActive(task) ||
      task.run.changeRunId !== entry.request.runId
    )
      throw Error(
        "This request is no longer waiting. Your answer was not sent.",
      );
    const request = entry.request;
    if (!response.cancelled) {
      if (
        Object.keys(response.answers ?? {}).some(
          (id) => !request.questions?.some((question) => question.id === id),
        )
      )
        throw Error("This request did not ask for that answer.");
      if (
        request.options?.length &&
        !request.options.some((option) => option.id === response.optionId)
      )
        throw Error("Choose one of the worker’s offered actions.");
      for (const question of request.questions ?? []) {
        const value = response.answers?.[question.id],
          values = Array.isArray(value)
            ? value
            : typeof value === "string"
              ? [value]
              : [];
        if (
          !values.length ||
          values.some((value) => !value.trim()) ||
          (!question.multiple && values.length > 1)
        )
          throw Error("Answer each question before continuing.");
        if (
          !question.allowText &&
          values.some(
            (value) => !question.options.some((option) => option.id === value),
          )
        )
          throw Error("Choose one of the offered answers.");
      }
    }
    const previousActivity = task.run.activity;
    const saved = structuredClone(response);
    for (const question of request.questions ?? [])
      if (question.secret && saved.answers?.[question.id])
        saved.answers[question.id] = "[redacted]";
    request.status = response.cancelled ? "cancelled" : "answered";
    request.answeredAt = new Date().toISOString();
    request.response = saved;
    const summary = response.cancelled
      ? `Dismissed worker request: ${request.title}`
      : request.questions?.length
        ? [
            request.title,
            ...request.questions.map((question) => {
              const value = saved.answers?.[question.id],
                chosen = (Array.isArray(value) ? value : [value ?? ""])
                  .map(
                    (value) =>
                      question.options.find((option) => option.id === value)
                        ?.label ?? value,
                  )
                  .join(", ");
              return `${question.question}: ${chosen}`;
            }),
          ].join("\n")
        : `${request.kind === "approval" ? "Approval decision" : "Plan decision"}: ${request.options?.find((option) => option.id === response.optionId)?.label ?? "Answered"}\n${request.title}`;
    const messageId = randomUUID();
    task.messages.push({
      id: messageId,
      role:
        request.kind === "question" && !response.cancelled ? "user" : "system",
      text: summary,
      at: request.answeredAt,
    });
    const remaining = this.state().workerInputs?.find(
      (input) =>
        input.id !== id &&
        input.taskId === taskId &&
        input.status === "pending",
    );
    task.run.activity = {
      phase: remaining ? "waiting_for_user" : "working",
      label: remaining
        ? remaining.title
        : response.cancelled
          ? "Input dismissed; notifying worker"
          : "Answer sent to worker",
      at: request.answeredAt,
    };
    try {
      await this.changed();
    } catch (error) {
      task.messages = task.messages.filter(
        (message) => message.id !== messageId,
      );
      if (this.pending.get(id) === entry) {
        request.status = "pending";
        request.response = undefined;
        request.answeredAt = undefined;
        task.run.activity = previousActivity;
      }
      throw error;
    }
    if (!this.pending.has(id)) {
      task.messages = task.messages.filter(
        (message) => message.id !== messageId,
      );
      await this.changed();
      throw Error(
        "The worker cancelled this request before your answer could be sent.",
      );
    }
    this.pending.delete(id);
    entry.cleanup();
    entry.resolve(response);
  }
  private cancel(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup();
    entry.request.status = "cancelled";
    entry.request.answeredAt = new Date().toISOString();
    entry.request.response = { cancelled: true };
    const task = this.state().tasks.find(
      (task) => task.id === entry.request.taskId,
    );
    const remaining = this.state().workerInputs?.find(
      (input) =>
        input.id !== id &&
        input.taskId === entry.request.taskId &&
        input.status === "pending",
    );
    if (task && isActive(task))
      task.run.activity = {
        phase: remaining ? "waiting_for_user" : "working",
        label: remaining?.title ?? "Input request cancelled",
        at: entry.request.answeredAt,
      };
    entry.resolve({ cancelled: true });
    void this.changed().catch(() => {});
  }
  cancelTask(taskId: string) {
    for (const [id, entry] of this.pending)
      if (entry.request.taskId === taskId) this.cancel(id);
  }
}
