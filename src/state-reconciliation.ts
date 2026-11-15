/** Reuse unchanged parts of JSON snapshots without mutating either receipt. */
export function reconcileSnapshot<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const values = incoming.map((value, index) =>
      reconcileSnapshot(previous[index], value),
    );
    return (previous.length === values.length &&
    values.every((value, index) => Object.is(value, previous[index]))
      ? previous
      : values) as T;
  }
  if (
    previous &&
    incoming &&
    typeof previous === "object" &&
    typeof incoming === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(incoming)
  ) {
    const old = previous as Record<string, unknown>;
    const next = incoming as Record<string, unknown>;
    const keys = Object.keys(next);
    let unchanged = Object.keys(old).length === keys.length;
    const entries = keys.map((key) => {
      const existed = Object.hasOwn(old, key);
      const value = existed ? reconcileSnapshot(old[key], next[key]) : next[key];
      unchanged &&= existed && Object.is(value, old[key]);
      return [key, value] as const;
    });
    return unchanged ? previous : (Object.fromEntries(entries) as T);
  }
  return incoming;
}
