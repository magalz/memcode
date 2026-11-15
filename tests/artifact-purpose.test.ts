import test from "node:test";
import assert from "node:assert/strict";
import { artifactPurpose, groupedArtifacts } from "../src/artifact-purpose";
import type { Artifact } from "../src/shared";
const artifact = (name: string, fields: Partial<Artifact> = {}): Artifact => ({
  id: name,
  name,
  path: `C:/project/.memcode/workers/task/artifacts/${name}`,
  kind: "text",
  taskId: "task",
  projectId: "project",
  source: "claude",
  createdAt: "2026-11-15T00:00:00Z",
  ...fields,
});

test("reports lead deliverables and supporting diagnostic files stay separate without mutating order", () => {
  const values = [
    artifact("site.html"),
    artifact("explore-watch.mts"),
    artifact("REPORT.md"),
    artifact("npm-build.log"),
    artifact("poster.svg"),
    artifact("quality-summary.pdf"),
  ];
  const result = groupedArtifacts(values);
  assert.deepEqual(
    result.primary.map((x) => x.name),
    ["REPORT.md", "quality-summary.pdf", "site.html", "poster.svg"],
  );
  assert.deepEqual(
    result.evidence.map((x) => x.name),
    ["explore-watch.mts", "npm-build.log"],
  );
  assert.equal(values[0].name, "site.html");
  assert.equal(result.primary[0], values[2]);
});

test("actual source and Office/media deliverables remain primary; diagnostic scripts use names or output folders", () => {
  for (const name of [
    "index.mts",
    "main.tsx",
    "worker.py",
    "live-dashboard.js",
    "analysis.ipynb",
    "data.jsonl",
    "plan.docx",
    "forecast.xlsx",
    "slides.pptx",
    "manual.pdf",
    "clip.mp4",
    "voice.wav",
  ])
    assert.equal(artifactPurpose(artifact(name)), "deliverable", name);
  for (const name of [
    "probe-engine.mts",
    "freshness.test.ts",
    "test_freshness.py",
    "live-owner-restart.mts",
    "live-freshness.mts",
    "page.inspect.ndjson",
  ])
    assert.equal(artifactPurpose(artifact(name)), "evidence", name);
  assert.equal(
    artifactPurpose(
      artifact("random.mjs", {
        path: "C:/project/.memcode/workers/task/artifacts/evidence/random.mjs",
      }),
    ),
    "evidence",
  );
});

test("explicit producer purpose wins and a project named evidence does not hide every output", () => {
  assert.equal(
    artifactPurpose(artifact("freshness.test.ts", { purpose: "deliverable" })),
    "deliverable",
  );
  assert.equal(
    artifactPurpose(artifact("report.log", { purpose: "report" })),
    "report",
  );
  assert.equal(
    artifactPurpose(artifact("REPORT.md", { purpose: "evidence" })),
    "evidence",
  );
  assert.equal(
    artifactPurpose(
      artifact("poster.svg", {
        path: "C:/repos/evidence/.memcode/workers/task/artifacts/poster.svg",
      }),
    ),
    "deliverable",
  );
  assert.equal(
    artifactPurpose(
      artifact("poster.svg", {
        path: "C:/MemCode/captures/evidence/poster.svg",
      }),
    ),
    "deliverable",
  );
});
