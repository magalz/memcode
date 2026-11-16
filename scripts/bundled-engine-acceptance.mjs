// The helper is compiled from the reviewed production runtime, then executed
// with the Node actually shipped inside the completed installer application.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Keep the one-time refresh grant out of esbuild, where.exe, tar, hdiutil and
// every other child. Only the isolated acceptance coordinator receives it.
const rawGrant = process.env.MEMCODE_MAC_ENGINE_ACCEPTANCE_GRANT;
delete process.env.MEMCODE_MAC_ENGINE_ACCEPTANCE_GRANT;
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const resources = resolve(option('--resources') ?? join(root, 'src-tauri/target/release/bundle/macos/MemCode.app/Contents/Resources'));
const mode = process.argv.includes('--prepare-only') ? 'prepare-only' : 'real-account-index-watch';
const output = resolve(option('--output') ?? join(root, `release/bundled-engine-${process.platform}-${mode}.json`));
const profile = await mkdtemp(join(tmpdir(), 'memcode-bundled-engine-'));
await mkdir(join(profile, 'home'), { recursive: true, mode: 0o700 });
await mkdir(join(root, 'release'), { recursive: true });
const helper = join(profile, 'acceptance.cjs');
await build({ entryPoints: [join(root, 'scripts/fixtures/bundled-engine-acceptance.ts')], outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['playwright-core'], logLevel: 'silent' });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:MEMCODE_|MEMTRACE_|MEMDB_|MEMCORTEX_|CORTEX_|NODE_|APPLE_|ANTHROPIC_|OPENAI_|CLAUDE_|CURSOR_|TAURI_SIGNING_|CODEX_)/i.test(key)));
Object.assign(env, {
  HOME: join(profile, 'home'), USERPROFILE: join(profile, 'home'),
  XDG_CONFIG_HOME: join(profile, 'home', '.config'),
  XDG_CACHE_HOME: join(profile, 'home', '.cache'),
  MEMTRACE_MEMDB_SIDECAR_STARTUP_SECS: '180',
});
if (process.platform === 'darwin') env.PATH = '/usr/bin:/bin';
if (process.platform === 'win32') {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const git = execFileSync(join(systemRoot, 'System32/where.exe'), ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  assert.ok(git && !/[\r\n]/.test(git), 'A real Git installation is required for the disposable project fixture.');
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [join(systemRoot, 'System32'), systemRoot, dirname(git)].join(';');
  env.APPDATA = join(profile, 'home/AppData/Roaming');
  env.LOCALAPPDATA = join(profile, 'home/AppData/Local');
  await mkdir(env.APPDATA, { recursive: true });
  await mkdir(env.LOCALAPPDATA, { recursive: true });
}
if (mode !== 'prepare-only') {
  assert.ok(rawGrant, 'Set a dedicated browser-approved CI test grant for the authenticated run.');
  env.MEMCODE_MAC_ENGINE_ACCEPTANCE_GRANT = rawGrant;
}
const node = join(resources, 'desktop-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const runHelper = helperOutput => new Promise((done, reject) => {
  const child = spawn(node, [helper, resources, profile, helperOutput, mode], { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const timeout = setTimeout(() => { child.kill('SIGTERM'); }, mode === 'prepare-only' ? 120000 : 1200000);
  // Drain but never retain or upload raw engine/account output.
  for (const stream of [child.stdout, child.stderr]) stream.on('data', () => {});
  child.once('error', reject);
  child.once('close', value => { clearTimeout(timeout); done(value ?? 1); });
});
const code = await runHelper(output);
let report;
try { report = JSON.parse(await readFile(output, 'utf8')); }
catch { report = { passed: false, mode, failedStage: 'helper-process', nativeMac: process.platform === 'darwin' }; await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
assert.equal(code, 0, 'The real bundled engine acceptance helper failed; inspect its content-free failedStage.');
assert.equal(report.passed, true);
if (mode === 'prepare-only') {
  const repeatOutput = join(profile, 'repeat.json');
  assert.equal(await runHelper(repeatOutput), 0);
  const repeated = JSON.parse(await readFile(repeatOutput, 'utf8'));
  assert.equal(repeated.passed, true);
  assert.equal(repeated.engineDownloadRequests, 0);
  assert.equal(repeated.engineSha256, report.engineSha256);
  report.offlineCacheAcrossProcesses = true;
  if (process.platform === 'darwin' && !option('--resources')) {
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const manifestBytes = await readFile(join(resources, 'memtrace-engine/memcode-engine.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const archiveHash = sha(await readFile(join(resources, 'memtrace-engine/engine.zip')));
    assert.equal(archiveHash, manifest.sha256);
    const samePayload = async directory => {
      assert.equal(sha(await readFile(join(directory, 'memtrace-engine/memcode-engine.json'))), sha(manifestBytes));
      assert.equal(sha(await readFile(join(directory, 'memtrace-engine/engine.zip'))), archiveHash);
    };
    const bundles = join(root, 'src-tauri/target/release/bundle');
    const updaterNames = (await readdir(join(bundles, 'macos'))).filter(name => name.endsWith('.app.tar.gz'));
    const dmgNames = (await readdir(join(bundles, 'dmg'))).filter(name => name.endsWith('.dmg'));
    assert.equal(updaterNames.length, 1);
    assert.equal(dmgNames.length, 1);
    const unpacked = join(profile, 'updater');
    await mkdir(unpacked);
    const updater = join(bundles, 'macos', updaterNames[0]);
    const members = execFileSync('/usr/bin/tar', ['-tzf', updater], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n').filter(Boolean);
    assert.ok(members.every(name => name.startsWith('MemCode.app/') && !name.split('/').includes('..') && !name.startsWith('/')));
    execFileSync('/usr/bin/tar', ['-xzf', updater, '-C', unpacked], { stdio: 'pipe' });
    await samePayload(join(unpacked, 'MemCode.app/Contents/Resources'));
    const mount = join(profile, 'dmg');
    await mkdir(mount);
    let mounted = false;
    try {
      execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, join(bundles, 'dmg', dmgNames[0])], { stdio: 'pipe', timeout: 30000 });
      mounted = true;
      await samePayload(join(mount, 'MemCode.app/Contents/Resources'));
    } finally {
      if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe', timeout: 30000 });
      await rm(unpacked, { recursive: true, force: true });
    }
    const minimums = [];
    const directory = join(profile, 'data/engines', `${manifest.id}-${manifest.platform}-${manifest.arch}`);
    for (const file of manifest.files) {
      const path = join(directory, file.name), handle = await open(path, 'r');
      const header = Buffer.alloc(4);
      try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
      if (!['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) continue;
      const load = execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      const minimum = load.match(/cmd LC_BUILD_VERSION[\s\S]*?\bminos\s+([\d.]+)/)?.[1] ?? load.match(/cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+([\d.]+)/)?.[1];
      assert.ok(minimum, 'Every bundled engine Mach-O must declare its minimum macOS.');
      minimums.push({ name: file.name, minimum });
    }
    assert.ok(minimums.length >= 4, 'The real four native engine executables must be inspected.');
    const configured = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).bundle.macOS.minimumSystemVersion;
    const compare = (left, right) => { const a = left.split('.').map(Number), b = right.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
    for (const value of minimums) assert.ok(compare(configured, value.minimum) >= 0, 'The declared macOS support must include the engine minimum.');
    report.packagedCopiesVerified = { application: true, updater: true, dmg: true };
    report.engineArchiveSha256 = archiveHash;
    report.engineMachOMinimums = minimums;
    report.configuredMacOSMinimum = configured;
    report.engineAppleTrust = 'original release bytes preserved; notarization not established by this test';
  }
}
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
