import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReviewComment } from "../review";
import { referenceAnchor } from "../review-anchor";
export function ReviewHighlights({
  comments,
  focusedId,
  focusVersion = 0,
  onFocus,
  root,
  hidePins = false,
}: {
  comments: ReviewComment[];
  focusedId?: string;
  focusVersion?: number;
  onFocus: (id: string) => void;
  root?: RefObject<HTMLElement | null>;
  hidePins?: boolean;
}) {
  const [marks, setMarks] = useState<
      Array<{
        comment: ReviewComment;
        rects: Array<{ x: number; y: number; width: number; height: number }>;
        index: number;
        pin?: { x: number; y: number };
      }>
    >([]),
    lastFocus = useRef("");
  useEffect(() => {
    let timer = 0,
      disposed = false;
    const doc = root?.current?.ownerDocument ?? document;
    const paint = () => {
      if (disposed) return;
      const container = root?.current ?? undefined,
        viewport = (container ?? doc).querySelector<HTMLElement>(
          ".change-patch-scroll,.terminal-mount,.pdf-stage,.sheet-scroll,.slide-stage",
        ),
        bounds = (viewport ?? container)?.getBoundingClientRect(),
        next: typeof marks = [];
      for (const [index, comment] of comments.entries()) {
        const anchor = referenceAnchor(doc, comment.reference, container);
        if (
          comment.id === focusedId &&
          lastFocus.current !== focusedId + "@" + focusVersion &&
          anchor.target
        ) {
          anchor.target.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "instant",
          });
          lastFocus.current = focusedId + "@" + focusVersion;
          requestAnimationFrame(paint);
          return;
        }
        const rects = anchor.rects
          .filter((rect) => rect.width && rect.height)
          .map((rect) => ({
            x: Math.max(rect.x, bounds?.x ?? 0),
            y: Math.max(rect.y, bounds?.y ?? 0),
            width: Math.max(
              0,
              Math.min(rect.right, bounds?.right ?? innerWidth) -
                Math.max(rect.x, bounds?.x ?? 0),
            ),
            height: Math.max(
              0,
              Math.min(rect.bottom, bounds?.bottom ?? innerHeight) -
                Math.max(rect.y, bounds?.y ?? 0),
            ),
          }))
          .filter((rect) => rect.width > 0 && rect.height > 0);
        const target = anchor.target,
          targetBounds = target?.getBoundingClientRect(),
          pin =
            targetBounds &&
            (comment.reference.selectionType === "area" ||
              target?.matches("input,textarea"))
              ? { x: targetBounds.right + 4, y: rects[0]?.y - 2 }
              : undefined;
        if (rects.length) next.push({ comment, rects, index, pin });
      }
      setMarks((previous) =>
        JSON.stringify(
          previous.map((m) => [m.comment.id, m.comment.updatedAt, m.rects]),
        ) ===
        JSON.stringify(
          next.map((m) => [m.comment.id, m.comment.updatedAt, m.rects]),
        )
          ? previous
          : next,
      );
    };
    const update = () => {
      cancelAnimationFrame(timer);
      timer = requestAnimationFrame(paint);
    };
    const resize = () => {
      // Opening comments can resize a native guest after its first focus pass.
      // Reveal the selected target again in the new viewport, without changing
      // the user's position during ordinary scrolling.
      lastFocus.current = "";
      update();
    };
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !(
              record.target instanceof Element &&
              record.target.closest(".annotation-layer,[data-memcode-measure]")
            ),
        ) &&
        !records.every(
          (record) =>
            [...record.addedNodes, ...record.removedNodes].length > 0 &&
            [...record.addedNodes, ...record.removedNodes].every(
              (node) =>
                node instanceof Element &&
                node.hasAttribute("data-memcode-measure"),
            ),
        )
      )
        update();
    });
    observer.observe(root?.current ?? doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    doc.addEventListener("scroll", update, true);
    window.addEventListener("resize", resize);
    window.addEventListener("memcode:layout", update);
    void doc.fonts.ready.then(update);
    update();
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(timer);
      doc.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("memcode:layout", update);
    };
  }, [comments, focusedId, focusVersion, root]);
  const placed: Array<{ x: number; y: number }> = [],
    positions = new Map<string, { left: number; top: number }>(),
    limit =
      Math.min(
        innerWidth,
        root?.current?.getBoundingClientRect().right ?? innerWidth,
      ) - 26;
  for (const mark of marks) {
    let x = Math.min(
        limit,
        mark.pin?.x ?? mark.rects[0].x + mark.rects[0].width + 4,
      ),
      y = Math.max(3, mark.pin?.y ?? mark.rects[0].y - 2);
    for (
      let tries = 0;
      tries < marks.length &&
      placed.some(
        (point) => Math.abs(point.x - x) < 23 && Math.abs(point.y - y) < 23,
      );
      tries++
    ) {
      if (x + 25 <= limit) x += 25;
      else {
        y += 25;
        x = Math.min(limit, mark.rects[0].x + mark.rects[0].width + 4);
      }
    }
    placed.push({ x, y });
    positions.set(mark.comment.id, { left: x, top: y });
  }
  return (
    <div
      className="annotation-layer"
      aria-label={
        hidePins ? "Selected content highlight" : "Saved comment markers"
      }
    >
      {marks.map(({ comment, rects, index }) => (
        <div
          key={comment.id}
          data-comment-id={comment.id}
          className={
            focusedId === comment.id
              ? "annotation-mark active"
              : "annotation-mark"
          }
        >
          {rects.map((rect, i) => (
            <span
              key={i}
              className="annotation-rect"
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }}
            />
          ))}
          {!hidePins && (
            <button
              className="annotation-pin"
              style={positions.get(comment.id)}
              aria-label={`Open comment ${index + 1}`}
              title={comment.text}
              onClick={() => onFocus(comment.id)}
            >
              {index + 1}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
