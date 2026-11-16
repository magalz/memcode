// Reviewed exceptions for upstream packages which omit their project-level
// license from the published archive. No package code is installed or executed.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'third_party');
const cargo = JSON.parse(await readFile(join(root, '.memcode/cargo-license-metadata.json'), 'utf8')).packages;
const receipts = JSON.parse(await readFile(join(output, 'upstream-notices.json'), 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function save(file, text, provenance = {}) {
  const path = join(output, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return { file, sha256: digest(text), ...provenance };
}
async function download(url, file, kind = 'upstream-license', note) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Error(`Could not obtain original notice: ${response.status} ${url}`);
  const text = await response.text();
  if (!text.trim() || text.length > 1_000_000 || /^\s*<!doctype/i.test(text)) throw Error(`Invalid notice response: ${url}`);
  return save(file, text, { url, kind, ...(note ? { note } : {}) });
}

const isarray = await readFile(join(root, 'node_modules/jszip/node_modules/isarray/README.md'), 'utf8');
const licenseAt = isarray.indexOf('## License');
if (licenseAt < 0 || !isarray.slice(licenseAt).includes('Copyright (c) 2013 Julian Gruber') || !isarray.slice(licenseAt).includes('Permission is hereby granted')) throw Error('isarray original README license changed');
receipts['npm:isarray@1.0.0'] = [await save('upstream/npm/isarray-1.0.0/README-LICENSE.txt', isarray.slice(licenseAt), {
  url: 'https://registry.npmjs.org/isarray/-/isarray-1.0.0.tgz', kind: 'upstream-license', sourceFile: 'package/README.md',
})];
receipts['cargo:libappindicator-sys@0.9.0'] = [await download(
  'https://raw.githubusercontent.com/tauri-apps/libappindicator-rs/eafd1e3682a1247f595410266091e9684021cb6f/LICENSE-MIT',
  'upstream/cargo/libappindicator-sys-0.9.0/LICENSE-MIT',
)];
receipts['npm:react-remove-scroll-bar@2.3.8'] = [await download(
  'https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE',
  'upstream/npm/react-remove-scroll-bar-2.3.8/LICENSE', 'upstream-license',
  'The published package declares MIT but omits LICENSE. This is the original project license added by upstream in commit 7301c160; no copyright holder or year was supplied by MemCode.',
)];
const canvas = await download(
  'https://raw.githubusercontent.com/Brooooooklyn/canvas/4627c0f8ddec93d8b25f2e24e6d7055a23b92691/LICENSE',
  'upstream/npm/napi-rs-canvas-1.1.1/LICENSE', 'upstream-license', 'Original project MIT license from the commit tagged v1.1.1. Optional canvas native binaries are not copied by MemCode packaging.',
);
for (const name of Object.keys(receipts).filter((name) => /^npm:@napi-rs\/canvas-/.test(name))) receipts[name] = [canvas];
receipts['npm:@napi-rs/canvas-win32-x64-msvc@1.1.1'] = [canvas];

const winapi = await download(
  'https://raw.githubusercontent.com/retep998/winapi-rs/5b1829956ef645f3c2f8236ba18bb198ca4c2468/LICENSE-MIT',
  'upstream/cargo/winapi-project/LICENSE-MIT', 'upstream-license', 'Original winapi project license referenced by the GNU subcrate source headers.',
);
for (const name of ['winapi-i686-pc-windows-gnu', 'winapi-x86_64-pc-windows-gnu']) {
  const pkg = cargo.find((value) => value.name === name && value.version === '0.4.0');
  const source = await readFile(join(dirname(pkg.manifest_path), 'src/lib.rs'), 'utf8');
  const header = source.slice(0, source.indexOf('#!'));
  if (!header.includes('Copyright © 2016 winapi-rs developers') || !header.includes('MIT license')) throw Error('winapi source license header changed');
  receipts[`cargo:${name}@0.4.0`] = [winapi, await save(`upstream/cargo/${name}-0.4.0/SOURCE-LICENSE-NOTICE.txt`, header, {
    url: `https://crates.io/api/v1/crates/${name}/0.4.0/download`, sourceFile: `${name}-0.4.0/src/lib.rs`, kind: 'upstream-license',
  })];
}

// Stylo publishes its MPL notice in each source file instead of a root LICENSE.
// Copy the notice exactly, and provide the full canonical license alongside it.
const mpl = await download('https://raw.githubusercontent.com/mozilla/bedrock/a15178c3c7c976c67b3641af77cae0b66093a175/media/MPL/2.0/index.txt', 'license-texts/MPL-2.0.txt', 'standard-license-text');
for (const version of ['0.38.0', '0.41.0']) {
  const pkg = cargo.find((value) => value.name === 'selectors' && value.version === version);
  const source = await readFile(join(dirname(pkg.manifest_path), 'lib.rs'), 'utf8');
  const header = source.slice(0, source.indexOf('*/') + 2) + '\n';
  if (!header.includes('Mozilla Public') || !header.includes('License, v. 2.0')) throw Error('selectors source license header changed');
  receipts[`cargo:selectors@${version}`] = [mpl, await save(`upstream/cargo/selectors-${version}/SOURCE-LICENSE-NOTICE.txt`, header, {
    url: `https://crates.io/api/v1/crates/selectors/${version}/download`, sourceFile: `selectors-${version}/lib.rs`, kind: 'upstream-license',
  })];
}

// worker-f explicitly declares MIT and authorship, but publishes no LICENSE
// file. Preserve that exact declaration; do not fabricate a copyright notice.
const declarationUrl = 'https://gitlab.com/api/v4/projects/catamphetamine%2Fworker-f/repository/files/package.json/raw?ref=60518db528d5b4cfdd8a5a70a631990bf8b623eb';
const declared = await download(declarationUrl, 'upstream/npm/worker-f-0.1.24/package.json', 'upstream-declaration');
const manifest = JSON.parse(await readFile(join(output, declared.file), 'utf8'));
if (manifest.name !== 'worker-f' || manifest.version !== '0.1.24' || manifest.license !== 'MIT') throw Error('worker-f pinned license declaration changed');
const mit = await download('https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt', 'license-texts/MIT.txt', 'standard-license-text',
  'Unmodified generic SPDX MIT license text. Its angle-bracket fields are template fields, not an attribution supplied by MemCode. worker-f authorship/license declaration is preserved separately from its pinned upstream package.json.');
receipts['npm:worker-f@0.1.24'] = [declared, mit];

await writeFile(join(output, 'upstream-notices.json'), JSON.stringify(receipts, null, 2) + '\n');
console.log(JSON.stringify({ reviewedUpstreamExceptions: 9, copyrightLinesInvented: 0 }));
