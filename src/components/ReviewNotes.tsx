import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, MessageSquare, Pencil, Trash2, X } from "lucide-react";
import { reviewLocation } from "../review-labels";
import type { ReviewComment } from "../review";
export function ReviewNotes({
  comments,
  focusedId,
  onFocus,
  onEdit,
  onDelete,
  onAttach,
  onClose,
}: {
  comments: ReviewComment[];
  focusedId?: string;
  onFocus: (comment: ReviewComment) => void;
  onEdit: (comment: ReviewComment) => void;
  onDelete: (comment: ReviewComment) => void;
  onAttach: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    known = useRef(new Set<string>()),
    pending = comments.filter((comment) => comment.status === "saved");
  useEffect(() => {
    const ids = new Set(pending.map((comment) => comment.id)),
      added = [...ids].filter((id) => !known.current.has(id));
    known.current = ids;
    setSelected((current) => {
      const next = [...current.filter((id) => ids.has(id)), ...added];
      return next.length === current.length &&
        next.every((id, i) => id === current[i])
        ? current
        : next;
    });
  }, [comments]);
  return (
    <section
      className="review-comments-panel"
      aria-label="Saved review comments"
    >
      <header>
        <MessageSquare size={14} />
        <strong>Comments</strong>
        <span>{comments.length}</span>
        <button
          className="icon-button"
          aria-label="Close comments"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      {comments.map((comment, index) => (
        <article
          key={comment.id}
          className={
            "saved-review-note " + (focusedId === comment.id ? "focused" : "")
          }
          data-review-id={comment.id}
        >
          <header>
            {comment.status === "saved" && (
              <input
                aria-label={"Include comment " + (index + 1)}
                type="checkbox"
                checked={selected.includes(comment.id)}
                onChange={(event) =>
                  setSelected((value) =>
                    event.target.checked
                      ? [...value, comment.id]
                      : value.filter((id) => id !== comment.id),
                  )
                }
              />
            )}
            <button onClick={() => onFocus(comment)}>
              <span>{index + 1}</span>
              <strong>{comment.reference.name}</strong>
              <span>{reviewLocation(comment.reference)}</span>
            </button>
            <small>
              {comment.status === "saved" ? "Saved locally" : "In conversation"}
            </small>
            {comment.status === "saved" && (
              <>
                <button
                  className="icon-button"
                  aria-label={"Edit comment " + (index + 1)}
                  onClick={() => onEdit(comment)}
                >
                  <Pencil size={11} />
                </button>
                <button
                  className="icon-button"
                  aria-label={"Delete comment " + (index + 1)}
                  onClick={() => onDelete(comment)}
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}
          </header>
          <blockquote>{comment.reference.quote}</blockquote>
          <p>{comment.text}</p>
        </article>
      ))}
      {pending.length > 0 && (
        <footer>
          <small>Saving a comment does not add it to the conversation.</small>
          <button
            className="primary-button"
            disabled={!selected.length}
            onClick={() => onAttach(selected)}
          >
            Add {selected.length} to follow-up
            <ArrowUpRight size={12} />
          </button>
        </footer>
      )}
    </section>
  );
}
