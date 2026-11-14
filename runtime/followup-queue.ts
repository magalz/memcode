import type { Message, WorkItem } from "../src/shared";

/** Only explicit Send creates automatic continuation authority. */
export function enqueueFollowup(
  task: WorkItem,
  messageId: string,
  order: number,
) {
  const message = task.messages.find((message) => message.id === messageId);
  if (!message || message.role !== "user")
    throw Error("Only a user follow-up in this card can be queued.");
  if (message.promptedAt)
    throw Error("This follow-up was already included in a worker brief.");
  message.followupState = "queued";
  message.queuedAt ??= new Date().toISOString();
  message.queueOrder ??= order;
}

export function queuedFollowups(task: WorkItem): Message[] {
  return task.messages.filter(
    (message) =>
      message.role === "user" &&
      message.followupState === "queued" &&
      !message.promptedAt,
  );
}

export function settleFollowupQueue(
  task: WorkItem,
  state: "paused" | "cancelled",
): boolean {
  const pending = queuedFollowups(task);
  for (const message of pending) message.followupState = state;
  return pending.length > 0;
}
