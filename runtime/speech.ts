import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { z } from "zod";
import type { Settings } from "../src/shared";
import {
  speechDefaults,
  type SpeechSettings,
  type SpeechStatus,
} from "../src/speech";
import {
  installSpeechAssets,
  managedInstallAvailable,
  speechDownloadBytes,
  validateSpeechFiles,
} from "./speech-install";
import { localURL } from "./urls";

type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function validateSpeechWav(value: string) {
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 44 ||
    bytes.length > 20_000_000 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    throw Error("Dictation requires a WAV recording under 20 MB.");
  return bytes;
}
export class SpeechManager {
  private child?: ChildProcess;
  private starting?: Promise<SpeechStatus>;
  private installing?: Promise<SpeechStatus>;
  private endpoint?: string;
  private phase?: SpeechStatus["state"];
  private note = "";
  private progress?: number;
  private closed = false;
  private transcribing = false;
  private runningConfig = "";
  private installAbort?: AbortController;
  private transcriptionAbort?: AbortController;
  constructor(
    private readonly settings: () => Settings,
    private readonly dataDir: string,
    private readonly save: (settings: SpeechSettings) => Promise<void>,
    private readonly launch: typeof spawn = spawn,
  ) {}
  private config(): SpeechSettings {
    return this.settings().speech ?? { ...speechDefaults, mode: "endpoint" };
  }
  private configKey(settings: SpeechSettings) {
    return JSON.stringify([
      settings,
      settings.mode === "endpoint" ? this.settings().speechEndpoint : "",
    ]);
  }
  async status(): Promise<SpeechStatus> {
    const settings = this.config(),
      configured =
        !!this.settings().speech &&
        (settings.mode === "endpoint"
          ? !!this.settings().speechEndpoint
          : !!settings.executable && !!settings.modelPath);
    const changed =
      this.phase === "ready" && this.runningConfig !== this.configKey(settings);
    const state = changed
      ? "available"
      : (this.phase ?? (configured ? "available" : "unconfigured"));
    return {
      state,
      settings,
      mode: settings.mode,
      endpoint:
        (!changed ? this.endpoint : undefined) ??
        (settings.mode === "endpoint"
          ? this.settings().speechEndpoint
          : undefined),
      message:
        (changed
          ? "Settings changed. The local model will restart when you record."
          : this.note) ||
        (configured
          ? "Local dictation is configured. It starts when you record."
          : "Set up local dictation to speak into any prompt."),
      progress: this.progress,
      modelName: settings.modelPath ? basename(settings.modelPath) : undefined,
      managedInstallAvailable,
      downloadBytes: speechDownloadBytes(),
    };
  }
  async install(): Promise<SpeechStatus> {
    if (this.closed) throw Error("The workspace is closing.");
    if (this.installing) return this.installing;
    this.installing = (async () => {
      await this.stop();
      this.phase = "installing";
      this.note = "Downloading verified local speech files…";
      this.progress = 0;
      this.installAbort = new AbortController();
      try {
        const settings = await installSpeechAssets(
          this.dataDir,
          (value) => {
            this.progress = value;
          },
          this.installAbort.signal,
        );
        if (this.closed) throw Error("The workspace is closing.");
        await this.save(settings);
        this.progress = undefined;
        this.phase = undefined;
        return await this.start();
      } catch (error) {
        this.phase = "error";
        this.note = (error as Error).message;
        throw error;
      } finally {
        this.installing = undefined;
        this.installAbort = undefined;
      }
    })();
    return this.installing;
  }
  async prepare(): Promise<SpeechStatus> {
    if (this.closed) throw Error("The workspace is closing.");
    if (this.installing) return this.installing;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async start(): Promise<SpeechStatus> {
    const settings = this.config(),
      key = this.configKey(settings);
    if (this.child && this.runningConfig === key && this.phase === "ready")
      return this.status();
    if (this.child) await this.stop();
    this.phase = "starting";
    this.note = "Starting local transcription…";
    try {
      if (settings.mode === "endpoint") {
        const endpoint = localURL(this.settings().speechEndpoint),
          base = new URL("/", endpoint);
        let response: Response;
        try {
          response = await fetch(base, {
            signal: AbortSignal.timeout(3000),
            redirect: "error",
          });
        } catch {
          throw Error(
            "Local speech server is not running. Open Settings → Local dictation and choose Set up local dictation.",
          );
        }
        if (response.status >= 500)
          throw Error(
            "The local speech server is not ready. Check Local dictation in Settings.",
          );
        this.endpoint = endpoint.href;
        this.runningConfig = key;
        this.phase = "ready";
        this.note = "Connected to the local speech server.";
        return this.status();
      }
      await validateSpeechFiles(settings);
      const listener = createServer();
      await new Promise<void>((done, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", done);
      });
      const port = (listener.address() as { port: number }).port;
      await new Promise<void>((done) => listener.close(() => done()));
      this.endpoint = `http://127.0.0.1:${port}/inference`;
      const child = this.launch(
        settings.executable,
        [
          "--model",
          settings.modelPath,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--language",
          settings.language,
          "--threads",
          String(Math.min(8, availableParallelism())),
        ],
        { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      this.child = child;
      this.runningConfig = key;
      let startupLog = "",
        error: Error | undefined;
      const capture = (data: Buffer) => {
        if (this.phase === "starting")
          startupLog = (startupLog + data.toString()).slice(-2000);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.once("error", (value) => {
        error = value;
      });
      child.once("exit", (code) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.phase = "error";
        this.note =
          "Local speech stopped (" +
          code +
          "). Use Settings to start it again.";
      });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (
          this.closed ||
          this.child !== child ||
          error ||
          child.exitCode !== null
        )
          throw Error(
            error?.message ||
              startupLog ||
              "The local Whisper runtime stopped before it was ready.",
          );
        const ready = await fetch(new URL("/", this.endpoint), {
          signal: AbortSignal.timeout(500),
          redirect: "error",
        })
          .then(() => true)
          .catch(() => false);
        if (ready) {
          this.phase = "ready";
          this.note =
            "Your local speech model is ready. Audio stays on this computer.";
          return this.status();
        }
        await new Promise((done) => setTimeout(done, 150));
      }
      throw Error(
        "The local model did not start within 45 seconds. Check the selected model in Settings.",
      );
    } catch (error) {
      await this.stop();
      this.phase = "error";
      this.note = (error as Error).message;
      throw error;
    }
  }
  async transcribe(value: string): Promise<string> {
    const bytes = validateSpeechWav(value);
    if (this.transcribing)
      throw Error(
        "A recording is already being transcribed. Wait for it to finish.",
      );
    this.transcribing = true;
    try {
      await this.prepare();
      const form = new FormData();
      form.append(
        "file",
        new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }),
        "dictation.wav",
      );
      form.append("response_format", "json");
      form.append("language", this.config().language);
      form.append("temperature", "0");
      this.transcriptionAbort = new AbortController();
      let response: Response;
      try {
        response = await fetch(localURL(this.endpoint!), {
          method: "POST",
          body: form,
          signal: AbortSignal.any([
            this.transcriptionAbort.signal,
            AbortSignal.timeout(120000),
          ]),
          redirect: "error",
        });
      } catch {
        throw Error(
          "Local transcription could not finish. Check Local dictation in Settings and try a shorter recording.",
        );
      }
      if (!response.ok)
        throw Error(
          "Local transcription failed (" +
            response.status +
            "). Check the selected speech model.",
        );
      const result = (await response.json().catch(() => {
        throw Error("The local speech server returned an invalid response.");
      })) as { text?: unknown };
      if (
        typeof result.text !== "string" ||
        !result.text.trim() ||
        /^\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH)\]$/i.test(result.text.trim())
      )
        throw Error("No speech was detected. Speak clearly and try again.");
      return result.text.trim();
    } finally {
      this.transcribing = false;
      this.transcriptionAbort = undefined;
    }
  }
  async stop() {
    this.transcriptionAbort?.abort();
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    this.runningConfig = "";
    this.phase = undefined;
    this.note = "";
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }
  async close() {
    this.closed = true;
    this.installAbort?.abort();
    this.transcriptionAbort?.abort();
    await this.stop();
    await this.installing?.catch(() => {});
  }
}
export function registerSpeech(register: Register, speech: SpeechManager) {
  register("speech:status", z.undefined(), () => speech.status());
  register("speech:prepare", z.undefined(), () => speech.prepare());
  register("speech:install", z.undefined(), () => speech.install());
  register("speech:stop", z.undefined(), () => speech.stop());
  register("speech:transcribe", z.string().min(60).max(28_000_000), (value) =>
    speech.transcribe(value),
  );
}
