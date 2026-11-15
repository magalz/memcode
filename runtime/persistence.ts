import { rename } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

const retryDelays = [25, 50, 100, 200, 400, 800, 1000, 1000, 1000];
const sharingErrors = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Replace atomically, allowing Windows readers/scanners time to release a file. */
export async function replaceWorkspace(
  temporary: string,
  destination: string,
  operations = { rename, wait: (milliseconds: number) => wait(milliseconds) },
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await operations.rename(temporary, destination);
      return;
    } catch (error) {
      if (
        !sharingErrors.has((error as NodeJS.ErrnoException).code ?? "") ||
        attempt >= retryDelays.length
      )
        throw error;
      // Never unlink the destination: the last saved workspace must survive failure.
      await operations.wait(retryDelays[attempt]);
    }
  }
}

/** Observe fire-and-forget saves while preserving rejection for awaited callers. */
export function observePersistence(
  pending: Promise<void>,
  failed: (error: unknown) => void,
): Promise<void> {
  void pending.catch((error) => {
    try {
      failed(error);
    } catch (reportError) {
      console.error("Could not report a workspace save failure:", reportError);
    }
  });
  return pending;
}
