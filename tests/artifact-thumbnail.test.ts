import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  truncate,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { readArtifactThumbnail } from "../runtime/artifact-thumbnail";
import type { Artifact } from "../src/shared";
import { within } from "../runtime/local";

async function fixture(
  run: (root: string, artifact: (name: string) => Artifact) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "memcode-thumbnail-test-")),
  );
  try {
    await run(root, (name) => ({
      id: name,
      name,
      kind: "text",
      path: join(root, name),
      taskId: "task",
      projectId: "project",
      source: "worker",
      createdAt: "2026-11-15T00:00:00Z",
    }));
  } finally {
    assert.ok(
      within(await realpath(tmpdir()), root) &&
        basename(root).startsWith("memcode-thumbnail-test-"),
    );
    await rm(root, { recursive: true, force: true });
  }
}

test("gallery thumbnail validates canonical artifact output boundary", async () => {
  await fixture(async (root, artifact) => {
    const allowed = join(root, "allowed"),
      sibling = join(root, "allowed-extra");
    await mkdir(allowed);
    await mkdir(sibling);
    const candidate = {
      ...artifact("report.md"),
      path: join(sibling, "report.md"),
    };
    await writeFile(candidate.path, "private outside output");
    await assert.rejects(
      readArtifactThumbnail(candidate, [allowed]),
      /outside the output folders/,
    );
  });
});

test("gallery content previews strip active HTML and bound text reads", async () => {
  await fixture(async (root, artifact) => {
    const html = artifact("site.html");
    await writeFile(
      html.path,
      "<html><head><title>Orbit &amp; stars</title><script>secretScript()</script><style>secretStyle</style></head><body><h1>Mission control</h1><p>Real saved content.</p></body></html>",
    );
    const page = await readArtifactThumbnail(html, [root]);
    assert.equal(page.kind, "document");
    if (page.kind !== "document") return;
    assert.equal(page.title, "Orbit & stars");
    assert.ok(page.lines.some((line) => line.includes("Real saved content.")));
    assert.ok(!page.lines.join("\n").includes("secret"));
    const text = artifact("large.md");
    await writeFile(
      text.path,
      "# Real heading\n" + "A".repeat(60_000) + "SENTINEL_AFTER_LIMIT",
    );
    const excerpt = await readArtifactThumbnail(text, [root]);
    assert.equal(excerpt.kind, "document");
    assert.ok(JSON.stringify(excerpt).length < 6000);
    assert.ok(!JSON.stringify(excerpt).includes("SENTINEL_AFTER_LIMIT"));
  });
});

test("Office gallery previews use actual first sheet, slide and document text", async () => {
  await fixture(async (root, artifact) => {
    const docs = [
      [
        "plan.docx",
        "word/document.xml",
        "<w:document><w:p><w:r><w:t>Mission plan</w:t></w:r></w:p><w:p><w:r><w:t>Reach Europa</w:t></w:r></w:p></w:document>",
      ],
      [
        "deck.pptx",
        "ppt/slides/slide1.xml",
        "<p:sld><a:p><a:r><a:t>Ocean observatory</a:t></a:r></a:p><a:p><a:r><a:t>Deep blue</a:t></a:r></a:p></p:sld>",
      ],
    ];
    for (const [name, path, xml] of docs) {
      const file = artifact(name);
      await writeFile(file.path, zipSync({ [path]: strToU8(xml) }));
      const preview = await readArtifactThumbnail(file, [root]);
      assert.equal(preview.kind, "document");
      if (preview.kind === "document")
        assert.ok(preview.title && preview.lines.length === 1);
    }
    const file = artifact("budget.xlsx");
    await writeFile(
      file.path,
      zipSync({
        "xl/workbook.xml": strToU8(
          '<workbook><sheets><sheet name="Budget &amp; plan" sheetId="1"/></sheets></workbook>',
        ),
        "xl/sharedStrings.xml": strToU8(
          "<sst><si><t>Mission</t></si><si><t>Europa</t></si></sst>",
        ),
        "xl/worksheets/sheet1.xml": strToU8(
          '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row><c r="A2"><v>42</v></c></row></sheetData></worksheet>',
        ),
      }),
    );
    const preview = await readArtifactThumbnail(file, [root]);
    assert.equal(preview.kind, "document");
    if (preview.kind === "document") {
      assert.equal(preview.title, "Budget & plan");
      assert.deepEqual(preview.rows?.[0], ["Mission", "", "Europa"]);
      assert.deepEqual(preview.rows?.[1], ["42"]);
    }
  });
});

test("gallery returns bounded binary data and honest oversized/unsupported fallbacks", async () => {
  await fixture(async (root, artifact) => {
    const image = artifact("image.png");
    await writeFile(image.path, Buffer.from("iVBORw0KGgo=", "base64"));
    const preview = await readArtifactThumbnail(image, [root]);
    assert.equal(preview.kind, "image");
    if (preview.kind === "image")
      assert.ok(preview.dataUrl.startsWith("data:image/png;base64,"));
    const video = artifact("clip.mp4");
    await writeFile(video.path, "");
    await truncate(video.path, 8_000_001);
    const fallback = await readArtifactThumbnail(video, [root]);
    assert.equal(fallback.kind, "fallback");
    assert.ok(
      fallback.kind === "fallback" && fallback.detail?.includes("Large file"),
    );
    const office = artifact("old.doc");
    await writeFile(office.path, "binary");
    assert.equal(
      (await readArtifactThumbnail(office, [root])).kind,
      "fallback",
    );
  });
});
