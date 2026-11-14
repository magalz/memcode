import type { ArtifactFormat } from "./artifact-format";
export interface FileReference {
  path: string;
  name: string;
  relativePath: string;
  format: ArtifactFormat;
  revision: string;
  size: number;
  line?: number;
  artifactId?: string;
}
/** A path may carry an editor line suffix; drive letters are not URL schemes. */
export function fileLink(href: string): { path: string; line?: number } {
  let path = href.trim();
  if (path.length > 6000 || !path || /[\u0000-\u001f]/.test(path))
    throw Error("This file reference is invalid.");
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    if (url.hostname && url.hostname !== "localhost")
      throw Error("Network file references cannot be opened.");
    path = url.pathname + url.hash;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    throw Error("This file reference is invalid.");
  }
  path = path.replace(/^\/(?:([A-Za-z]:)[/\\])/, "$1/");
  const anchor = path.match(/#L?(\d+)(?:C\d+)?(?:[-:]L?\d+)?$/i),
    suffix = path.match(/:(\d+)(?::\d+)?$/);
  const match = anchor ?? suffix;
  if (
    /^[a-z][a-z\d+.-]*:/i.test(path) &&
    !/^[A-Za-z]:[/\\]/.test(path) &&
    !(suffix && /\.[a-z\d_-]+$/i.test(path.slice(0, suffix.index)))
  )
    throw Error("Open a local project file or a web address.");
  const line = match ? Number(match[1]) : undefined;
  if (match) path = path.slice(0, match.index);
  if (!path || path.startsWith("//") || path.startsWith("\\\\"))
    throw Error("Network file references cannot be opened.");
  return { path, ...(line && line <= 10_000_000 ? { line } : {}) };
}
export function isWebLink(href: string) {
  return /^https?:\/\//i.test(href);
}
export function localFileURL(href: string) {
  try {
    fileLink(href);
    return true;
  } catch {
    return false;
  }
}
