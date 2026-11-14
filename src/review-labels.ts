import type { ReviewReference } from "./review";
export function reviewLocation(ref: ReviewReference) {
  return [
    ref.page && `Page ${ref.page}`,
    ref.sheet,
    ref.cells,
    ref.lineStart &&
      `${ref.kind === "terminal" ? "Output" : "Line"} ${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? "–" + ref.lineEnd : ""}`,
    ref.location,
    ref.selectionType === "area" && "Selected area",
  ]
    .filter(Boolean)
    .join(" · ");
}
