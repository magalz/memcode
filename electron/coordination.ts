import type { WorkItem } from "../src/shared";
import type { Project } from "../src/shared";
import { resolve } from "node:path";

export function touchedIdentities(task: WorkItem, project?: Project): string[] {
  const symbols = (task.evidence?.symbols ?? []).map(
    (symbol) => symbol.nodeId ?? `${symbol.file}::${symbol.name}`,
  );
  const files = (task.scope ?? []).map((path) => {
    const full = resolve(project?.path ?? ".", path).replaceAll("\\", "/");
    return (
      "file::" + (process.platform === "win32" ? full.toLowerCase() : full)
    );
  });
  return [...new Set([...symbols, ...files])];
}
// A declared work category, not a semantic classification of the resulting diff.
export function declaredIntent(task: WorkItem): unknown {
  if (task.kind === "test")
    return { test_add: { covers: touchedIdentities(task) } };
  if (task.kind === "research") return "exploratory";
  if (task.kind === "refactor")
    return { refactor: { pattern: "extract_function" } };
  if (task.kind === "fix") return { bug_fix: { defect: "logic_error" } };
  return { feature_add: { surface: "new_symbol" } };
}
