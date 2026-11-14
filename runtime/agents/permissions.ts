import type { Harness } from "../../src/shared";

/** Transport-owned permissions cannot be replaced by inherited profile arguments. */
export function withoutPermissionArgs(
  harness: Harness,
  args: string[],
): string[] {
  const output: string[] = [];
  const values =
    harness === "codex"
      ? ["--ask-for-approval", "-a", "--sandbox", "-s"]
      : harness === "claude"
        ? [
            "--permission-mode",
            "--permission-prompts",
            "--permission-prompt-tool",
          ]
        : ["--sandbox"];
  const flags =
    harness === "codex"
      ? ["--dangerously-bypass-approvals-and-sandbox", "--full-auto"]
      : harness === "claude"
        ? [
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
          ]
        : ["--force", "-f", "--yolo", "--auto-review"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.some((flag) => arg === flag || arg.startsWith(flag + "=")))
      continue;
    if (values.includes(arg)) {
      i++;
      continue;
    }
    if (values.some((flag) => arg.startsWith(flag + "="))) continue;
    if (harness === "codex" && ["-c", "--config"].includes(arg)) {
      const value = args[i + 1] ?? "";
      if (
        /^(approval_policy|approvals_reviewer|sandbox_mode|sandbox_workspace_write|permissions)(?:\.|\s*=)/.test(
          value,
        )
      ) {
        i++;
        continue;
      }
    }
    if (
      harness === "codex" &&
      /^--config=(approval_policy|approvals_reviewer|sandbox_mode|sandbox_workspace_write|permissions)(?:\.|\s*=)/.test(
        arg,
      )
    )
      continue;
    output.push(arg);
  }
  return output;
}
