import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
  chmod,
} from "node:fs/promises";
import { join, resolve, isAbsolute, basename } from "node:path";
import { unzipSync } from "fflate";
import type { SpeechSettings } from "../src/speech";
import speechRuntimeCatalog from "../scripts/speech-runtime.json";

export interface SpeechRuntimeAsset {
  url: string;
  sha256: string;
  bytes: number;
  executableSha256?: string;
}
export function speechRuntimeFor(
  platform: string = process.platform,
  arch: string = process.arch,
): SpeechRuntimeAsset | undefined {
  const runtimes: Record<string, SpeechRuntimeAsset> =
    speechRuntimeCatalog.runtimes;
  const runtime = runtimes[`${platform}-${arch}`];
  if (!runtime) return;
  const url = new URL(runtime.url);
  if (
    url.protocol !== "https:" ||
    !["github.com", "d12b8r6xagt10r.cloudfront.net"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !/^[a-f0-9]{64}$/.test(runtime.sha256) ||
    !Number.isSafeInteger(runtime.bytes) ||
    runtime.bytes < 1 ||
    runtime.bytes > 32_000_000 ||
    (runtime.executableSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(runtime.executableSha256))
  )
    throw Error("The local speech runtime manifest is invalid.");
  return runtime;
}

// The official Windows package, our pinned-source Mac CPU build, and the
// multilingual model. Setup never invokes installer scripts or package managers.
export const speechAssets = {
  version: speechRuntimeCatalog.version,
  modelUrl:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
  modelSha256:
    "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  modelBytes: 77691713,
};
export const managedInstallAvailable = !!speechRuntimeFor();
export const speechDownloadBytes = () =>
  (speechRuntimeFor()?.bytes ?? 0) + speechAssets.modelBytes;
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
  const runtime = speechRuntimeFor();
  if (!runtime)
    throw Error(
      "Local dictation setup is available for Windows x64 and Apple Silicon Mac installers. This architecture needs an existing local speech server in Advanced settings.",
    );
  const root = join(dataDir, "speech"),
    directory = join(
      root,
      speechAssets.version,
      `${process.platform}-${process.arch}-${runtime.sha256.slice(0, 12)}`,
    ),
    total = runtime.bytes + speechAssets.modelBytes;
  await mkdir(directory, { recursive: true });
  const zip = await download(
    runtime.url,
    join(
      root,
      `whisper-cpu-${speechAssets.version}-${process.platform}-${process.arch}-${runtime.sha256.slice(0, 12)}.zip`,
    ),
    runtime.sha256,
    runtime.bytes,
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
  if (
    runtime.executableSha256 &&
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex") !== runtime.executableSha256
  )
    throw Error("The local speech executable failed its integrity check.");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const modelPath = join(root, "ggml-tiny.bin");
  await download(
    speechAssets.modelUrl,
    modelPath,
    speechAssets.modelSha256,
    speechAssets.modelBytes + 1024,
    (bytes) => progress((runtime.bytes + bytes) / total),
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
