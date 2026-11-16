// Fetch missing upstream notices only; never execute downloaded package code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const inventory = JSON.parse(await readFile(join(root, 'third_party/inventory.json'), 'utf8')).packages;
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages;
const cargo = JSON.parse(await readFile(join(root, '.memcode/cargo-license-metadata.json'), 'utf8')).packages;
const receipts = JSON.parse(await readFile(join(root, 'third_party/upstream-notices.json'), 'utf8').catch(() => '{}'));
async function get(url) { const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) }); return response.ok ? response : null; }
async function resolveNotice(pkg) {
  const key = `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
  if (pkg.notices.length || receipts[key]?.length) return;
  let repository, revision;
  if (pkg.ecosystem === 'cargo') {
    const original = cargo.find((item) => item.name === pkg.name && item.version === pkg.version);
    repository = original.repository;
    revision = JSON.parse(await readFile(join(dirname(original.manifest_path), '.cargo_vcs_info.json'), 'utf8').catch(() => '{}')).git?.sha1;
  } else {
    const path = Object.keys(lock).find((path) => (lock[path].name ?? path.split('node_modules/').at(-1)) === pkg.name && lock[path].version === pkg.version);
    const meta = lock[path];
    if (meta.optional && !await readFile(join(root, path, 'package.json')).then(() => true, () => false)) { receipts[key] = [{ notInstalledOnBuildPlatform: true }]; return; }
    const response = await get(`https://registry.npmjs.org/${pkg.name}/${pkg.version}`);
    if (!response) return;
    const data = await response.json(); repository = typeof data.repository === 'string' ? data.repository : data.repository?.url; revision = data.gitHead;
  }
  const match = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/.exec(repository ?? '');
  if (!match || !/^[a-f0-9]{40}$/.test(revision ?? '')) return;
  const found = [];
  for (const file of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'LICENSE-MPL', 'LICENCE']) {
    const url = `https://raw.githubusercontent.com/${match[1]}/${revision}/${file}`;
    const response = await get(url); if (!response) continue;
    const text = await response.text();
    if (!text.trim() || text.length > 1_000_000 || /^\s*<!doctype/i.test(text)) continue;
    const target = `upstream/${pkg.ecosystem}/${pkg.name.replace(/[^\w.-]/g, '_')}-${pkg.version}/${file}`;
    await mkdir(dirname(join(root, 'third_party', target)), { recursive: true });
    await writeFile(join(root, 'third_party', target), text);
    found.push({ file: target, url, sha256: createHash('sha256').update(text).digest('hex') });
    if (!pkg.license.includes('AND')) break;
  }
  if (found.length) receipts[key] = found;
}
const pending = inventory.filter((item) => !item.notices.length);
for (let i = 0; i < pending.length; i += 6) await Promise.all(pending.slice(i, i + 6).map(resolveNotice));
await writeFile(join(root, 'third_party/upstream-notices.json'), JSON.stringify(receipts, null, 2) + '\n');
console.log(JSON.stringify({ fetchedOrExcluded: Object.keys(receipts).length, unresolved: pending.filter((pkg) => !receipts[`${pkg.ecosystem}:${pkg.name}@${pkg.version}`]?.length).map((pkg) => `${pkg.ecosystem}:${pkg.name}@${pkg.version}`) }));
