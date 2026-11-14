import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCodexSession } from "../runtime/agents/codex";
import { findCommand, childEnv } from "../runtime/commands";
import type { AgentEvent } from "../runtime/agents/types";
import type { WorkerInputPrompt } from "../src/worker-input";

// Explicit opt-in integration probe. Never runs as part of npm test or app boot.
if (!process.argv.includes("--run"))
  throw Error(
    "Pass --run to authorize one small gpt-6-luna model turn in a temporary folder.",
  );
const command = await findCommand("codex");
if (!command) throw Error("Codex is not installed.");
const cwd = await mkdtemp(join(tmpdir(), "memcode-codex-input-probe-"));
const nodeVersionCommand = `& '${process.execPath}' --version`;
const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const nativeVersionCommand = `${JSON.stringify(powershell)} -Command ${JSON.stringify(nodeVersionCommand)}`;
const prompts: WorkerInputPrompt[] = [],
  events: AgentEvent[] = [];
const session = startCodexSession({
  command,
  cwd,
  env: childEnv(),
  model: "gpt-6-luna",
  effort: "low",
  briefPath: "",
  toolArgs: ["-c", "mcp_servers.memtrace.enabled=false"],
  prompt: `This is an authorized minimal interactive integration test in an empty temporary folder. Do not inspect files or use network, skills, MCP, or unrelated commands. First call the native request_user_input tool with ONE question id=color, header=Color, question="Which color?", choices Green and Blue, both with brief descriptions. Wait for the tool answer. Then use the native command execution tool to run exactly the harmless command & '${process.execPath}' --version in PowerShell. Explicitly request sandbox escalation/approval for this command with the justification "MemCode integration probe: approve this one Node version check?" so the host receives a native command approval request. Do not amend policy or run anything else. Finish with one short sentence naming the selected color and Node version.`,
  onEvent(event) {
    events.push(event);
    if (event.type === "activity")
      console.log(
        JSON.stringify({ activity: event.label, phase: event.phase }),
      );
    if (event.type === "error")
      console.log(JSON.stringify({ error: event.message }));
  },
  async requestInput(prompt) {
    prompts.push(prompt);
    console.log(
      JSON.stringify({
        input: prompt.kind,
        title: prompt.title,
        questions: prompt.questions?.map((q) => ({
          id: q.id,
          allowText: q.allowText,
          options: q.options.map((o) => o.label),
        })),
        command: prompt.details,
      }),
    );
    if (prompt.kind === "question")
      return {
        answers: Object.fromEntries(
          (prompt.questions || []).map((q) => [
            q.id,
            q.options.find((o) => /^Green/.test(o.label))?.id ||
              q.options[0]?.id ||
              "Green",
          ]),
        ),
      };
    const once = prompt.options?.find((option) => option.kind === "allow-once");
    if (
      prompt.toolName === "commandExecution" &&
      prompt.details?.split("\nDirectory: ")[0] === nativeVersionCommand &&
      once
    )
      return { optionId: once.id };
    return { cancelled: true };
  },
});
const timer = setTimeout(() => session.stop(), 90_000);
const result = await session.completion;
clearTimeout(timer);
const text = events
  .filter((event) => event.type === "message" && event.role === "assistant")
  .map((event) => (event.type === "message" ? event.text : ""))
  .join("");
const report = {
  cwd,
  sessionId: events.find((event) => event.type === "session")?.sessionId,
  result,
  prompts,
  text,
  questionSeen: prompts.some((p) => p.kind === "question"),
  commandApprovalSeen: prompts.some((p) => p.toolName === "commandExecution"),
};
await writeFile(join(cwd, "evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (
  result.exitCode !== 0 ||
  !report.questionSeen ||
  !report.commandApprovalSeen
)
  process.exitCode = 1;
