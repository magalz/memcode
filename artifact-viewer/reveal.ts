import type { ReviewReference } from "../src/review";
let current: ReviewReference | undefined;
export function revealReference(reference: ReviewReference) {
  current = reference;
  window.dispatchEvent(
    new CustomEvent("memcode:reveal", { detail: reference }),
  );
}
export function currentReviewTarget() {
  return current;
}
