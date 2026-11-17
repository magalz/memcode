import test from "node:test";
import assert from "node:assert/strict";
import {
  RetrievalStatusCheck,
  retrievalSetupMessage,
  retrievalSetupState,
} from "../src/context-setup-status";
import type { ContextAssistantSetupState } from "../src/context-settings";

const ready: ContextAssistantSetupState = {
  status: "ready",
  downloadedBytes: 874,
  totalBytes: 874,
  model: "local/model",
};

test("a cached ready model without an optional message never says it is still checking", () => {
  assert.equal(
    retrievalSetupMessage(ready),
    "The local model is installed and ready on this computer.",
  );
  assert.match(retrievalSetupMessage(), /Checking/);
  assert.doesNotMatch(
    retrievalSetupMessage({ ...ready, status: "not-installed" }),
    /Checking/,
  );
});

test("incomplete native replies are errors rather than an indefinitely disabled setup button", async () => {
  for (const value of [
    undefined,
    null,
    {},
    { ...ready, status: "unknown" },
    { ...ready, totalBytes: NaN },
    { ...ready, downloadedBytes: -1 },
  ]) {
    const result = await new RetrievalStatusCheck().run(async () => value);
    assert.match(result?.error ?? "", /incomplete local model status/);
  }
  assert.deepEqual(retrievalSetupState(ready), ready);
});

test("a silent native call reaches a finite error and a retry can recover without setup", async () => {
  const checker = new RetrievalStatusCheck();
  let reads = 0;
  let finish!: (value: ContextAssistantSetupState) => void;
  const result = await checker.run(() => {
    reads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  }, 20);
  assert.match(result?.error ?? "", /took too long.*checking setup does not start a download/);
  const retried = await checker.run(async () => {
    reads++;
    return ready;
  });
  assert.deepEqual(retried, { status: ready });
  finish({ ...ready, status: "not-installed" });
  await Promise.resolve();
  assert.deepEqual(
    retried,
    { status: ready },
    "The late first response cannot replace the recovered state.",
  );
  assert.equal(reads, 2, "Status checks do not invoke model setup.");
});

test("an obsolete response cannot clear a newer failure or apply after unmount", async () => {
  const checker = new RetrievalStatusCheck();
  let finish!: (value: ContextAssistantSetupState) => void;
  const old = checker.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  const current = await checker.run(async () => {
    throw Error("native runtime unavailable");
  });
  finish(ready);
  assert.equal(await old, undefined);
  assert.deepEqual(current, { error: "native runtime unavailable" });
  const closed = checker.run(async () => ready);
  checker.invalidate();
  assert.equal(await closed, undefined);
});
