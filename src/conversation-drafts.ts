export interface ConversationDraft {
  draft: string;
  comments: string[];
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const emptyDraft = (): ConversationDraft => ({ draft: "", comments: [] });

function parsedDraft(value: string | null): ConversationDraft | undefined {
  if (!value) return;
  try {
    const saved: unknown = JSON.parse(value);
    if (!saved || typeof saved !== "object") return;
    const record = saved as Record<string, unknown>;
    return {
      draft: typeof record.draft === "string" ? record.draft : "",
      comments: Array.isArray(record.comments)
        ? record.comments.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {}
}

/** Unsent composer state only; queued follow-ups remain owned by the runtime. */
export class ConversationDrafts {
  private drafts = new Map<string, ConversationDraft>();
  constructor(private storage: () => DraftStorage | undefined) {}

  read(taskId: string): ConversationDraft {
    const remembered = this.drafts.get(taskId);
    if (remembered) return remembered;
    let saved: ConversationDraft | undefined;
    try {
      const storage = this.storage();
      saved =
        parsedDraft(
          storage?.getItem("memcode:conversation-draft:" + taskId) ?? null,
        ) ??
        parsedDraft(
          storage?.getItem("memcode:connection-draft:" + taskId) ?? null,
        );
    } catch {}
    const value = saved ?? emptyDraft();
    this.drafts.set(taskId, value);
    return value;
  }

  write(taskId: string, value: ConversationDraft): void {
    this.drafts.set(taskId, value);
    try {
      const storage = this.storage();
      const key = "memcode:conversation-draft:" + taskId;
      if (value.draft || value.comments.length)
        storage?.setItem(key, JSON.stringify(value));
      else storage?.removeItem(key);
      storage?.removeItem("memcode:connection-draft:" + taskId);
    } catch {
      // Card switching still retains the draft when browser storage is unavailable.
    }
  }

  /** A reply may arrive after the user has already started their next message. */
  clearSubmitted(taskId: string, submitted: ConversationDraft): boolean {
    const current = this.read(taskId);
    const draft = current.draft === submitted.draft ? "" : current.draft;
    const sameComments =
      current.comments.length === submitted.comments.length &&
      current.comments.every((id, index) => id === submitted.comments[index]);
    const comments = sameComments ? [] : current.comments;
    if (draft === current.draft && comments.length === current.comments.length)
      return false;
    this.write(taskId, { draft, comments });
    return true;
  }
}
