/** Opt-in, repeatable live coding comparison. Workers only edit fresh temporary fixtures. */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { childEnv, findCommand, type Command } from "../runtime/commands";
import { gitText } from "../runtime/context/source";
import { startContextSession } from "../runtime/context/host";
import { brokerInstructions } from "../runtime/context/profile";
import type { ContextBinding } from "../runtime/context/contracts";

type Harness = "codex" | "cursor";
type Case = "signature" | "bug";
type Variant = "baseline" | "broker";
const option = (name: string, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const harness = option("--harness") as Harness;
if (!["codex", "cursor"].includes(harness))
  throw Error("Use --harness codex|cursor");
const repetitions = Number(option("--repetitions", "3"));
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
  throw Error("Repetitions must be 1..5");
const maxRuns = Number(option("--max-runs", "100"));
const out = resolve(option("--out", `docs/context-coding-${harness}.json`));
const command = await findCommand(harness),
  memtrace = await findCommand("memtrace"),
  git = await findCommand("git");
if (!command || !memtrace || !git)
  throw Error("Installed harness, Memtrace and Git are required");
const model = harness === "codex" ? "gpt-6-luna" : "composer-2.5";
const report: any = process.argv.includes("--resume")
  ? JSON.parse(await readFile(out, "utf8"))
  : {
      version: 1,
      harness,
      model,
      repetitions,
      at: new Date().toISOString(),
      sourceCommit: (
        await gitText(process.cwd(), ["rev-parse", "HEAD"])
      ).trim(),
      temporaryRoot: await mkdtemp(
        join(tmpdir(), `memcode-coding-${harness}-`),
      ),
      design: {
        cases: ["signature", "bug"],
        variants: ["baseline", "broker"],
        order:
          "Within each case, baseline/broker on odd repetitions; broker/baseline on even repetitions.",
        baseline:
          "Full fixture-scoped Memtrace MCP, inherited skills and native coding tools.",
        broker:
          "Three MemCode MCP capabilities; inherited skills and native coding tools.",
        prompt:
          "Same task; only retrieval routing instructions differ. No preloaded task-specific evidence or mandatory call sequence.",
        unrelatedMcp:
          "Known unrelated user MCP servers disabled in both arms using per-invocation/project config only.",
        localHelper: false,
        semanticEmbedding: false,
        timeoutMs: 240000,
      },
      limitations: [
        "Two small synthetic coding tasks; repetitions do not establish production savings or broad code quality.",
        "Normal means the full Memtrace-enabled baseline, not a bare harness without Memtrace.",
        "User authentication, global skills and native tools are preserved. Exclusive catalog/skill isolation is not certified.",
        "Preferred retrieval is an instruction, not a shell or write fence. Unexpected calls/edits are retained.",
        "Provider usage fields are preserved as emitted; cache semantics and billing are not assumed equal across harnesses.",
        "Worker latency excludes isolated fixture/index preparation and independent post-run verification.",
      ],
      workers: [],
    };
if (
  report.harness !== harness ||
  report.model !== model ||
  report.repetitions !== repetitions
)
  throw Error("Resume configuration does not match the saved report");
const save = () => writeFile(out, JSON.stringify(report, null, 2) + "\n");
const parseLines = (text: string) =>
  text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
function unwrap(value: any) {
  if (value.isError)
    throw Error(value.content?.map((p: any) => p.text ?? "").join("\n"));
  for (const part of [...(value.content ?? [])].reverse()) {
    try {
      return JSON.parse(part.text);
    } catch {
      /* Human summary. */
    }
  }
  return value;
}
const toml = (value: any): string =>
  typeof value === "object" && value !== null
    ? Array.isArray(value)
      ? `[${value.map(toml).join(",")}]`
      : `{${Object.entries(value)
          .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
          .join(",")}}`
    : JSON.stringify(value);

async function run(
  cmd: Command,
  args: string[],
  cwd: string,
  input = "",
  observe = false,
) {
  const at = Date.now(),
    started = performance.now(),
    events: any[] = [];
  let firstSourceChange: number | null = null,
    checking = false;
  const sourceFiles = ["src/pricing.mjs", "src/receipt.mjs"];
  const fingerprint = async () =>
    createHash("sha256")
      .update(
        (
          await Promise.all(
            sourceFiles.map((file) =>
              readFile(join(cwd, file), "utf8").catch(() => "<missing>"),
            ),
          )
        ).join("\0"),
      )
      .digest("hex");
  const before = observe ? await fingerprint() : "";
  const poll = observe
    ? setInterval(async () => {
        if (checking || firstSourceChange !== null) return;
        checking = true;
        try {
          if ((await fingerprint()) !== before) firstSourceChange = Date.now();
        } finally {
          checking = false;
        }
      }, 30)
    : undefined;
  try {
    return await new Promise<any>((resolveRun, reject) => {
      const p = spawn(cmd.command, [...cmd.prefix, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...childEnv(), ...cmd.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        buffer = "",
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill();
      }, 240000);
      p.stdout.on("data", (chunk) => {
        stdout += chunk;
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            events.push({ at: Date.now(), event: JSON.parse(line) });
          } catch {
            /* CLI log. */
          }
        }
      });
      p.stderr.on("data", (chunk) => (stderr += chunk));
      p.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      p.once("close", (code) => {
        clearTimeout(timer);
        resolveRun({
          code,
          timedOut,
          stdout,
          stderr,
          events,
          startedAt: at,
          latencyMs: Math.round(performance.now() - started),
          firstSourceChange,
        });
      });
      p.stdin.on("error", () => {});
      p.stdin.end(input);
    });
  } finally {
    if (poll) clearInterval(poll);
  }
}

const tasks: Record<Case, string> = {
  bug: "Investigate this invoice symptom: a line with quantity zero and unit price 9 is still charged 9. Find the calculation from that description, explain observed callers, assess the implementation fix, and fix it. Preserve default quantity 1 only when quantity is null or undefined; zero must stay zero. Preserve roundCents and DKK currency. Edit only src/pricing.mjs. Run node --test. Report source references, applicable constraints, actual checks and uncertainty. Keep this bounded.",
  signature:
    "Locate the code that converts quantities and unit prices to an invoice amount, describe its immediate callers, and assess a signature change. Then implement optional discountRate=0 in total(lines, discountRate) and makeReceipt(lines, discountRate), forwarding it from makeReceipt. Apply discount before roundCents. Valid rate is finite 0..1; reject invalid rates with RangeError. Preserve existing one-argument behavior, caller compatibility and DKK currency. Only edit src/pricing.mjs and src/receipt.mjs. Run node --test. Report source references, constraints, actual checks and uncertainty. Keep this bounded; no broad exploration.",
};

async function fixture(id: string, caseName: Case) {
  const repoId = id + "-" + Date.now().toString(36);
  const directory = join(report.temporaryRoot, repoId),
    anchor = join(directory, ".memcode", "engine");
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(anchor, { recursive: true });
  const files: Record<string, string> = {
    "AGENTS.md":
      "Keep currency DKK. Keep totals rounded by roundCents. Preserve existing one-argument calls. Only edit src/pricing.mjs and src/receipt.mjs. Do not switch branches or edit Git state. Run node --test.\n",
    ".gitignore": ".memcode/\n",
    ".gitattributes": "* text eol=lf\n",
    "src/money.mjs":
      "export function roundCents(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }\n",
    "src/pricing.mjs":
      "import { roundCents } from './money.mjs';\nexport function total(lines) {\n  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);\n  return roundCents(subtotal);\n}\n",
    "src/receipt.mjs":
      "import { total } from './pricing.mjs';\nexport function makeReceipt(lines) {\n  return { amount: total(lines), currency: 'DKK' };\n}\n",
    "src/checkout.mjs":
      "import { makeReceipt } from './receipt.mjs';\nexport function checkout(lines) { return makeReceipt(lines); }\n",
    "pricing.test.mjs":
      "import test from 'node:test';import assert from 'node:assert/strict';import {total} from './src/pricing.mjs';import {checkout} from './src/checkout.mjs';test('existing calls',()=>{assert.equal(total([{quantity:2,unitPrice:5},{quantity:1,unitPrice:2}]),12);assert.deepEqual(checkout([]),{amount:0,currency:'DKK'});});\n",
  };
  if (caseName === "bug")
    files["src/pricing.mjs"] = files["src/pricing.mjs"].replace(
      "line.quantity *",
      "(line.quantity || 1) *",
    );
  for (const [file, text] of Object.entries(files))
    await writeFile(join(directory, file), text);
  await gitText(directory, ["init", "--initial-branch=main"]);
  await gitText(directory, ["config", "core.autocrlf", "false"]);
  await gitText(directory, ["add", "."]);
  await gitText(directory, [
    "-c",
    "user.name=Evaluation",
    "-c",
    "user.email=evaluation@local.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const workspace = join(anchor, "workspace.toml");
  await writeFile(
    workspace,
    `version = 1\nname = "Coding evaluation"\nmembers = [${JSON.stringify(directory.replaceAll("\\", "/"))}]\n`,
  );
  const env: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...childEnv(),
      ...memtrace!.env,
      MEMTRACE_MEMDB_DATA_DIR: join(anchor, ".memdb"),
      MEMTRACE_DATA_DIR: join(anchor, ".memtrace"),
      MEMTRACE_NO_WATCH_RESTORE: "1",
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key];
  env.PATH = [
    dirname(git!.command),
    `${process.env.SystemRoot}/System32`,
    process.env.SystemRoot,
    dirname(process.execPath),
  ].join(";");
  const native = {
    command: memtrace!.command,
    args: [...memtrace!.prefix, "mcp", "--workspace-file", workspace],
    cwd: directory,
    env,
  };
  const transport = new StdioClientTransport({ ...native, stderr: "pipe" });
  const owner = new Client({ name: "memcode-coding-evaluation", version: "1" });
  let errors = "";
  transport.stderr?.on(
    "data",
    (chunk) => (errors = (errors + chunk).slice(-20000)),
  );
  await owner.connect(transport);
  const call = async (name: string, args: any) =>
    unwrap(
      await owner.callTool({ name, arguments: args }, undefined, {
        timeout: 120000,
      }),
    );
  try {
    await call("list_indexed_repositories", {});
    const scope = JSON.parse(
      await readFile(
        join(anchor, ".memdb", ".memtrace-store-scope.json"),
        "utf8",
      ),
    );
    const job = await call("index_directory", {
      path: directory,
      repo_id: repoId,
      skip_embed: true,
    });
    if (!job.job_id && !job.skipped)
      throw Error("Fixture indexing did not start");
    for (let n = 0; n < 120; n++) {
      const state = job.job_id
        ? await call("check_job_status", { job_id: job.job_id })
        : await call("get_query_revision", { repo_id: repoId });
      if (state.status === "completed" || state.ready === true) break;
      if (state.status === "failed" || n === 119)
        throw Error("Fixture index failed: " + JSON.stringify(state));
      await new Promise((r) => setTimeout(r, 500));
    }
    const repos = await call("list_indexed_repositories", {}),
      rows = Array.isArray(repos) ? repos : (repos.repos ?? []);
    if (rows.length !== 1 || rows[0].repo_id !== repoId)
      throw Error("Fixture scope contains another repository");
    const binding: ContextBinding = {
      project: {
        id,
        name: "Coding evaluation",
        description: "Disposable fixture",
        path: directory,
        repoId,
        branch: "main",
        analysis: "ready",
        createdAt: new Date().toISOString(),
      },
      workerId: id,
      branch: "main",
      scope: [],
    };
    return {
      directory,
      anchor,
      native,
      owner,
      call,
      binding,
      scope,
      tools: (await owner.listTools()).tools,
      close: async () => {
        await writeFile(join(anchor, "engine-stderr.log"), errors);
        await owner.close();
      },
    };
  } catch (error) {
    await owner.close();
    throw error;
  }
}

function oracle(caseName: Case) {
  return `import assert from 'node:assert/strict';
import {total} from './src/pricing.mjs';import {makeReceipt} from './src/receipt.mjs';import {checkout} from './src/checkout.mjs';
const checks=[];function check(name,fn){try{fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:String(error)});}}
const lines=[{quantity:2,unitPrice:5},{quantity:1,unitPrice:2}];
check('old total',()=>assert.equal(total(lines),12));
check('old receipt',()=>assert.deepEqual(makeReceipt(lines),{amount:12,currency:'DKK'}));
check('checkout compatibility',()=>assert.deepEqual(checkout(lines),{amount:12,currency:'DKK'}));
check('empty',()=>assert.equal(total([]),0));
check('cents rounding',()=>assert.equal(total([{quantity:1,unitPrice:1.005}]),1.01));
${
  caseName === "signature"
    ? `
for(const rate of [0,0.1,0.5,1]){
check('discount '+rate,()=>assert.equal(total(lines,rate),Math.round((12*(1-rate)+Number.EPSILON)*100)/100));
check('receipt forwards '+rate,()=>assert.deepEqual(makeReceipt(lines,rate),{amount:Math.round((12*(1-rate)+Number.EPSILON)*100)/100,currency:'DKK'}));}
for(const rate of [-1,-0.01,1.1,NaN,Infinity,-Infinity]){
check('reject total '+String(rate),()=>assert.throws(()=>total(lines,rate),RangeError));
check('reject receipt '+String(rate),()=>assert.throws(()=>makeReceipt(lines,rate),RangeError));}
check('undefined discount',()=>assert.equal(total(lines,undefined),12));
check('round after discount',()=>assert.equal(total([{quantity:1,unitPrice:1.005}],0.5),0.5));
check('no input mutation',()=>{const frozen=Object.freeze([Object.freeze({quantity:2,unitPrice:5})]);assert.equal(total(frozen,0.1),9);});
`
    : `
for(const [label,quantity,expected] of [['zero',0,0],['null',null,9],['undefined',undefined,9],['two',2,18],['negative',-1,-9]]){
const item={quantity,unitPrice:9};check('quantity '+label,()=>assert.equal(total([item]),expected));
check('receipt '+label,()=>assert.deepEqual(makeReceipt([item]),{amount:expected,currency:'DKK'}));
check('checkout '+label,()=>assert.deepEqual(checkout([item]),{amount:expected,currency:'DKK'}));}
check('missing quantity',()=>assert.equal(total([{unitPrice:9}]),9));
check('mixed quantities',()=>assert.equal(total([{quantity:0,unitPrice:9},{quantity:null,unitPrice:3},{quantity:2,unitPrice:2.5}]),8));
check('no input mutation',()=>{const frozen=Object.freeze([Object.freeze({quantity:0,unitPrice:9})]);assert.equal(total(frozen),0);});
`
}
console.log(JSON.stringify({passed:checks.every(c=>c.passed),passedCount:checks.filter(c=>c.passed).length,total:checks.length,checks}));
if(checks.some(c=>!c.passed))process.exitCode=1;`;
}

async function evaluate(
  id: string,
  caseName: Case,
  variant: Variant,
  repetition: number,
) {
  console.log(`Preparing ${id}`);
  const f = await fixture(id, caseName),
    workerDirectory = join(f.directory, ".memcode", "worker");
  await mkdir(workerDirectory, { recursive: true });
  let session: Awaited<ReturnType<typeof startContextSession>> | undefined;
  try {
    if (variant === "broker")
      session = await startContextSession(
        { call: (_project, name, args) => f.call(name, args) },
        f.binding,
        workerDirectory,
      );
    const audit = join(workerDirectory, "mcp-audit.jsonl"),
      proxyConfig = join(workerDirectory, "proxy.json");
    const target = session
      ? {
          command: process.execPath,
          args: [
            resolve("dist-runtime/context-gateway.cjs"),
            session.configPath,
          ],
          cwd: f.directory,
        }
      : f.native;
    await writeFile(proxyConfig, JSON.stringify({ ...target, audit }), {
      mode: 0o600,
    });
    const server = {
      command: process.execPath,
      args: [resolve("scripts/context-evaluation-proxy.mjs"), proxyConfig],
      enabled: true,
      required: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    };
    const prompt =
      tasks[caseName] +
      "\n\n" +
      (variant === "baseline"
        ? "Use the full Memtrace server for repository discovery, observed callers, change impact and applicable constraints when relevant. Native source reads, edits and test commands remain available."
        : brokerInstructions +
          "\nMemCode is the approved host implementation of Memtrace retrieval for this worker. Ask it for repository understanding and change impact when relevant; native source reads, edits and test commands remain available.");
    let args: string[];
    if (harness === "codex") {
      const discovered = await run(
        command!,
        ["mcp", "list", "--json"],
        f.directory,
      );
      if (discovered.code !== 0)
        throw Error("Codex MCP discovery failed: " + discovered.stderr);
      const map: Record<string, any> = {};
      for (const entry of JSON.parse(discovered.stdout)) {
        const transport = entry.transport;
        map[entry.name] =
          transport.type === "stdio"
            ? {
                command: transport.command,
                args: transport.args ?? [],
                enabled: false,
              }
            : { url: transport.url, enabled: false };
      }
      map[variant === "baseline" ? "memtrace" : "memcode_context"] = server;
      args = [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "-C",
        f.directory,
        "-m",
        model,
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        "mcp_servers=" + toml(map),
        "-",
      ];
      const configCheck = await run(
        command!,
        ["-c", "mcp_servers=" + toml(map), "mcp", "list", "--json"],
        f.directory,
      );
      if (configCheck.code !== 0)
        throw Error("Codex per-run MCP config rejected: " + configCheck.stderr);
    } else {
      await mkdir(join(f.directory, ".cursor"), { recursive: true });
      const cursorServer = { command: server.command, args: server.args };
      const inherited =
        JSON.parse(
          await readFile(join(homedir(), ".cursor", "mcp.json"), "utf8").catch(
            () => "{}",
          ),
        ).mcpServers ?? {};
      const fixtureServers = Object.fromEntries(
        Object.entries(inherited).map(([name, config]) => [
          name,
          { ...(config as object), disabled: true },
        ]),
      );
      fixtureServers[variant === "baseline" ? "memtrace" : "memcode-context"] =
        cursorServer as any;
      await writeFile(
        join(f.directory, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: fixtureServers }),
        { mode: 0o600 },
      );
      await writeFile(
        join(f.directory, ".cursor", "cli.json"),
        JSON.stringify({
          permissions: {
            allow: [
              "Read(**)",
              "Write(src/pricing.mjs)",
              ...(caseName === "signature" ? ["Write(src/receipt.mjs)"] : []),
              "Shell(node)",
              "Shell(git)",
              variant === "baseline"
                ? "Mcp(memtrace:*)"
                : "Mcp(memcode-context:*)",
            ],
            deny: [],
          },
        }),
      );
      args = [
        "--print",
        "--trust",
        "--approve-mcps",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--workspace",
        f.directory,
        prompt,
      ];
    }
    const initialHead = (
      await gitText(f.directory, ["rev-parse", "HEAD"])
    ).trim();
    const hostConfigFiles =
      harness === "cursor" ? [".cursor/mcp.json", ".cursor/cli.json"] : [];
    const hostConfigs = await Promise.all(
      hostConfigFiles.map((file) => readFile(join(f.directory, file), "utf8")),
    );
    await writeFile(join(workerDirectory, "prompt.txt"), prompt);
    const result = await run(
      command!,
      args,
      f.directory,
      harness === "codex" ? prompt : "",
      true,
    );
    await writeFile(join(workerDirectory, "stream.jsonl"), result.stdout);
    await writeFile(
      join(workerDirectory, "events-timed.jsonl"),
      result.events.map((event: any) => JSON.stringify(event)).join("\n") +
        "\n",
    );
    await writeFile(join(workerDirectory, "stderr.log"), result.stderr);
    const events = parseLines(result.stdout),
      final = events.findLast((e: any) => e.type === "result"),
      turn = events.findLast((e: any) => e.type === "turn.completed");
    const auditEvents = parseLines(
      await readFile(audit, "utf8").catch(() => ""),
    );
    const diagnostics = parseLines(
      await readFile(
        join(workerDirectory, "context-diagnostics.jsonl"),
        "utf8",
      ).catch(() => ""),
    );
    const oracleRun = await run(
      { command: process.execPath, prefix: [] },
      ["--input-type=module"],
      f.directory,
      oracle(caseName),
    );
    const oracleResult = parseLines(oracleRun.stdout).at(-1) ?? {
      passed: false,
      output: oracleRun.stdout + oracleRun.stderr,
    };
    const existing = await run(
      { command: process.execPath, prefix: [] },
      ["--test"],
      f.directory,
    );
    const changed = (await gitText(f.directory, ["diff", "--name-only"]))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const untracked = (
      await gitText(f.directory, ["ls-files", "--others", "--exclude-standard"])
    )
      .trim()
      .split(/\r?\n/)
      .filter((file) => Boolean(file) && !hostConfigFiles.includes(file));
    const allowed =
      caseName === "bug"
        ? ["src/pricing.mjs"]
        : ["src/pricing.mjs", "src/receipt.mjs"];
    const diff = await gitText(f.directory, ["diff"]),
      head = (await gitText(f.directory, ["rev-parse", "HEAD"])).trim(),
      branch = (
        await gitText(f.directory, ["branch", "--show-current"])
      ).trim();
    await writeFile(join(workerDirectory, "worker.diff"), diff);
    const init = events.find(
      (e: any) => e.type === "system" && e.subtype === "init",
    );
    const calls = auditEvents.filter((e: any) => e.phase === "request"),
      responses = auditEvents.filter((e: any) => e.phase === "response");
    const beforeEdit = responses.filter(
      (e: any) =>
        result.firstSourceChange !== null &&
        e.at < result.firstSourceChange &&
        !e.isError &&
        !e.error,
    );
    return {
      id,
      harness,
      model,
      case: caseName,
      variant,
      repetition,
      fixture: f.directory,
      code: result.code,
      timedOut: result.timedOut,
      latencyMs: result.latencyMs,
      startedAt: result.startedAt,
      firstSourceChange: result.firstSourceChange,
      promptChars: prompt.length,
      usage: turn?.usage ?? final?.usage ?? null,
      actualModel: init?.model ?? null,
      initTools: init?.tools ?? null,
      initSkills: init?.skills ?? init?.slash_commands ?? null,
      fullMemtraceCatalog: {
        count: f.tools.length,
        characters: JSON.stringify(f.tools).length,
      },
      retrieval: {
        calls,
        responses,
        successfulBeforeFirstEdit: beforeEdit.map((e: any) => e.tool),
        diagnosticsCount: diagnostics.length,
      },
      quality: {
        independent: oracleResult,
        existingTestsPassed: existing.code === 0,
        scopePreserved:
          changed.every((file) => allowed.includes(file)) &&
          untracked.length === 0,
        changedFiles: changed,
        untracked,
        branchPreserved: branch === "main",
        headPreserved: head === initialHead,
        hostConfigPreserved: (
          await Promise.all(
            hostConfigFiles.map((file) =>
              readFile(join(f.directory, file), "utf8").catch(
                () => "<missing>",
              ),
            ),
          )
        ).every((text, index) => text === hostConfigs[index]),
        head,
        diffStats: (await gitText(f.directory, ["diff", "--numstat"])).trim(),
        existingTestOutput: existing.stdout + existing.stderr,
      },
      finalText:
        final?.result ??
        events
          .filter((e: any) => e.item?.type === "agent_message")
          .map((e: any) => e.item.text)
          .join("\n"),
      artifacts: {
        directory: workerDirectory,
        stream: join(workerDirectory, "stream.jsonl"),
        diff: join(workerDirectory, "worker.diff"),
        audit,
      },
      stderr: result.stderr.slice(-2000),
    };
  } finally {
    await session?.close();
    await f.close();
  }
}

let executed = 0;
await save();
try {
  outer: for (const caseName of ["signature", "bug"] as Case[]) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const variant of (repetition % 2
        ? ["baseline", "broker"]
        : ["broker", "baseline"]) as Variant[]) {
        const id = `${harness}-${caseName}-${repetition}-${variant}`;
        if (report.workers.some((worker: any) => worker.id === id)) continue;
        if (executed++ >= maxRuns) break outer;
        const worker = await evaluate(id, caseName, variant, repetition);
        report.workers.push(worker);
        await save();
        console.log(
          JSON.stringify({
            id,
            code: worker.code,
            oracle: worker.quality.independent.passed,
            tests: worker.quality.existingTestsPassed,
            scope: worker.quality.scopePreserved,
            usage: worker.usage,
            retrievalBeforeEdit: worker.retrieval.successfulBeforeFirstEdit,
            latencyMs: worker.latencyMs,
          }),
        );
      }
    }
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
}
await save();
console.log(`Saved ${report.workers.length} coding runs: ${out}`);
