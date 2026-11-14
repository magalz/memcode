export interface ContextAssistantSettings {
  enabled: boolean;
  provider: "onnx" | "openai-compatible";
  packageDirectory: string;
  baseUrl: string;
  model: string;
}

export const contextAssistantDefaults: ContextAssistantSettings = {
  enabled: false,
  provider: "onnx",
  packageDirectory: "",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
};
