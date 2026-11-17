import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ContextAssistantSetupState } from "../../src/context-settings";
import type { RetrievalAssistant } from "./local-model";
import { OnnxAssistant } from "./onnx";
import { retrievalAssetUrl, retrievalModel, retrievalSetupDownloadBytes } from "./retriever-model";

type Asset = { name: string; bytes: number; sha256: string; url?: string };
type ModelManifest = { id: string; revision: string; runtimeVersion: string; assets: readonly Asset[] };
type FileReceipt = { name: string; bytes: number; modifiedMs: number; sha256: string };
export interface ManagedRetrievalAssistantOptions {
  runtimeDirectory: string;
  changed?: () => void | Promise<void>;
  fetch?: typeof fetch;
  /** Dependency seams for bounded installer tests; product uses the reviewed model/runtime. */
  modelManifest?: ModelManifest;
  createAssistant?: (packageDirectory: string, modelDirectory: string) => RetrievalAssistant;
  platform?: NodeJS.Platform;
  arch?: string;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function regular(path: string, bytes?: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (bytes !== undefined && stat.size !== bytes)) throw Error("The local retrieval file is missing or incomplete.");
  return stat;
}
async function boundedJson(path: string, maximum = 2_000_000) {
  const stat = await regular(path);
  if (stat.size > maximum) throw Error("Local retrieval metadata is too large.");
  return JSON.parse(await readFile(path, "utf8"));
}

/** Owns one lazy CPU model for the whole application, rather than one per worker. */
export class ManagedRetrievalAssistant {
  readonly modelDirectory: string;
  readonly packageDirectory: string;
  private readonly manifest: ModelManifest;
  private readonly directory: string;
  private readonly receiptPath: string;
  private readonly download: typeof fetch;
  private readonly supported: boolean;
  private readonly createAssistant: (packageDirectory: string, modelDirectory: string) => RetrievalAssistant;
  private current: ContextAssistantSetupState;
  private installing?: Promise<ContextAssistantSetupState>;
  private controller?: AbortController;
  private shared?: RetrievalAssistant;
  private probe?: RetrievalAssistant;
  private verifiedForUse?: Promise<void>;
  private users = 0;
  private idle?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(dataDirectory: string, private readonly options: ManagedRetrievalAssistantOptions) {
    this.manifest = options.modelManifest ?? retrievalModel;
    this.directory = resolve(dataDirectory, "local-retriever", this.manifest.revision);
    this.modelDirectory = join(this.directory, "model");
    this.receiptPath = join(this.directory, "ready.json");
    this.packageDirectory = join(options.runtimeDirectory, "node_modules", "@huggingface", "transformers");
    this.download = options.fetch ?? fetch;
    const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
    this.supported = (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64");
    this.createAssistant = options.createAssistant ?? ((directory, modelDirectory) => new OnnxAssistant(directory, 60_000, modelDirectory));
    this.current = { status: this.supported ? "not-installed" : "unsupported", downloadedBytes: 0, totalBytes: this.manifest.assets.reduce((n, a) => n + a.bytes, 0), model: this.manifest.id, ...(!this.supported ? { message: "Local retrieval is available on Apple Silicon Macs and Windows x64." } : {}) };
  }

  private notify(patch: Partial<ContextAssistantSetupState>) {
    this.current = { ...this.current, ...patch };
    void Promise.resolve(this.options.changed?.()).catch(() => {});
  }
  private assetPath(name: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.split("/").some(p => !p || p === "." || p === "..")) throw Error("Invalid local model asset path.");
    const path = resolve(this.modelDirectory, name);
    if (!path.startsWith(this.modelDirectory + sep)) throw Error("Local model asset escaped its directory.");
    return path;
  }
  private async runtime(full = false) {
    const root = resolve(this.options.runtimeDirectory);
    let data;
    try { data = await boundedJson(join(root, "provenance.json")); }
    catch { throw Error("The local retrieval runtime is missing from this MemCode build. Install the latest update."); }
    if (data.schema !== 1 || data.version !== this.manifest.runtimeVersion || data.platform !== (this.options.platform ?? process.platform) || data.arch !== (this.options.arch ?? process.arch) || data.entry !== "node_modules/@huggingface/transformers/dist/transformers.node.mjs" || !Array.isArray(data.files) || !data.files.length) throw Error("The bundled local retrieval runtime does not match this computer. Install the latest MemCode update.");
    for (const file of data.files) {
      if (!file || typeof file.name !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw Error("The local retrieval runtime manifest is invalid.");
      const path = resolve(root, file.name);
      if (!path.startsWith(root + sep) || file.name.split(/[\\/]/).includes("..")) throw Error("The local retrieval runtime escaped its directory.");
      if (full || file.name === data.entry) {
        await regular(path, file.bytes);
        if (await fileHash(path) !== file.sha256) throw Error("The bundled local retrieval runtime failed verification. Install MemCode again.");
      }
    }
    if (!data.files.some((file: { name: string }) => file.name === data.entry)) throw Error("The local retrieval runtime entry is missing.");
  }
  private async receipt(): Promise<FileReceipt[] | undefined> {
    try {
      const data = await boundedJson(this.receiptPath, 20_000);
      if (data.schema !== 1 || data.id !== this.manifest.id || data.revision !== this.manifest.revision || data.runtimeVersion !== this.manifest.runtimeVersion || !Array.isArray(data.files) || data.files.length !== this.manifest.assets.length) return;
      for (const asset of this.manifest.assets) {
        const saved = data.files.find((file: FileReceipt) => file.name === asset.name);
        const stat = await regular(this.assetPath(asset.name), asset.bytes);
        if (!saved || saved.sha256 !== asset.sha256 || saved.bytes !== asset.bytes || saved.modifiedMs !== stat.mtimeMs) return;
      }
      return data.files;
    } catch { return; }
  }
  private verifyForUse(): Promise<void> {
    return this.verifiedForUse ??= (async () => {
      await this.runtime(true);
      if (!await this.receipt()) throw Error("The local retrieval model changed. Retry setup in Settings.");
      for (const asset of this.manifest.assets)
        if (await fileHash(this.assetPath(asset.name)) !== asset.sha256) throw Error("The local retrieval model failed verification. Retry setup in Settings.");
    })().catch(error => { this.verifiedForUse = undefined; this.notify({ status: "error", message: (error as Error).message }); throw error; });
  }
  async status(): Promise<ContextAssistantSetupState> {
    if (!this.supported || this.installing || this.current.status === "error") return { ...this.current };
    try {
      await this.runtime();
      if (await this.receipt()) this.current = { ...this.current, status: "ready", phase: undefined, downloadedBytes: this.current.totalBytes, message: undefined };
      else this.current = { ...this.current, status: "not-installed", phase: undefined, downloadedBytes: 0, message: "Download the local retrieval model once. It stays on this computer." };
    } catch (error) {
      this.current = { ...this.current, status: "error", message: (error as Error).message };
    }
    return { ...this.current };
  }
  install(): Promise<ContextAssistantSetupState> {
    if (this.installing) return this.installing;
    this.installing = this.performInstall().finally(() => { this.installing = undefined; });
    return this.installing;
  }
  private async performInstall(): Promise<ContextAssistantSetupState> {
    if (this.closed) throw Error("Local retrieval is closed.");
    if (!this.supported) return { ...this.current };
    this.controller = new AbortController();
    this.verifiedForUse = undefined;
    try {
      this.notify({ status: "installing", phase: "runtime", downloadedBytes: 0, message: "Checking the included local inference runtime…" });
      await this.runtime(true);
      if (await this.receipt()) {
        this.notify({ status: "ready", phase: undefined, downloadedBytes: this.current.totalBytes, message: undefined });
        return { ...this.current };
      }
      await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 });
      const receipts: FileReceipt[] = [];
      let completed = 0, lastProgress = 0;
      for (const asset of this.manifest.assets) {
        const path = this.assetPath(asset.name);
        const existing = await regular(path, asset.bytes).catch(() => undefined);
        if (!existing || await fileHash(path) !== asset.sha256) {
          await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
          const temporary = path + ".partial-" + randomUUID();
          const url = asset.url ?? retrievalAssetUrl(asset);
          if (new URL(url).protocol !== "https:") throw Error("Local models must use verified HTTPS downloads.");
          const response = await this.download(url, { redirect: "follow", signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(900_000)]) });
          if (!response.ok || !response.body) throw Error(`Could not download the local retrieval model (HTTP ${response.status}). Retry setup.`);
          const declared = response.headers.get("content-length");
          if (declared && Number(declared) !== asset.bytes) throw Error("The local retrieval download size changed. Update MemCode before retrying.");
          const file = await open(temporary, "wx", 0o600);
          const hash = createHash("sha256"); let downloaded = 0;
          try {
            this.notify({ phase: "model", message: "Downloading the local retrieval model…" });
            for await (const chunk of response.body) {
              downloaded += chunk.length;
              if (downloaded > asset.bytes) throw Error("The local retrieval download exceeded its reviewed size.");
              hash.update(chunk); await file.writeFile(chunk);
              if (Date.now() - lastProgress > 200) { lastProgress = Date.now(); this.notify({ downloadedBytes: completed + downloaded }); }
            }
            if (downloaded !== asset.bytes || hash.digest("hex") !== asset.sha256) throw Error("The local retrieval model checksum failed. Retry setup.");
          } catch (error) {
            await file.close(); await rm(temporary, { force: true }); throw error;
          } finally { await file.close(); }
          try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
        }
        const stat = await regular(path, asset.bytes);
        receipts.push({ name: asset.name, bytes: asset.bytes, sha256: asset.sha256, modifiedMs: stat.mtimeMs });
        completed += asset.bytes; this.notify({ downloadedBytes: completed });
      }
      this.notify({ phase: "verify", message: "Testing the local model on this computer…" });
      if (this.closed) throw Error("Local retrieval setup was cancelled.");
      const check = this.probe = this.createAssistant(this.packageDirectory, this.modelDirectory);
      try {
        const result = await check.plan("find the function that validates a session token");
        if (!result.query.trim()) throw Error("The local retrieval model did not return a search query.");
      } finally { await check.close?.(); if (this.probe === check) this.probe = undefined; }
      if (this.closed) throw Error("Local retrieval setup was cancelled.");
      const marker = this.receiptPath + ".next";
      await writeFile(marker, JSON.stringify({ schema: 1, id: this.manifest.id, revision: this.manifest.revision, runtimeVersion: this.manifest.runtimeVersion, files: receipts }), { mode: 0o600 });
      await rename(marker, this.receiptPath);
      this.notify({ status: "ready", phase: undefined, downloadedBytes: this.current.totalBytes, message: undefined });
    } catch (error) {
      this.notify({ status: "error", phase: undefined, message: (error as Error).message });
    } finally { this.controller = undefined; }
    return { ...this.current };
  }
  async assistant(): Promise<RetrievalAssistant> {
    if (this.closed) throw Error("Local retrieval is closed.");
    if ((await this.status()).status !== "ready") throw Error("Set up the local retrieval assistant in Settings first.");
    await this.verifyForUse();
    clearTimeout(this.idle);
    this.shared ??= this.createAssistant(this.packageDirectory, this.modelDirectory);
    this.users++;
    let released = false;
    const run = <T>(operation: (assistant: RetrievalAssistant) => Promise<T>): Promise<T> => {
      if (released || this.closed) return Promise.reject(Error("Local retrieval session is closed."));
      const work = this.queue.catch(() => {}).then(async () => {
        if (released || this.closed) throw Error("Local retrieval session is closed.");
        const shared = this.shared ??= this.createAssistant(this.packageDirectory, this.modelDirectory);
        try { return await operation(shared); }
        catch (error) { if (this.shared === shared) this.shared = undefined; await shared.close?.(); throw error; }
      });
      this.queue = work.catch(() => {}); return work;
    };
    return {
      model: this.shared.model,
      plan: query => run(shared => shared.plan(query)),
      rank: (query, candidates) => run(shared => shared.rank(query, candidates)),
      close: async () => {
        if (released) return; released = true; this.users--;
        if (!this.users) {
          this.idle = setTimeout(() => { void this.queue.finally(async () => { if (!this.users) { const shared = this.shared; this.shared = undefined; await shared?.close?.(); } }); }, 30_000);
          this.idle.unref();
        }
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.idle); this.controller?.abort();
    await Promise.allSettled([this.shared?.close?.(), this.probe?.close?.()]); this.shared = undefined; this.probe = undefined;
    await this.installing;
  }
}

export { retrievalSetupDownloadBytes };
