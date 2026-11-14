export function browserPoint(
  image: { width: number; height: number },
  rect: DOMRect,
  clientX: number,
  clientY: number,
) {
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  const x = (clientX - rect.x - (rect.width - image.width * scale) / 2) / scale;
  const y =
    (clientY - rect.y - (rect.height - image.height * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x <= image.width && y <= image.height
    ? { x, y }
    : null;
}
