import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../runtime/app";
import { LocalStore, within } from "../runtime/local";
import { ManagedRetrievalAssistant } from "../runtime/context/managed-assistant";
import {
  contextAssistantDefaults,
  type ContextAssistantSetupState,
} from "../src/context-settings";

test("disabling retrieval during setup survives setup completion and restarting the actual runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memcode-retrieval-choice-"));
  const profile = join(root, "profile");
  const manifestOnlyStatus: ContextAssistantSetupState = {
    status: "ready",
    model: contextAssistantDefaults.model,
    downloadedBytes: 10,
    totalBytes: 10,
  };
  let finishSetup!: (state: ContextAssistantSetupState) => void;
  let setupStarted!: () => void;
  let settled = false;
  const started = new Promise<void>((resolve) => { setupStarted = resolve; });
  const setupResult = new Promise<ContextAssistantSetupState>((resolve) => { finishSetup = resolve; });
  // Hold only model setup, never the preference or persistence routes. The
  // release acceptance test separately uses real downloads and inference.
  t.mock.method(ManagedRetrievalAssistant.prototype, "install", () => {
    setupStarted();
    return setupResult;
  });
  const host = { call: async <T>() => undefined as T };
  const options = { discoverHarnesses: async () => [] };
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let restarted: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime(profile, root, host, () => {}, options);
    const enabled = { ...contextAssistantDefaults, enabled: true };
    await runtime.request("retrieval:configure", enabled);
    const setup = runtime.request("retrieval:setup").then((value) => {
      settled = true;
      return value;
    });
    await started;
    const disabled = { ...enabled, enabled: false };
    await runtime.request("retrieval:configure", disabled);
    assert.equal(settled, false, "The choice changes before setup finishes.");
    const whileInstalling = new LocalStore(profile);
    await whileInstalling.load();
    assert.deepEqual(whileInstalling.state.settings.contextAssistant, disabled,
      "Disabling is saved immediately; closing Settings need not trigger another save.");
    finishSetup(manifestOnlyStatus);
    assert.deepEqual(await setup, manifestOnlyStatus);
    assert.deepEqual(runtime.store.state.settings.contextAssistant, disabled,
      "A late successful setup cannot enable a model the user disabled.");
    await runtime.close();
    runtime = undefined;
    restarted = await createRuntime(profile, root, host, () => {}, options);
    assert.deepEqual(restarted.store.state.settings.contextAssistant, disabled);
    assert.equal(restarted.store.state.settings.contextAssistant?.enabled, false);
  } finally {
    finishSetup?.(manifestOnlyStatus);
    await runtime?.close();
    await restarted?.close();
    assert.ok(within(resolve(tmpdir()), resolve(root)));
    assert.ok(basename(root).startsWith("memcode-retrieval-choice-"));
    await rm(root, { recursive: true, force: true });
  }
});
