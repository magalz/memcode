import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FileCode2,
  Image,
  RefreshCw,
  ShieldCheck,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Artifact } from "../shared";
import { errorMessage } from "../errors";
import { Spinner } from "./UI";
import { artifactFormat } from "../artifact-format";
import type { FileReference } from "../file-reference";

/** A saved output opens directly. It never joins or navigates the worker's browser. */
export function ArtifactPreview({
  artifact: savedArtifact,
  file,
  commentId,
  commentFocus,
  taskId,
  obscured,
  onBack,
}: {
  artifact?: Artifact;
  file?: FileReference;
  commentId?: string;
  commentFocus?: number;
  taskId: string;
  obscured: boolean;
  onBack: () => void;
}) {
  const artifact: Artifact = savedArtifact ?? {
    id: "file:" + file!.path,
    name: file!.name,
    path: file!.path,
    kind: "text",
    source: file!.relativePath,
    taskId,
    projectId: "",
    createdAt: "",
    revision: file!.revision,
  };
  const format = file?.format ?? artifactFormat(artifact.name);
  const native = !!file || format !== "image";
  const ref = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (native) return;
    let active = true;
    void window.memcode
      .readArtifact(artifact.id)
      .then((value) => {
        if (active) setContent(value);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [artifact.id, native, artifact.revision]);
  useEffect(() => {
    if (!native) return;
    let stopped = false,
      popover = false;
    const show = () => {
      if (stopped) return;
      const rect = ref.current?.getBoundingClientRect();
      if (
        obscured ||
        popover ||
        document.visibilityState === "hidden" ||
        !rect ||
        rect.width < 10 ||
        rect.height < 10
      ) {
        void window.memcode.hidePreview();
        return;
      }
      void window.memcode
        .showPreview({
          taskId,
          commentId,
          commentFocus,
          ...(file
            ? {
                filePath: file.path,
                line: file.line,
                fileRevision: file.revision,
              }
            : { artifactId: artifact.id }),
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        })
        .catch((error) => {
          if (!stopped) setError(errorMessage(error));
        });
    };
    const menu = (event: Event) => {
      popover = (event as CustomEvent<boolean>).detail;
      show();
    };
    const observer = new ResizeObserver(show);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", show);
    window.addEventListener("scroll", show, true);
    window.addEventListener("memcode:popover", menu);
    document.addEventListener("visibilitychange", show);
    show();
    return () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener("resize", show);
      window.removeEventListener("scroll", show, true);
      window.removeEventListener("memcode:popover", menu);
      document.removeEventListener("visibilitychange", show);
      void window.memcode.hidePreview().catch(() => {});
    };
  }, [
    artifact.id,
    native,
    artifact.revision,
    file?.line,
    taskId,
    obscured,
    commentId,
    commentFocus,
  ]);
  return (
    <section className="artifact-preview" aria-label="Artifact preview">
      <header className="artifact-preview-header">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={13} />
          {file ? "Conversation" : "All artifacts"}
        </button>
        <span className="artifact-preview-divider" />
        {artifact.kind === "image" ? (
          <Image size={16} />
        ) : (
          <FileCode2 size={16} />
        )}
        <div>
          <strong>{artifact.name}</strong>
          <small>{artifact.source}</small>
        </div>
        <span className="artifact-preview-type">
          {
            {
              html: "Interactive artifact",
              image: "Image",
              markdown: "Markdown",
              docx: "Word document",
              xlsx: "Excel workbook",
              pptx: "Presentation",
              pdf: "PDF",
              video: "Video",
              audio: "Audio",
              text: "Text",
              unsupported: "Document",
            }[format]
          }
        </span>
        {!native && artifact.kind === "image" && (
          <button
            className="icon-button"
            aria-label={zoom ? "Fit image" : "View image at full size"}
            onClick={() => setZoom(!zoom)}
          >
            {zoom ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
          </button>
        )}
        {native && (
          <button
            className="icon-button"
            aria-label="Reload artifact"
            onClick={() =>
              void window.memcode
                .previewAction("reload")
                .catch((error) => setError(errorMessage(error)))
            }
          >
            <RefreshCw size={14} />
          </button>
        )}
      </header>
      {error && (
        <div className="browser-error" role="alert">
          {error}
        </div>
      )}
      <div
        ref={ref}
        className={
          "artifact-preview-content " +
          artifact.kind +
          (zoom ? " full-size" : "")
        }
      >
        {!native && content === null && !error && <Spinner />}
        {!native && artifact.kind === "image" && content && (
          <img
            src={content}
            alt={artifact.name}
            onClick={() => setZoom(!zoom)}
          />
        )}
        {format === "text" && content !== null && (
          <article className="artifact-document">
            <pre>{content}</pre>
          </article>
        )}
      </div>
      <footer className="artifact-preview-footer">
        <ShieldCheck size={11} />
        {file
          ? "Project file · " + file.relativePath
          : "Saved output · " + new Date(artifact.createdAt).toLocaleString()}
        <span>
          {native ? "Isolated interactive preview" : "Stored locally"}
        </span>
      </footer>
    </section>
  );
}
