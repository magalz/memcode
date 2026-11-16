import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const namespaces = ["claude", "codex", "cursor"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const starter = String.raw`// Minute offsets are integers; intervals are half-open [start, end).
export function normalizeBusy(busy, windowStart, windowEnd) {
  const rows = busy.sort((a, b) => a.start - b.start);
  const result = [];
  for (const interval of rows) {
    if (interval.end >= windowStart && interval.start <= windowEnd) {
      const start = Math.max(windowStart, interval.start);
      const end = Math.min(windowEnd, interval.end);
      if (result.length) {
        const previous = result[result.length - 1];
        if (start < previous.end) {
          previous.end = end;
        } else {
          result.push({ start, end });
        }
      } else {
        result.push({ start, end });
      }
    }
  }
  return result;
}

export function freeWindows(busy, windowStart, windowEnd, minimumDuration = 1) {
  const occupied = normalizeBusy(busy, windowStart, windowEnd);
  const result = [];
  let cursor = windowStart;
  for (const interval of occupied) {
    if (interval.start - cursor > minimumDuration) {
      result.push({ start: cursor, end: interval.start });
    }
    cursor = interval.end;
  }
  if (windowEnd - cursor > minimumDuration) {
    result.push({ start: cursor, end: windowEnd });
  }
  return result;
}

export function nextStart(busy, windowStart, windowEnd, duration, step) {
  for (const gap of freeWindows(busy, windowStart, windowEnd, duration)) {
    const candidate = Math.floor(gap.start / step) * step;
    if (candidate + duration < gap.end) return candidate;
  }
  return null;
}
`;

const specification = `Repair the existing availability module without changing its exported names or signatures.

normalizeBusy(busy, windowStart, windowEnd): busy must be an array of objects with finite integer start/end values and start < end. Invalid shapes or non-integer/non-finite numbers throw TypeError; empty/reversed intervals throw RangeError. Window bounds follow the same numeric rule, with windowStart < windowEnd or RangeError. Bounds may be negative. Never coerce strings and never mutate input arrays or objects. Clip busy intervals to the half-open window, discard empty intersections, sort by start then end, and merge overlapping or touching intervals. Return new {start,end} objects.

freeWindows(busy, windowStart, windowEnd, minimumDuration=1): return the sorted complement of normalized busy intervals in the window. Include leading/trailing gaps and gaps whose length is exactly minimumDuration. minimumDuration must be a positive finite integer; otherwise throw RangeError. Busy/window validation is the same as normalizeBusy. Return [] when no gap qualifies.

nextStart(busy, windowStart, windowEnd, duration, step): duration and step must be positive finite integers or throw RangeError. Return the earliest start that is an absolute integer multiple of step, lies in a free gap, and fits duration entirely in it. Ending exactly at the gap/window end is allowed. Never return a start before its gap; return null when no fit exists. Preserve inputs.

Keep the repair focused and use only the standard runtime. No dependency installation or external network is needed.`;

const smoke = String.raw`import assert from 'node:assert/strict';
const namespace = process.argv[2];
if (!['claude','codex','cursor'].includes(namespace)) throw Error('Choose claude, codex or cursor');
const {normalizeBusy,freeWindows,nextStart}=await import('../src/'+namespace+'/availability.mjs');
assert.deepEqual(normalizeBusy([{start:3,end:8},{start:5,end:6},{start:8,end:10}],0,12),[{start:3,end:10}]);
assert.deepEqual(freeWindows([{start:3,end:7}],0,10,3),[{start:0,end:3},{start:7,end:10}]);
assert.equal(nextStart([{start:0,end:3}],0,10,6,4),4);
assert.throws(()=>normalizeBusy([{start:3,end:3}],0,10),RangeError);
console.log('Visible availability smoke passed. Independent verification runs separately.');
`;

// The verifier is saved outside the project and never included in a worker prompt.
// It evaluates exports and input invariants directly; no assistant text is read.
const verifier = String.raw`import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [project,namespace,output]=process.argv.slice(2);
if(!['claude','codex','cursor'].includes(namespace))throw Error('Invalid namespace');
const file=join(resolve(project),'src',namespace,'availability.mjs'),started=Date.now();
let subject,loadError;
try{subject=await import(pathToFileURL(file).href);for(const name of ['normalizeBusy','freeWindows','nextStart'])assert.equal(typeof subject[name],'function');}
catch(error){loadError=String(error.message);}
const cases=[];
function check(id,run){try{if(loadError)throw Error('Module load failed: '+loadError);run(subject);cases.push({id,passed:true});}catch(error){cases.push({id,passed:false,error:String(error.message).slice(0,500)});}}
const B=(start,end)=>({start,end});
check('sorts-disjoint-intervals',m=>assert.deepEqual(m.normalizeBusy([B(8,10),B(1,3)],0,12),[B(1,3),B(8,10)]));
check('clips-and-discards-empty-intersections',m=>assert.deepEqual(m.normalizeBusy([B(-4,0),B(-2,2),B(8,14),B(10,12)],0,10),[B(0,2),B(8,10)]));
check('nested-overlaps-do-not-shrink-busy-time',m=>assert.deepEqual(m.normalizeBusy([B(1,12),B(3,5),B(7,10)],0,20),[B(1,12)]));
check('touching-intervals-merge',m=>assert.deepEqual(m.normalizeBusy([B(1,3),B(3,8),B(8,9)],0,12),[B(1,9)]));
check('duplicate-intervals-collapse',m=>assert.deepEqual(m.normalizeBusy([B(1,3),B(1,3),B(6,9)],0,12),[B(1,3),B(6,9)]));
check('preserves-array-order-and-input-objects',m=>{const input=[B(8,10),B(1,3),B(2,4)],before=structuredClone(input);m.normalizeBusy(input,0,12);m.freeWindows(input,0,12,2);m.nextStart(input,0,12,2,2);assert.deepEqual(input,before);});
check('rejects-invalid-busy-container-and-shapes',m=>{for(const input of [null,{},'busy',[null],[3],[{}]])assert.throws(()=>m.normalizeBusy(input,0,10),TypeError);});
check('rejects-nonfinite-fractional-and-coerced-endpoints',m=>{for(const interval of [B(NaN,4),B(1,Infinity),B(1.5,4),B(1,4.5),B('1',4),B(1,'4')])assert.throws(()=>m.normalizeBusy([interval],0,10),TypeError);});
check('rejects-empty-or-reversed-intervals',m=>{for(const interval of [B(3,3),B(5,2)])assert.throws(()=>m.normalizeBusy([interval],0,10),RangeError);});
check('validates-window-bounds',m=>{for(const bounds of [[NaN,10],[0,Infinity],[0.5,10],['0',10]])assert.throws(()=>m.normalizeBusy([],bounds[0],bounds[1]),TypeError);for(const bounds of [[0,0],[10,0]])assert.throws(()=>m.normalizeBusy([],bounds[0],bounds[1]),RangeError);});
check('finds-leading-and-trailing-free-windows',m=>assert.deepEqual(m.freeWindows([B(2,5),B(7,8)],0,10,1),[B(0,2),B(5,7),B(8,10)]));
check('minimum-duration-is-inclusive',m=>assert.deepEqual(m.freeWindows([B(2,5)],0,8,2),[B(0,2),B(5,8)]));
check('fully-busy-window-has-no-free-time',m=>assert.deepEqual(m.freeWindows([B(-10,30),B(0,2)],0,10,1),[]));
check('empty-busy-list-and-exact-window-duration',m=>assert.deepEqual(m.freeWindows([],0,5,5),[B(0,5)]));
check('rejects-invalid-minimum-duration',m=>{for(const duration of [0,-1,NaN,Infinity,1.5,'2'])assert.throws(()=>m.freeWindows([],0,10,duration),RangeError);});
check('aligned-booking-rounds-up-and-stays-in-gap',m=>assert.equal(m.nextStart([B(0,3)],0,20,5,4),4));
check('aligned-booking-accepts-exact-end-and-no-fit',m=>{assert.equal(m.nextStart([],0,10,10,5),0);assert.equal(m.nextStart([B(0,3)],0,10,8,4),null);assert.equal(m.nextStart([], -7,7,5,4),-4);});
check('rejects-invalid-booking-duration-and-step',m=>{for(const value of [0,-1,NaN,Infinity,1.5,'2']){assert.throws(()=>m.nextStart([],0,10,value,2),RangeError);assert.throws(()=>m.nextStart([],0,10,2,value),RangeError);}});
check('deterministic-occupancy-oracle-64-scenarios',m=>{
 let seed=0x517cc1b7;const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 for(let scenario=0;scenario<64;scenario++){
  const low=-10,high=30,busy=Array.from({length:random(7)},()=>{const start=random(61)-20;return B(start,start+1+random(12));}),minimum=1+random(8),duration=1+random(9),step=1+random(7),before=structuredClone(busy);
  const occupied=Array.from({length:high-low},(_,index)=>busy.some(row=>row.start<=low+index&&row.end>low+index));
  const runs=flag=>{const out=[];let start=null;for(let index=0;index<=occupied.length;index++){const matches=index<occupied.length&&occupied[index]===flag;if(matches&&start===null)start=low+index;if(!matches&&start!==null){out.push(B(start,low+index));start=null;}}return out;};
  assert.deepEqual(m.normalizeBusy(busy,low,high),runs(true),'busy oracle scenario '+scenario);
  assert.deepEqual(m.freeWindows(busy,low,high,minimum),runs(false).filter(row=>row.end-row.start>=minimum),'free oracle scenario '+scenario);
  let expected=null;for(let start=low;start+duration<=high;start++)if(start%step===0&&Array.from({length:duration},(_,offset)=>occupied[start-low+offset]).every(flag=>!flag)){expected=start;break;}
  assert.ok(m.nextStart(busy,low,high,duration,step)===expected,'booking oracle scenario '+scenario);assert.deepEqual(busy,before,'input immutability scenario '+scenario);
 }
});
const result={version:1,namespace,module:'src/'+namespace+'/availability.mjs',moduleSha256:createHash('sha256').update(await readFile(file)).digest('hex'),startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString(),durationMs:Date.now()-started,total:cases.length,passed:cases.filter(row=>row.passed).length,failed:cases.filter(row=>!row.passed).length,cases};
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log('MEMCODE_CHECK_RESULT '+JSON.stringify({version:1,passed:result.passed,failed:result.failed}));process.exitCode=result.failed?1:0;
`;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function task(namespace) {
  const module = `src/${namespace}/availability.mjs`,
    report = `reports/${namespace}.md`;
  return {
    namespace,
    title: `Repair availability calculations — ${namespace}`,
    scope: [module],
    allowedEdits: [module, report],
    prompt: `${specification}\n\nYour namespace is ${namespace}. Edit only ${module} and ${report}; other workers own the other namespaces on this shared epic branch. Coordinate through MemCode Fleet before edits. Use MemCode source context when exploration matters. Do not edit shared scripts, specifications, package files or another worker's files. Do not inspect parent directories or external verification files.\n\nRun the visible check with: node scripts/smoke.mjs ${namespace}\nPublish a concise Markdown report at ${report} explaining the repair and the checks you actually ran. Do not claim independent test results; MemCode evaluates those separately. Do not commit or push.`,
  };
}

export async function createRealMeasurementsFixture(parentDirectory) {
  assert.ok(
    isAbsolute(parentDirectory),
    "Use an absolute private QA parent directory",
  );
  await mkdir(parentDirectory, { recursive: true });
  const directory = await mkdtemp(
    join(resolve(parentDirectory), "memcode-real-measurements-"),
  );
  const projectPath = join(directory, "project"),
    verificationPath = join(directory, "verification"),
    evidencePath = join(directory, "evidence");
  await Promise.all([
    mkdir(join(projectPath, "scripts"), { recursive: true }),
    mkdir(join(projectPath, "reports"), { recursive: true }),
    mkdir(verificationPath),
    mkdir(evidencePath),
  ]);
  await Promise.all(
    namespaces.map(async (namespace) => {
      await mkdir(join(projectPath, "src", namespace), { recursive: true });
      await writeFile(
        join(projectPath, "src", namespace, "availability.mjs"),
        starter,
      );
    }),
  );
  await writeFile(
    join(projectPath, "README.md"),
    "# Real coding measurements fixture\n\nThree identical independent availability modules are assigned to separate coding workers. This is a labelled QA project, not customer work.\n\n" +
      specification +
      "\n",
  );
  await writeFile(
    join(projectPath, "AGENTS.md"),
    "# Coding QA workspace\n\nThis is a synthetic but real coding task. All workers share one checkout and epic branch. Coordinate edits through MemCode Fleet. Each task authorizes only its own src/<namespace>/availability.mjs and reports/<namespace>.md. Do not inspect parent directories or external verification files. Do not change shared scripts, dependencies, Git configuration or another namespace. Do not commit or push. Use only standard runtime facilities.\n",
  );
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify(
      {
        name: "memcode-real-coding-qa",
        private: true,
        type: "module",
        scripts: { smoke: "node scripts/smoke.mjs" },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(projectPath, ".gitignore"),
    ".memcode/\n.memtrace/\n.memdb/\nnode_modules/\n",
  );
  await writeFile(join(projectPath, "scripts", "smoke.mjs"), smoke);
  await writeFile(join(verificationPath, "verify.mjs"), verifier);
  git(["init", "-b", "main"], projectPath);
  git(["config", "user.name", "MemCode coding QA"], projectPath);
  git(["config", "user.email", "qa@example.invalid"], projectPath);
  git(["add", "--", "."], projectPath);
  git(
    [
      "-c",
      "core.hooksPath=NUL",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Add identical bugged availability coding fixtures",
    ],
    projectPath,
  );
  const fixture = {
    version: 1,
    directory,
    projectPath,
    verificationPath,
    evidencePath,
    manifestPath: join(directory, "fixture.json"),
    createdAt: new Date().toISOString(),
    baselineCommit: git(["rev-parse", "HEAD"], projectPath),
    baselineModuleSha256: sha(starter),
    verifierSha256: sha(verifier),
    tasks: namespaces.map(task),
    baseline: [],
  };
  for (const namespace of namespaces) {
    const result = await verifyRealMeasurementsFixture(fixture, namespace, {
      label: "baseline",
    });
    assert.ok(
      result.failed > 0 && result.total === 19,
      "The starter must fail the independent suite",
    );
    fixture.baseline.push(result);
  }
  await writeFile(
    fixture.manifestPath,
    JSON.stringify(fixture, null, 2) + "\n",
  );
  return fixture;
}

export async function verifyRealMeasurementsFixture(
  fixture,
  namespace,
  options = {},
) {
  assert.ok(namespaces.includes(namespace), "Unknown worker namespace");
  assert.equal(fixture.version, 1);
  assert.ok(
    isAbsolute(fixture.projectPath) && isAbsolute(fixture.verificationPath),
  );
  const program = join(fixture.verificationPath, "verify.mjs");
  assert.equal(
    sha(await readFile(program)),
    fixture.verifierSha256,
    "Trusted verifier changed",
  );
  const label = options.label ?? "review";
  assert.match(label, /^[a-z0-9-]{1,60}$/);
  const outputPath = join(fixture.evidencePath, `${namespace}-${label}.json`),
    timeout = options.timeoutMs ?? 15000;
  assert.ok(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000);
  let exitCode = 0;
  try {
    execFileSync(
      process.execPath,
      [program, fixture.projectPath, namespace, outputPath],
      {
        cwd: fixture.verificationPath,
        timeout,
        maxBuffer: 1_000_000,
        windowsHide: true,
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
          PATH: dirname(process.execPath),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    if (typeof error.status !== "number")
      throw Error(
        "Trusted verifier did not complete within its bounded process",
      );
    exitCode = error.status;
  }
  const result = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(result.namespace, namespace);
  assert.equal(result.total, 19);
  assert.equal(result.passed + result.failed, result.total);
  assert.equal(
    exitCode,
    result.failed ? 1 : 0,
    "Verifier exit and structured counts disagree",
  );
  return {
    ...result,
    exitCode,
    outputPath,
    verifierSha256: fixture.verifierSha256,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, path, namespace, label] = process.argv.slice(2);
  if (action === "create")
    console.log(
      JSON.stringify(await createRealMeasurementsFixture(path), null, 2),
    );
  else if (action === "verify")
    console.log(
      JSON.stringify(
        await verifyRealMeasurementsFixture(
          JSON.parse(await readFile(path, "utf8")),
          namespace,
          { label },
        ),
        null,
        2,
      ),
    );
  else
    throw Error(
      "Use: node scripts/real-measurements-fixture.mjs create <private-parent> | verify <fixture.json> <namespace> [label]",
    );
}
