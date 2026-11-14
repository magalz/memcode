import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** One first-page raster, sharing PDF.js's worker code; no embedded document UI. */
export async function pdfThumbnail(bytes: Uint8Array): Promise<string> {
  const job = getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
    enableXfa: false,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const document = await job.promise;
        const page = await document.getPage(1);
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(1, 520 / original.width),
        });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.min(740, Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) throw Error("Thumbnail canvas unavailable.");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        return canvas.toDataURL("image/webp", 0.8);
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("PDF thumbnail timed out.")),
          8000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await job.destroy();
  }
}
