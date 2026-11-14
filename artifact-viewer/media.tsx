import { useEffect, useRef, useState } from "react";
import { selectForComment } from "./selection";
import { currentReviewTarget } from "./reveal";
export default function Media({
  format,
  name,
}: {
  format: "video" | "audio";
  name: string;
}) {
  const media = useRef<HTMLMediaElement>(null),
    [error, setError] = useState("");
  const attrs = {
    src: "./__document",
    controls: true,
    preload: "metadata",
    onLoadedMetadata: () => {
      const target = currentReviewTarget();
      if (target?.time !== undefined && media.current) {
        media.current.currentTime = target.time;
        media.current.pause();
      }
      window.dispatchEvent(new Event("memcode:layout"));
    },
    onError: () =>
      setError(
        "This media codec is not supported by the installed system browser. Try MP4 (H.264/AAC), WebM or MP3/WAV.",
      ),
    ref: (node: HTMLMediaElement | null) => {
      media.current = node;
    },
  };
  useEffect(() => {
    const reveal = (event: Event) => {
      const target = (event as CustomEvent).detail;
      if (target.time !== undefined && media.current?.readyState) {
        media.current.currentTime = target.time;
        media.current.pause();
        window.dispatchEvent(new Event("memcode:layout"));
      }
    };
    window.addEventListener("memcode:reveal", reveal);
    return () => window.removeEventListener("memcode:reveal", reveal);
  }, []);
  return (
    <div className={"media-viewer " + format}>
      <div className="media-stage">
        {format === "video" ? (
          <video {...attrs} playsInline />
        ) : (
          <div className="audio-player">
            <span>♪</span>
            <h2>{name}</h2>
            <audio {...attrs} />
          </div>
        )}
      </div>
      <button
        className="media-comment"
        onClick={() => {
          const seconds = media.current?.currentTime ?? 0;
          selectForComment(
            {
              selectionType: "time",
              time: seconds,
              quote: `${name} at ${seconds.toFixed(1)} seconds`,
              location: `Time ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`,
            },
            true,
          );
        }}
      >
        Comment at current time
      </button>
      {error && (
        <div className="viewer-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
