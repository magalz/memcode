import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
export default function Word({ bytes }: { bytes: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const container = host.current!;
    container.replaceChildren();
    void renderAsync(bytes, container, undefined, {
      inWrapper: true,
      breakPages: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderAltChunks: false,
      ignoreLastRenderedPageBreak: false,
    }).catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
      container.replaceChildren();
    };
  }, [bytes]);
  return (
    <div className="word-viewer">
      {error && (
        <div role="alert" className="viewer-error">
          {error}
        </div>
      )}
      <div ref={host} />
    </div>
  );
}
