import test from "node:test";
import assert from "node:assert/strict";
import { taskDraftTitle } from "../src/task-draft";
test("brief-only work items have a visible deterministic title while explicit titles take precedence", () => {
  assert.equal(
    taskDraftTitle("", "Add an export button.\nPreserve the report layout."),
    "Add an export button.",
  );
  assert.equal(
    taskDraftTitle("  Export reports  ", "Different first line"),
    "Export reports",
  );
  assert.equal(
    taskDraftTitle("  ", "\n\n# Improve sign-in\nDetails below"),
    "Improve sign-in",
  );
  assert.equal(taskDraftTitle(" ", "\n  "), "");
});
test("derived titles fit the server limit without dropping the complete brief", () => {
  const brief =
    "Implement " + "a".repeat(200) + "\nKeep all details in the brief.";
  const title = taskDraftTitle("", brief);
  assert.ok(title.length <= 160);
  assert.ok(title.endsWith("…"));
  assert.ok(brief.includes("Keep all details"));
});
