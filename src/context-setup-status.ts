import type { ContextAssistantSetupState } from "./context-settings";

export function retrievalSetupState(
  value: unknown,
): ContextAssistantSetupState {
  const state = value as ContextAssistantSetupState | undefined;
  if (
    !state ||
    !["not-installed", "installing", "ready", "error", "unsupported"].includes(
      state.status,
    ) ||
    typeof state.model !== "string" ||
    !state.model.trim() ||
    !Number.isFinite(state.downloadedBytes) ||
    state.downloadedBytes < 0 ||
    !Number.isFinite(state.totalBytes) ||
    state.totalBytes < 0 ||
    (state.message !== undefined && typeof state.message !== "string") ||
    (state.phase !== undefined &&
      !["runtime", "model", "verify"].includes(state.phase))
  )
    throw new Error(
      "MemCode returned an incomplete local model status. Check setup again.",
    );
  return state;
}

export function retrievalSetupMessage(
  status?: ContextAssistantSetupState,
  error = "",
): string {
  if (error) return "Local setup could not be checked. Try again below.";
  if (status?.message) return status.message;
  switch (status?.status) {
    case "ready":
      return "The local model is installed and ready on this computer.";
    case "not-installed":
      return "Download the local retrieval model once. It stays on this computer.";
    case "installing":
      return status.phase === "verify"
        ? "Testing the local model on this computer…"
        : "Preparing your local retrieval model…";
    case "error":
      return "Local model setup needs attention. Retry setup below.";
    case "unsupported":
      return "Local retrieval is not available on this computer.";
    default:
      return "Checking the model on this computer…";
  }
}

/** A slow or obsolete native response must never keep Settings busy forever. */
export class RetrievalStatusCheck {
  private sequence = 0;
  invalidate() {
    this.sequence++;
  }
  async run(
    load: () => Promise<unknown>,
    timeoutMs = 10_000,
  ): Promise<
    | { status: ContextAssistantSetupState; error?: never }
    | { error: string; status?: never }
    | undefined
  > {
    const sequence = ++this.sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(load),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "The local model check took too long. Try again; checking setup does not start a download.",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
      const status = retrievalSetupState(value);
      if (sequence === this.sequence) return { status };
    } catch (error) {
      if (sequence === this.sequence)
        return {
          error: error instanceof Error ? error.message : String(error),
        };
    } finally {
      clearTimeout(timer);
    }
  }
}
