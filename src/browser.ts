import { z } from "zod";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}
export interface BrowserActivity {
  at: string;
  actor: "user" | "worker" | "page";
  text: string;
  tabId?: string;
}
export interface WorkerBrowserState {
  taskId: string;
  status: "idle" | "starting" | "ready" | "error";
  control: "user" | "worker";
  workerConnected: boolean;
  harness?: string;
  tabs: BrowserTab[];
  activity: BrowserActivity[];
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  nativeSurface?: boolean;
  cursor?: string;
  pointer?: { x: number; y: number; actor: "user" | "worker"; at: number };
  action?: string;
  error?: string;
}
export interface BrowserImage {
  mimeType: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
}
export interface BrowserReply {
  state: WorkerBrowserState;
  snapshot?: { revision: string; text: string };
  image?: BrowserImage;
  artifactId?: string;
}

const tabId = z.string().max(100).optional();
export const browserOpenSchema = z
  .object({
    url: z.string().trim().min(1).max(4096),
    tabId,
  })
  .strict();
export const browserObserveSchema = z
  .object({
    tabId,
    screenshot: z.boolean().optional(),
  })
  .strict();
export const browserActSchema = z
  .object({
    action: z.enum([
      "click",
      "type",
      "choose",
      "press",
      "scroll",
      "back",
      "forward",
      "reload",
      "select",
      "close",
      "capture",
      "hover",
    ]),
    tabId,
    ref: z
      .string()
      .regex(/^m\d+$/)
      .optional(),
    x: z.number().finite().min(0).optional(),
    y: z.number().finite().min(0).optional(),
    text: z.string().max(12000).optional(),
    value: z.string().max(2000).optional(),
    label: z.string().max(2000).optional(),
    key: z
      .enum([
        "Enter",
        "Tab",
        "Shift+Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Space",
        "Control+A",
        "Meta+A",
      ])
      .optional(),
    deltaY: z.number().finite().min(-4000).max(4000).optional(),
    revision: z.string().max(100).optional(),
  })
  .strict();
export const browserRequestSchema = z.discriminatedUnion("action", [
  browserOpenSchema.extend({ action: z.literal("open") }),
  browserObserveSchema.extend({ action: z.literal("observe") }),
  z.object({ action: z.literal("act"), input: browserActSchema }).strict(),
  z.object({ action: z.literal("frame") }).strict(),
  z.object({ action: z.literal("state") }).strict(),
  z.object({ action: z.literal("new-tab") }).strict(),
  z
    .object({
      action: z.literal("surface"),
      tabId,
      visible: z.boolean(),
      bounds: z
        .object({
          x: z.number().finite().min(0),
          y: z.number().finite().min(0),
          width: z.number().finite().min(1).max(10000),
          height: z.number().finite().min(1).max(10000),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("control"), value: z.enum(["user", "worker"]) })
    .strict(),
  z
    .object({
      action: z.literal("resize"),
      width: z.number().int().min(640).max(1920),
      height: z.number().int().min(400).max(1200),
      deviceScaleFactor: z.number().finite().min(1).max(2).optional(),
    })
    .strict(),
  z.object({ action: z.literal("capture") }).strict(),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export type BrowserInteraction = z.infer<typeof browserActSchema>;

export { browserURL } from "./browser-address";
