import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { unzip } from 'fflate';
import { z } from 'zod';

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
async function bounded(response: Response, limit: number) {
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit) throw Error('The MemCode beta engine is not available yet. Try again when its release is published.');
  const reader = response.body?.getReader(); if (!reader) throw Error('The release service returned an empty response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) throw Error('The beta engine download exceeded its declared size.'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
async function extracted(bytes: Uint8Array, bundle: MemcodeEngineBundle) {
  const expected = new Map(bundle.files.map((file) => [file.name, file]));
  if (expected.size !== bundle.files.length || bundle.files.reduce((sum, file) => sum + file.bytes, 0) > 750_000_000) throw Error('The beta engine manifest contains duplicate or oversized files.');
  let invalid = false;
  const files = await new Promise<Record<string, Uint8Array>>((resolveFiles, reject) => unzip(bytes, { filter: (file) => {
    const match = expected.get(file.name);
    if (!match || file.originalSize !== match.bytes) { invalid = true; return false; }
    return true;
  } }, (error, result) => error ? reject(error) : resolveFiles(result)));
  if (invalid || Object.keys(files).length !== expected.size) throw Error('The beta engine archive does not match its manifest.');
  for (const file of bundle.files) {
    if (!files[file.name] || files[file.name].byteLength !== file.bytes || createHash('sha256').update(files[file.name]).digest('hex') !== file.sha256) throw Error('The beta engine file integrity check failed. No engine was activated.');
  }
  return files;
}
export interface ManagedMemcodeEngineOptions {
  /** A test seam only. Production calls the fixed official service over HTTPS. */
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  progress?: (note: string) => void;
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
      if ((await lstat(directory)).isSymbolicLink()) return false;
      for (const file of bundle.files) { const path = join(directory, file.name), info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await digest(path) !== file.sha256) return false; }
      return true;
    } catch { return false; }
  }
  private async install(): Promise<string> {
    if (!['windows', 'macos', 'linux'].includes(this.platform) || !['x86_64', 'aarch64'].includes(this.arch)) throw Error('A MemCode beta engine has not been published for this platform.');
    const request = this.options.fetch ?? fetch;
    this.options.progress?.('Checking the MemCode beta engine…');
    const body = await bounded(await request(`https://www.memtrace.io/api/memcode/engine/${this.platform}/${this.arch}`, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json' } }), 32_768);
    const envelope = JSON.parse(body.toString('utf8'));
    const bundle = memcodeEngineBundleSchema.parse(envelope.bundle);
    if (bundle.platform !== this.platform || bundle.arch !== this.arch) throw Error('The release service returned the wrong engine platform.');
    const url = assetUrl(bundle.url), executable = this.platform === 'windows' ? 'memtrace.exe' : 'memtrace';
    if (!bundle.files.some((file) => file.name === executable)) throw Error('The beta engine executable is missing from its manifest.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw Error('The private engine directory must not be a symbolic link.');
    const destination = join(this.directory, `${bundle.id}-${this.platform}-${this.arch}`);
    if (!await this.verify(destination, bundle)) {
      this.options.progress?.('Downloading the separately licensed Memtrace beta engine…');
      const archive = await bounded(await request(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) }), bundle.bytes);
      if (archive.length !== bundle.bytes || createHash('sha256').update(archive).digest('hex') !== bundle.sha256) throw Error('The beta engine archive checksum failed. No engine was activated.');
      const files = await extracted(archive, bundle), temporary = join(this.directory, `.install-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        for (const file of bundle.files) { const path = join(temporary, file.name); await writeFile(path, files[file.name], { flag: 'wx', mode: 0o600 }); if (this.platform !== 'windows' && !/\.(txt|md|json)$/i.test(file.name) && !/^(LICENSE|NOTICE)/i.test(file.name)) await chmod(path, 0o700); }
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
