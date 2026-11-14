import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReviewReference } from "../review";
export function useReviewSelection(
  root: RefObject<HTMLElement | null>,
  source: (selection: Selection) => ReviewReference,
) {
  const [selection, setSelection] = useState<ReviewReference>(),
    factory = useRef(source);
  factory.current = source;
  useEffect(() => {
    const update = () => {
      const value = window.getSelection();
      if (
        !value?.toString().trim() ||
        !root.current?.contains(value.anchorNode) ||
        !root.current.contains(value.focusNode)
      )
        return;
      setSelection(factory.current(value));
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [root]);
  return [selection, setSelection] as const;
}
