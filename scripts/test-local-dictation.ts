// Explicit real-model check. Downloads only the pinned small speech setup into
// the test directory, never activates the user's account or microphone.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SpeechManager } from "../runtime/speech";
import { initialState } from "../src/seed";
const directory = resolve("../tmp/memcode-speech-evidence");
await mkdir(directory, { recursive: true });
const state = initialState();
const manager = new SpeechManager(
  () => state.settings,
  directory,
  async (speech) => {
    state.settings.speech = speech;
  },
);
let previous = -1;
const timer = setInterval(
  () =>
    void manager.status().then((status) => {
      const progress = Math.floor((status.progress ?? 0) * 10) * 10;
      if (progress !== previous) {
        previous = progress;
        console.log(status.state + " " + progress + "%");
      }
    }),
  1000,
);
const started = Date.now();
try {
  const status = await manager.install();
  console.log("Local model ready: " + status.modelName);
  const response = await fetch(
    "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/samples/jfk.wav",
  );
  if (!response.ok)
    throw Error("Could not obtain the public-domain upstream audio fixture.");
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(join(directory, "jfk.wav"), bytes);
  const inferenceStarted = Date.now(),
    text = await manager.transcribe(bytes.toString("base64"));
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ");
  const passed =
    normalized.includes("ask not what your country can do for you") &&
    normalized.includes("what you can do for your country");
  const result = {
    at: new Date().toISOString(),
    passed,
    model: "Whisper Tiny multilingual",
    runtime: "whisper.cpp v1.9.2 CPU",
    audioSource:
      "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/samples/jfk.wav",
    inferenceMs: Date.now() - inferenceStarted,
    totalSetupAndCheckMs: Date.now() - started,
    text,
    microphone: "Not used; file fixture only",
    cloudInference: false,
  };
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  clearInterval(timer);
  await manager.close();
}
