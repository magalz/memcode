/** Give brief-only drafts a predictable title without a model request. */
export function taskDraftTitle(title: string, brief: string): string {
  if (title.trim()) return title.trim();
  const line = (brief.split(/\r?\n/).find((line) => line.trim()) ?? "")
    .trim()
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ");
  return line.length <= 160
    ? line
    : line
        .slice(0, 157)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd() + "…";
}
