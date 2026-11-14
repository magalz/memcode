import { useEffect, useRef, useState } from "react";
import { Copy, MessageSquarePlus, MousePointer2 } from "lucide-react";
import type {
  ReviewComment,
  ReviewReference,
  ReviewSelection,
} from "../src/review";
import {
  captureSelection,
  contentScope,
  cssPath,
  nodeElement,
} from "../src/review-anchor";
import { ReviewHighlights } from "../src/components/ReviewHighlights";

export async function viewerAction(input: unknown) {
  const response = await fetch("./__review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw Error(await response.text());
}
export function selectForComment(selection: ReviewSelection, open = false) {
  window.dispatchEvent(
    new CustomEvent(open ? "memcode:comment-selection" : "memcode:selection", {
      detail: selection,
    }),
  );
}
export default function SelectionTools() {
  const [selected, setSelected] = useState<ReviewSelection>(),
    [frozen, setFrozen] = useState<ReviewSelection>(),
    [status, setStatus] = useState(""),
    [picking, setPicking] = useState(false),
    [hover, setHover] = useState<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>();
  const selection = useRef(selected);
  selection.current = selected;
  const choose = (value: ReviewSelection) => {
    setSelected(value);
    setFrozen(value);
    setPicking(false);
    setHover(undefined);
    void viewerAction({ action: "comment", selection: value })
      .then(() => setStatus("Write a comment below"))
      .catch((e) => setStatus(e.message));
  };
  useEffect(() => {
    const capture = () => {
      const value = captureSelection(document);
      if (value) {
        setSelected(value);
        setStatus("");
      }
    };
    const field = (event: Event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement;
      if (
        !target?.matches("input,textarea") ||
        target.closest(".viewer-selection") ||
        target.selectionStart == null ||
        target.selectionEnd == null ||
        target.selectionStart === target.selectionEnd
      )
        return;
      const start = target.selectionStart,
        end = target.selectionEnd;
      setSelected({
        selectionType: "text",
        selector: cssPath(target),
        quote: target.value.slice(start, end).slice(0, 4000),
        startOffset: start,
        endOffset: end,
        location: `Text field · characters ${start + 1}–${end}`,
        lineStart: target.value.slice(0, start).split("\n").length,
        lineEnd: target.value.slice(0, end).split("\n").length,
      });
    };
    const custom = (event: Event) => {
      setSelected((event as CustomEvent<ReviewSelection>).detail);
      setStatus("");
    };
    const open = (event: Event) =>
      choose((event as CustomEvent<ReviewSelection>).detail);
    const clear = () => {
      setFrozen(undefined);
      document.getSelection()?.removeAllRanges();
      setPicking(false);
      setHover(undefined);
    };
    const saved = (event: Event) => {
      if (
        (event as CustomEvent<ReviewComment[]>).detail.some(
          (comment) => comment.reference.quote === selection.current?.quote,
        )
      ) {
        setFrozen(undefined);
        setStatus("Comment saved on this file");
      }
    };
    const links = (event: MouseEvent) => {
      const link = nodeElement(
        event.target as Node,
      )?.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      event.preventDefault();
      void viewerAction({ action: "link", href }).catch((e) =>
        setStatus(e.message),
      );
    };
    document.addEventListener("selectionchange", capture);
    document.addEventListener("mouseup", field);
    document.addEventListener("keyup", field);
    document.addEventListener("click", links);
    window.addEventListener("memcode:selection", custom);
    window.addEventListener("memcode:comment-selection", open);
    window.addEventListener("memcode:annotations", saved);
    window.addEventListener("memcode:clear-selection", clear);
    return () => {
      document.removeEventListener("selectionchange", capture);
      document.removeEventListener("mouseup", field);
      document.removeEventListener("keyup", field);
      document.removeEventListener("click", links);
      window.removeEventListener("memcode:selection", custom);
      window.removeEventListener("memcode:comment-selection", open);
      window.removeEventListener("memcode:annotations", saved);
      window.removeEventListener("memcode:clear-selection", clear);
    };
  }, []);
  useEffect(() => {
    if (!picking) return;
    let down: { x: number; y: number; scope: HTMLElement } | undefined;
    const targetFor = (event: MouseEvent) =>
      nodeElement(event.target as Node)?.closest<HTMLElement>(
        "p,h1,h2,h3,h4,li,td,th,input,textarea,button,img,svg,g,rect,div,section",
      ) ?? null;
    const excluded = (element: Element | null) =>
      !element ||
      !!element.closest(
        ".viewer-selection,.annotation-layer,.pdf-toolbar,.slide-toolbar,.sheet-tabs,.sheet-formula",
      );
    const move = (event: MouseEvent) => {
      if (down) {
        setHover({
          x: Math.min(down.x, event.clientX),
          y: Math.min(down.y, event.clientY),
          width: Math.abs(down.x - event.clientX),
          height: Math.abs(down.y - event.clientY),
        });
        return;
      }
      const target = targetFor(event);
      if (excluded(target)) return;
      const rect = target!.getBoundingClientRect();
      setHover({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };
    const start = (event: MouseEvent) => {
      const target = targetFor(event);
      if (excluded(target) || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const page = target!.closest<HTMLElement>("[data-page]"),
        word = target!.closest("section.docx"),
        pageNumber = page
          ? Number(page.dataset.page)
          : word
            ? [...document.querySelectorAll("section.docx")].indexOf(word) + 1
            : undefined;
      const content = contentScope(document, { page: pageNumber }),
        scope =
          content === document.body
            ? (target!.closest<HTMLElement>("div,section,article,svg,canvas") ??
              content)
            : content;
      if (scope) down = { x: event.clientX, y: event.clientY, scope };
    };
    const finish = (event: MouseEvent) => {
      if (!down) return;
      event.preventDefault();
      event.stopPropagation();
      const target = targetFor(event);
      if (excluded(target)) {
        down = undefined;
        return;
      }
      const page = target!.closest<HTMLElement>("[data-page]"),
        word = target!.closest("section.docx"),
        pageNumber = page
          ? Number(page.dataset.page)
          : word
            ? [...document.querySelectorAll("section.docx")].indexOf(word) + 1
            : undefined;
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) {
        const scope = down.scope,
          bounds = scope.getBoundingClientRect(),
          x = Math.max(bounds.x, Math.min(event.clientX, down.x)),
          y = Math.max(bounds.y, Math.min(event.clientY, down.y)),
          right = Math.min(bounds.right, Math.max(event.clientX, down.x)),
          bottom = Math.min(bounds.bottom, Math.max(event.clientY, down.y));
        choose({
          selectionType: "area",
          quote:
            "Selected area: " +
            ((target!.innerText ?? target!.textContent)?.trim().slice(0, 240) ||
              target!.tagName.toLowerCase()),
          selector: cssPath(scope),
          page: pageNumber,
          rect: {
            x: Math.max(0, Math.min(1, (x - bounds.x) / bounds.width)),
            y: Math.max(0, Math.min(1, (y - bounds.y) / bounds.height)),
            width: Math.max(0, Math.min(1, (right - x) / bounds.width)),
            height: Math.max(0, Math.min(1, (bottom - y) / bounds.height)),
          },
        });
      } else
        choose({
          selectionType: "element",
          quote:
            (target!.innerText ?? target!.textContent)?.trim().slice(0, 4000) ||
            `<${target!.tagName.toLowerCase()}> element`,
          selector: cssPath(target!),
          location: `<${target!.tagName.toLowerCase()}${target!.id ? "#" + target!.id : ""}>`,
          page: pageNumber,
        });
      down = undefined;
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPicking(false);
        setHover(undefined);
      }
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mousedown", start, true);
    document.addEventListener("mouseup", finish, true);
    document.addEventListener("keydown", cancel, true);
    document.body.classList.add("review-picking");
    return () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mousedown", start, true);
      document.removeEventListener("mouseup", finish, true);
      document.removeEventListener("keydown", cancel, true);
      document.body.classList.remove("review-picking");
    };
  }, [picking]);
  const frozenComment: ReviewComment | undefined = frozen
    ? {
        id: "pending-selection",
        taskId: "",
        reference: {
          ...frozen,
          kind: "file",
          taskId: "",
          name: "Selected content",
        },
        text: "Selected content",
        createdAt: "",
        updatedAt: "",
        status: "saved",
      }
    : undefined;
  return (
    <>
      {frozenComment && (
        <ReviewHighlights
          comments={[frozenComment]}
          focusedId="pending-selection"
          onFocus={() => {}}
          hidePins
        />
      )}
      {picking && hover && (
        <div
          className="element-picker-outline"
          style={{
            left: hover.x,
            top: hover.y,
            width: hover.width,
            height: hover.height,
          }}
        />
      )}
      <div
        className="viewer-selection"
        role="toolbar"
        aria-label="Selection actions"
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          className={picking ? "active" : ""}
          aria-label="Select element or area"
          aria-pressed={picking}
          onClick={() => {
            setPicking((value) => !value);
            setStatus("Click an element, or drag an area · Esc to cancel");
          }}
        >
          <MousePointer2 size={13} /> Select
        </button>
        <span title={selected?.quote}>
          {status ||
            (selected
              ? selected.cells
                ? `${selected.sheet} · ${selected.cells}`
                : `${selected.quote.length} characters selected`
              : "Select text, lines or cells")}
        </span>
        <button
          disabled={!selected}
          aria-label="Copy selection"
          onClick={() =>
            void navigator.clipboard
              .writeText(selected!.quote)
              .then(() => setStatus("Copied"))
              .catch((e) => setStatus(e.message))
          }
        >
          <Copy size={13} /> Copy
        </button>
        <button
          disabled={!selected}
          aria-label="Comment on selection"
          onClick={() => choose(selected!)}
        >
          <MessageSquarePlus size={13} /> Comment
        </button>
      </div>
    </>
  );
}
