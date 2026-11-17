import type { Settings } from "./shared";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!object(left) || !object(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && same(left[key], right[key]),
    )
  );
}
function reconcile(
  draft: unknown,
  previous: unknown,
  incoming: unknown,
): unknown {
  if (same(draft, previous)) return incoming;
  if (!object(draft) || !object(previous) || !object(incoming)) return draft;
  return Object.fromEntries(
    [...new Set([...Object.keys(draft), ...Object.keys(incoming)])].map(
      (key) => [key, reconcile(draft[key], previous[key], incoming[key])],
    ),
  );
}

/** Retain edits while adopting settings saved by completed model setup. */
export function synchronizeSettingsDraft(
  draft: Settings,
  previous: Settings,
  incoming: Settings,
): Settings {
  return reconcile(draft, previous, incoming) as Settings;
}
