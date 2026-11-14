import type { Message } from "../src/shared";

/** Keep unsent-to-worker user input even when a long run pushes it out of recent history. */
export function reviewContext(
  messages: Message[],
  recentLimit = 15,
): Message[] {
  const recent = new Set(
    messages
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .slice(-recentLimit)
      .map((message) => message.id),
  );
  const seen = new Set<string>();
  return messages
    .filter((message) => {
      if (
        (message.role === "user" && message.followupState === "cancelled") ||
        seen.has(message.id) ||
        (!recent.has(message.id) &&
          !(message.role === "user" && !message.promptedAt))
      )
        return false;
      seen.add(message.id);
      return true;
    })
    .map((message) => ({ ...message }));
}

/** Included in a successfully spawned brief; this does not mean read or applied. */
export function markReviewContext(
  messages: Message[],
  snapshot: Message[],
  promptedAt: string,
) {
  const included = new Map(snapshot.map((message) => [message.id, message]));
  for (const message of messages) {
    const original = included.get(message.id);
    if (
      message.role === "user" &&
      !message.promptedAt &&
      original?.role === "user" &&
      original.text === message.text &&
      original.at === message.at
    ) {
      message.promptedAt = promptedAt;
      if (
        message.followupState === "queued" ||
        message.followupState === "paused"
      )
        message.followupState = "included";
    }
  }
}

export function claimReviewContext(messages: Message[], pickedUpAt: string) {
  const snapshot = reviewContext(messages),
    ids = new Set(snapshot.map((message) => message.id));
  for (const message of messages)
    if (
      ids.has(message.id) &&
      !message.promptedAt &&
      ["queued", "paused"].includes(message.followupState ?? "")
    )
      message.pickedUpAt = pickedUpAt;
  return snapshot.map((message) => ({
    ...message,
    ...(ids.has(message.id) &&
    ["queued", "paused"].includes(message.followupState ?? "")
      ? { pickedUpAt }
      : {}),
  }));
}

/** A failed preparation/spawn did not consume its claimed request. */
export function releaseReviewClaims(messages: Message[], snapshot: Message[]) {
  const claims = new Map(
    snapshot
      .filter((message) => message.pickedUpAt)
      .map((message) => [message.id, message.pickedUpAt]),
  );
  for (const message of messages)
    if (!message.promptedAt && claims.get(message.id) === message.pickedUpAt)
      delete message.pickedUpAt;
}

/** Output retention must not delete user input awaiting its first worker brief. */
export function retainReviewContext(messages: Message[], recentLimit = 250) {
  const start = Math.max(0, messages.length - recentLimit + 1);
  return messages.filter(
    (message, index) =>
      index === 0 ||
      index >= start ||
      (message.role === "user" && !message.promptedAt),
  );
}
