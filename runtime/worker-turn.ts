import type { Message, WorkItem } from "../src/shared";

/** Separate this pass's user requests from already-consumed conversation history. */
export function workerTurnContext(
  task: Pick<WorkItem, "description">,
  snapshot: Message[],
  historyLimit = 8000,
) {
  const visible = snapshot.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.followupState !== "cancelled",
  );
  const fresh = visible.filter(
    (message) => message.role === "user" && !message.promptedAt,
  );
  const latest = visible.findLast((message) => message.role === "user");
  const requests = fresh.length ? fresh : latest ? [latest] : [];
  const currentIds = new Set(requests.map((message) => message.id));
  const history: string[] = [];
  let remaining = Math.max(0, historyLimit);
  for (const message of [...visible].reverse()) {
    if (currentIds.has(message.id) || remaining === 0) continue;
    const text = `Previous ${message.role}: ${message.text}`;
    const entry = text.slice(-remaining);
    history.unshift(entry);
    remaining = Math.max(0, remaining - entry.length - 2);
  }
  const kind = fresh.length
    ? visible.some((message) => message.promptedAt)
      ? "follow-up"
      : "initial request"
    : "continuation";
  return {
    intro: `CURRENT WORKER PASS: ${kind}. Act on the CURRENT REQUESTS block at the end of this prompt. The original story brief, source evidence and historical conversation are background, not new requests to repeat. Preserve completed work and apply the current requests in order; a later current request supersedes an earlier one if they conflict. All host scope, coordination and permission rules still apply.`,
    history: history.length
      ? "HISTORICAL CONVERSATION — background only, bounded to recent context. Previous requests may already be complete; their assistant replies are not the instructions for this pass.\n\n" +
        history.join("\n\n")
      : "",
    current:
      "CURRENT REQUESTS — implement these in this worker pass.\n\n" +
      (requests.length
        ? requests
            .map(
              (message, index) => `User request ${index + 1}:\n${message.text}`,
            )
            .join("\n\n")
        : task.description),
  };
}
