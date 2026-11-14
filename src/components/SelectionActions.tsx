import { useState } from "react";
import { Check, Copy, MessageSquarePlus } from "lucide-react";
import type { ReviewReference } from "../review";
export function SelectionActions({
  selection,
  onComment,
}: {
  selection?: ReviewReference;
  onComment: (reference: ReviewReference) => void;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <div
      className="selection-actions"
      role="toolbar"
      aria-label="Selection actions"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        className="icon-button"
        aria-label="Copy selection"
        title={error || "Copy selection"}
        disabled={!selection}
        onClick={() =>
          void navigator.clipboard
            .writeText(selection!.quote)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch((e) => setError(e.message))
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button
        className="selection-comment"
        disabled={!selection}
        onClick={() => onComment(selection!)}
      >
        <MessageSquarePlus size={13} /> Comment
      </button>
    </div>
  );
}
