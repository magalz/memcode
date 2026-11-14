/** Bound Office archives before any renderer inflates their XML or media. */
export function inspectOfficeZip(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (
    let i = buffer.byteLength - 22;
    i >= Math.max(0, buffer.byteLength - 65557);
    i--
  )
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error("This is not a supported Office document.");
  const entries = view.getUint16(end + 10, true),
    offset = view.getUint32(end + 16, true);
  if (entries > 5000 || entries === 65535)
    throw Error("This document contains too many archive entries.");
  let at = offset,
    total = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > buffer.byteLength || view.getUint32(at, true) !== 0x02014b50)
      throw Error("The document archive is damaged.");
    const bytes = view.getUint32(at + 24, true);
    total += bytes;
    if (bytes > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
      throw Error("This document exceeds the preview memory limit.");
    if (view.getUint16(at + 8, true) & 1)
      throw Error("Unlock this encrypted document before previewing it.");
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
}
