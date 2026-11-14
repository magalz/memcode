/** Bounded, opt-in live evaluation. All workers and indexes operate in fresh temporary fixture repositories. */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findCommand, childEnv, type Command } from "../runtime/commands";
import { gitText } from "../runtime/context/source";
import { startContextSession } from "../runtime/context/host";
import {
  claudeProfileArgs,
  writeClaudeProfile,
  brokerInstructions,
} from "../runtime/context/profile";
import { OnnxAssistant } from "../runtime/context/onnx";
import type { ContextBinding, GraphClient } from "../runtime/context/contracts";

const root = await mkdtemp(join(tmpdir(), "memcode-context-eval-"));
const caseName =
  process.argv[process.argv.indexOf("--case") + 1] === "bug"
    ? "bug"
    : "signature";
const out = resolve(
  caseName === "bug"
    ? "docs/context-broker-evaluation-bug.json"
    : "docs/context-broker-evaluation.json",
);
const report: Record<string, any> = {
  version: 1,
  case: caseName,
  at: new Date().toISOString(),
  temporaryRoot: root,
  fixtureOnly: true,
  limitations: [
    "One small synthetic fixture per case/variant; not statistical evidence of general task savings.",
    "No native/shell hard fencing claim. Local token counts are tokenizer measurements, not provider billing.",
    "Graph indexing uses skip_embed=true to keep the experiment isolated and bounded; semantic retrieval is unavailable in this fixture.",
  ],
  retrieval: [],
  workers: [],
};
const command = await findCommand(
  "memtrace",
  process.env.MEMCODE_EVAL_MEMTRACE ?? "",
);
const gitCommand = await findCommand("git");
if (!command) throw new Error("Installed Memtrace CLI required");
function unwrap(value: any) {
  if (value.isError)
    throw new Error(value.content?.map((c: any) => c.text ?? "").join("\n"));
  for (const part of [...(value.content ?? [])].reverse())
    try {
      return JSON.parse(part.text);
    } catch {
      /* summary */
    }
  return value;
}
async function run(
  command: Command,
  args: string[],
  cwd: string,
  input = "",
  timeout = 180000,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}> {
  const at = performance.now();
  return new Promise((resolve, reject) => {
    const p = spawn(command.command, [...command.prefix, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...childEnv(), ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeout);
    p.stdout.on("data", (c) => {
      stdout += c;
    });
    p.stderr.on("data", (c) => {
      stderr += c;
    });
    p.once("error", reject);
    p.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        ms: Math.round(performance.now() - at),
        timedOut,
      });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}
async function fixture(variant: string) {
  const repoId = `context-${caseName}-${variant}-${Date.now().toString(36)}`;
  const directory = join(root, repoId),
    anchor = join(directory, ".memcode", "engine");
  await mkdir(join(directory, "src"), { recursive: true });
  await mkdir(anchor, { recursive: true });
  const files = {
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
  await gitText(directory, ["add", "."]);
  await gitText(directory, ["config", "core.autocrlf", "false"]);
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
    `version = 1\nname = "Context fixture"\nmembers = [${JSON.stringify(directory.replaceAll("\\", "/"))}]\n`,
  );
  const env = Object.fromEntries(
    Object.entries({
      ...childEnv(),
      ...command!.env,
      MEMTRACE_MEMDB_DATA_DIR: join(anchor, ".memdb"),
      MEMTRACE_DATA_DIR: join(anchor, ".memtrace"),
      MEMTRACE_NO_WATCH_RESTORE: "1",
    }).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  if (process.platform === "win32") {
    // The native engine requires a bounded, usable Git PATH, independent of long desktop PATHs.
    for (const key of Object.keys(env))
      if (key.toLowerCase() === "path") delete env[key];
    env.PATH = [
      gitCommand ? dirname(gitCommand.command) : "",
      `${process.env.SystemRoot}/System32`,
      process.env.SystemRoot,
      dirname(process.execPath),
    ]
      .filter(Boolean)
      .join(";");
  }
  const transport = new StdioClientTransport({
    command: command!.command,
    args: [...command!.prefix, "mcp", "--workspace-file", workspace],
    cwd: directory,
    env,
    stderr: "pipe",
  });
  const client = new Client({
    name: "memcode-context-evaluation",
    version: "1",
  });
  let engineStderr = "";
  transport.stderr?.on("data", (data) => {
    engineStderr = (engineStderr + data).slice(-20000);
  });
  await client.connect(transport);
  try {
    const call = async (name: string, args: any) =>
      unwrap(
        await client.callTool({ name, arguments: args }, undefined, {
          timeout: 120000,
        }),
      );
    await call("list_indexed_repositories", {});
    const scopeFile = JSON.parse(
      await readFile(
        join(anchor, ".memdb", ".memtrace-store-scope.json"),
        "utf8",
      ),
    );
    report.scopeVerification ??= [];
    report.scopeVerification.push({ variant, scopeFile });
    const job = await call("index_directory", {
      path: directory,
      repo_id: repoId,
      skip_embed: true,
    });
    if (!job.job_id && !job.skipped)
      throw new Error("Fixture index did not start: " + JSON.stringify(job));
    for (let n = 0; n < 120; n++) {
      const state = job.job_id
        ? await call("check_job_status", { job_id: job.job_id })
        : await call("get_query_revision", { repo_id: repoId });
      if (state.status === "completed" || state.ready === true) break;
      if (state.status === "failed" || n === 119)
        throw new Error("Fixture indexing failed: " + JSON.stringify(state));
      await new Promise((r) => setTimeout(r, 500));
    }
    const repos = await call("list_indexed_repositories", {}),
      rows = Array.isArray(repos) ? repos : (repos.repos ?? []);
    if (rows.length !== 1 || rows[0].repo_id !== repoId)
      throw new Error("Fixture store admitted unexpected repositories");
    const binding: ContextBinding = {
      project: {
        id: repoId,
        name: "Isolated evaluation",
        description: "Fixture",
        path: directory,
        repoId,
        branch: "main",
        analysis: "ready",
        createdAt: new Date().toISOString(),
      },
      workerId: "evaluation:" + variant,
      branch: "main",
      scope: [],
    };
    const graph: GraphClient = {
      call: (_project, name, args) => call(name, args),
    };
    const tools = (await client.listTools()).tools;
    await writeFile(join(anchor, "engine-stderr.log"), engineStderr);
    return {
      directory,
      anchor,
      binding,
      graph,
      tools,
      client,
      nativeConfig: {
        type: "stdio",
        command: command!.command,
        args: [...command!.prefix, "mcp", "--workspace-file", workspace],
        env,
      },
      call,
    };
  } catch (error) {
    await writeFile(join(anchor, "engine-stderr.log"), engineStderr);
    await client.close();
    throw error;
  }
}

function eventSummary(stdout: string) {
  const events = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.findLast((e) => e.type === "result");
  return {
    events,
    summary: {
      initTools: init?.tools ?? [],
      skills: init?.skills ?? init?.slash_commands ?? [],
      mcpServers: init?.mcp_servers ?? [],
      actualUsage:
        result?.usage ??
        events.findLast((e) => e.type === "turn.completed")?.usage ??
        null,
      modelUsage: result?.modelUsage ?? null,
      totalCostUsd: result?.total_cost_usd ?? null,
      resultSubtype: result?.subtype ?? null,
      toolCalls: events
        .flatMap((e) => e.message?.content ?? [])
        .filter((c) => c.type === "tool_use")
        .map((c) => ({ name: c.name, input: c.input })),
      finalText:
        result?.result ??
        events
          .filter((e) => e.item?.type === "agent_message")
          .map((e) => e.item.text)
          .join("\n"),
    },
  };
}
const task =
  caseName === "bug"
    ? "Investigate this invoice symptom: a line with quantity zero and unit price 9 is still charged 9. Find the calculation from that description, explain observed callers, assess the implementation fix, and fix it. Preserve default quantity 1 only when quantity is null or undefined; zero must stay zero. Preserve roundCents and DKK currency. Edit only src/pricing.mjs. Run node --test. Report source references, applicable constraints, actual checks and uncertainty. Keep this bounded."
    : "Locate the code that converts quantities and unit prices to an invoice amount, describe its immediate callers, and assess a signature change. Then implement optional discountRate=0 in total(lines, discountRate) and makeReceipt(lines, discountRate), forwarding it from makeReceipt. Apply discount before roundCents. Valid rate is finite 0..1; reject invalid rates with RangeError. Preserve existing one-argument behavior, caller compatibility and DKK currency. Only edit src/pricing.mjs and src/receipt.mjs. Run node --test. Report source references, constraints, actual checks and uncertainty. Keep this bounded; no broad exploration.";
const variants = process.argv.includes("--claude")
  ? ["baseline", "broker", "local"]
  : ["broker", "local"];
try {
  for (const variant of variants) {
    process.stdout.write(`Preparing isolated ${variant} fixture\n`);
    const f = await fixture(variant);
    let session: Awaited<ReturnType<typeof startContextSession>> | undefined;
    const packageDirectory = process.env.MEMCODE_CONTEXT_TRANSFORMERS_DIR;
    const assistant =
      variant === "local" && packageDirectory
        ? new OnnxAssistant(packageDirectory)
        : undefined;
    try {
      session = await startContextSession(
        f.graph,
        f.binding,
        join(f.directory, ".memcode", "worker"),
        { assistant },
      );
      const gateway = resolve("dist-runtime/context-gateway.cjs");
      const config = await writeClaudeProfile(
        join(f.directory, ".memcode", "worker"),
        gateway,
        session.configPath,
      );
      const initial = await session.broker.execute({
        capability: "find",
        query: "quantity unit price invoice amount",
        budgetChars: 12000,
      });
      const understood = await session.broker.execute({
        capability: "understand",
        target: { symbol: "total", file: "src/pricing.mjs" },
        budgetChars: 14000,
      });
      const assessed = await session.broker.execute({
        capability: "assess",
        targets: [{ symbol: "total", file: "src/pricing.mjs" }],
        change: "signature",
        intent: "Add optional discountRate while preserving callers",
        budgetChars: 16000,
      });
      report.retrieval.push({
        variant,
        fullCatalogCount: f.tools.length,
        fullCatalogChars: JSON.stringify(f.tools).length,
        gatewayCatalogCount: 3,
        steps: [initial, understood, assessed].map((pack) => ({
          capability: pack.capability,
          chars: JSON.stringify(pack).length,
          revision: pack.revision,
          telemetry: pack.telemetry,
          coverage: pack.coverage,
          sourceFiles: pack.evidence
            .filter((e) => e.ref)
            .map((e) => e.ref!.file),
          preservedProjectRules: pack.constraints.some(
            (c) => c.origin === "project-rules",
          ),
        })),
      });
      if (!process.argv.includes("--claude")) continue;
      const claude = await findCommand("claude");
      if (!claude) {
        report.workers.push({ harness: "claude", variant, unavailable: true });
        continue;
      }
      const baselineConfig = join(f.directory, ".memcode", "baseline-mcp.json");
      await writeFile(
        baselineConfig,
        JSON.stringify({ mcpServers: { memtrace: f.nativeConfig } }),
      );
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--effort",
        "low",
        "--model",
        "haiku",
        "--max-budget-usd",
        "1.0",
        "--no-session-persistence",
        ...(variant === "baseline"
          ? ["--strict-mcp-config", "--mcp-config", baselineConfig]
          : claudeProfileArgs(config)),
        "--allowedTools",
        "Bash(node *)",
        variant === "baseline" ? "mcp__memtrace__*" : "mcp__memcode-context__*",
      ];
      const prompt = `${task}\n\n${variant === "baseline" ? "Use the full Memtrace server for graph retrieval and constraints before editing." : brokerInstructions + "\nUse all three gateway capabilities before editing. Initial host evidence:\n" + JSON.stringify(initial)}`;
      const result = await run(claude, args, f.directory, prompt);
      await writeFile(join(f.anchor, "claude-stream.jsonl"), result.stdout);
      await writeFile(join(f.anchor, "claude-stderr.log"), result.stderr);
      const { summary } = eventSummary(result.stdout);
      const oracle =
        caseName === "bug"
          ? "import assert from 'node:assert/strict';import {total} from './src/pricing.mjs';import {makeReceipt} from './src/receipt.mjs';assert.equal(total([{quantity:0,unitPrice:9}]),0);assert.equal(total([{unitPrice:9}]),9);assert.equal(total([{quantity:null,unitPrice:9}]),9);assert.deepEqual(makeReceipt([{quantity:0,unitPrice:9}]),{amount:0,currency:'DKK'});assert.equal(total([{quantity:1,unitPrice:1.005}]),1.01);console.log('All independent zero/null/missing quantity, currency and rounding assertions passed');"
          : "import assert from 'node:assert/strict';import {total} from './src/pricing.mjs';import {makeReceipt} from './src/receipt.mjs';const lines=[{quantity:2,unitPrice:5},{quantity:1,unitPrice:2}];assert.equal(total(lines),12);assert.equal(total(lines,0.1),10.8);assert.deepEqual(makeReceipt(lines,0.1),{amount:10.8,currency:'DKK'});for(const rate of [-1,1.1,NaN,Infinity])assert.throws(()=>total(lines,rate),RangeError);assert.equal(total([{quantity:1,unitPrice:1.005}],0),1.01);console.log('All independent discount/currency/rounding assertions passed');";
      const verification = await run(
        { command: process.execPath, prefix: [] },
        ["--input-type=module", "-e", oracle],
        f.directory,
      );
      const tests = await run(
        { command: process.execPath, prefix: [] },
        ["--test"],
        f.directory,
      );
      const changed = (await gitText(f.directory, ["diff", "--name-only"]))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const diff = await gitText(f.directory, ["diff"]);
      await writeFile(join(f.anchor, "worker.diff"), diff);
      report.workers.push({
        harness: "claude",
        variant,
        fixture: f.directory,
        code: result.code,
        latencyMs: result.ms,
        timedOut: result.timedOut,
        promptChars: prompt.length,
        ...summary,
        quality: {
          independentOraclePassed: verification.code === 0,
          oracleOutput: verification.stdout + verification.stderr,
          existingTestsPassed: tests.code === 0,
          scopePreserved: changed.every((file) =>
            ["src/pricing.mjs", "src/receipt.mjs"].includes(file),
          ),
          changedFiles: changed,
          diffFile: join(f.anchor, "worker.diff"),
        },
        stderr: result.stderr.slice(-1000),
      });
      process.stdout.write(
        `${variant}: worker exit ${result.code}; independent oracle ${verification.code}; ${result.ms} ms\n`,
      );
    } finally {
      await session?.close();
      assistant?.close();
      await f.client.close();
    }
    await mkdir(resolve("docs"), { recursive: true });
    await writeFile(out, JSON.stringify(report, null, 2));
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
}
await mkdir(resolve("docs"), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2));
process.stdout.write(
  `Evaluation report: ${out}\nRetained isolated fixtures: ${root}\n`,
);
