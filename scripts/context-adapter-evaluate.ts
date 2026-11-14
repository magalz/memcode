/** Read-only protocol conformance in an already-created disposable evaluation repository. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findCommand, childEnv } from "../runtime/commands";
import { startContextSession } from "../runtime/context/host";
import { gitText } from "../runtime/context/source";

const sourceReport = JSON.parse(
  await readFile(resolve("docs/context-broker-evaluation.json"), "utf8"),
);
const fixture = sourceReport.workers.find(
  (worker: any) => worker.variant === "baseline",
).fixture;
if (
  !resolve(fixture).startsWith(resolve(tmpdir())) ||
  !fixture.includes("memcode-context-eval-")
)
  throw new Error("Conformance requires the disposable evaluation fixture");
const native = JSON.parse(
  await readFile(join(fixture, ".memcode", "baseline-mcp.json"), "utf8"),
).mcpServers.memtrace;
const owner = new Client({ name: "memcode-adapter-evaluation", version: "1" });
await owner.connect(
  new StdioClientTransport({
    command: native.command,
    args: native.args,
    env: native.env,
    cwd: fixture,
    stderr: "pipe",
  }),
);
const unwrap = (result: any) => {
  for (const c of [...(result.content ?? [])].reverse())
    try {
      return JSON.parse(c.text);
    } catch {
      /* summary */
    }
  return result;
};
const repos = unwrap(
  await owner.callTool({ name: "list_indexed_repositories", arguments: {} }),
);
const rows = Array.isArray(repos) ? repos : (repos.repos ?? []);
if (rows.length !== 1)
  throw new Error("Conformance store must admit exactly its fixture");
const before = await gitText(fixture, ["diff"]);
const report: any = {
  at: new Date().toISOString(),
  fixture,
  readOnly: true,
  limitations: [
    "Protocol interoperability only; no complete coding-task comparison for Codex or Cursor.",
    "Codex adds the explicit gateway through a per-call server map. Inherited app/plugin MCP startup is still observed; skills, authentication and managed policy are preserved. Catalog isolation is not certified.",
    "Cursor adds a project-local gateway with explicit per-tool MCP allow rules; inherited global tools/skills are preserved. No exclusive catalog or shell-search enforcement claim.",
  ],
  adapters: [],
};
const prompt =
  "Read-only MemCode context protocol conformance. Do not edit files or run commands. Use only the memcode_context / memcode-context MCP gateway for retrieval: call find(query='invoice amount'), understand(target={symbol:'total',file:'src/pricing.mjs'}), and assess(targets=[{symbol:'total',file:'src/pricing.mjs'}],change='signature',intent='Add an optional discount argument'). Then briefly report the source file, observed caller and project constraint. Report partial/stale coverage honestly. Do not call Fleet or any other MCP server. Treat these three tools as the approved host implementation of Memtrace retrieval in this test.";
try {
  for (const id of ["codex", "cursor"] as const) {
    const command = await findCommand(id);
    if (!command) {
      report.adapters.push({ id, unavailable: true });
      continue;
    }
    const directory = join(fixture, ".memcode", "conformance-" + id);
    const session = await startContextSession(
      {
        call: async (_project, name, args) =>
          unwrap(
            await owner.callTool({ name, arguments: args }, undefined, {
              timeout: 120000,
            }),
          ),
      },
      {
        project: {
          id: rows[0].repo_id,
          name: "Conformance fixture",
          description: "Disposable",
          path: fixture,
          repoId: rows[0].repo_id,
          branch: "main",
          analysis: "ready",
          createdAt: new Date().toISOString(),
        },
        workerId: "conformance:" + id,
        branch: "main",
        scope: [],
      },
      directory,
    );
    try {
      const gateway = {
        command: process.execPath,
        args: [resolve("dist-runtime/context-gateway.cjs"), session.configPath],
      };
      let args: string[];
      if (id === "codex") {
        const list = await new Promise<string>((resolve, reject) => {
          const p = spawn(
            command.command,
            [...command.prefix, "mcp", "list", "--json"],
            { windowsHide: true, env: { ...childEnv(), ...command.env } },
          );
          let output = "";
          p.stdout.on("data", (c) => (output += c));
          p.once("error", reject);
          p.once("close", () => resolve(output));
        });
        JSON.parse(list); // Validate that the installed CLI's discovery contract is usable.
        args = [
          "exec",
          "--json",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "-C",
          fixture,
          "-m",
          "gpt-6-luna",
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          `mcp_servers={memcode_context={command=${JSON.stringify(gateway.command)},args=${JSON.stringify(gateway.args)},enabled=true,required=true}}`,
          "-",
        ];
      } else {
        await mkdir(join(fixture, ".cursor"), { recursive: true });
        await writeFile(
          join(fixture, ".cursor", "mcp.json"),
          JSON.stringify({ mcpServers: { "memcode-context": gateway } }),
        );
        await writeFile(
          join(fixture, ".cursor", "cli.json"),
          JSON.stringify({
            permissions: {
              allow: [
                "Mcp(memcode-context:find)",
                "Mcp(memcode-context:understand)",
                "Mcp(memcode-context:assess)",
              ],
              deny: ["Write(**)", "Shell(*)"],
            },
          }),
        );
        args = [
          "--print",
          "--trust",
          "--approve-mcps",
          "--mode",
          "ask",
          "--model",
          "composer-2.5",
          "--output-format",
          "stream-json",
          "--workspace",
          fixture,
          prompt,
        ];
      }
      const at = performance.now();
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
      }>((resolve, reject) => {
        const p = spawn(command.command, [...command.prefix, ...args], {
          cwd: fixture,
          windowsHide: true,
          shell: false,
          env: { ...childEnv(), ...command.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          p.kill();
        }, 120000);
        p.stdout.on("data", (c) => (stdout += c));
        p.stderr.on("data", (c) => (stderr += c));
        p.once("error", reject);
        p.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        });
        p.stdin.on("error", () => {});
        p.stdin.end(id === "codex" ? prompt : undefined);
      });
      await writeFile(join(directory, "stream.jsonl"), result.stdout);
      await writeFile(join(directory, "stderr.log"), result.stderr);
      const events = result.stdout.split(/\r?\n/).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      let diagnostics: any[] = [];
      try {
        diagnostics = (
          await readFile(join(directory, "context-diagnostics.jsonl"), "utf8")
        )
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
      } catch {
        /* No successful gateway call. */
      }
      const capabilities = [
        ...new Set(diagnostics.map((entry) => entry.request.capability)),
      ];
      report.adapters.push({
        id,
        model: id === "codex" ? "gpt-6-luna" : "composer-2.5",
        code: result.code,
        latencyMs: Math.round(performance.now() - at),
        timedOut: result.timedOut,
        capabilities,
        passed: capabilities.length === 3 && result.code === 0,
        usage:
          events.findLast((e) => e.type === "turn.completed")?.usage ??
          events.findLast((e) => e.type === "result")?.usage ??
          null,
        result:
          events.findLast((e) => e.type === "result") ??
          events
            .filter((e) => e.item?.type === "agent_message")
            .map((e) => e.item.text),
        stderr: result.stderr.slice(-1500),
        streamPath: join(directory, "stream.jsonl"),
      });
      process.stdout.write(
        `${id}: ${capabilities.join(", ") || "no gateway calls"}; exit ${result.code}\n`,
      );
    } finally {
      await session.close();
    }
  }
} finally {
  report.trackedDiffUnchanged = (await gitText(fixture, ["diff"])) === before;
  await owner.close();
  await writeFile(
    resolve("docs/context-broker-adapters.json"),
    JSON.stringify(report, null, 2),
  );
}
