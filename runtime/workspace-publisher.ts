import type { AppState } from "../src/shared";

interface Output {
  write(state: AppState): boolean;
  needsDrain(): boolean;
  onDrain(listener: () => void): () => void;
}
interface Options {
  intervalMs?: number;
  now?: () => number;
  schedule?: (run: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  onError?: (error: unknown) => void;
}
const active = new Set(["preparing", "running", "stopping"]);

/** Keep notifications bounded before encoding; persistence and RPCs stay separate. */
export class LatestWorkspacePublisher {
  private pending?: { state: AppState; urgent: boolean };
  private runStates = new Map<string, string>();
  private lastSent = -Infinity;
  private timer?: unknown;
  private blocked = false;
  private closed = false;
  private failure?: unknown;
  private waiters: Array<{ resolve(): void; reject(error: unknown): void }> =
    [];
  private readonly interval: number;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, delay: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly unsubscribe: () => void;

  constructor(
    private output: Output,
    private options: Options = {},
  ) {
    this.interval = options.intervalMs ?? 150;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ?? ((run, delay) => setTimeout(run, delay));
    this.cancel =
      options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.unsubscribe = output.onDrain(() => {
      this.blocked = false;
      this.attempt();
    });
  }

  publish(state: AppState): void {
    if (this.closed || this.failure) return;
    let urgent = this.pending?.urgent ?? false;
    const next = new Map<string, string>();
    for (const task of state.tasks) {
      const current = task.run.state;
      if (active.has(this.runStates.get(task.id) ?? "") && !active.has(current))
        urgent = true;
      next.set(task.id, current);
    }
    this.runStates = next;
    // Retain one live state reference, never a queue of encoded JSON snapshots.
    this.pending = { state, urgent };
    this.attempt();
  }

  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed)
      return Promise.reject(new Error("Workspace publisher closed."));
    if (this.pending) this.pending.urgent = true;
    this.attempt();
    if (this.failure) return Promise.reject(this.failure);
    if (!this.pending && !this.blocked && !this.output.needsDrain())
      return Promise.resolve();
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }

  dispose(): void {
    this.closed = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.runStates.clear();
    this.unsubscribe();
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new Error("Workspace publisher closed."));
  }

  private attempt(): void {
    if (this.closed || this.failure) return;
    if (this.blocked || this.output.needsDrain()) {
      this.blocked = true;
      return;
    }
    if (this.pending) {
      const delay = this.lastSent + this.interval - this.now();
      if (!this.pending.urgent && delay > 0) {
        if (this.timer === undefined)
          this.timer = this.schedule(() => {
            this.timer = undefined;
            this.attempt();
          }, delay);
        return;
      }
      if (this.timer !== undefined) this.cancel(this.timer);
      this.timer = undefined;
      const { state } = this.pending;
      this.pending = undefined;
      this.lastSent = this.now();
      try {
        this.blocked = !this.output.write(state);
      } catch (error) {
        this.failure = error;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        this.options.onError?.(error);
        return;
      }
    }
    if (!this.blocked)
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }
}
