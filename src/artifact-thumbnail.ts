import type { ArtifactFormat } from "./artifact-format";

/** Inert, bounded gallery content. Full documents still open in their isolated viewer. */
export type ArtifactThumbnail =
  | { kind: "image"; format: ArtifactFormat; dataUrl: string }
  | {
      kind: "document";
      format: ArtifactFormat;
      title?: string;
      lines: string[];
      rows?: string[][];
      label?: string;
    }
  | { kind: "media"; format: "pdf" | "video"; dataUrl: string }
  | {
      kind: "fallback";
      format: ArtifactFormat;
      label: string;
      detail?: string;
    };
