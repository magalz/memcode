import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = join(root, 'third_party');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inventory = JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8'));
const packageLock = digest(await readFile(join(root, 'package-lock.json')));
const cargoLock = digest(await readFile(join(root, 'src-tauri/Cargo.lock')));
if (inventory.inputs?.packageLockSha256 !== packageLock || inventory.inputs?.cargoLockSha256 !== cargoLock) throw Error('Dependency locks changed. Regenerate and review third-party notices before packaging.');
let references = 0;
const checked = new Map();
async function verifyNotice(entry) {
  if (typeof entry.file !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw Error('Incomplete third-party notice reference');
  const path = resolve(directory, entry.file);
  if (!path.startsWith(directory + sep)) throw Error('Third-party notice path escaped its directory');
  let actual = checked.get(path);
  if (!actual) { actual = digest(await readFile(path)); checked.set(path, actual); }
  if (actual !== entry.sha256) throw Error(`Third-party notice content changed: ${entry.file}`);
}
for (const pkg of inventory.packages) {
  if (!pkg.license || !pkg.notices?.length) throw Error(`Missing license or notices: ${pkg.name}`);
  for (const notice of pkg.notices) { await verifyNotice(notice); references++; }
}
const resources = JSON.parse(await readFile(join(directory, 'resources.json'), 'utf8'));
await verifyNotice(resources.liberationSource);
for (const resource of resources.files) {
  const bytes = await readFile(join(root, 'node_modules', resources.package, resource.path));
  if (digest(bytes) !== resource.sha256) throw Error(`Licensed PDF resource changed: ${resource.path}`);
}
await readFile(join(directory, 'SOURCE_ACCESS.md'));
console.log(JSON.stringify({ packages: inventory.packages.length, noticeReferences: references, distinctNoticeFiles: checked.size, dependencyLocksMatch: true, fontSourceVerified: true }));
