import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'scripts/desktop-node.json'), 'utf8'));
const platform = process.env.MEMCODE_PACKAGE_PLATFORM ?? process.platform;
const arch = process.env.MEMCODE_PACKAGE_ARCH ?? process.arch;
const entry = manifest.archives[`${platform}-${arch}`];
if (!entry) throw Error(`No reviewed desktop runtime for ${platform}-${arch}`);
const cache = join(root, '.memcode/desktop-runtime-cache');
const output = join(root, 'dist-desktop-runtime');
await mkdir(cache, { recursive: true }); await mkdir(output, { recursive: true });
const archive = join(cache, entry.file);
let bytes = await readFile(archive).catch(() => undefined);
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (!bytes || hash(bytes) !== entry.sha256) {
  const response = await fetch(`https://nodejs.org/dist/v${manifest.version}/${entry.file}`, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 150_000_000) throw Error('Could not download the reviewed Node runtime');
  bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 150_000_000 || hash(bytes) !== entry.sha256) throw Error('Desktop runtime checksum failed; no installer will be built');
  await writeFile(archive, bytes);
}
const prefix = entry.file.replace(/\.(zip|tar\.gz)$/, '');
const executable = platform === 'win32' ? 'node.exe' : 'node';
if (platform === 'win32') {
  const wanted = new Set([`${prefix}/node.exe`, `${prefix}/LICENSE`]);
  const files = unzipSync(bytes, { filter: (file) => wanted.has(file.name) });
  for (const name of wanted) {
    if (!files[name]) throw Error('Reviewed Node archive has an unexpected layout');
    await writeFile(join(output, name.endsWith('/LICENSE') ? 'NODE-LICENSE' : executable), files[name]);
  }
} else {
  execFileSync('tar', ['-xzf', archive, '-C', cache, `${prefix}/bin/node`, `${prefix}/LICENSE`], { windowsHide: true });
  await copyFile(join(cache, prefix, 'bin/node'), join(output, executable));
  await copyFile(join(cache, prefix, 'LICENSE'), join(output, 'NODE-LICENSE'));
  await chmod(join(output, executable), 0o755);
}
if (process.platform === platform && process.arch === arch) {
  const version = execFileSync(join(output, executable), ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (version !== `v${manifest.version}`) throw Error('Bundled Node version verification failed');
}
await writeFile(join(output, 'provenance.json'), JSON.stringify({ version: manifest.version, platform, arch, archive: entry.file, archiveSha256: entry.sha256, executableSha256: hash(await readFile(join(output, executable))), source: manifest.source }, null, 2) + '\n');
console.log(`Verified Node ${manifest.version} desktop runtime for ${platform}-${arch}.`);
