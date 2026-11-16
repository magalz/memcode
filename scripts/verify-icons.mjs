import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../src-tauri/icons/", import.meta.url);
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngSize(bytes) {
  assert(bytes.subarray(0, 8).equals(signature), "Expected a PNG payload");
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

const pngs = {};
for (const [name, expected] of Object.entries({
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
})) {
  const size = pngSize(await readFile(new URL(name, root)));
  assert.deepEqual(size, [expected, expected], `${name} has the wrong size`);
  pngs[name] = size;
}

const ico = await readFile(new URL("icon.ico", root));
assert.equal(ico.readUInt16LE(0), 0);
assert.equal(ico.readUInt16LE(2), 1, "Not a native ICO file");
const icoSizes = [];
for (let index = 0; index < ico.readUInt16LE(4); index++) {
  const entry = 6 + index * 16;
  const width = ico[entry] || 256;
  const height = ico[entry + 1] || 256;
  const size = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert(size > 0 && offset + size <= ico.length, "Truncated ICO frame");
  assert.equal(width, height);
  const frame = ico.subarray(offset, offset + size);
  if (frame.subarray(0, 8).equals(signature))
    assert.deepEqual(pngSize(frame), [width, height]);
  else {
    assert(frame.length >= 40, "Truncated ICO bitmap");
    assert.equal(frame.readInt32LE(4), width);
    assert.equal(frame.readInt32LE(8), height * 2);
  }
  icoSizes.push(width);
}
for (const required of [16, 32, 48, 256])
  assert(icoSizes.includes(required), `Missing ${required}px Windows frame`);

const icns = await readFile(new URL("icon.icns", root));
assert.equal(icns.toString("ascii", 0, 4), "icns", "Not a native ICNS file");
assert.equal(icns.readUInt32BE(4), icns.length);
const icnsFrames = {};
for (let offset = 8; offset < icns.length;) {
  const type = icns.toString("ascii", offset, offset + 4);
  const size = icns.readUInt32BE(offset + 4);
  assert(size > 8 && offset + size <= icns.length, "Truncated ICNS frame");
  const frame = icns.subarray(offset + 8, offset + size);
  icnsFrames[type] = frame.subarray(0, 8).equals(signature)
    ? pngSize(frame)
    : { bytes: frame.length };
  offset += size;
}
for (const required of ["ic07", "ic08", "ic09", "ic10"])
  assert(required in icnsFrames, `Missing macOS ${required} frame`);
assert.deepEqual(icnsFrames.ic10, [1024, 1024]);
console.log(
  JSON.stringify(
    {
      source: fileURLToPath(new URL("source.svg", root)),
      pngs,
      windows: { frames: icoSizes, bytes: ico.length },
      macos: { frames: icnsFrames, bytes: icns.length },
    },
    null,
    2,
  ),
);
