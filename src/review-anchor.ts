import type { ReviewReference, ReviewSelection } from "./review";
import { fieldSelectionRects } from "./review-field";
export function nodeElement(node: Node | null) {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}
export function cssPath(element: Element) {
  if (element.tagName === "BODY") return "body";
  const parts: string[] = [];
  let current: Element | null = element;
  for (
    let n = 0;
    current && current.tagName !== "BODY" && n < 12;
    n++, current = current.parentElement
  ) {
    if (current.id) {
      parts.unshift("#" + CSS.escape(current.id));
      break;
    }
    const tag = current.tagName.toLowerCase(),
      siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (child) => child.tagName === current!.tagName,
          )
        : [];
    parts.unshift(
      tag +
        (siblings.length > 1
          ? `:nth-of-type(${siblings.indexOf(current) + 1})`
          : ""),
    );
  }
  return parts.join(" > ");
}
export function contentScope(
  doc: Document,
  reference?: Partial<ReviewReference>,
) {
  if (reference?.page) {
    const pdf = doc.querySelector<HTMLElement>(".pdf-page");
    if (pdf)
      return Number(pdf.dataset.page) === reference.page
        ? pdf.querySelector<HTMLElement>(".textLayer")
        : null;
    const pages = doc.querySelectorAll<HTMLElement>("section.docx");
    if (pages.length) return pages[reference.page - 1] ?? null;
    const slide = doc.querySelector<HTMLElement>(".slide-stage");
    if (slide)
      return Number(slide.dataset.page) === reference.page ? slide : null;
  }
  return (
    doc.querySelector<HTMLElement>(
      ".markdown-document,.source-code,.word-viewer,.slide-stage",
    ) ?? doc.body
  );
}
export function captureSelection(doc: Document): ReviewSelection | undefined {
  const field = doc.activeElement as
    HTMLInputElement | HTMLTextAreaElement | null;
  if (
    field?.matches("input:not([type=password]),textarea") &&
    !field.closest(".viewer-selection") &&
    field.selectionStart !== null &&
    field.selectionEnd !== null &&
    field.selectionStart !== field.selectionEnd
  ) {
    const start = field.selectionStart,
      end = field.selectionEnd;
    return {
      selectionType: "text",
      selector: cssPath(field),
      quote: field.value.slice(start, end).slice(0, 4000),
      startOffset: start,
      endOffset: end,
      location: `Text field · characters ${start + 1}–${end}`,
      lineStart: field.value.slice(0, start).split("\n").length,
      lineEnd: field.value.slice(0, end).split("\n").length,
    };
  }
  const value = doc.getSelection();
  if (!value?.rangeCount || !value.toString().trim()) return;
  const anchor = nodeElement(value.anchorNode);
  if (anchor?.closest(".viewer-selection,.annotation-layer")) return;
  const page = anchor?.closest<HTMLElement>("[data-page]"),
    word = anchor?.closest("section.docx"),
    pageNumber = page
      ? Number(page.dataset.page)
      : word
        ? [...doc.querySelectorAll("section.docx")].indexOf(word) + 1
        : undefined,
    scope = contentScope(doc, { page: pageNumber });
  if (!scope) return;
  const range = value.getRangeAt(0);
  if (
    !scope.contains(range.startContainer) ||
    !scope.contains(range.endContainer)
  )
    return;
  const before = doc.createRange();
  before.selectNodeContents(scope);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length,
    raw = range.toString(),
    quote = value.toString().trim().slice(0, 4000),
    lines = [
      nodeElement(range.startContainer)?.closest<HTMLElement>(
        "[data-code-line]",
      ),
      nodeElement(range.endContainer)?.closest<HTMLElement>("[data-code-line]"),
    ]
      .map((el) => Number(el?.dataset.codeLine))
      .filter(Boolean);
  return {
    selectionType: "text",
    quote,
    page: pageNumber,
    selector: cssPath(scope),
    startOffset: offset,
    endOffset: offset + raw.length,
    ...(lines.length
      ? { lineStart: Math.min(...lines), lineEnd: Math.max(...lines) }
      : {}),
    prefix: scope.textContent?.slice(Math.max(0, offset - 120), offset),
    suffix: scope.textContent?.slice(
      offset + raw.length,
      offset + raw.length + 120,
    ),
  };
}
export function textRange(root: Element, start: number, end: number) {
  const doc = root.ownerDocument,
    walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0,
    node: Node | null,
    first: Node | undefined,
    last: Node | undefined,
    from = 0,
    to = 0;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!first && start < offset + length) {
      first = node;
      from = start - offset;
    }
    if (first && end <= offset + length) {
      last = node;
      to = Math.max(0, end - offset);
      break;
    }
    offset += length;
  }
  if (!first || !last) return;
  const range = doc.createRange();
  range.setStart(first, from);
  range.setEnd(last, to);
  return range;
}
export function referenceAnchor(
  doc: Document,
  ref: ReviewReference,
  container?: Element,
): { ranges: Range[]; rects: DOMRect[]; target?: Element } {
  const empty = { ranges: [] as Range[], rects: [] as DOMRect[] };
  if (ref.kind === "changes" || ref.kind === "terminal") {
    const root = container ?? doc.body,
      rows =
        ref.kind === "terminal"
          ? [
              ...root.querySelectorAll<HTMLElement>("[data-terminal-row]"),
            ].filter(
              (row) =>
                Number(row.dataset.terminalRow) >= (ref.lineStart ?? 0) &&
                Number(row.dataset.terminalRow) <=
                  (ref.lineEnd ?? ref.lineStart ?? 0),
            )
          : [...root.querySelectorAll<HTMLElement>(".change-line")].filter(
              (row) => {
                if (
                  ref.checkpointId &&
                  row.closest<HTMLElement>("[data-checkpoint]")?.dataset
                    .checkpoint !== ref.checkpointId
                )
                  return false;
                const n = Number(
                  ref.side === "before"
                    ? row.dataset.oldLine
                    : row.dataset.newLine,
                );
                return (
                  n >= (ref.lineStart ?? 0) &&
                  n <= (ref.lineEnd ?? ref.lineStart ?? 0) &&
                  (ref.side === "before"
                    ? row.dataset.kind !== "add"
                    : row.dataset.kind !== "delete")
                );
              },
            );
    return {
      ranges: [],
      rects: rows.map((row) =>
        (ref.kind === "changes"
          ? (row.querySelector("code") ?? row)
          : row
        ).getBoundingClientRect(),
      ),
      target: rows[0],
    };
  }
  if (ref.cells) {
    const sheet = doc.querySelector<HTMLElement>("[data-sheet-name]");
    if (!sheet || sheet.dataset.sheetName !== ref.sheet) return empty;
    const parse = (cell: string) => {
        const m = /^([A-Z]+)(\d+)$/.exec(cell);
        if (!m) return;
        let column = 0;
        for (const letter of m[1])
          column = column * 26 + letter.charCodeAt(0) - 64;
        return [Number(m[2]), column];
      },
      parts = ref.cells.split(":"),
      from = parse(parts[0]),
      to = parse(parts[1] ?? parts[0]);
    if (!from || !to) return empty;
    const cells = [
      ...sheet.querySelectorAll<HTMLElement>("[data-cell-row]"),
    ].filter(
      (el) =>
        Number(el.dataset.cellRow) >= from[0] &&
        Number(el.dataset.cellRow) <= to[0] &&
        Number(el.dataset.cellColumn) >= from[1] &&
        Number(el.dataset.cellColumn) <= to[1],
    );
    return {
      ranges: [],
      rects: cells.map((cell) => cell.getBoundingClientRect()),
      target: cells[0],
    };
  }
  const scope = contentScope(doc, ref);
  if (ref.selectionType === "time") {
    const media = doc.querySelector<HTMLMediaElement>("video,audio");
    if (!media) return empty;
    const bounds = media.getBoundingClientRect(),
      fraction =
        Number.isFinite(media.duration) && media.duration > 0
          ? Math.max(0, Math.min(1, (ref.time ?? 0) / media.duration))
          : 0;
    return {
      ranges: [],
      rects: [
        new DOMRect(
          bounds.x + 20 + fraction * Math.max(0, bounds.width - 40),
          bounds.bottom - 20,
          3,
          12,
        ),
      ],
      target: media,
    };
  }
  if (!scope) return empty;
  let target: Element | null = null;
  try {
    target = ref.selector ? doc.querySelector(ref.selector) : null;
  } catch {}
  if (target?.matches("input,textarea") && ref.selectionType === "text")
    return {
      ranges: [],
      rects: fieldSelectionRects(
        target as HTMLInputElement | HTMLTextAreaElement,
        ref.startOffset ?? 0,
        ref.endOffset ?? 0,
      ),
      target,
    };
  if (ref.selectionType === "element" || ref.selectionType === "area") {
    if (!target || (!scope.contains(target) && scope !== doc.body))
      return empty;
    const bounds = target.getBoundingClientRect(),
      area = ref.rect;
    return {
      ranges: [],
      rects: [
        area
          ? new DOMRect(
              bounds.x + bounds.width * area.x,
              bounds.y + bounds.height * area.y,
              bounds.width * area.width,
              bounds.height * area.height,
            )
          : bounds,
      ],
      target,
    };
  }
  let range =
    ref.startOffset !== undefined && ref.endOffset !== undefined
      ? textRange(scope, ref.startOffset, ref.endOffset)
      : undefined;
  const comparable = (text: string) => text.replace(/\s+/g, " ").trim();
  if (!range || comparable(range.toString()) !== comparable(ref.quote)) {
    const text = scope.textContent ?? "",
      at = text.indexOf(ref.quote);
    if (at < 0 || text.indexOf(ref.quote, at + 1) >= 0) return empty;
    range = textRange(scope, at, at + ref.quote.length);
  }
  return range
    ? {
        ranges: [range],
        rects: [...range.getClientRects()],
        target: nodeElement(range.startContainer) ?? scope,
      }
    : empty;
}
