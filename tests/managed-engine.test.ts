import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { ManagedMemcodeEngine } from '../runtime/managed-engine';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = () => {
  const files = { 'memtrace.exe': strToU8('synthetic executable: never run'), 'LICENSE.txt': strToU8('Synthetic separate engine license') };
  const archive = zipSync(files);
  return { archive, bundle: { id: 'synthetic-1', engineVersion: 'synthetic', purpose: 'memcode-engine-beta', platform: 'windows', arch: 'x86_64', url: 'https://d1234567890abcd.cloudfront.net/releases/memtrace-engine/synthetic.zip', sha256: sha(archive), bytes: archive.length, files: Object.entries(files).map(([name, bytes]) => ({ name, sha256: sha(bytes), bytes: bytes.length })) } };
};
test('managed beta engine verifies archive and each file, then reuses a checked private install', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
  try {
    const { archive, bundle } = fixture(); let downloads = 0;
    const request = (async (url: string | URL | Request) => String(url).includes('/api/') ? Response.json({ bundle }) : (downloads++, new Response(archive))) as typeof fetch;
    const create = () => new ManagedMemcodeEngine(directory, { platform: 'win32', arch: 'x64', fetch: request });
    const engine = create(); assert.throws(() => engine.executable());
    const [a, b] = await Promise.all([engine.prepare(), engine.prepare()]); assert.equal(a, b); assert.equal(downloads, 1);
    assert.match(a, /engines[\\/]synthetic-1-windows-x86_64[\\/]memtrace.exe$/);
    assert.equal(await readFile(a, 'utf8'), 'synthetic executable: never run');
    await create().prepare(); assert.equal(downloads, 1);
    await writeFile(a, 'tampered'); await create().prepare(); assert.equal(downloads, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('no release, mismatched archive, untrusted host and zip traversal all fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memcode-engine-test-'));
  try {
    for (const mode of ['missing', 'checksum', 'host', 'path']) {
      const { archive, bundle } = fixture();
      if (mode === 'checksum') bundle.sha256 = 'a'.repeat(64);
      if (mode === 'host') bundle.url = 'https://attacker.example/releases/memtrace-engine/app.zip';
      if (mode === 'path') bundle.files[0].name = '../escape.exe';
      const fetcher = (async (url: any) => String(url).includes('/api/') ? mode === 'missing' ? new Response(null, { status: 503 }) : Response.json({ bundle }) : new Response(archive)) as typeof fetch;
      const engine = new ManagedMemcodeEngine(directory, { platform: 'win32', arch: 'x64', fetch: fetcher });
      await assert.rejects(engine.prepare()); assert.throws(() => engine.executable());
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
