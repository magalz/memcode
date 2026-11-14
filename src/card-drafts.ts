// Renderer-only drafts survive tab switches without becoming sent messages.
export function loadCardDraft(key: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
export function saveCardDraft(key: string, value: unknown) {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The visible draft remains usable when browser storage is unavailable. */
  }
}
