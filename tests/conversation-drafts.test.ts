import test from "node:test";
import assert from "node:assert/strict";
import { ConversationDrafts } from "../src/conversation-drafts.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("unsent text and attached review notes stay separate when switching cards", () => {
  const kept = storage();
  const drafts = new ConversationDrafts(() => kept);
  drafts.write("card-a", { draft: "Please refine this", comments: ["note-a"] });
  drafts.write("card-b", { draft: "Keep the chart", comments: ["note-b"] });
  assert.deepEqual(drafts.read("card-a"), {
    draft: "Please refine this",
    comments: ["note-a"],
  });
  assert.deepEqual(drafts.read("card-b"), {
    draft: "Keep the chart",
    comments: ["note-b"],
  });
  assert.deepEqual(
    new ConversationDrafts(() => kept).read("card-a"),
    drafts.read("card-a"),
  );
});

test("clearing after send cannot restore stale connection drafts on reopen", () => {
  const kept = storage();
  kept.setItem(
    "memcode:connection-draft:card-a",
    JSON.stringify({ draft: "legacy text", comments: ["note"] }),
  );
  const drafts = new ConversationDrafts(() => kept);
  assert.equal(drafts.read("card-a").draft, "legacy text");
  drafts.write("card-a", { draft: "", comments: [] });
  assert.deepEqual(new ConversationDrafts(() => kept).read("card-a"), {
    draft: "",
    comments: [],
  });
  assert.equal(kept.getItem("memcode:conversation-draft:card-a"), null);
  assert.equal(kept.getItem("memcode:connection-draft:card-a"), null);
});

test("unavailable browser storage retains card drafts in the window", () => {
  const drafts = new ConversationDrafts(() => {
    throw new Error("storage unavailable");
  });
  drafts.write("card-a", { draft: "Retain my input", comments: [] });
  drafts.read("card-b");
  assert.equal(drafts.read("card-a").draft, "Retain my input");
});

test("malformed saved data does not break the conversation or accept invalid note IDs", () => {
  const kept = storage();
  kept.setItem("memcode:conversation-draft:bad-json", "{");
  kept.setItem(
    "memcode:conversation-draft:mixed",
    JSON.stringify({ draft: "typed", comments: [3, "saved-note", null] }),
  );
  const drafts = new ConversationDrafts(() => kept);
  assert.deepEqual(drafts.read("bad-json"), { draft: "", comments: [] });
  assert.deepEqual(drafts.read("mixed"), {
    draft: "typed",
    comments: ["saved-note"],
  });
});

test("a completed send preserves text and review selections edited while the request awaited", async () => {
  const kept = storage();
  const drafts = new ConversationDrafts(() => kept);
  const submitted = {
    draft: "Send the first follow-up",
    comments: ["first-note"],
  };
  drafts.write("card-a", submitted);
  drafts.write("card-b", { draft: "Other card", comments: ["other-note"] });
  let reply!: () => void;
  const response = new Promise<void>((resolve) => {
    reply = resolve;
  });
  const send = response.then(() => drafts.clearSubmitted("card-a", submitted));
  drafts.write("card-a", {
    draft: "New text while sending",
    comments: ["new-note"],
  });
  reply();
  assert.equal(await send, false);
  assert.deepEqual(drafts.read("card-a"), {
    draft: "New text while sending",
    comments: ["new-note"],
  });
  assert.deepEqual(drafts.read("card-b"), {
    draft: "Other card",
    comments: ["other-note"],
  });
  assert.deepEqual(
    new ConversationDrafts(() => kept).read("card-a"),
    drafts.read("card-a"),
  );
});

test("successful send clears only unchanged submitted fields", () => {
  const drafts = new ConversationDrafts(() => storage());
  const submitted = { draft: "Submitted text", comments: ["submitted-note"] };
  drafts.write("text-edited", { ...submitted, draft: "Next follow-up" });
  drafts.clearSubmitted("text-edited", submitted);
  assert.deepEqual(drafts.read("text-edited"), {
    draft: "Next follow-up",
    comments: [],
  });
  drafts.write("notes-edited", { ...submitted, comments: ["next-note"] });
  drafts.clearSubmitted("notes-edited", submitted);
  assert.deepEqual(drafts.read("notes-edited"), {
    draft: "",
    comments: ["next-note"],
  });
  drafts.write("unchanged", submitted);
  drafts.clearSubmitted("unchanged", submitted);
  assert.deepEqual(drafts.read("unchanged"), { draft: "", comments: [] });
});
