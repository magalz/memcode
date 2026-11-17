import test from "node:test";
import assert from "node:assert/strict";
import { synchronizeSettingsDraft } from "../src/settings-draft";
import { initialState } from "../src/seed";
import { contextAssistantDefaults } from "../src/context-settings";

test("completed model setup reaches an open settings draft without discarding unrelated edits", () => {
  const previous = structuredClone(initialState().settings);
  const draft = { ...previous, maxWorkers: 9 };
  const incoming = {
    ...previous,
    contextAssistant: { ...contextAssistantDefaults, enabled: true },
    speech: {
      mode: "managed" as const,
      executable: "/private/cache/whisper-server",
      modelPath: "/private/cache/tiny.bin",
      language: "da",
    },
  };
  const result = synchronizeSettingsDraft(draft, previous, incoming);
  assert.deepEqual(result.contextAssistant, incoming.contextAssistant);
  assert.deepEqual(result.speech, incoming.speech);
  assert.equal(result.maxWorkers, 9);
  assert.equal(previous.speech, undefined);
});

test("an explicit user language or local retrieval choice wins over a concurrent server refresh", () => {
  const previous = {
    ...initialState().settings,
    speech: {
      mode: "managed" as const,
      executable: "/cache/server",
      modelPath: "/cache/model",
      language: "auto",
    },
    contextAssistant: { ...contextAssistantDefaults, enabled: true },
  };
  const draft = {
    ...previous,
    speech: { ...previous.speech, language: "da" },
    contextAssistant: { ...previous.contextAssistant, enabled: false },
  };
  const incoming = {
    ...previous,
    speech: { ...previous.speech, executable: "/new/cache/server" },
    maxWorkers: 6,
  };
  const result = synchronizeSettingsDraft(draft, previous, incoming);
  assert.equal(result.speech?.language, "da");
  assert.equal(result.speech?.executable, "/new/cache/server");
  assert.equal(result.contextAssistant?.enabled, false);
  assert.equal(result.maxWorkers, 6);
});
