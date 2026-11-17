import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  readdir,
  chmod,
  lstat,
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

export interface SpeechCacheManifest {
  runtime: SpeechRuntimeAsset;
  version: string;
  platform: string;
  arch: string;
  modelSha256: string;
  modelBytes: number;
}
function speechCacheManifest(): SpeechCacheManifest | undefined {
  const runtime = speechRuntimeFor();
  return runtime
    ? {
        runtime,
        version: speechAssets.version,
        platform: process.platform,
        arch: process.arch,
        modelSha256: speechAssets.modelSha256,
        modelBytes: speechAssets.modelBytes,
      }
    : undefined;
}
async function cachedFileHash(path: string, bytes: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes)
    throw Error("The cached speech file changed.");
  const hash = createHash("sha256");
  let observed = 0;
  for await (const chunk of createReadStream(path)) {
    observed += chunk.length;
    if (observed > bytes) throw Error("The cached speech file changed.");
    hash.update(chunk);
  }
  if (observed !== bytes) throw Error("The cached speech file changed.");
  return hash.digest("hex");
}

/** Read-only recovery of this release's already verified managed assets. */
export async function findManagedSpeechAssets(
  dataDir: string,
  manifest: SpeechCacheManifest | undefined = speechCacheManifest(),
): Promise<SpeechSettings | undefined> {
  if (!manifest) return;
  const { runtime, version, platform, arch } = manifest;
  const root = join(dataDir, "speech"),
    directory = join(
      root,
      version,
      `${platform}-${arch}-${runtime.sha256.slice(0, 12)}`,
    );
  const archive = join(
    root,
    `whisper-cpu-${version}-${platform}-${arch}-${runtime.sha256.slice(0, 12)}.zip`,
  );
  try {
    if ((await cachedFileHash(archive, runtime.bytes)) !== runtime.sha256)
      return;
    const zip = await readFile(archive);
    if (
      zip.length !== runtime.bytes ||
      createHash("sha256").update(zip).digest("hex") !== runtime.sha256
    )
      return;
    const files = unzipSync(zip, {
      filter: (file) => {
        if (!safeArchivePath(file.name) || file.originalSize > 64_000_000)
          throw Error("Invalid speech runtime archive.");
        return !file.name.endsWith("/");
      },
    });
    const entries = Object.entries(files);
    if (
      entries.length > 128 ||
      entries.reduce((n, [, bytes]) => n + bytes.length, 0) > 256_000_000
    )
      return;
    for (const [name, bytes] of entries)
      if (
        (await cachedFileHash(join(directory, name), bytes.length)) !==
        createHash("sha256").update(bytes).digest("hex")
      )
        return;
    const executables = entries
      .filter(([name]) =>
        /^(whisper-server|server)(\.exe)?$/i.test(basename(name)),
      )
      .sort(
        ([a], [b]) =>
          Number(!basename(a).startsWith("whisper-server")) -
          Number(!basename(b).startsWith("whisper-server")),
      );
    const chosen = executables.find(
      ([, bytes]) =>
        !runtime.executableSha256 ||
        createHash("sha256").update(bytes).digest("hex") ===
          runtime.executableSha256,
    );
    if (!chosen) return;
    const executable = join(directory, chosen[0]),
      modelPath = join(root, "ggml-tiny.bin");
    if (platform !== "win32" && !((await lstat(executable)).mode & 0o111))
      return;
    if (
      (await cachedFileHash(modelPath, manifest.modelBytes)) !==
      manifest.modelSha256
    )
      return;
    return { mode: "managed", executable, modelPath, language: "auto" };
  } catch {
    return;
  }
}
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
  const cached = await findManagedSpeechAssets(dataDir);
  if (cached) {
    signal?.throwIfAborted();
    progress(1);
    return cached;
  }
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
    if (
      (await cachedFileHash(path, bytes.length).catch(() => "")) ===
      createHash("sha256").update(bytes).digest("hex")
    )
      continue;
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
  if (
    process.platform !== "win32" &&
    ((await stat(executable)).mode & 0o777) !== 0o755
  )
    await chmod(executable, 0o755);
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
