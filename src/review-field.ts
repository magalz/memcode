/** Measure native field characters without replacing the field or changing its value. */
export function fieldSelectionRects(
  field: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
): DOMRect[] {
  const doc = field.ownerDocument,
    style = getComputedStyle(field),
    bounds = field.getBoundingClientRect(),
    borderX = parseFloat(style.borderLeftWidth) || 0,
    borderY = parseFloat(style.borderTopWidth) || 0;
  if (field.tagName === "INPUT") {
    const context = doc.createElement("canvas").getContext("2d")!;
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    const padding = parseFloat(style.paddingLeft) || 0,
      fontSize = parseFloat(style.fontSize) || 14,
      x =
        bounds.x +
        borderX +
        padding +
        context.measureText(field.value.slice(0, start)).width -
        field.scrollLeft,
      width = context.measureText(field.value.slice(start, end)).width;
    return width
      ? [
          new DOMRect(
            Math.max(bounds.x, x),
            bounds.y + (bounds.height - fontSize * 1.2) / 2,
            Math.max(
              0,
              Math.min(bounds.right, x + width) - Math.max(bounds.x, x),
            ),
            fontSize * 1.2,
          ),
        ]
      : [];
  }
  const mirror = doc.createElement("div");
  mirror.dataset.memcodeMeasure = "true";
  mirror.style.cssText =
    "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;";
  for (const property of [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "word-spacing",
    "padding",
    "text-align",
    "text-indent",
    "tab-size",
    "word-break",
    "overflow-wrap",
    "direction",
  ])
    mirror.style.setProperty(property, style.getPropertyValue(property));
  mirror.style.width = field.clientWidth + "px";
  mirror.style.whiteSpace =
    (field as HTMLTextAreaElement).wrap === "off" ? "pre" : "pre-wrap";
  const node = doc.createTextNode(field.value);
  mirror.append(node);
  doc.body.append(mirror);
  const range = doc.createRange();
  range.setStart(node, Math.min(start, node.length));
  range.setEnd(node, Math.min(end, node.length));
  const origin = mirror.getBoundingClientRect(),
    rects = [...range.getClientRects()].map(
      (rect) =>
        new DOMRect(
          bounds.x + borderX + rect.x - origin.x - field.scrollLeft,
          bounds.y + borderY + rect.y - origin.y - field.scrollTop,
          rect.width,
          rect.height,
        ),
    );
  mirror.remove();
  return rects;
}
