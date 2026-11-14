import { z } from "zod";

const sessionId = z.string().uuid();
export const terminalRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("start"),
      label: z.string().trim().min(1).max(100),
      shellId: z.string().max(100).optional(),
      program: z.string().min(1).max(2000).optional(),
      args: z
        .union([z.array(z.string().max(8000)).max(80), z.string().max(64000)])
        .default([])
        .describe(
          'Executable arguments as a JSON array, e.g. ["tools/server.mjs"]. A JSON-encoded array string is also accepted for adapter compatibility. Never a shell command.',
        ),
      cwd: z.string().max(2000).optional(),
      cols: z.number().int().min(20).max(400).default(110),
      rows: z.number().int().min(5).max(200).default(28),
    })
    .strict(),
  z
    .object({
      action: z.literal("observe"),
      sessionId,
      after: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      action: z.literal("write"),
      sessionId,
      data: z.string().max(65536).default(""),
      submit: z
        .boolean()
        .default(false)
        .describe(
          "Press Enter after data. Prefer this to literal backslash-r text.",
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("resize"),
      sessionId,
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(200),
    })
    .strict(),
  z.object({ action: z.literal("stop"), sessionId }).strict(),
  z.object({ action: z.literal("close"), sessionId }).strict(),
]);
export type TerminalRequest = z.input<typeof terminalRequestSchema>;
export interface TerminalShell {
  id: string;
  name: string;
  command: string;
  args: string[];
}
export interface TerminalSession {
  id: string;
  taskId: string;
  label: string;
  command: string[];
  cwd: string;
  origin: "user" | "worker";
  startedAt: string;
  pid?: number;
  status: "running" | "exited";
  exitCode?: number;
  seq: number;
}
export interface TerminalChunk {
  seq: number;
  data: string;
}
export interface TerminalOutput {
  sessionId: string;
  taskId: string;
  seq: number;
  data?: string;
  status?: "exited";
  exitCode?: number;
}
export interface TerminalReply {
  sessions: TerminalSession[];
  shells: TerminalShell[];
  session?: TerminalSession;
  chunks?: TerminalChunk[];
  truncated?: boolean;
  text?: string;
}
