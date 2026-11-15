/** Serialize local preparation, while launched harnesses keep working concurrently. */
export class WorkerStartupQueue {
  private active = false;
  private waiting: Array<() => void> = [];

  get busy(): boolean {
    return this.active;
  }

  enter(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.waiting = this.waiting.filter((entry) => entry !== grant);
        reject(signal.reason);
      };
      const grant = () => {
        signal.removeEventListener("abort", aborted);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          const next = this.waiting.shift();
          if (next) next();
          else this.active = false;
        });
      };
      if (this.active) {
        this.waiting.push(grant);
        signal.addEventListener("abort", aborted, { once: true });
      } else {
        this.active = true;
        grant();
      }
    });
  }
}
