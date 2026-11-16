import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { ManagedMemcodeEngine, type MemcodeEngineBundle } from '../runtime/managed-engine';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = (platform: 'windows' | 'macos' = 'windows') => {
  const files = { [platform === 'windows' ? 'memtrace.exe' : 'memtrace']: strToU8('synthetic executable: never run'), 'LICENSE.txt': strToU8('Synthetic separate engine license') };
  const archive = zipSync(files);
  const bundle: MemcodeEngineBundle = { id: 'synthetic-1', engineVersion: 'synthetic', purpose: 'memcode-engine-beta', platform, arch: platform === 'windows' ? 'x86_64' : 'aarch64', url: 'https://d1234567890abcd.cloudfront.net/releases/memtrace-engine/synthetic.zip', sha256: sha(archive), bytes: archive.length, files: Object.entries(files).map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.length })) };
  return { archive, bundle };
};
const offline = (async () => { throw Error('Network must not be contacted'); }) as typeof fetch;
async function resources(directory: string, data: ReturnType<typeof fixture>) {
  const path = join(directory, 'resources', 'memtrace-engine');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'memcode-engine.json'), JSON.stringify(data.bundle));
  await writeFile(join(path, 'engine.zip'), data.archive);
  return path;
}

test('a downloaded private engine starts cache-first across new managers with no manifest request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
  try {
    const { archive, bundle } = fixture(); let downloads = 0;
    const request = (async (url: string | URL | Request) => { assert.equal(String(url), bundle.url); downloads++; return new Response(archive); }) as typeof fetch;
    const create = (fetcher = request) => new ManagedMemcodeEngine(directory, { platform: 'win32', arch: 'x64', bundle, fetch: fetcher });
    const engine = create(); assert.throws(() => engine.executable());
    const [a, b] = await Promise.all([engine.prepare(), engine.prepare()]); assert.equal(a, b); assert.equal(downloads, 1);
    assert.match(a, /engines[\\/]synthetic-1-windows-x86_64[\\/]memtrace.exe$/);
    assert.equal(await readFile(a, 'utf8'), 'synthetic executable: never run');
    assert.equal(await create(offline).prepare(), a);
    await writeFile(a, 'tampered'); await create().prepare(); assert.equal(downloads, 2);
    assert.ok((await readdir(join(directory, 'engines'))).some(name => name.includes('.invalid-')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fresh Windows and Mac profiles unpack the pinned installer engine offline without touching the global CLI', async () => {
  for (const platform of ['windows', 'macos'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
    try {
      const data = fixture(platform), bundledDirectory = await resources(directory, data);
      const globalDirectory = join(directory, 'global-cli'); await mkdir(globalDirectory);
      const globalFile = join(globalDirectory, platform === 'windows' ? 'memtrace.exe' : 'memtrace');
      await writeFile(globalFile, 'existing user CLI remains untouched');
      const options = { platform: platform === 'windows' ? 'win32' as const : 'darwin' as const, arch: platform === 'windows' ? 'x64' : 'arm64', bundle: data.bundle, bundledDirectory, fetch: offline };
      const profile = join(directory, 'private-profile'), engine = new ManagedMemcodeEngine(profile, options);
      const executable = await engine.prepare();
      assert.ok(executable.startsWith(join(profile, 'engines')));
      assert.equal(await readFile(executable, 'utf8'), 'synthetic executable: never run');
      assert.equal(await readFile(globalFile, 'utf8'), 'existing user CLI remains untouched');
      // A new manager must reuse valid cache even without installer resources.
      await rm(bundledDirectory, { recursive: true });
      assert.equal(await new ManagedMemcodeEngine(profile, options).prepare(), executable);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('a restarted runtime process reuses its engine with empty PATH and network disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
  try {
    const data = fixture(), bundledDirectory = await resources(directory, data), profile = join(directory, 'profile');
    const executable = await new ManagedMemcodeEngine(profile, { platform: 'win32', arch: 'x64', bundle: data.bundle, bundledDirectory, fetch: offline }).prepare();
    await rm(bundledDirectory, { recursive: true });
    const manifestPath = join(profile, 'engines', 'synthetic-1-windows-x86_64', 'memcode-engine.json');
    const code = `import { readFile } from 'node:fs/promises';
      import { ManagedMemcodeEngine } from './runtime/managed-engine.ts';
      const bundle = JSON.parse(await readFile(process.argv[2], 'utf8'));
      const engine = new ManagedMemcodeEngine(process.argv[1], { platform:'win32', arch:'x64', bundle,
        fetch: async () => { throw Error('Offline restart must never fetch'); } });
      process.stdout.write(JSON.stringify({executable:await engine.prepare(),path:process.env.PATH}));`;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, profile, manifestPath], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
      env: { ...process.env, PATH: '' }, timeout: 15_000,
    });
    assert.deepEqual(JSON.parse(result.stdout), { executable, path: '' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('tampered cache manifests, payloads and unexpected loadable files cannot become a trusted offline engine', async () => {
  for (const mode of ['manifest', 'payload', 'extra']) {
    const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
    try {
      const data = fixture(), bundledDirectory = await resources(directory, data);
      const options = { platform: 'win32' as const, arch: 'x64', bundle: data.bundle, bundledDirectory, fetch: offline };
      const profile = join(directory, 'profile');
      const executable = await new ManagedMemcodeEngine(profile, options).prepare();
      const cache = join(profile, 'engines', 'synthetic-1-windows-x86_64');
      if (mode === 'manifest') await writeFile(join(cache, 'memcode-engine.json'), JSON.stringify({ ...data.bundle, id: 'arbitrary-unreviewed-version' }));
      if (mode === 'payload') await writeFile(executable, 'tampered');
      if (mode === 'extra') await writeFile(join(cache, 'unreviewed.dll'), 'must never be loaded');
      await rm(bundledDirectory, { recursive: true });
      const engine = new ManagedMemcodeEngine(profile, options);
      await assert.rejects(engine.prepare(), /Network must not be contacted/);
      assert.throws(() => engine.executable());
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('damaged bundled archives, mismatched manifests and wrong platforms fail closed without online fallback', async () => {
  for (const mode of ['checksum', 'manifest', 'platform', 'missing-file']) {
    const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
    try {
      const data = fixture(), bundledDirectory = await resources(directory, data);
      if (mode === 'checksum') { const corrupt = Buffer.from(data.archive); corrupt[0] ^= 1; await writeFile(join(bundledDirectory, 'engine.zip'), corrupt); }
      if (mode === 'manifest') await writeFile(join(bundledDirectory, 'memcode-engine.json'), JSON.stringify({ ...data.bundle, engineVersion: 'different' }));
      if (mode === 'missing-file') await rm(join(bundledDirectory, 'engine.zip'));
      const engine = new ManagedMemcodeEngine(join(directory, 'profile'), { platform: mode === 'platform' ? 'darwin' : 'win32', arch: 'x64', bundle: data.bundle, bundledDirectory, fetch: offline });
      await assert.rejects(engine.prepare(), (error: unknown) => error instanceof Error && !error.message.includes('Network must not be contacted'));
      assert.throws(() => engine.executable());
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('no release, mismatched checksum, untrusted host and zip traversal fail closed', async () => {
  for (const mode of ['missing', 'checksum', 'host', 'path', 'extra-zip', 'case-collision', 'file-checksum', 'partial-zip', 'missing-entry']) {
    const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
    try {
      const { archive: original, bundle } = fixture(); let archive = original;
      if (mode === 'checksum') bundle.sha256 = 'a'.repeat(64);
      if (mode === 'host') bundle.url = 'https://attacker.example/releases/memtrace-engine/app.zip';
      if (mode === 'path') bundle.files[0].name = '../escape.exe';
      if (mode === 'case-collision') bundle.files.push({ ...bundle.files[0], name: 'MEMTRACE.EXE' });
      if (mode === 'extra-zip') {
        archive = zipSync({ 'memtrace.exe': strToU8('synthetic executable: never run'), 'LICENSE.txt': strToU8('Synthetic separate engine license'), '../escape.exe': strToU8('no') });
        bundle.bytes = archive.length; bundle.sha256 = sha(archive);
      }
      if (mode === 'file-checksum') archive = zipSync({ 'memtrace.exe': strToU8('Synthetic executable: never run'), 'LICENSE.txt': strToU8('Synthetic separate engine license') });
      if (mode === 'partial-zip') archive = original.subarray(0, Math.floor(original.length / 2));
      if (mode === 'missing-entry') archive = zipSync({ 'memtrace.exe': strToU8('synthetic executable: never run') });
      if (['file-checksum', 'partial-zip', 'missing-entry'].includes(mode)) { bundle.bytes = archive.length; bundle.sha256 = sha(archive); }
      const fetcher = (async () => mode === 'missing' ? new Response(null, { status: 503 }) : new Response(archive)) as typeof fetch;
      const engine = new ManagedMemcodeEngine(directory, { platform: 'win32', arch: 'x64', bundle, fetch: fetcher });
      await assert.rejects(engine.prepare()); assert.throws(() => engine.executable());
      const inventory = await readdir(join(directory, 'engines')).catch(() => []);
      assert.deepEqual(inventory, [], 'a failed streamed extraction must close its files, remove temporary output and never activate the engine');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
