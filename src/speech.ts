import { z } from "zod";

export const speechSettingsSchema = z
  .object({
    mode: z.enum(["managed", "endpoint"]),
    executable: z.string().max(2000),
    modelPath: z.string().max(2000),
    language: z.string().regex(/^(auto|[a-z]{2,3})$/),
  })
  .strict();
export type SpeechSettings = z.infer<typeof speechSettingsSchema>;
export const speechDefaults: SpeechSettings = {
  mode: "managed",
  executable: "",
  modelPath: "",
  language: "auto",
};
export interface SpeechStatus {
  state:
    | "unconfigured"
    | "available"
    | "starting"
    | "installing"
    | "ready"
    | "error";
  message: string;
  mode: "managed" | "endpoint";
  settings: SpeechSettings;
  endpoint?: string;
  progress?: number;
  modelName?: string;
  managedInstallAvailable: boolean;
  downloadBytes: number;
}
