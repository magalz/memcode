export interface RuntimeHealth {
  available: boolean;
  message?: string;
  saveError?: string;
}

// Transport liveness is transient UI state, separate from saved worker receipts
// and the last recorded run state. A save failure does not imply runtime death.
export class RuntimeHealthStore {
  private value: RuntimeHealth = { available: true };
  private listeners = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(value: RuntimeHealth) {
    if (
      this.value.available === value.available &&
      this.value.message === value.message &&
      this.value.saveError === value.saveError
    )
      return;
    this.value = value;
    this.listeners.forEach((listener) => listener());
  }
  stopped(message: string) {
    this.update({ ...this.value, available: false, message });
  }
  observeError(message: string) {
    if (
      /^(?:The local runtime (?:stopped\.|is unavailable\.)|The runtime response channel closed\.)/.test(
        message,
      )
    ) {
      this.stopped(message);
      return true;
    }
    return false;
  }
  saveStatus(status: { state: "error" | "saved"; message?: string }) {
    this.update({
      ...this.value,
      saveError:
        status.state === "error"
          ? (status.message ?? "Workspace changes could not be saved.")
          : undefined,
    });
  }
}

export const runtimeHealth = new RuntimeHealthStore();
