import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initialState } from "../src/seed";
import { fileLink } from "../src/file-reference";
import { resolveFile } from "../runtime/files";
import { byteRange } from "../runtime/artifact-stream";
import { PreviewManager } from "../runtime/preview";
import type { NativeHost } from "../runtime/host";
import { formatReviewMessage, reviewReferenceSchema } from "../src/review";

test("file links preserve editor locations while rejecting unsafe schemes and network paths", () => {
  assert.deepEqual(fileLink("apps/codex/report.md#L12-L20"), {
    path: "apps/codex/report.md",
    line: 12,
  });
  assert.deepEqual(fileLink("sample.ts:2"), { path: "sample.ts", line: 2 });
  assert.deepEqual(fileLink("C:/project/main.ts:24:5"), {
    path: "C:/project/main.ts",
    line: 24,
  });
  assert.deepEqual(fileLink("file:///C:/My%20Project/notes.md#L3"), {
    path: "C:/My Project/notes.md",
    line: 3,
  });
  for (const path of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file://server/secret.txt",
    "//server/secret",
    "\\\\server\\secret",
  ])
    assert.throws(() => fileLink(path));
});

test("file previews resolve project source and worker outputs without following paths out of their scope", async () => {
  const data = await realpath(
      await mkdtemp(join(tmpdir(), "memcode-file-review-")),
    ),
    root = join(data, "project"),
    state = initialState(),
    task = state.tasks[0];
  state.projects.find((p) => p.id === task.projectId)!.path = root;
  task.run = { state: "finished", workspace: root };
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const value = 42;\n");
  await writeFile(join(root, "index.html"), "<script>window.bad=true</script>");
  await writeFile(join(data, "secret.md"), "private");
  const output = join(
    root,
    ".memcode",
    "workers",
    task.id,
    "artifacts",
    "report.md",
  );
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, "# Worker report\n");
  state.artifacts.push({
    id: "report",
    name: "report.md",
    path: output,
    taskId: task.id,
    projectId: task.projectId,
    kind: "text",
    createdAt: new Date().toISOString(),
    source: "fixture",
  });
  assert.equal(
    (await resolveFile(state, data, task.id, "src/app.ts:1")).line,
    1,
  );
  assert.equal(
    (await resolveFile(state, data, task.id, "report.md")).artifactId,
    "report",
  );
  assert.equal(
    (await resolveFile(state, data, task.id, "index.html")).format,
    "text",
  );
  await assert.rejects(
    resolveFile(state, data, task.id, "../secret.md"),
    /outside/,
  );
  await symlink(
    data,
    join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    resolveFile(state, data, task.id, "escape/secret.md"),
    /outside/,
  );
});

test("media range parsing covers suffix, partial, open-ended and unsatisfiable requests", () => {
  assert.deepEqual(byteRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=0-100", 10), { start: 0, end: 9 });
  for (const range of [
    "bytes=10-",
    "bytes=4-2",
    "bytes=-0",
    "bytes=0-1,4-5",
    "bytes=-",
    "bytes=9007199254740993-",
  ])
    assert.equal(byteRange(range, 10), null);
});

test("streaming media and viewer comments retain capabilities and never publish automatically", async () => {
  const data = await realpath(
      await mkdtemp(join(tmpdir(), "memcode-media-review-")),
    ),
    state = initialState(),
    task = state.tasks[0],
    root = join(data, "captures", task.id);
  await mkdir(root, { recursive: true });
  const path = join(root, "clip.mp4"),
    bytes = Buffer.from("0123456789");
  await writeFile(path, bytes);
  state.artifacts.push({
    id: "clip",
    name: "clip.mp4",
    path,
    taskId: task.id,
    projectId: task.projectId,
    kind: "text",
    createdAt: new Date().toISOString(),
    source: "fixture",
  });
  let url = "";
  const events: Array<{ name: string; input: any }> = [];
  const preview = new PreviewManager(
    {
      call: async (method: string, input: any) => {
        if (method === "preview_show") url = input.url;
      },
    } as NativeHost,
    () => state,
    data,
    async () => {},
    (name, input) => events.push({ name, input }),
    resolve("."),
  );
  try {
    await preview.show({
      taskId: task.id,
      artifactId: "clip",
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    });
    const document = new URL("__document", url),
      origin = new URL(url).origin;
    const partial = await fetch(document, { headers: { Range: "bytes=2-5" } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(partial.headers.get("content-type"), "video/mp4");
    assert.equal(await partial.text(), "2345");
    const head = await fetch(document, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    assert.equal(
      (await fetch(document, { headers: { Range: "bytes=10-" } })).status,
      416,
    );
    const post = (headers: Record<string, string>) =>
      fetch(new URL("__review", url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "comment",
          selection: { quote: "Frame 2", location: "Time 0:02" },
        }),
      });
    assert.equal(
      (await post({ "Content-Type": "application/json" })).status,
      400,
    );
    assert.equal(
      (await post({ Origin: origin, "Content-Type": "application/json" }))
        .status,
      200,
    );
    const comment = events.find((e) => e.name === "review:event")!.input;
    assert.equal(comment.reference.taskId, task.id);
    assert.equal(comment.reference.artifactId, "clip");
    assert.equal(comment.reference.quote, "Frame 2");
    assert.equal(
      task.messages.some((m) => m.text.includes("Frame 2")),
      false,
    );
    await preview.hide();
    assert.equal(
      (await post({ Origin: origin, "Content-Type": "application/json" }))
        .status,
      400,
    );
  } finally {
    await preview.close();
  }
});

test("review follow-ups carry exact quotes and source locations in all harness prompts", () => {
  const reference = reviewReferenceSchema.parse({
    kind: "changes",
    taskId: "one",
    name: "src/app.ts",
    path: "src/app.ts",
    quote: "const value = 42;",
    lineStart: 7,
    lineEnd: 9,
    side: "after",
    checkpointId: "check-1",
    revision: "sha256:test",
  });
  const message = formatReviewMessage("Please rename this value.", [reference]);
  assert.match(message, /Please rename this value/);
  assert.match(message, /src\/app.ts/);
  assert.match(message, /lines 7–9/);
  assert.match(message, /> const value = 42;/);
  assert.match(message, /checkpoint check-1/);
  assert.throws(() =>
    reviewReferenceSchema.parse({ ...reference, quote: "x".repeat(4001) }),
  );
});
