import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { supportingArtifactFolders } from "../src/artifact-purpose";

/** Discover saved outputs as they arrive, independently of browser sessions. */
export function watchArtifacts(
  directory: string,
  collect: () => Promise<void>,
  failed: (error: Error) => void,
) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const supporting = new Map<string, FSWatcher>();
  const refreshSupporting = async () => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !supportingArtifactFolders.some(
          (name) => name === entry.name.toLowerCase(),
        ) ||
        supporting.has(entry.name)
      )
        continue;
      try {
        const watcher = watch(
          join(directory, entry.name),
          { persistent: false, recursive: true },
          schedule,
        );
        supporting.set(entry.name, watcher);
        watcher.on("error", (error) => {
          watcher.close();
          supporting.delete(entry.name);
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed(error);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = pending
        .then(refreshSupporting)
        .then(collect)
        .catch((error) =>
          failed(error instanceof Error ? error : new Error(String(error))),
        );
    }, 250);
  };
  const watcher = watch(
    directory,
    { persistent: false },
    (_event, filename) => {
      const name = filename?.toString();
      if (name && supporting.has(name)) {
        supporting.get(name)!.close();
        supporting.delete(name);
      }
      schedule();
    },
  );
  watcher.on("error", (error) => failed(error));
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    await pending;
    for (const child of supporting.values()) child.close();
    supporting.clear();
  };
}
