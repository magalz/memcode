import { useEffect, useRef, useState } from "react";
import type { ReviewComment } from "../src/review";
import { ReviewHighlights } from "../src/components/ReviewHighlights";
import { viewerAction } from "./selection";
import { revealReference } from "./reveal";
import "../src/styles-annotations.css";
export default function Annotations() {
  const [comments, setComments] = useState<ReviewComment[]>([]),
    [focused, setFocused] = useState<string>(),
    [focusVersion, setFocusVersion] = useState(0);
  const focusKey = useRef("");
  const epoch = useRef<number | undefined>(undefined);
  useEffect(() => {
    const stream = new EventSource("./__annotations");
    stream.onmessage = (event) => {
      const value = JSON.parse(event.data);
      setComments(value.comments);
      const key = value.focusedId + "@" + value.focusVersion;
      if (value.focusedId && key !== focusKey.current) {
        focusKey.current = key;
        setFocused(value.focusedId);
        setFocusVersion(value.focusVersion ?? 0);
        const comment = value.comments.find(
          (c: ReviewComment) => c.id === value.focusedId,
        );
        if (comment) revealReference(comment.reference);
      }
      if (epoch.current !== undefined && epoch.current !== value.selectionEpoch)
        window.dispatchEvent(new Event("memcode:clear-selection"));
      epoch.current = value.selectionEpoch;
      window.dispatchEvent(
        new CustomEvent("memcode:annotations", { detail: value.comments }),
      );
    };
    return () => stream.close();
  }, []);
  return (
    <ReviewHighlights
      comments={comments}
      focusedId={focused}
      focusVersion={focusVersion}
      onFocus={(id) => {
        setFocused(id);
        setFocusVersion((value) => value + 1);
        void viewerAction({ action: "focus-comment", commentId: id });
      }}
    />
  );
}
