export type StatePatch =
  | { kind: "replace"; value: unknown }
  | { kind: "object"; set: Array<[string, StatePatch]>; remove: string[] }
  | { kind: "array"; length: number; set: Array<[number, StatePatch]> };

/** Apply a native JSON update, retaining every unchanged subtree by identity. */
export function applyStatePatch<T>(
  previous: T | undefined,
  patch: StatePatch,
): T {
  if (patch.kind === "replace") return patch.value as T;
  if (patch.kind === "array") {
    if (
      !Array.isArray(previous) ||
      !Number.isSafeInteger(patch.length) ||
      patch.length < 0
    )
      throw new Error("Workspace array update has no valid baseline.");
    const next = previous.slice(0, patch.length);
    next.length = patch.length;
    for (const [index, value] of patch.set) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= patch.length)
        throw new Error("Workspace array update is out of bounds.");
      next[index] = applyStatePatch(previous[index], value);
    }
    return next as T;
  }
  if (
    patch.kind !== "object" ||
    !previous ||
    typeof previous !== "object" ||
    Array.isArray(previous)
  )
    throw new Error("Workspace object update has no valid baseline.");
  const old = previous as Record<string, unknown>;
  const next = { ...old };
  for (const key of patch.remove) delete next[key];
  for (const [key, value] of patch.set)
    Object.defineProperty(next, key, {
      value: applyStatePatch(
        Object.hasOwn(old, key) ? old[key] : undefined,
        value,
      ),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return next as T;
}
