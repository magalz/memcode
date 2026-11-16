// Runs on the installed Node binary, against the real production engine classes.
// It never fabricates an account, license, graph, watch or successful query.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ManagedMemcodeEngine } from '../../runtime/managed-engine';
import { MemtraceEngine } from '../../runtime/memtrace';
import { findCommand } from '../../runtime/commands';
import { createBetaAuthorization, verifyBetaAccess } from '../../runtime/beta-auth';
import { verifiedIndexRevision } from '../../runtime/memtrace-peer-index';
import type { Project } from '../../src/shared';

async function run() {
// The refresh grant belongs to this coordinator only. Clear it before even the
// version probe: no engine, Git or other tool subprocess may inherit it.
const rawGrant = process.env.MEMCODE_MAC_ENGINE_ACCEPTANCE_GRANT;
delete process.env.MEMCODE_MAC_ENGINE_ACCEPTANCE_GRANT;
const [resources, profile, output, mode] = process.argv.slice(2);
assert.ok(resources && profile && output, 'Provide packaged resources, private profile and output.');
const report: Record<string, any> = {
  passed: false,
  platform: process.platform,
  architecture: process.arch,
  mode,
  nativeMac: process.platform === 'darwin',
  freshPrivateHome: process.env.HOME === join(profile, 'home'),
  bundledNodeUsed: process.execPath === join(resources, 'desktop-runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  signInBrowserOnMacTested: false,
  nativeKeychainPersistenceTested: false,
  nativeProjectPickerTested: false,
  modelProviderStarted: false,
};
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
let stage = 'environment', networkRequests = 0, engine: MemtraceEngine | undefined;
let grant: { deviceId: string; sessionId: string; refreshToken: string } | undefined;
let refreshToken: string | undefined;
const authorization = createBetaAuthorization({ openExternal: async () => { throw Error('Unexpected browser authorization in CI'); } });
const proof = join(profile, 'engine-access.jwt');
try {
  assert.equal(report.freshPrivateHome, true);
  assert.equal(report.bundledNodeUsed, true);
  assert.equal(await findCommand('memtrace'), null, 'A global CLI must not be discoverable.');
  report.noGlobalMemtraceOnPath = true;
  report.noGlobalCredentials = true;
  const options = {
    bundledDirectory: join(resources, 'memtrace-engine'),
    fetch: (async () => { networkRequests++; throw Error('Engine download forbidden in packaged acceptance.'); }) as typeof fetch,
  };
  stage = 'offline-engine-prepare';
  const managed = new ManagedMemcodeEngine(join(profile, 'data'), options);
  const executable = await managed.prepare();
  assert.equal(executable.startsWith(resolve(profile, 'data', 'engines') + (process.platform === 'win32' ? '\\' : '/')), true);
  report.enginePreparedWithoutDownload = true;
  report.engineSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  report.engineVersion = execFileSync(executable, ['--version'], {
    env: process.env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().slice(0, 100);
  const cached = new ManagedMemcodeEngine(join(profile, 'data'), options);
  assert.equal(await cached.prepare(), executable);
  report.cachePreparedWithoutDownload = true;
  report.engineDownloadRequests = networkRequests;
  if (mode === 'prepare-only') {
    report.passed = true;
  } else {
    stage = 'real-account-refresh';
    assert.ok(rawGrant, 'A dedicated real browser-approved test grant is required.');
    grant = JSON.parse(rawGrant);
    assert.ok(grant && /^[A-Za-z0-9_-]{16,128}$/.test(grant.deviceId) && /^[A-Za-z0-9_-]{16,128}$/.test(grant.sessionId) && /^[A-Za-z0-9_-]{32,200}$/.test(grant.refreshToken));
    refreshToken = grant.refreshToken;
    const tokens = await authorization.refresh(refreshToken, grant);
    refreshToken = tokens.refresh_token;
    const access = await verifyBetaAccess(tokens.access_token, grant, { accountId: tokens.account.id });
    await writeFile(proof, tokens.access_token, { mode: 0o600, flag: 'wx' });
    report.realAccountGrantVerified = true;
    report.accountApprovalOrigin = 'dedicated-browser-approved-session';
    report.nativeMacTokenRefresh = process.platform === 'darwin';
    const authentication = {
      MEMCODE_ENGINE_ACCESS_FILE: proof,
      MEMCODE_ENGINE_DEVICE_ID: grant.deviceId,
      MEMCODE_ENGINE_SESSION_ID: grant.sessionId,
      MEMCORTEX_STORE_DIR: join(profile, 'cortex'),
      MEMTRACE_ENGINEER: access.account.id,
    };
    stage = 'fresh-project';
    const directory = join(profile, 'project');
    await mkdir(directory, { recursive: true });
    const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
    execFileSync(git, ['init', '-b', 'main', directory], { stdio: 'pipe' });
    await writeFile(join(directory, '.gitignore'), '.memcode/\n');
    await writeFile(join(directory, 'index.ts'), 'export function welcome(name: string): string { return `Hello ${name}`; }\nexport function total(values: number[]): number { return values.reduce((sum, value) => sum + value, 0); }\n');
    execFileSync(git, ['-C', directory, 'add', '.'], { stdio: 'pipe' });
    execFileSync(git, ['-C', directory, '-c', 'user.name=MemCode acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-m', 'Fresh project fixture'], { stdio: 'pipe' });
    const project: Project = { id: 'fresh-engine-acceptance', name: 'Fresh engine acceptance', description: 'Disposable native integration fixture', path: directory, branch: 'main', analysis: 'idle', createdAt: new Date().toISOString() };
    stage = 'actual-mcp-index';
    engine = new MemtraceEngine(() => managed.executable(), {
      privateProject: () => true,
      environment: async () => authentication,
    });
    project.repoId = await engine.analyze(project, () => {});
    const scope = engine.scopeFor(project.id);
    assert.equal(scope?.mode, 'project');
    assert.equal(scope?.dataDirectory, join(directory, '.memcode', 'memtrace', '.memdb'));
    const indexed = await engine.call(project, 'find_symbol', { repo_id: project.repoId, branch: project.branch, name: 'welcome', limit: 5 });
    assert.equal(indexed.found, true);
    assert.ok(indexed.count > 0);
    const revision = await engine.call(project, 'get_query_revision', { repo_id: project.repoId, branch: project.branch });
    assert.equal(verifiedIndexRevision(revision, project, project.repoId), true);
    report.realProjectIndexed = true;
    report.privateProjectGraphAligned = true;
    report.indexedSymbolRetrieved = true;
    stage = 'actual-mcp-watch';
    const watch = await engine.watch(project);
    assert.equal(watch?.state, 'watching');
    report.nativeWatchStarted = true;
    await writeFile(join(directory, 'index.ts'), 'export function welcome(name: string): string { return `Hello ${name}`; }\nexport function total(values: number[]): number { return values.reduce((sum, value) => sum + value, 0); }\nexport function savedAfterIndex(value: number): number { return value * 2; }\n');
    const deadline = Date.now() + 180000;
    let saved = false;
    while (Date.now() < deadline) {
      await pause(1500);
      const result = await engine.call(project, 'find_symbol', { repo_id: project.repoId, branch: project.branch, name: 'savedAfterIndex', limit: 5 });
      if (!result.found || !result.count) continue;
      const revision = await engine.call(project, 'get_query_revision', { repo_id: project.repoId, branch: project.branch });
      if (verifiedIndexRevision(revision, project, project.repoId)) { saved = true; break; }
    }
    assert.equal(saved, true, 'The real watch must publish the edited symbol and aligned revision.');
    report.savedEditIndexedWithoutReindex = true;
    report.engineDownloadRequests = networkRequests;
    assert.equal(networkRequests, 0);
    report.passed = true;
  }
} catch (error) {
  // Never upload raw native stderr or service responses: these can contain
  // credentials or account metadata. The stage is enough for the CI gate.
  report.failedStage = stage;
  report.failureType = error instanceof assert.AssertionError ? 'assertion' : 'operation-failed';
  report.passed = false;
  process.exitCode = 1;
} finally {
  await engine?.close().catch(() => { report.engineCleanupFailed = true; process.exitCode = 1; report.passed = false; });
  if (grant && refreshToken) {
    try { await authorization.revoke(refreshToken, grant); report.testGrantRevoked = true; }
    catch { report.testGrantRevoked = false; report.passed = false; process.exitCode = 1; }
  }
  await rm(proof, { force: true });
  report.checkedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
}
void run().catch(() => { console.error('Bundled engine acceptance could not initialize.'); process.exitCode = 1; });
