import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { currentReviewTarget } from "./reveal";
GlobalWorkerOptions.workerSrc = workerURL;
export default function PDF() {
  const [pdf, setPDF] = useState<PDFDocumentProxy>(),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState<number | "fit">("fit"),
    [width, setWidth] = useState(800),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [password, setPassword] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    passwordCallback = useRef<((password: string) => void) | undefined>(
      undefined,
    );
  useEffect(() => {
    let alive = true;
    const base = new URL("./pdfjs/", window.location.href).href,
      task = getDocument({
        url: new URL("./__document", window.location.href).href,
        cMapUrl: base + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: base + "standard_fonts/",
        wasmUrl: base + "wasm/",
        iccUrl: base + "iccs/",
        enableXfa: false,
        disableAutoFetch: true,
      });
    task.onPassword = (
      callback: (password: string) => void,
      reason: number,
    ) => {
      if (alive) {
        passwordCallback.current = callback;
        setPassword(
          reason === 2
            ? "Incorrect password. Try again."
            : "Enter the document password.",
        );
      }
    };
    void task.promise
      .then((value) => {
        if (alive) setPDF(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      void task.destroy();
    };
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf) return;
    const reveal = (event: Event) => {
      const reference = (event as CustomEvent).detail;
      if (reference.page && reference.page <= pdf.numPages)
        setPage(reference.page);
    };
    window.addEventListener("memcode:reveal", reveal);
    const target = currentReviewTarget();
    if (target?.page && target.page <= pdf.numPages) setPage(target.page);
    return () => window.removeEventListener("memcode:reveal", reveal);
  }, [pdf]);
  useEffect(() => {
    if (!pdf) return;
    let alive = true,
      render:
        | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
        | undefined,
      layer: TextLayer | undefined;
    setLoading(true);
    void (async () => {
      const source = await pdf.getPage(page);
      if (!alive) return;
      const natural = source.getViewport({ scale: 1 }),
        scale =
          zoom === "fit"
            ? Math.max(0.2, Math.min(2, (width - 48) / natural.width))
            : zoom,
        viewport = source.getViewport({ scale }),
        output = Math.min(window.devicePixelRatio || 1, 2),
        surface = canvas.current!,
        container = text.current!;
      surface.width = Math.floor(viewport.width * output);
      surface.height = Math.floor(viewport.height * output);
      surface.style.width = viewport.width + "px";
      surface.style.height = viewport.height + "px";
      container.replaceChildren();
      container.style.setProperty("--total-scale-factor", String(scale));
      container.parentElement!.style.width = viewport.width + "px";
      container.parentElement!.style.height = viewport.height + "px";
      render = source.render({
        canvas: surface,
        viewport,
        transform: output === 1 ? undefined : [output, 0, 0, output, 0, 0],
      });
      layer = new TextLayer({
        textContentSource: source.streamTextContent(),
        container,
        viewport,
      });
      await Promise.all([render.promise, layer.render()]);
      if (alive) setLoading(false);
    })().catch((e) => {
      if (alive && e.name !== "RenderingCancelledException") {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, zoom, width]);
  return (
    <div className="pdf-viewer">
      <header className="pdf-toolbar">
        <button
          aria-label="Previous page"
          disabled={!pdf || page === 1}
          onClick={() => setPage((p) => p - 1)}
        >
          ←
        </button>
        <label>
          Page{" "}
          <input
            aria-label="PDF page"
            type="number"
            min={1}
            max={pdf?.numPages ?? 1}
            value={page}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (pdf && n >= 1 && n <= pdf.numPages) setPage(n);
            }}
          />{" "}
          of {pdf?.numPages ?? "…"}
        </label>
        <button
          aria-label="Next page"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          →
        </button>
        <span className="pdf-toolbar-divider" />
        <button
          aria-label="Zoom out"
          onClick={() =>
            setZoom((z) =>
              Math.max(0.25, (typeof z === "number" ? z : 1) - 0.25),
            )
          }
        >
          −
        </button>
        <button aria-label="Fit PDF width" onClick={() => setZoom("fit")}>
          {zoom === "fit" ? "Fit width" : Math.round(zoom * 100) + "%"}
        </button>
        <button
          aria-label="Zoom in"
          onClick={() =>
            setZoom((z) => Math.min(3, (typeof z === "number" ? z : 1) + 0.25))
          }
        >
          +
        </button>
      </header>
      {password && (
        <form
          className="pdf-password"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("password");
            passwordCallback.current?.(String(value));
            setPassword("");
          }}
        >
          <label>
            {password}
            <input
              aria-label="Document password"
              name="password"
              type="password"
              required
            />
          </label>
          <button>Open PDF</button>
        </form>
      )}
      {error && (
        <div role="alert" className="viewer-error">
          {error}
        </div>
      )}
      <div className="pdf-stage" ref={stage}>
        {!pdf && !error && <div className="loading">Opening PDF…</div>}
        <div
          className="pdf-page"
          data-page={page}
          aria-label={`PDF page ${page}`}
          aria-busy={loading}
        >
          <canvas ref={canvas} />
          <div className="textLayer" ref={text} />
        </div>
      </div>
    </div>
  );
}
