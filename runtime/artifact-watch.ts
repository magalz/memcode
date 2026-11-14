import { watch } from "node:fs";

/** Discover saved outputs as they arrive, independently of browser sessions. */
export function watchArtifacts(
  directory: string,
  collect: () => Promise<void>,
  failed: (error: Error) => void,
) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = pending
        .then(collect)
        .catch((error) =>
          failed(error instanceof Error ? error : new Error(String(error))),
        );
    }, 250);
  };
  const watcher = watch(directory, { persistent: false }, schedule);
  watcher.on("error", (error) => failed(error));
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    await pending;
  };
}
