import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'third_party');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const cargoFile = process.argv[2] ?? join(root, '.memcode/cargo-license-metadata.json');
const cargo = JSON.parse(await readFile(cargoFile, 'utf8'));
const upstream = JSON.parse(await readFile(join(output, 'upstream-notices.json'), 'utf8').catch(() => '{}'));
const resources = JSON.parse(await readFile(join(output, 'resources.json'), 'utf8'));
const inventory = [], missing = [];
const safe = (value) => value.replace(/[^A-Za-z0-9._-]/g, '_');
async function licenseFiles(directory, relative = '') {
  const found = [];
  for (const entry of await readdir(join(directory, relative), { withFileTypes: true }).catch(() => [])) {
    const path = join(relative, entry.name);
    if (entry.isFile() && /^(licen[cs]e|copying|copyright|notice|authors)([-_.]|$)/i.test(entry.name)) found.push(path);
    else if (entry.isDirectory() && !['node_modules', '.git', 'target'].includes(entry.name)) found.push(...await licenseFiles(directory, path));
  }
  return found;
}
async function notices(directory, ecosystem, name, version) {
  const files = await licenseFiles(directory);
  const copied = [];
  for (const file of files) {
    let text;
    try { text = await readFile(join(directory, file), 'utf8'); } catch { continue; }
    if (!text.trim()) continue;
    const target = `licenses/${ecosystem}/${safe(name)}-${safe(version)}/${file.replaceAll('\\', '/')}`;
    await mkdir(dirname(join(output, target)), { recursive: true });
    await writeFile(join(output, target), text);
    copied.push({ file: target, sha256: createHash('sha256').update(text).digest('hex') });
  }
  if (!copied.length) {
    const fallback = upstream[`${ecosystem}:${name}@${version}`];
    if (fallback?.length) {
      for (const item of fallback) {
        if (!item.file || item.file.includes('\\') || item.file.split('/').some((part) => !part || part === '.' || part === '..') || item.file.startsWith('/')) throw Error(`Invalid original notice path: ${name}`);
        const original = await readFile(join(output, item.file));
        if (createHash('sha256').update(original).digest('hex') !== item.sha256) throw Error(`Original notice integrity mismatch: ${name}`);
      }
      return fallback;
    }
    missing.push(`${ecosystem}:${name}@${version}`);
  }
  return copied;
}
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path || meta.dev || meta.link) continue;
  const name = meta.name ?? path.split('node_modules/').at(-1);
  if (!meta.license || !meta.version) throw Error(`Missing license metadata: ${name}`);
  inventory.push({ ecosystem: 'npm', name, version: meta.version, license: meta.license,
    source: name === 'mtx-decompressor'
      ? 'https://github.com/ChristopherVR/mtx-decompressor/tree/d4a554a4ea8126aac0ab00a1fe8253e0ffd316d4'
      : `https://www.npmjs.com/package/${name}/v/${meta.version}`,
    notices: await notices(join(root, path), 'npm', name, meta.version) });
}
for (const pkg of cargo.packages) {
  if (!pkg.source) continue;
  if (!pkg.license) throw Error(`Missing crate license metadata: ${pkg.name}`);
  inventory.push({ ecosystem: 'cargo', name: pkg.name, version: pkg.version, license: pkg.license,
    source: `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`,
    notices: await notices(dirname(pkg.manifest_path), 'cargo', pkg.name, pkg.version) });
}
inventory.sort((a, b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`));
await writeFile(join(output, 'inventory.json'), JSON.stringify({
  scope: 'Resolved production npm dependencies and Cargo lockfile dependencies, including target-specific entries. Some Cargo entries are build-only, not shipped executable code.',
  inputs: {
    packageLockSha256: createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'),
    cargoLockSha256: createHash('sha256').update(await readFile(join(root, 'src-tauri/Cargo.lock'))).digest('hex'),
  },
  packages: inventory,
}, null, 2) + '\n');
const table = inventory.map((pkg) => `| ${pkg.ecosystem} | ${pkg.name} | ${pkg.version} | ${pkg.license} | [Source](${pkg.source}) |`).join('\n');
const sourceTable = inventory.filter((pkg) => pkg.license === 'MPL-2.0').map((pkg) => `| ${pkg.ecosystem} | ${pkg.name} | ${pkg.version} | [Preferred source form](${pkg.source}) |`).join('\n');
await writeFile(join(output, 'SOURCE_ACCESS.md'), `# Third-party source access\n\nMemCode's original code is licensed separately from these components. The\nnoncommercial restriction does not apply to their independently granted rights.\nThe unmodified MPL-2.0 components remain available under MPL-2.0; the full\n[license text](license-texts/MPL-2.0.txt) and original notices accompany MemCode.\n\n| Ecosystem | Component | Version | Source |\n| --- | --- | --- | --- |\n${sourceTable}\n\nThe mtx-decompressor link identifies the exact upstream source commit recorded\nin npm metadata for 1.8.1. Cargo links provide complete exact-version source\narchives, including the files in their preferred form for modification.\n\n## Liberation font source\n\nPDF.js's Liberation Sans files identify themselves as version 1.07.4. The\ncorresponding SFD source, FontForge scripts and build instructions are supplied\nin [liberation-fonts-1.07.4.tar.gz](sources/liberation-fonts-1.07.4.tar.gz).\nThey retain the [original GPL v2 font terms and exceptions](licenses/npm/pdfjs-dist-${resources.version}/standard_fonts/LICENSE_LIBERATION).\nThe archive is unmodified and its SHA-256 matches the original-source checksum\nin the Debian source descriptor linked from [resources.json](resources.json).\nThese font rights include modification and replacement; MemCode's separate\nlicense does not narrow those rights.\n\nMemtrace/MemDB proprietary engine source is not included by this source-access\nnotice. Node is distributed with its complete separate NODE-LICENSE in the\ndesktop-runtime resources; operating-system browser/credential services retain\ntheir own applicable terms.\n`);
if (!inventory.some((pkg) => pkg.ecosystem === 'npm' && pkg.name === resources.package && pkg.version === resources.version)) throw Error('Bundled resource notices require review after the PDF.js version changes');
for (const resource of resources.files) {
  const bytes = await readFile(join(root, 'node_modules', resources.package, resource.path));
  if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw Error(`Bundled font resource changed: ${resource.path}`);
}
const fontSource = await readFile(join(output, resources.liberationSource.file));
if (createHash('sha256').update(fontSource).digest('hex') !== resources.liberationSource.sha256) throw Error('Liberation corresponding-source archive integrity mismatch');
const resourceText = `## Bundled PDF resources\n\nPDF.js ${resources.version} also supplies separately licensed CMaps, ICC profiles,\nfonts and WASM codecs. Their complete original notices are in\n[its resource notice directory](third_party/licenses/npm/pdfjs-dist-${resources.version}).\nThe package-level Apache license does not replace these resource licenses.\n\nThe Liberation Sans font files identify themselves as version 1.07.4. They\nretain the original GPL v2 Liberation-font terms and exceptions in\n[LICENSE_LIBERATION](third_party/licenses/npm/pdfjs-dist-${resources.version}/standard_fonts/LICENSE_LIBERATION).\nMemCode copies these font resources unchanged from PDF.js; its noncommercial\nrestriction does not apply to the fonts. Their corresponding SFD source and\nbuild instructions are included in the unmodified\n[Liberation 1.07.4 source archive](third_party/${resources.liberationSource.file}).\nThe original source archive checksum matches the Debian source descriptor,\nrecorded in [resources.json](third_party/resources.json).\n\nOptional Node-only native canvas packages appear in the lockfile inventory,\nbut their native binaries are not part of MemCode's configured renderer/runtime\nresources. Their upstream project notice is retained for completeness.\n\nworker-f 0.1.24 declares MIT and authorship but publishes no LICENSE file.\nIts exact pinned upstream [package declaration](third_party/upstream/npm/worker-f-0.1.24/package.json)\nis preserved together with unmodified generic SPDX MIT text. No missing\ncopyright holder or year has been invented. The original project LICENSE\nadded upstream for react-remove-scroll-bar is also retained, with its exact\ncommit and provenance in the inventory.\n\n`;
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices\n\nMemCode includes third-party software and fonts. These components retain their\nown licenses; MemCode's noncommercial terms do not restrict rights granted by\nthose licenses. The original notices are supplied in [third_party/licenses](third_party/licenses)\nand [third_party/upstream](third_party/upstream). The inventory records exact\nprovenance and SHA-256 hashes. Nested notices for bundled fonts, PDF/WASM codecs\nand other resource files are retained alongside package-level notices.\n\nThis inventory covers resolved production npm and Cargo lockfile dependencies,\nincluding platform-specific and build-only crates. It is deliberately broader\nthan the code linked into any one installer. License alternatives are preserved;\nMemCode uses permissive alternatives such as MIT where offered, rather than GPL\nor LGPL alternatives. Conjunctive licenses remain conjunctive.\n\n## Source access for MPL components\n\nThe unmodified MPL-2.0 components listed below remain available under MPL-2.0.\nTheir exact-version source is available at each Source link. In particular,\nmtx-decompressor 1.8.1 source is pinned to upstream commit\nd4a554a4ea8126aac0ab00a1fe8253e0ffd316d4. Source rights granted by MPL-2.0\nremain available, including commercial use of those components. No proprietary\nMemtrace or MemDB implementation is included by these notices.\n\n${resourceText}## Dependency inventory\n\n| Ecosystem | Component | Version | License expression | Source |\n| --- | --- | --- | --- | --- |\n${table}\n\nRegenerate with \`cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml\`\nand \`node scripts/third-party-notices.mjs <metadata-file>\`. See\n[third_party/inventory.json](third_party/inventory.json) for original-notice file hashes.\n`);
console.log(JSON.stringify({ packages: inventory.length, missingNotices: missing, mpl: inventory.filter((p) => p.license === 'MPL-2.0').map((p) => `${p.ecosystem}:${p.name}@${p.version}`) }));
if (missing.length) process.exitCode = 1;
