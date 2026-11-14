/** Opt-in real worker check. Uses the production WorkerManager, profiles and browser gateway. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { initialState } from "../src/seed";
import type { Harness, WorkItem } from "../src/shared";
import { MemtraceEngine } from "../runtime/memtrace";
import { WorkerManager } from "../runtime/workers";
import { AgentBrowserManager } from "../runtime/browser/manager";
import { findCommand, git } from "../runtime/local";

const root = await mkdtemp(join(tmpdir(), "memcode-worker-browser-"));
const repo = join(root, "project"),
  data = join(root, "data");
await mkdir(join(repo, "src"), { recursive: true });
await mkdir(data);
console.log(JSON.stringify({ phase: "setup", root }));
const selected = process.argv[process.argv.indexOf("--harness") + 1] as Harness;
if (
  !process.argv.includes("--harness") ||
  !["codex", "claude", "cursor"].includes(selected)
)
  throw Error(
    "Use --harness codex|claude|cursor. Each invocation gets a fresh project.",
  );
const providers: Harness[] = [selected];
const configs = [
  join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".cursor", "mcp.json"),
  join(homedir(), ".cursor", "cli-config.json"),
];
const hashes = () =>
  Promise.all(
    configs.map(async (path) =>
      createHash("sha256")
        .update(await readFile(path).catch(() => Buffer.alloc(0)))
        .digest("hex"),
    ),
  );
const beforeConfig = await hashes();
const files: Record<string, string> = {
  ".gitignore": ".memcode/\n",
  "AGENTS.md":
    "Keep currency DKK and rounding. Edit only the pricing file assigned to your story. Never modify tests, Git state or another worker's files. The host manages Fleet. Use the provided MemCode context and browser tools when relevant; native reads, edits and test commands remain available. Run node --test.\n",
  "src/money.mjs":
    "export function roundCents(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }\n",
};
for (const id of providers) {
  await mkdir(join(repo, "src", id));
  files[`src/${id}/pricing.mjs`] =
    `import {roundCents} from '../money.mjs';\nexport function total_${id}(lines) { return roundCents(lines.reduce((sum,line)=>sum+(line.quantity || 1)*line.unitPrice,0)); }\n`;
  files[`src/${id}/receipt.mjs`] =
    `import {total_${id}} from './pricing.mjs';\nexport function receipt_${id}(lines) { return {amount:total_${id}(lines),currency:'DKK'}; }\n`;
  files[`${id}.test.mjs`] =
    `import test from 'node:test';import assert from 'node:assert/strict';import {receipt_${id}} from './src/${id}/receipt.mjs';test('${id} compatibility',()=>assert.deepEqual(receipt_${id}([{quantity:2,unitPrice:9}]),{amount:18,currency:'DKK'}));\n`;
}
for (const [file, content] of Object.entries(files))
  await writeFile(join(repo, file), content);
await git(repo, ["init", "--initial-branch=epic/live-harnesses"]);
await git(repo, ["add", "."]);
await git(repo, [
  "-c",
  "user.name=MemCode conformance",
  "-c",
  "user.email=check@local.invalid",
  "commit",
  "-m",
  "Disposable browser and coding fixture",
]);
const head = await git(repo, ["rev-parse", "HEAD"]);
const state = initialState();
state.tasks = [];
state.epics = [];
state.artifacts = [];
state.fleetConflicts = [];
state.settings.maxWorkers = 3;
state.settings.contextAssistant = undefined;
const project = {
  id: "live-harness-check",
  name: "Live harness check",
  description: "Disposable production-path conformance",
  path: repo,
  branch: "epic/live-harnesses",
  analysis: "ready" as const,
  createdAt: new Date().toISOString(),
};
state.projects = [project];
state.activeProjectId = project.id;
const epic = {
  id: "live-browser",
  projectId: project.id,
  identifier: "EP-01",
  title: "Real coding and browser sessions",
  description: "Three installed harnesses, one epic branch",
  phase: "now" as const,
  color: "mint" as const,
  order: 0,
  branch: project.branch,
  baseRevision: head,
};
state.epics = [epic];
const server = createServer(async (request, response) => {
  const id = request.url?.split("/")[1] as Harness;
  if (!providers.includes(id)) {
    response.writeHead(404).end();
    return;
  }
  if (request.method === "POST") {
    let body = "";
    for await (const part of request) body += part;
    const quantity = JSON.parse(body).quantity;
    const file = join(repo, "src", id, "pricing.mjs");
    const module = await import(
      pathToFileURL(file).href + "?v=" + (await stat(file)).mtimeMs
    );
    const amount = module[`total_${id}`]([{ quantity, unitPrice: 9 }]);
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ amount, currency: "DKK" }));
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<!doctype html><html><head><title>${id} · Live browser check</title><style>body{font:16px system-ui;background:#f5f8f2;color:#163b2b;margin:48px}main{max-width:600px;padding:36px;background:white;border:1px solid #dbe8d5;border-radius:14px}h1{font-size:30px}input,button{font:inherit;padding:12px;border:1px solid #abc2aa;border-radius:6px}button{background:#1b4b32;color:white;cursor:pointer}output{display:block;margin:26px 0;font-size:26px}small{color:#758773}</style></head><body><main><small>DISPOSABLE INTEGRATION CHECK · ${id}</small><h1>Zero-quantity invoice</h1><p>This page calls the actual pricing module in the test project.</p><label>Quantity <input aria-label="Quantity" id="quantity" type="number" value="0"></label> <button id="calculate">Calculate</button><output id="result">Not calculated</output><script>calculate.onclick=async()=>{const r=await fetch(location.pathname,{method:'POST',body:JSON.stringify({quantity:Number(quantity.value)})});const data=await r.json();result.textContent='Amount: '+data.amount+' '+data.currency};</script></main></body></html>`,
  );
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const models = { codex: "gpt-6-luna", claude: "haiku", cursor: "composer-2.5" };
state.tasks = providers.map(
  (id, index) =>
    ({
      ...initialState().tasks[0],
      id: `live-${id}`,
      identifier: `LIVE-00${index + 1}`,
      projectId: project.id,
      epicId: epic.id,
      example: false,
      assignment: "manual",
      harness: id,
      modelOverride: models[id],
      title: `Fix ${id} zero quantity and verify in its shared browser`,
      description: `A zero-quantity line with unit price 9 is still charged 9. Investigate the calculation in src/${id}/pricing.mjs and its observed caller, assess the implementation change, and fix it. Default quantity 1 only for null/undefined. Preserve rounding and DKK. Edit only src/${id}/pricing.mjs; do not edit tests. Run node --test. Then open ${base}/${id} in the provided MemCode browser, observe the real page, set Quantity to 0, click Calculate, confirm Amount: 0 DKK, and capture a screenshot. Leave the tab open for the user. Do not use a private vendor browser. Report actual checks and uncertainty.`,
      scope: [`src/${id}/pricing.mjs`],
      messages: [],
      checklist: [],
      dependsOn: [],
      stage: "planned",
      run: { state: "idle" },
    }) as WorkItem,
);
const save = async () =>
  writeFile(join(data, "workspace.json"), JSON.stringify(state, null, 2));
const engine = new MemtraceEngine(() => "");
const browsers = new AgentBrowserManager(() => state, data, save);
const proxy = join(root, "record-cli.mjs");
await writeFile(
  proxy,
  `import{spawn}from'node:child_process';import{readFileSync,createWriteStream}from'node:fs';const c=JSON.parse(readFileSync(process.argv[2],'utf8'));const p=spawn(c.command,[...c.prefix,...process.argv.slice(3)],{env:process.env,cwd:process.cwd(),stdio:['pipe','pipe','pipe'],windowsHide:true});const out=createWriteStream(c.out),err=createWriteStream(c.err);process.stdin.pipe(p.stdin);p.stdin.on('error',()=>{});p.stdout.on('data',b=>{out.write(b);process.stdout.write(b)});p.stderr.on('data',b=>{err.write(b);process.stderr.write(b)});p.once('error',e=>{console.error(e);process.exitCode=1});p.once('close',code=>{out.end();err.end();process.exitCode=code??1});`,
);
const manager = new WorkerManager(
  () => state,
  save,
  engine,
  data,
  async (name) => {
    const command = await findCommand(name);
    if (!command) return null;
    const config = join(root, `${name}-command.json`);
    await writeFile(
      config,
      JSON.stringify({
        ...command,
        out: join(root, `${name}-stream.jsonl`),
        err: join(root, `${name}-stderr.log`),
      }),
    );
    return {
      command: process.execPath,
      prefix: [proxy, config],
      env: command.env,
    };
  },
  undefined,
  browsers,
);
const report: any = {
  version: 1,
  at: new Date().toISOString(),
  root,
  repo,
  sourceCommit: await git(process.cwd(), ["rev-parse", "HEAD"]),
  scope:
    "Production WorkerManager with unchanged harness arguments, authenticated per-worker profiles and real browser gateways. A transparent stdout/stderr tee records provider events. This is conformance, not a new token savings benchmark.",
  workers: [],
};
try {
  const admitted = await engine.call(project, "list_indexed_repositories", {});
  const rows = Array.isArray(admitted) ? admitted : (admitted.repos ?? []);
  (project as any).repoId = rows.find((r: any) =>
    (r.repo_path ?? r.path ?? "")
      .replaceAll("\\", "/")
      .toLowerCase()
      .endsWith(repo.replaceAll("\\", "/").toLowerCase()),
  )?.repo_id;
  const job = await engine.call(project, "index_directory", {
    path: repo,
    repo_id: (project as any).repoId,
    skip_embed: true,
  });
  if (job.job_id)
    for (let i = 0; i < 120; i++) {
      const status = await engine.call(project, "check_job_status", {
        job_id: job.job_id,
      });
      if (status.status === "completed") break;
      if (status.status === "failed" || i === 119)
        throw Error(JSON.stringify(status));
      await new Promise((r) => setTimeout(r, 500));
    }
  const indexed = await engine.call(project, "list_indexed_repositories", {});
  const indexedRows = Array.isArray(indexed) ? indexed : (indexed.repos ?? []);
  assert.equal(indexedRows.length, 1);
  (project as any).repoId = indexedRows[0].repo_id;
  await save();
  for (const task of state.tasks) {
    console.log(JSON.stringify({ phase: "start", harness: task.harness }));
    const start = Date.now();
    let launchError: string | undefined;
    try {
      await manager.start(task, project);
    } catch (error) {
      launchError = String(error);
    }
    const deadline = Date.now() + 240000;
    while (
      ["preparing", "running", "stopping"].includes(task.run.state) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 500));
    if (["preparing", "running", "stopping"].includes(task.run.state))
      await manager.stop(task.id);
    const directory = join(repo, ".memcode", "workers", task.id);
    const diagnostics = (
      await readFile(
        join(directory, "context-diagnostics.jsonl"),
        "utf8",
      ).catch(() => "")
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const activity = (await browsers.execute(task.id, { action: "state" }))
      .state;
    const observed = activity.tabs.length
      ? await browsers.execute(task.id, { action: "observe" })
      : undefined;
    const module = await import(
      pathToFileURL(join(repo, "src", task.harness, "receipt.mjs")).href +
        "?oracle=" +
        Date.now()
    );
    const total = module[`receipt_${task.harness}`];
    const checks = [
      total([{ quantity: 0, unitPrice: 9 }]).amount === 0,
      total([{ quantity: null, unitPrice: 9 }]).amount === 9,
      total([{ unitPrice: 9 }]).amount === 9,
      total([{ quantity: 2, unitPrice: 9 }]).amount === 18,
      total([]).currency === "DKK",
    ];
    const row = {
      harness: task.harness,
      model: models[task.harness],
      elapsedMs: Date.now() - start,
      state: task.run.state,
      error: launchError ?? task.run.error,
      checks,
      context: diagnostics,
      browser: activity,
      observed: observed?.snapshot,
      artifacts: state.artifacts.filter((a) => a.taskId === task.id),
      messages: task.messages,
    };
    report.workers.push(row);
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        phase: "result",
        harness: task.harness,
        state: row.state,
        checks,
        contextCalls: diagnostics.length,
        browserWorkerActions: activity.activity
          .filter((a) => a.actor === "worker")
          .map((a) => a.text),
        error: row.error,
      }),
    );
  }
  report.diff = await git(repo, ["diff", "--no-ext-diff"]);
  report.headUnchanged = (await git(repo, ["rev-parse", "HEAD"])) === head;
  report.branch = await git(repo, ["branch", "--show-current"]);
  report.configsUnchanged =
    JSON.stringify(await hashes()) === JSON.stringify(beforeConfig);
} finally {
  await manager.close();
  await browsers.close();
  await engine.close();
  await new Promise<void>((done) => server.close(() => done()));
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ phase: "complete", report: join(root, "report.json") }),
  );
}
