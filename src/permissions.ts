import type { Harness, Settings, WorkItem } from "./shared";

export const permissionModes = ["review", "auto", "full-access"] as const;
export type PermissionMode = (typeof permissionModes)[number];

export function effectivePermissionMode(
  task: Pick<WorkItem, "permissionMode" | "harness">,
  settings: Pick<Settings, "workerPermissionDefaults">,
  harness: Harness = task.harness,
): PermissionMode {
  return (
    task.permissionMode ??
    settings.workerPermissionDefaults?.[harness] ??
    "review"
  );
}

export const permissionLabels: Record<PermissionMode, string> = {
  review: "Review",
  auto: "Smart auto",
  "full-access": "Full access",
};

export function supportsPermissionMode(
  harness: Harness,
  mode: PermissionMode,
): boolean {
  // Cursor's installed ACP transport does not run its CLI Smart Auto classifier.
  return harness !== "cursor" || mode !== "auto";
}

export function permissionDescription(
  harness: Harness,
  mode: PermissionMode,
): string {
  if (mode === "full-access")
    return "Bypasses tool approvals and the harness sandbox where supported. Installed deny rules and administrator policies may still apply. Questions and Fleet decisions still come to you.";
  if (mode === "auto")
    return harness === "claude"
      ? "Claude’s native classifier reviews actions automatically and asks you when it needs a decision. Requires a model and account that support Auto mode."
      : harness === "cursor"
        ? "Cursor’s interactive ACP connection does not support Smart Auto yet. Choose Review or Full access."
        : "Codex’s native automatic reviewer evaluates permission requests; remaining decisions come to you. Workspace sandbox stays enabled.";
  return harness === "claude"
    ? "Allows file edits. Other actions follow Claude’s permission rules and ask you when approval is needed."
    : harness === "cursor"
      ? "Follows your Cursor permission rules. Actions needing approval are sent to you."
      : "Workspace sandbox stays enabled. Codex asks you when an action needs additional approval.";
}
