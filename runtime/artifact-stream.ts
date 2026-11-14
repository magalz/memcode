import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stat } from "node:fs/promises";

export function byteRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || !size || (!match[1] && !match[2])) return null;
  const suffix = !match[1],
    start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]),
    end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (
    ![start, end].every(Number.isSafeInteger) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end };
}
/** Stream large media without buffering it into the runtime or renderer. */
export async function streamArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  mime: string,
  limit: number,
) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit)
    throw Error("This file exceeds the preview size limit.");
  response.setHeader("Content-Type", mime);
  response.setHeader("Accept-Ranges", "bytes");
  const range = request.headers.range
    ? byteRange(request.headers.range, info.size)
    : undefined;
  if (range === null) {
    response.writeHead(416, {
      "Content-Range": `bytes */${info.size}`,
      "Content-Length": "0",
    });
    response.end();
    return;
  }
  if (range) {
    response.statusCode = 206;
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${info.size}`,
    );
  }
  response.setHeader(
    "Content-Length",
    range ? range.end - range.start + 1 : info.size,
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const source = createReadStream(path, range ?? {});
  source.once("error", () => response.destroy());
  response.once("close", () => source.destroy());
  source.pipe(response);
}
