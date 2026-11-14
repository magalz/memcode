export type ArtifactFormat =
  | "html"
  | "image"
  | "markdown"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "unsupported";
export function artifactFormat(name: string): ArtifactFormat {
  const ext = name.toLowerCase().split(".").at(-1) ?? "";
  if (["html", "htm"].includes(ext)) return "html";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext))
    return "image";
  if (["md", "markdown", "mdown"].includes(ext)) return "markdown";
  if (["mp4", "webm", "ogv", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"].includes(ext))
    return "audio";
  if (["docx", "xlsx", "pptx", "pdf"].includes(ext))
    return ext as ArtifactFormat;
  if (["doc", "xls", "ppt", "odt", "ods", "odp"].includes(ext))
    return "unsupported";
  return "text";
}
export function artifactTypeLabel(name: string) {
  return {
    html: "Interactive",
    image: "Image",
    markdown: "Markdown",
    docx: "Word",
    xlsx: "Excel",
    pptx: "Presentation",
    pdf: "PDF",
    video: "Video",
    audio: "Audio",
    text: "Text",
    unsupported: "Document",
  }[artifactFormat(name)];
}
