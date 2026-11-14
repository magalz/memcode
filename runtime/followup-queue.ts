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

/** The edit/cancel window closes atomically when a brief snapshot is claimed. */
export function editableFollowup(task: WorkItem, messageId: string) {
  const message = task.messages.find(
    (message) => message.id === messageId && message.role === "user",
  );
  if (!message || !["queued", "paused"].includes(message.followupState ?? ""))
    throw Error("This follow-up is no longer waiting in the queue.");
  if (message.promptedAt || message.pickedUpAt)
    throw Error(
      "The worker already picked up this follow-up. Send a new follow-up instead.",
    );
  return message;
}

export function settleFollowupQueue(
  task: WorkItem,
  state: "paused" | "cancelled",
): boolean {
  const pending = queuedFollowups(task);
  for (const message of pending) message.followupState = state;
  return pending.length > 0;
}
