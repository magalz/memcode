import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed";
import { registerReview, migrateReviewComments } from "../runtime/review";
import type { ReviewReference } from "../src/review";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../runtime/local";
function harness() {
  const state = initialState(),
    routes = new Map<string, { schema: any; run: (input: any) => any }>();
  let saved = 0,
    published = 0;
  registerReview(
    (name, schema, run) => {
      routes.set(name, { schema, run });
    },
    () => state,
    async () => {
      saved++;
    },
    () => {
      published++;
    },
  );
  return {
    state,
    call: async (name: string, input: unknown) => {
      const route = routes.get(name)!;
      return route.run(route.schema.parse(input));
    },
    counts: () => ({ saved, published }),
  };
}
function reference(taskId: string): ReviewReference {
  return {
    taskId,
    kind: "artifact",
    artifactId: "a",
    name: "brief.docx",
    path: "/project/brief.docx",
    quote: "shared context",
    page: 1,
    selector: "section.docx",
    startOffset: 320,
    endOffset: 334,
    selectionType: "text",
    revision: "file-version-1",
  };
}
test("saving an annotation persists a precise target without adding a conversation message or starting a worker", async () => {
  const h = harness(),
    task = h.state.tasks[0],
    before = structuredClone(task),
    comment = await h.call("review:save", {
      taskId: task.id,
      reference: reference(task.id),
      text: "Use more precise wording.",
    });
  assert.equal(comment.status, "saved");
  assert.deepEqual(task, before);
  assert.deepEqual(comment.reference, reference(task.id));
  assert.deepEqual(h.counts(), { saved: 1, published: 1 });
  const data = await mkdtemp(join(tmpdir(), "memcode-annotations-")),
    store = new LocalStore(data);
  store.state = h.state;
  await store.save();
  const restored = await new LocalStore(data).load();
  assert.equal(restored.reviewComments?.[0].reference.startOffset, 320);
  assert.equal(restored.reviewComments?.[0].text, "Use more precise wording.");
});
test("saved comments can be edited and deleted locally; only an explicit follow-up shares the chosen comments", async () => {
  const h = harness(),
    task = h.state.tasks[0],
    before = task.messages.length,
    one = await h.call("review:save", {
      taskId: task.id,
      reference: reference(task.id),
      text: "First note",
    }),
    two = await h.call("review:save", {
      taskId: task.id,
      reference: {
        ...reference(task.id),
        cells: "B4:D8",
        sheet: "Forecast",
        selectionType: "cells",
      },
      text: "Check these totals",
    });
  await h.call("review:save", {
    id: one.id,
    taskId: task.id,
    reference: one.reference,
    text: "More precise first note",
  });
  assert.equal(task.messages.length, before);
  const id = await h.call("review:share", {
    taskId: task.id,
    ids: [one.id],
    text: "Please address this one comment.",
  });
  const message = task.messages.at(-1)!;
  assert.equal(message.id, id);
  assert.equal(message.reviewText, "Please address this one comment.");
  assert.deepEqual(message.commentIds, [one.id]);
  assert.equal(message.references?.[0].startOffset, 320);
  assert.match(message.text, /More precise first note/);
  assert.match(message.text, /"selector":"section.docx"/);
  assert.equal(two.status, "saved");
  assert.equal(one.status, "shared");
  assert.equal(task.run.state, "idle");
  await assert.rejects(
    h.call("review:share", {
      taskId: task.id,
      ids: [one.id],
      text: "Duplicate",
    }),
    /not yet/,
  );
  await assert.rejects(
    h.call("review:delete", { taskId: task.id, id: one.id }),
    /history/,
  );
  await h.call("review:delete", { taskId: task.id, id: two.id });
  assert.equal(h.state.reviewComments?.length, 1);
});
test("annotation ownership and old review history remain explicit", async () => {
  const h = harness(),
    task = h.state.tasks[0],
    other = h.state.tasks[1];
  await assert.rejects(
    h.call("review:save", {
      taskId: task.id,
      reference: reference(other.id),
      text: "wrong owner",
    }),
    /another/,
  );
  task.messages.push({
    id: "legacy",
    role: "user",
    text: "Clearer wording.\n\nReference 1: /project/brief.docx\n> shared context",
    at: new Date().toISOString(),
    references: [reference(task.id)],
  });
  migrateReviewComments(h.state);
  migrateReviewComments(h.state);
  assert.equal(h.state.reviewComments?.length, 1);
  assert.equal(h.state.reviewComments?.[0].status, "shared");
  assert.equal(h.state.reviewComments?.[0].text, "Clearer wording.");
  assert.equal(task.messages.at(-1)?.commentIds?.length, 1);
});
