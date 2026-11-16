import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { prepareMemtraceEngine, validateEnginePin, verifyEngineArchive } from '../scripts/prepare-memtrace-engine.mjs';
import type { MemcodeEngineBundle } from '../runtime/managed-engine';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(extra = false) {
  const files = Object.fromEntries(['memtrace.exe', 'memcore-server.exe', 'memcortex-daemon.exe', 'memcortex-mcp.exe', 'LICENSE', 'NOTICE', 'BETA-USAGE.txt', 'LICENSE-MEMDB.txt', 'THIRD-PARTY-NOTICES.txt', 'ENGINE-PROVENANCE.json'].map((name) => [name, strToU8(`synthetic ${name}; never executed`)]));
  const archive = zipSync(extra ? { ...files, 'unexpected.txt': strToU8('unexpected') } : files);
  const bundle: MemcodeEngineBundle = { id: 'fixture-1', engineVersion: 'synthetic', purpose: 'memcode-engine-beta', platform: 'windows', arch: 'x86_64', url: 'https://d1234567890abcd.cloudfront.net/releases/memtrace-engine/fixture.zip', sha256: sha(archive), bytes: archive.length, files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) })) };
  return { files, archive, bundle, catalog: { bundles: { 'windows-x86_64': bundle } } };
}

test('installer stages original pinned archive and licensing, then builds from the verified cache with no network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memcode-engine-package-'));
  try {
    const { archive, bundle, files, catalog } = fixture();
    let downloads = 0;
    const request = (async () => { downloads++; return new Response(archive); }) as typeof fetch;
    const first = await prepareMemtraceEngine({ root, platform: 'win32', arch: 'x64', catalog, fetch: request });
    assert.equal(downloads, 1); assert.equal(first.verifiedFiles, bundle.files.length);
    assert.deepEqual(JSON.parse(await readFile(join(first.output, 'memcode-engine.json'), 'utf8')), bundle);
    assert.equal(sha(await readFile(join(first.output, 'engine.zip'))), bundle.sha256);
    assert.equal(await readFile(join(first.output, 'notices/LICENSE'), 'utf8'), Buffer.from(files.LICENSE).toString());
    const provenance = JSON.parse(await readFile(join(first.output, 'provenance.json'), 'utf8'));
    assert.equal(provenance.separateLicense, true); assert.equal(provenance.sourceIncluded, false);
    await writeFile(join(first.output, 'stale-file.txt'), 'old generated file');
    await prepareMemtraceEngine({ root, platform: 'win32', arch: 'x64', catalog, fetch: (async () => { throw Error('network must not be used'); }) as typeof fetch });
    await assert.rejects(access(join(first.output, 'stale-file.txt')));
    assert.equal(downloads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer rejects platform, host, duplicate names, missing license and incomplete native inventory', () => {
  const { bundle } = fixture();
  assert.equal(validateEnginePin(bundle, 'windows', 'x86_64').id, bundle.id);
  assert.throws(() => validateEnginePin(bundle, 'macos', 'aarch64'));
  for (const url of ['https://evil.example/releases/memtrace-engine/x.zip', bundle.url + '?signature=unreviewed', bundle.url.replace('https:', 'http:')])
    assert.throws(() => validateEnginePin({ ...bundle, url }, 'windows', 'x86_64'));
  assert.throws(() => validateEnginePin({ ...bundle, files: [...bundle.files, bundle.files[0]] }, 'windows', 'x86_64'));
  for (const name of ['LICENSE', 'memcortex-mcp.exe'])
    assert.throws(() => validateEnginePin({ ...bundle, files: bundle.files.filter((file) => file.name !== name) }, 'windows', 'x86_64'));
  assert.throws(() => validateEnginePin({ ...bundle, files: [{ ...bundle.files[0], name: '../escape.exe' }, ...bundle.files.slice(1)] }, 'windows', 'x86_64'));
});

test('archive verification rejects digest tampering, file-level changes, unknown files and declared-size mismatch', () => {
  const { archive, bundle } = fixture();
  assert.ok(verifyEngineArchive(archive, bundle).has('LICENSE'));
  assert.throws(() => verifyEngineArchive(archive, { ...bundle, sha256: 'f'.repeat(64) }));
  assert.throws(() => verifyEngineArchive(archive, { ...bundle, files: [{ ...bundle.files[0], sha256: 'f'.repeat(64) }, ...bundle.files.slice(1)] }));
  assert.throws(() => verifyEngineArchive(archive, { ...bundle, files: [{ ...bundle.files[0], bytes: bundle.files[0].bytes + 1 }, ...bundle.files.slice(1)] }));
  const extra = fixture(true);
  assert.throws(() => verifyEngineArchive(extra.archive, extra.bundle));
});

test('a rejected engine download cannot produce installer engine resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memcode-engine-package-'));
  try {
    const { catalog } = fixture();
    await assert.rejects(prepareMemtraceEngine({ root, platform: 'win32', arch: 'x64', catalog, fetch: (async () => new Response('bad content')) as typeof fetch }));
    await assert.rejects(access(join(root, 'dist-memtrace-engine')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
