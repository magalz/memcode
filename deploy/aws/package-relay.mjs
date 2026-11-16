// Build only the frozen Team relay. No application, engine or user state enters this archive.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'tmp/relay-deploy');
await mkdir(output, { recursive: true });
const bundle = await build({ absWorkingDir: root, entryPoints: ['runtime/team/relay.ts'], outfile: join(output, 'relay.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, metafile: true });
if (Object.values(bundle.metafile.outputs).some(entry => entry.imports.some(item => item.external && !item.path.startsWith('node:')))) throw Error('Unexpected external relay dependency');
const launcher = `const fs=require('node:fs');
const config=JSON.parse(fs.readFileSync('/etc/memcode-relay/config.json','utf8'));
require('./relay.cjs').startTeamRelay({dataDir:'/var/lib/memcode/state',host:'127.0.0.1',port:8787,advertisedUrl:config.publicURL,selfServiceTeams:true,maxTeamsPerAccount:3}).then(relay=>{
 console.log('MemCode beta Team service ready');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void relay.close().then(()=>process.exit(0));});
}).catch(error=>{console.error('Team service startup failed:',error.message);process.exitCode=1;});
`;
await writeFile(join(output, 'start.cjs'), launcher);
for (const name of ['LICENSE', 'NOTICE']) await copyFile(join(root, name), join(output, name));
const provenance = { product: 'MemCode beta Team relay', builtAt: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), workingTree: 'Includes reviewed uncommitted beta Team source; gitHead alone is not source provenance.', relaySha256: createHash('sha256').update(await readFile(join(output, 'relay.cjs'))).digest('hex'), inputs: Object.keys(bundle.metafile.inputs).sort() };
await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
const archive = join(output, 'relay.tar.gz');
execFileSync('tar', ['-czf', archive, '-C', output, 'relay.cjs', 'start.cjs', 'provenance.json', 'LICENSE', 'NOTICE'], { windowsHide: true });
const bytes = await readFile(archive);
const result = { archive, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), relaySha256: provenance.relaySha256, inputCount: provenance.inputs.length };
await writeFile(join(output, 'package.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
