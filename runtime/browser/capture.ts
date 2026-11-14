/** Read-only browser calls must release their card queue even if a renderer stalls. */
export function browserDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(Error(`${label} timed out.`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Both methods capture this exact native page; neither creates a mirrored tab. */
export async function browserCapture(
  native: () => Promise<string>,
  compositor: () => Promise<string>,
  budget = { native: 5000, compositor: 5000 },
): Promise<string> {
  try {
    return await browserDeadline(
      native(),
      budget.native,
      "Native browser screenshot",
    );
  } catch {
    try {
      return await browserDeadline(
        compositor(),
        budget.compositor,
        "Browser compositor screenshot",
      );
    } catch {
      throw Error(
        "The browser could not capture an image. No screenshot was produced; use a DOM-only observation to continue.",
      );
    }
  }
}
