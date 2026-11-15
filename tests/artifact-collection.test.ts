import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Artifact } from "../src/shared";
import { ArtifactCollection } from "../src/components/ArtifactCollection";

const artifact = (name: string, fields: Partial<Artifact> = {}): Artifact => ({
  id: name,
  name,
  kind: "text",
  path: "/project/.memcode/workers/story-one/artifacts/" + name,
  taskId: "story-one",
  projectId: "project-one",
  source: "claude",
  createdAt: "2026-11-15T18:00:00Z",
  ...fields,
});
const render = (artifacts: Artifact[], layout: "list" | "gallery" = "list") =>
  renderToStaticMarkup(
    createElement(ArtifactCollection, {
      artifacts,
      layout,
      tasks: [{ id: "story-one", identifier: "MC-007" }],
      onOpen: () => {},
    }),
  );

test("story output promotes the report and keeps investigation files unmounted until expanded", () => {
  const html = render([
    artifact("explore-watch.mts"),
    artifact("npm-test.log"),
    artifact("poster.svg", { kind: "image" }),
    artifact("REPORT.md"),
    artifact("calculator.ts"),
  ]);
  assert.ok(html.indexOf("REPORT.md") < html.indexOf("poster.svg"));
  assert.ok(html.indexOf("poster.svg") < html.indexOf("calculator.ts"));
  assert.match(html, /Report · Markdown/);
  assert.match(html, /Supporting evidence/);
  assert.match(html, /artifact-evidence-count">2</);
  assert.ok(!html.includes("explore-watch.mts"));
  assert.ok(!html.includes("npm-test.log"));
  assert.ok(!html.includes("artifact-evidence-files"));
  assert.ok(!/<details[^>]*\sopen/.test(html));
  assert.match(html, /MC-007/);
});

test("the global gallery mounts thumbnails only for primary output", () => {
  const html = render(
    [
      artifact("report.pdf"),
      artifact("drawing.png", { kind: "image" }),
      artifact("freshness.test.ts"),
      artifact("build.log"),
    ],
    "gallery",
  );
  assert.equal((html.match(/class="artifact-tile text"/g) ?? []).length, 1);
  assert.equal((html.match(/class="artifact-tile image"/g) ?? []).length, 1);
  assert.equal((html.match(/artifact-thumbnail format-/g) ?? []).length, 2);
  assert.ok(!html.includes("freshness.test.ts"));
  assert.ok(!html.includes("build.log"));
  assert.match(html, /artifact-evidence-count">2</);
});

test("explicit published code stays primary and an evidence-only collection remains discoverable", () => {
  const published = render([
    artifact("probe-engine.mts", { purpose: "deliverable" }),
  ]);
  assert.match(published, /probe-engine.mts/);
  assert.ok(!published.includes("Supporting evidence"));
  const evidence = render([artifact("run.log")]);
  assert.match(evidence, /Supporting files from the work are available below/);
  assert.match(evidence, /Supporting evidence/);
  assert.match(evidence, /artifact-evidence-count">1</);
  assert.ok(!evidence.includes("run.log"));
});
