import { useEffect, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { reviewLocation } from "../review-labels";
import type { ReviewComment, ReviewReference } from "../review";
export function ReviewComposer({
  references,
  onRemove,
  onClose,
  onSave,
  editing,
}: {
  references: ReviewReference[];
  onRemove: (index: number) => void;
  onClose: () => void;
  onSave: (text: string, references: ReviewReference[]) => Promise<void>;
  editing?: ReviewComment;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const taskId = references[0]?.taskId;
  const draftKey =
    "memcode:review:" +
    taskId +
    ":" +
    JSON.stringify(
      references.map((ref) => [
        ref.path,
        ref.selector,
        ref.startOffset,
        ref.lineStart,
        ref.cells,
      ]),
    );
  useEffect(() => {
    setText(editing?.text ?? sessionStorage.getItem(draftKey) ?? "");
  }, [draftKey, editing?.id]);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(text, references);
      sessionStorage.removeItem(draftKey);
      setText("");
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="review-composer" aria-label="New annotation">
      <header>
        <MessageSquarePlus size={14} />
        <strong>
          {editing ? "Edit comment" : "Comment on this selection"}
        </strong>
        <button
          className="icon-button"
          aria-label="Cancel annotation"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <div className="review-references">
        {references.map((ref, index) => (
          <div className="review-reference" key={index}>
            <div>
              <strong>{ref.name}</strong>
              <span>{reviewLocation(ref)}</span>
              {references.length > 1 && (
                <button
                  className="icon-button"
                  aria-label={"Remove reference " + (index + 1)}
                  onClick={() => onRemove(index)}
                >
                  <X size={11} />
                </button>
              )}
            </div>
            <blockquote>{ref.quote}</blockquote>
          </div>
        ))}
      </div>
      <textarea
        autoFocus
        aria-label="Review comment"
        placeholder="Describe what should change here…"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          sessionStorage.setItem(draftKey, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <small>
          Saved on the selection. Sent only when you send a follow-up.
        </small>
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={!text.trim() || busy}
          onClick={() => void save()}
        >
          Save comment
        </button>
      </footer>
    </section>
  );
}
