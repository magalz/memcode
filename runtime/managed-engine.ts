import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { Unzip, UnzipInflate } from 'fflate';
import { z } from 'zod';
import enginePins from '../scripts/memtrace-engine.json';

const filename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,120}$/).refine((value) => value !== '..');
const fileSchema = z.object({ name: filename, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(350_000_000) }).strict();
export const memcodeEngineBundleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/),
  engineVersion: z.string().min(1).max(100),
  purpose: z.literal('memcode-engine-beta'),
  platform: z.enum(['windows', 'macos', 'linux']),
  arch: z.enum(['x86_64', 'aarch64']),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(200_000_000),
  files: z.array(fileSchema).min(2).max(40),
}).strict();
export type MemcodeEngineBundle = z.infer<typeof memcodeEngineBundleSchema>;

function assetUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !(url.hostname === 'downloads.memtrace.io' || /^d[a-z0-9]{10,}\.cloudfront\.net$/.test(url.hostname)) ||
      !url.pathname.startsWith('/releases/memtrace-engine/')) throw Error('The beta engine download did not come from the official release service.');
  return url.href;
}
async function digest(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function digestBytes(bytes: Uint8Array) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    hash.update(bytes.subarray(offset, offset + 1024 * 1024));
    await yieldLoop();
  }
  return hash.digest('hex');
}
async function bounded(response: Response, limit: number) {
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit) throw Error('The MemCode beta engine is not available yet. Try again when its release is published.');
  const reader = response.body?.getReader(); if (!reader) throw Error('The release service returned an empty response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw Error('The beta engine download exceeded its declared size.'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
async function extractInto(bytes: Uint8Array, bundle: MemcodeEngineBundle, directory: string) {
  const expected = new Map(bundle.files.map((file) => [file.name, file]));
  if (expected.size !== bundle.files.length || bundle.files.reduce((sum, file) => sum + file.bytes, 0) > 750_000_000) throw Error('The beta engine manifest contains duplicate or oversized files.');
  const files = new Map<string, { opened: Promise<FileHandle>; writes: Promise<void>; received: number; finished: boolean; verified: boolean }>();
  const handles = new Set<FileHandle>();
  let failure: Error | undefined, pending: Promise<void>[] = [];
  const archive = new Unzip(file => {
    const match = expected.get(file.name);
    if (!match || file.originalSize !== match.bytes || files.has(file.name)) throw Error('The beta engine archive does not match its manifest.');
    const hash = createHash('sha256');
    const state = {
      opened: open(join(directory, file.name), 'wx', 0o600).then(handle => { handles.add(handle); return handle; }),
      writes: Promise.resolve(), received: 0, finished: false, verified: false,
    };
    files.set(file.name, state);
    void state.opened.catch(error => { failure ??= error; });
    file.ondata = (error, chunk, final) => {
      if (error) { failure ??= error; return; }
      if (state.finished || state.received + chunk.length > match.bytes) { failure ??= Error('The beta engine file exceeds its declared size.'); return; }
      state.received += chunk.length;
      state.finished = final;
      state.writes = state.writes.then(async () => {
        const handle = await state.opened;
        if (failure) return;
        // Hash/write bounded slices, with backpressure before feeding more ZIP
        // input. Never retain the complete uncompressed executable in memory.
        for (let offset = 0; offset < chunk.length; offset += 1024 * 1024) {
          const part = chunk.subarray(offset, offset + 1024 * 1024);
          hash.update(part);
          for (let written = 0; written < part.length;) {
            const result = await handle.write(part, written, part.length - written, null);
            if (!result.bytesWritten) throw Error('The beta engine file could not be written.');
            written += result.bytesWritten;
          }
        }
        if (final) {
          if (state.received !== match.bytes || hash.digest('hex') !== match.sha256) throw Error('The beta engine file integrity check failed. No engine was activated.');
          state.verified = true;
        }
      });
      pending.push(state.writes.catch(error => { failure ??= error; }));
    };
    file.start();
  });
  archive.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      archive.push(bytes.subarray(offset, offset + 16_384), offset + 16_384 >= bytes.length);
      await Promise.all(pending); pending = [];
      if (failure) throw failure;
      await yieldLoop();
    }
    if (files.size !== expected.size || [...files.values()].some(file => !file.finished || !file.verified)) throw Error('The beta engine archive is incomplete. No engine was activated.');
  } finally {
    // Includes opens/writes queued by a malformed final ZIP push. Settle all I/O
    // before closing files and letting the caller remove its private temp dir.
    await Promise.allSettled([...files.values()].map(async file => { await file.opened; await file.writes; }));
    await Promise.all([...handles].map(handle => handle.close()));
  }
}
export interface ManagedMemcodeEngineOptions {
  /** Immutable installer resources, resolved by the native host, never PATH. */
  bundledDirectory?: string;
  /** Test seams only. Production uses the reviewed pin compiled into this app. */
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  bundle?: unknown;
  progress?: (note: string) => void;
}

function manifestIdentity(bundle: MemcodeEngineBundle) {
  // Sorting permits only harmless JSON/file-order differences, not different bytes.
  return JSON.stringify({ ...bundle, files: [...bundle.files].sort((a, b) => a.name.localeCompare(b.name)) });
}

async function regularFile(path: string, maxBytes: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw Error('The local Memtrace engine resource is not a bounded regular file.');
  return info;
}

/** Installs the separately licensed engine into MemCode's private profile, never the global CLI. */
export class ManagedMemcodeEngine {
  private ready?: string;
  private preparing?: Promise<string>;
  private readonly directory: string;
  private readonly platform: string;
  private readonly arch: string;
  constructor(dataDirectory: string, private readonly options: ManagedMemcodeEngineOptions = {}) {
    this.directory = resolve(dataDirectory, 'engines');
    const platform = options.platform ?? process.platform;
    this.platform = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
    const arch = options.arch ?? process.arch; this.arch = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  }
  executable(): string {
    if (!this.ready) throw Error('Prepare the MemCode beta engine before connecting code context. The installed CLI has been left unchanged.');
    return this.ready;
  }
  prepare(): Promise<string> {
    if (this.ready) return Promise.resolve(this.ready);
    if (this.preparing) return this.preparing;
    const pending = this.install().finally(() => { if (this.preparing === pending) this.preparing = undefined; });
    this.preparing = pending; return pending;
  }
  private async verify(directory: string, bundle: MemcodeEngineBundle) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const names = await readdir(directory), expected = new Set([...bundle.files.map(file => file.name), 'memcode-engine.json']);
      if (names.length !== expected.size || names.some(name => !expected.has(name))) return false;
      await this.checkManifest(join(directory, 'memcode-engine.json'), bundle);
      for (const file of bundle.files) {
        const path = join(directory, file.name), info = await regularFile(path, file.bytes);
        if (info.size !== file.bytes || await digest(path) !== file.sha256) return false;
        if (process.platform !== 'win32' && ['memtrace', 'memcore-server', 'memcortex-daemon', 'memcortex-mcp'].includes(file.name) && !(info.mode & 0o100)) return false;
      }
      return true;
    } catch { return false; }
  }
  private async checkManifest(path: string, bundle: MemcodeEngineBundle) {
    await regularFile(path, 32_768);
    const local = memcodeEngineBundleSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (manifestIdentity(local) !== manifestIdentity(bundle)) throw Error('The local Memtrace engine does not match this MemCode release. No engine was activated.');
  }
  private async archive(bundle: MemcodeEngineBundle): Promise<Uint8Array> {
    const directory = this.options.bundledDirectory;
    if (directory) {
      let info;
      try { info = await lstat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (info) {
        // A damaged installed resource is not an invitation to trust another
        // manifest or silently choose an installed global CLI.
        if (!info.isDirectory() || info.isSymbolicLink()) throw Error('The bundled Memtrace engine directory is invalid. Reinstall MemCode.');
        await this.checkManifest(join(directory, 'memcode-engine.json'), bundle);
        const path = join(directory, 'engine.zip'), file = await regularFile(path, bundle.bytes);
        if (file.size !== bundle.bytes) throw Error('The bundled Memtrace engine archive size is invalid. Reinstall MemCode.');
        this.options.progress?.('Preparing the bundled Memtrace engine…');
        return readFile(path);
      }
    }
    // Source checkouts and older installations can recover the exact reviewed
    // engine. Never consult a moving online manifest before a usable local copy.
    this.options.progress?.('Downloading the separately licensed Memtrace beta engine…');
    return bounded(await (this.options.fetch ?? fetch)(assetUrl(bundle.url), { redirect: 'error', signal: AbortSignal.timeout(180_000) }), bundle.bytes);
  }
  private async install(): Promise<string> {
    if (!['windows', 'macos', 'linux'].includes(this.platform) || !['x86_64', 'aarch64'].includes(this.arch)) throw Error('A MemCode beta engine has not been published for this platform.');
    const pins = enginePins.bundles as Record<string, unknown>;
    const candidate = this.options.bundle ?? pins[`${this.platform}-${this.arch}`];
    if (!candidate) throw Error('A MemCode beta engine has not been published for this platform.');
    const bundle = memcodeEngineBundleSchema.parse(candidate);
    if (bundle.platform !== this.platform || bundle.arch !== this.arch) throw Error('The engine pin belongs to a different platform.');
    assetUrl(bundle.url);
    const executable = this.platform === 'windows' ? 'memtrace.exe' : 'memtrace';
    if (!bundle.files.some((file) => file.name === executable)) throw Error('The beta engine executable is missing from its manifest.');
    const names = new Set(bundle.files.map(file => file.name.toLowerCase()));
    if (names.size !== bundle.files.length || names.has('memcode-engine.json') || bundle.files.reduce((sum, file) => sum + file.bytes, 0) > 750_000_000) throw Error('The beta engine manifest contains duplicate or oversized files.');
    this.options.progress?.('Checking the local Memtrace engine…');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw Error('The private engine directory must not be a symbolic link.');
    const destination = join(this.directory, `${bundle.id}-${this.platform}-${this.arch}`);
    if (!await this.verify(destination, bundle)) {
      const archive = await this.archive(bundle);
      if (archive.length !== bundle.bytes || await digestBytes(archive) !== bundle.sha256) throw Error('The beta engine archive checksum failed. No engine was activated.');
      const temporary = join(this.directory, `.install-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        await extractInto(archive, bundle, temporary);
        for (const file of bundle.files) if (this.platform !== 'windows' && !/\.(txt|md|json)$/i.test(file.name) && !/^(LICENSE|NOTICE)/i.test(file.name)) await chmod(join(temporary, file.name), 0o700);
        await writeFile(join(temporary, 'memcode-engine.json'), JSON.stringify(bundle, null, 2), { flag: 'wx', mode: 0o600 });
        // Preserve an unexpected prior installation for diagnosis; never overwrite it.
        try { await lstat(destination); await rename(destination, destination + `.invalid-${Date.now()}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(temporary, destination);
      } finally {
        const target = resolve(temporary);
        if (!target.startsWith(this.directory + sep) || !/^\.install-[a-f0-9-]{36}$/.test(target.slice(this.directory.length + 1))) throw Error('Refused an unexpected engine cleanup path.');
        await rm(target, { recursive: true, force: true });
      }
    }
    this.ready = join(destination, executable);
    this.options.progress?.('MemCode beta engine is ready.');
    return this.ready;
  }
}
