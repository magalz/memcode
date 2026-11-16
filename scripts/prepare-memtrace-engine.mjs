// Release packaging only. The separately licensed compiled engine is staged as
// its original archive; no Memtrace source code or user configuration is copied.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Unzip, UnzipInflate } from 'fflate';
import { memcodeEngineBundleSchema } from '../runtime/managed-engine.ts';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const noticeName = /^(?:LICENSE(?:[-.].*)?|NOTICE|BETA-USAGE\.txt|THIRD-PARTY-NOTICES\.txt|ENGINE-PROVENANCE\.json)$/;

export function validateEnginePin(value, platform, arch) {
  const bundle = memcodeEngineBundleSchema.parse(value);
  if (bundle.platform !== platform || bundle.arch !== arch) throw Error('The reviewed engine pin targets a different platform.');
  const url = new URL(bundle.url);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !(url.hostname === 'downloads.memtrace.io' || /^d[a-z0-9]{10,}\.cloudfront\.net$/.test(url.hostname)) ||
      !url.pathname.startsWith('/releases/memtrace-engine/')) throw Error('The reviewed engine archive must use the official release service.');
  const names = new Set(bundle.files.map((file) => file.name));
  if (names.size !== bundle.files.length || bundle.files.reduce((sum, file) => sum + file.bytes, 0) > 750_000_000) throw Error('Duplicate or oversized reviewed engine files.');
  const suffix = platform === 'windows' ? '.exe' : '';
  for (const name of ['memtrace', 'memcore-server', 'memcortex-daemon', 'memcortex-mcp'])
    if (!names.has(name + suffix)) throw Error('The reviewed engine is missing a native component.');
  for (const name of ['LICENSE', 'NOTICE', 'BETA-USAGE.txt', 'LICENSE-MEMDB.txt', 'THIRD-PARTY-NOTICES.txt', 'ENGINE-PROVENANCE.json'])
    if (!names.has(name)) throw Error('The reviewed engine is missing its original licensing or provenance.');
  return bundle;
}

/** Hashes decompressed chunks and discards executable bytes immediately. */
export function verifyEngineArchive(archive, bundle) {
  if (archive.byteLength !== bundle.bytes || hash(archive) !== bundle.sha256) throw Error('Engine archive checksum failed; no installer will be built.');
  const expected = new Map(bundle.files.map((file) => [file.name, file]));
  const seen = new Set(), completed = new Set(), notices = new Map();
  const stream = new Unzip((file) => {
    const wanted = expected.get(file.name);
    if (!wanted || seen.has(file.name) || (file.originalSize !== undefined && file.originalSize !== wanted.bytes)) throw Error('Engine archive file inventory differs from the reviewed pin.');
    seen.add(file.name);
    const digest = createHash('sha256'), chunks = [];
    let bytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      bytes += chunk.byteLength;
      if (bytes > wanted.bytes) { file.terminate(); throw Error('Engine file exceeded its reviewed size.'); }
      digest.update(chunk);
      if (noticeName.test(file.name)) chunks.push(chunk.slice());
      if (final) {
        if (bytes !== wanted.bytes || digest.digest('hex') !== wanted.sha256) throw Error('Engine file checksum failed; no installer will be built.');
        completed.add(file.name);
        if (noticeName.test(file.name)) notices.set(file.name, Buffer.concat(chunks));
      }
    };
    file.start();
  });
  stream.register(UnzipInflate);
  // Bound each inflate push so even a highly compressed component is hashed in
  // chunks instead of materializing every decompressed native file at once.
  const step = 16_384;
  for (let offset = 0; offset < archive.byteLength; offset += step)
    stream.push(archive.subarray(offset, offset + step), offset + step >= archive.byteLength);
  if (completed.size !== expected.size) throw Error('Engine archive is missing reviewed files.');
  return notices;
}

async function digest(path) {
  const value = createHash('sha256');
  for await (const bytes of createReadStream(path)) value.update(bytes);
  return value.digest('hex');
}
async function validArchive(path, bundle) {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink() && info.size === bundle.bytes && await digest(path) === bundle.sha256; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function download(path, bundle, request) {
  const response = await request(bundle.url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body || (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== bundle.bytes)) throw Error('Could not download the reviewed Memtrace engine.');
  let bytes = 0;
  const digest = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.byteLength;
    if (bytes > bundle.bytes) return done(Error('Engine download exceeded its reviewed size.'));
    digest.update(chunk); done(null, chunk);
  } }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  if (bytes !== bundle.bytes || digest.digest('hex') !== bundle.sha256) throw Error('Engine download checksum failed; no installer will be built.');
}
async function realDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Engine packaging directory must be a real directory.');
}

export async function prepareMemtraceEngine(options = {}) {
  const base = resolve(options.root ?? root);
  const platform = (options.platform ?? process.env.MEMCODE_PACKAGE_PLATFORM ?? process.platform).replace(/^win32$/, 'windows').replace(/^darwin$/, 'macos');
  const arch = (options.arch ?? process.env.MEMCODE_PACKAGE_ARCH ?? process.arch).replace(/^x64$/, 'x86_64').replace(/^arm64$/, 'aarch64');
  const catalog = options.catalog ?? JSON.parse(await readFile(join(base, 'scripts/memtrace-engine.json'), 'utf8'));
  const bundle = validateEnginePin(catalog.bundles?.[`${platform}-${arch}`], platform, arch);
  const cache = join(base, '.memcode/engine-archive-cache'), output = join(base, 'dist-memtrace-engine');
  await realDirectory(cache);
  const archive = join(cache, `${bundle.sha256}.zip`);
  if (!await validArchive(archive, bundle)) {
    const temporary = join(cache, `download-${randomUUID()}.zip`);
    try {
      await download(temporary, bundle, options.fetch ?? fetch);
      try { await lstat(archive); await rename(archive, archive + `.invalid-${randomUUID()}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  const notices = verifyEngineArchive(await readFile(archive), bundle);
  const stage = await mkdtemp(join(cache, 'stage-'));
  try {
    await copyFile(archive, join(stage, 'engine.zip'));
    await writeFile(join(stage, 'memcode-engine.json'), JSON.stringify(bundle, null, 2) + '\n');
    await mkdir(join(stage, 'notices'));
    for (const [name, bytes] of notices) await writeFile(join(stage, 'notices', name), bytes, { flag: 'wx' });
    await writeFile(join(stage, 'provenance.json'), JSON.stringify({ engineVersion: bundle.engineVersion, id: bundle.id, platform, arch, archiveSha256: bundle.sha256, archiveBytes: bundle.bytes, verifiedFiles: bundle.files.length, separateLicense: true, sourceIncluded: false }, null, 2) + '\n');
    // This fixed generated output contains no source or local user data. Check
    // both the resolved boundary and symlink status before replacement.
    if (output !== join(base, 'dist-memtrace-engine') || !output.startsWith(base + sep)) throw Error('Refused unexpected engine resource output.');
    try { if ((await lstat(output)).isSymbolicLink()) throw Error('Engine output cannot be a symbolic link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(output, { recursive: true, force: true });
    await rename(stage, output);
  } finally {
    if (!stage.startsWith(cache + sep) || !stage.slice(cache.length + 1).startsWith('stage-')) throw Error('Refused unexpected engine staging cleanup.');
    await rm(stage, { recursive: true, force: true });
  }
  return { output, platform, arch, engineVersion: bundle.engineVersion, id: bundle.id, archiveSha256: bundle.sha256, archiveBytes: bundle.bytes, verifiedFiles: bundle.files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await prepareMemtraceEngine()));
