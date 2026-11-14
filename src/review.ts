import { z } from "zod";

export const selectionSchema = z
  .object({
    quote: z.string().trim().min(1).max(4000),
    location: z.string().max(300).optional(),
    page: z.number().int().min(1).max(100000).optional(),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    sheet: z.string().max(200).optional(),
    cells: z.string().max(80).optional(),
    side: z.enum(["before", "after", "mixed"]).optional(),
    checkpointId: z.string().max(200).optional(),
    prefix: z.string().max(160).optional(),
    suffix: z.string().max(160).optional(),
    selector: z.string().max(2000).optional(),
    startOffset: z.number().int().min(0).max(100000000).optional(),
    endOffset: z.number().int().min(0).max(100000000).optional(),
    time: z.number().min(0).max(10000000).optional(),
    selectionType: z
      .enum(["text", "element", "area", "cells", "lines", "terminal", "time"])
      .optional(),
    rect: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0).max(1),
        height: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    columnStart: z.number().int().min(0).max(10000).optional(),
    columnEnd: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type ReviewSelection = z.infer<typeof selectionSchema>;
export const reviewReferenceSchema = selectionSchema
  .extend({
    kind: z.enum(["artifact", "file", "changes", "terminal", "conversation"]),
    taskId: z.string().min(1).max(200),
    name: z.string().min(1).max(1000),
    path: z.string().max(4000).optional(),
    artifactId: z.string().max(200).optional(),
    sessionId: z.string().max(200).optional(),
    revision: z.string().max(200).optional(),
  })
  .strict();
export type ReviewReference = z.infer<typeof reviewReferenceSchema>;
export interface ReviewComment {
  id: string;
  taskId: string;
  reference: ReviewReference;
  text: string;
  createdAt: string;
  updatedAt: string;
  status: "saved" | "shared";
  messageId?: string;
}
export type ReviewEvent =
  | { action: "comment"; reference: ReviewReference }
  | { action: "link"; taskId: string; href: string; basePath?: string }
  | { action: "focus-comment"; taskId: string; commentId: string };
export function reviewLocation(ref: ReviewReference) {
  return [
    ref.page && `Page ${ref.page}`,
    ref.sheet,
    ref.cells,
    ref.lineStart &&
      `${ref.kind === "terminal" ? "Output" : "Line"} ${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? "–" + ref.lineEnd : ""}`,
    ref.selectionType === "element" && ref.location,
    ref.selectionType === "area" && "Selected area",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Keep the exact quote and version in the text every harness already receives. */
export function formatReviewMessage(
  text: string,
  references: ReviewReference[],
) {
  const context = references
    .map((ref, index) => {
      const source = ref.path ?? ref.name;
      const details = [
        ref.location,
        ref.page && `page ${ref.page}`,
        ref.sheet,
        ref.cells,
        ref.lineStart &&
          `lines ${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? "–" + ref.lineEnd : ""}`,
        ref.side && `${ref.side} change`,
        ref.revision && `version ${ref.revision}`,
        ref.sessionId && `session ${ref.sessionId}`,
        ref.checkpointId && `checkpoint ${ref.checkpointId}`,
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        `Reference ${index + 1}: ${source}${details ? " (" + details + ")" : ""}\n` +
        ref.quote
          .split("\n")
          .map((line) => "> " + line)
          .join("\n") +
        "\nSelection target: " +
        JSON.stringify({
          type: ref.selectionType,
          time: ref.time,
          selector: ref.selector,
          startOffset: ref.startOffset,
          endOffset: ref.endOffset,
          page: ref.page,
          sheet: ref.sheet,
          cells: ref.cells,
          lines: ref.lineStart
            ? [ref.lineStart, ref.lineEnd ?? ref.lineStart]
            : undefined,
          columns:
            ref.columnStart !== undefined
              ? [ref.columnStart, ref.columnEnd]
              : undefined,
          rect: ref.rect,
          side: ref.side,
          checkpointId: ref.checkpointId,
        })
      );
    })
    .join("\n\n");
  return [text.trim(), context].filter(Boolean).join("\n\n");
}
