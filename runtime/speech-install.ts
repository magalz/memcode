import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
} from "node:fs/promises";
import { join, resolve, isAbsolute, basename } from "node:path";
import { unzipSync } from "fflate";
import type { SpeechSettings } from "../src/speech";

// Official CPU packages and multilingual model, pinned to verified upstream assets.
// No installer script, package-manager command or downloaded code runs here.
export const speechAssets = {
  version: "v1.9.2",
  runtimeUrl:
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
  runtimeSha256:
    "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
  runtimeBytes: 8194445,
  modelUrl:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
  modelSha256:
    "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  modelBytes: 77691713,
};
export const managedInstallAvailable =
  process.platform === "win32" && process.arch === "x64";
export function safeArchivePath(name: string) {
  return (
    !!name &&
    !isAbsolute(name) &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.split("/").some((p) => p === ".." || p === ".")
  );
}
async function download(
  url: string,
  path: string,
  sha: string,
  maxBytes: number,
  progress: (bytes: number) => void,
  signal?: AbortSignal,
) {
  const info = await stat(path).catch(() => undefined);
  const cached =
    info?.isFile() && info.size <= maxBytes
      ? await readFile(path).catch(() => undefined)
      : undefined;
  if (cached && createHash("sha256").update(cached).digest("hex") === sha) {
    progress(cached.length);
    return cached;
  }
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(240000)])
      : AbortSignal.timeout(240000),
  });
  if (!response.ok || !response.body)
    throw Error(
      "Could not download local dictation assets (" +
        response.status +
        "). Check your connection and try again.",
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes)
      throw Error("The speech download exceeds its expected size.");
    chunks.push(chunk);
    progress(bytes);
  }
  const body = Buffer.concat(chunks);
  if (createHash("sha256").update(body).digest("hex") !== sha)
    throw Error(
      "The speech download failed its integrity check. Nothing was installed.",
    );
  await mkdir(resolve(path, ".."), { recursive: true });
  const partial = path + ".verified";
  await writeFile(partial, body);
  await rename(partial, path);
  return body;
}
export async function findSpeechExecutable(
  root: string,
  depth = 0,
): Promise<string | undefined> {
  if (depth > 5) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries)
    if (entry.isFile() && /^(whisper-server|server)(\.exe)?$/i.test(entry.name))
      return join(root, entry.name);
  for (const entry of entries)
    if (entry.isDirectory()) {
      const result = await findSpeechExecutable(
        join(root, entry.name),
        depth + 1,
      );
      if (result) return result;
    }
}
export async function installSpeechAssets(
  dataDir: string,
  progress: (value: number) => void,
  signal?: AbortSignal,
): Promise<SpeechSettings> {
  if (!managedInstallAvailable)
    throw Error(
      "Automatic setup currently supports Windows x64. In Advanced, choose an installed whisper-server and a local Whisper model, or use an existing local server.",
    );
  const root = join(dataDir, "speech"),
    directory = join(root, speechAssets.version),
    total = speechAssets.runtimeBytes + speechAssets.modelBytes;
  await mkdir(directory, { recursive: true });
  const zip = await download(
    speechAssets.runtimeUrl,
    join(root, "whisper-cpu-" + speechAssets.version + ".zip"),
    speechAssets.runtimeSha256,
    speechAssets.runtimeBytes + 1024,
    (bytes) => progress(bytes / total),
    signal,
  );
  const files = unzipSync(zip, {
    filter: (file) => {
      if (!safeArchivePath(file.name) || file.originalSize > 64_000_000)
        throw Error("Invalid speech runtime archive.");
      return !file.name.endsWith("/");
    },
  });
  if (
    Object.keys(files).length > 128 ||
    Object.values(files).reduce((sum, file) => sum + file.length, 0) >
      256_000_000
  )
    throw Error("The speech runtime archive is too large.");
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  const executable = await findSpeechExecutable(directory);
  if (!executable)
    throw Error("The verified speech package did not contain whisper-server.");
  const modelPath = join(root, "ggml-tiny.bin");
  await download(
    speechAssets.modelUrl,
    modelPath,
    speechAssets.modelSha256,
    speechAssets.modelBytes + 1024,
    (bytes) => progress((speechAssets.runtimeBytes + bytes) / total),
    signal,
  );
  signal?.throwIfAborted();
  progress(1);
  return { mode: "managed", executable, modelPath, language: "auto" };
}

export async function validateSpeechFiles(settings: SpeechSettings) {
  for (const [path, label] of [
    [settings.executable, "Whisper executable"],
    [settings.modelPath, "Whisper model"],
  ]) {
    if (!isAbsolute(path))
      throw Error(
        "Choose an absolute path for the " + label.toLowerCase() + ".",
      );
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile())
      throw Error(
        label +
          " was not found. Set up local dictation or choose an installed file.",
      );
  }
  return { modelName: basename(settings.modelPath) };
}
