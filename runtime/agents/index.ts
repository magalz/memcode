import type { Harness } from "../../src/shared";
import type { AgentSessionOptions, AgentSession } from "./types";
import { startCodexSession } from "./codex";
import { startClaudeSession } from "./claude";
import { startCursorSession } from "./cursor";
export function startHarnessSession(
  harness: Harness,
  options: AgentSessionOptions,
): AgentSession {
  return harness === "codex"
    ? startCodexSession(options)
    : harness === "claude"
      ? startClaudeSession(options)
      : startCursorSession(options);
}
