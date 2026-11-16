// Read-only protocol diagnosis for the exact packaged engine. No account grant,
// auth bypass, memtrace start, index call or source retrieval is used here.
import assert from 'node:assert/strict';
import { ChildProcess, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ManagedMemcodeEngine } from '../runtime/managed-engine';
import { projectMcpWorkspace } from '../runtime/memtrace-workspace';
import { appVersion } from '../src/version';

type Json = Record<string, any>;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'release/macos-engine-admission-probe.json');
const normalize = (value: string) => value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const pathClass = (value: unknown) => typeof value !== 'string' ? 'missing' : value.startsWith('/private/var/') ? 'posix-private-var' : value.startsWith('/var/') ? 'posix-var' : value.startsWith('\\\\?\\') ? 'windows-extended' : /^[A-Za-z]:[\\/]/.test(value) ? 'windows' : value.startsWith('/') ? 'posix-other' : 'relative-or-other';
const keys = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(key)).slice(0, 60) : [];
const category = (value: string) => /license|credentials|auth login|sign.in|beta access|not authenticated/i.test(value) ? 'auth-refused' : /no workspace owner|attaches when memtrace start|ClientPending/i.test(value) ? 'owner-not-started' : /scope|membership|workspace.*include/i.test(value) ? 'scope-admission' : /timeout|timed out|deadline/i.test(value) ? 'operation-timeout' : /connection closed|not connected/i.test(value) ? 'connection-closed' : 'unclassified-operation';
const bounded = async <T>(pending: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Probe operation deadline')), ms); })]); }
  finally { clearTimeout(timer); }
};
const jsonBlocks = (result: Json): { index: number; value: any }[] => (result.content ?? []).flatMap((entry: Json, index: number) => {
  if (entry.type !== 'text') return [];
  try { return [{ index, value: JSON.parse(entry.text) }]; } catch { return []; }
});
const rowsOf = (value: any): Json[] => Array.isArray(value) ? value : Array.isArray(value?.repos) ? value.repos : Array.isArray(value?.repositories) ? value.repositories : [];
const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : '[other-id-format]';

async function run() {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'memcode-admission-probe-')));
  const home = join(profile, 'home'), directory = join(profile, 'project');
  await mkdir(home); await mkdir(directory); await mkdir(join(root, 'release'), { recursive: true });
  const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
  execFileSync(git, ['init', '-b', 'main', directory], { stdio: 'pipe' });
  await writeFile(join(directory, 'README.md'), '# Admission probe\n\nDisposable metadata-only fixture.\n');
  execFileSync(git, ['-C', directory, 'add', '.'], { stdio: 'pipe' });
  execFileSync(git, ['-C', directory, '-c', 'user.name=MemCode probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'Metadata probe fixture'], { stdio: 'pipe' });
  const scope = await projectMcpWorkspace(directory);
  const managed = new ManagedMemcodeEngine(join(profile, 'data'), { bundledDirectory: join(root, 'dist-memtrace-engine'), fetch: (async () => { throw Error('An engine download is not allowed from the probe.'); }) as typeof fetch });
  const executable = await managed.prepare();
  const env: Record<string, string> = {
    PATH: process.platform === 'darwin' ? '/usr/bin:/bin' : (process.env.PATH ?? ''),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    MEMTRACE_MEMDB_DATA_DIR: scope.dataDirectory, MEMTRACE_DATA_DIR: scope.jobDirectory, MEMTRACE_NO_WATCH_RESTORE: '1',
    ...managed.executionEnvironment({}),
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.APPDATA = join(home, 'AppData/Roaming'); env.LOCALAPPDATA = join(home, 'AppData/Local');
  }
  const report: Json = { completed: false, platform: process.platform, engineVersion: 'pinned', authenticated: false, authBypassUsed: false, ownerStartCommandUsed: false, indexToolUsed: false, sourceToolUsed: false, projectCanonical: directory === await realpath(directory), calls: [] };
  const compare = (value: unknown, expected: string) => typeof value === 'string' ? normalize(value) === normalize(expected) : null;
  const canonical = async (value: unknown) => { if (typeof value !== 'string') return null; try { return compare(await realpath(value), directory); } catch { return false; } };
  const metadata = (value: Json | undefined) => ({
    keys: keys(value), anchorSource: typeof value?.anchor_source === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.anchor_source) ? value.anchor_source : null,
    emptyStateReason: typeof value?.empty_state_reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.empty_state_reason) ? value.empty_state_reason : null,
    dataDirectoryMatches: compare(value?.data_dir ?? value?.store, scope.dataDirectory),
    cwdMatches: compare(value?.cwd, directory),
    workspaceFileMatches: compare(value?.workspace_file, scope.workspaceFile),
  });
  const summarize = async (value: any) => ({
    shape: Array.isArray(value) ? 'array' : value && typeof value === 'object' ? 'object' : typeof value,
    topLevelKeys: keys(value), meta: metadata(value?._meta), rowCount: rowsOf(value).length,
    rows: await Promise.all(rowsOf(value).slice(0, 5).map(async row => ({
      repo_id: safeId(row.repo_id), pathFieldPresent: typeof row.path === 'string', repoPathFieldPresent: typeof row.repo_path === 'string',
      pathMatch: compare(row.path, directory), repoPathMatch: compare(row.repo_path, directory),
      canonicalPathMatches: await canonical(row.path), canonicalRepoPathMatches: await canonical(row.repo_path),
      pathStyle: pathClass(row.path), repoPathStyle: pathClass(row.repo_path),
      nodesKnown: typeof row.nodes === 'number', indexState: typeof row.index_state === 'string' && /^[A-Za-z_-]{1,60}$/.test(row.index_state) ? row.index_state : null,
    }))),
  });
  let stderr = '', client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    transport = new StdioClientTransport({ command: executable, args: ['mcp', '--workspace-file', scope.workspaceFile], cwd: directory, env, stderr: 'pipe' });
    transport.stderr?.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16000); });
    client = new Client({ name: 'memcode', version: appVersion }, { capabilities: {} });
    await bounded(client.connect(transport), 30000);
    const listed = await client.callTool({ name: 'list_indexed_repositories', arguments: {} }, undefined, { timeout: 15000 }) as Json;
    const blocks = jsonBlocks(listed);
    report.calls.push({ name: 'list_indexed_repositories', isError: listed.isError === true, structuredContentPresent: listed.structuredContent !== undefined,
      blocks: await Promise.all(blocks.map(async block => ({ contentIndex: block.index, ...await summarize(block.value) }))),
      structuredContent: listed.structuredContent === undefined ? null : await summarize(listed.structuredContent),
      productionSelectedJsonBlock: blocks.at(-1)?.index ?? null,
    });
    if (listed.isError) {
      report.refusalCategory = category((listed.content ?? []).filter((entry: Json) => entry.type === 'text').map((entry: Json) => entry.text).join('\n') + stderr);
    } else {
      const selected = blocks.at(-1)?.value;
      const ids = [...new Set(rowsOf(selected).map(row => row.repo_id).filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128))].slice(0, 3);
      if (!ids.length) ids.push('project');
      for (const repoId of ids) {
        const result = await client.callTool({ name: 'get_repository_stats', arguments: { repo_id: repoId, branch: 'main' } }, undefined, { timeout: 15000 }) as Json;
        const selected = jsonBlocks(result).at(-1)?.value;
        report.calls.push({ name: 'get_repository_stats', requestedRepoId: safeId(repoId), isError: result.isError === true, topLevelKeys: keys(selected), repoInStore: typeof selected?.repo_in_store === 'boolean' ? selected.repo_in_store : null,
          errorCode: typeof selected?.error_code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(selected.error_code) ? selected.error_code : null,
          diagnosticReason: typeof selected?.diagnostic?.reason === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(selected.diagnostic.reason) ? selected.diagnostic.reason : null,
          diagnosticKeys: keys(selected?.diagnostic), diagnosticMemberCount: Array.isArray(selected?.diagnostic?.members) ? selected.diagnostic.members.length : null,
        });
        if (result.isError) { report.refusalCategory = category(JSON.stringify(result.content) + stderr); break; }
      }
    }
    report.completed = true;
  } catch (error) {
    report.completed = true;
    report.refusalCategory = category((error instanceof Error ? error.message : '') + stderr);
  } finally {
    await bounded(client?.close() ?? Promise.resolve(), 5000).catch(() => { report.closeTimedOut = true; });
    await bounded(transport?.close() ?? Promise.resolve(), 5000).catch(() => { report.transportCloseTimedOut = true; });
    report.checkedAt = new Date().toISOString();
    const handles = (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    report.liveNodeChildProcessesAtEnd = handles.filter(handle => handle instanceof ChildProcess && handle.exitCode === null && handle.signalCode === null).length;
    report.activeResourcesAtEnd = process.getActiveResourcesInfo().reduce<Record<string, number>>((counts, name) => { counts[name] = (counts[name] ?? 0) + 1; return counts; }, {});
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    await new Promise<void>((done, reject) => process.stdout.write(JSON.stringify(report) + '\n', error => error ? reject(error) : done()));
  }
}
void run().then(() => process.exit(0), () => { process.stderr.write('Admission diagnostic could not initialize.\n', () => process.exit(1)); });
