import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCapture } from "../runtime/browser/capture.ts";
import { AgentBrowserManager } from "../runtime/browser/manager.ts";
import { initialState } from "../src/seed.ts";

test("a missing native capture callback falls back without waiting indefinitely", async () => {
  const start = Date.now();
  let fallbacks = 0;
  const image = await browserCapture(
    () => new Promise(() => {}),
    async () => {
      fallbacks++;
      return "actual-compositor-result";
    },
    { native: 5, compositor: 5 },
  );
  assert.equal(image, "actual-compositor-result");
  assert.equal(fallbacks, 1);
  assert.ok(Date.now() - start < 500);
});

test("both stalled capture methods produce a bounded honest failure", async () => {
  const start = Date.now();
  await assert.rejects(
    browserCapture(
      () => new Promise(() => {}),
      () => new Promise(() => {}),
      { native: 5, compositor: 5 },
    ),
    /No screenshot was produced/,
  );
  assert.ok(Date.now() - start < 500);
});

test("a successful native image does not invoke another capture path", async () => {
  let fallback = false;
  assert.equal(
    await browserCapture(
      async () => "native-result",
      async () => {
        fallback = true;
        return "fallback";
      },
    ),
    "native-result",
  );
  assert.equal(fallback, false);
});

test(
  "screenshot failure preserves a real DOM observation, releases actions, and recovers",
  { timeout: 30000 },
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<title>Capture recovery</title><button onclick=\"this.textContent='Updated'\">Continue</button>",
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const state = initialState(),
      task = state.tasks[0];
    const manager = new AgentBrowserManager(
      () => state,
      await mkdtemp(join(tmpdir(), "memcode-capture-test-")),
      async () => {},
    );
    const rendering = (manager as any).rendering,
      original = rendering.capture.bind(rendering);
    try {
      await manager.execute(task.id, {
        action: "open",
        url: `http://127.0.0.1:${address.port}`,
      });
      rendering.capture = async () => {
        throw Error("Native fixture callback never supplied an image");
      };
      const observed = await manager.execute(task.id, {
        action: "observe",
        screenshot: true,
      });
      assert.match(observed.snapshot!.text, /Continue/);
      assert.equal(observed.image, undefined);
      assert.match(observed.state.error ?? "", /^Screenshot unavailable:/);
      await manager.execute(task.id, {
        action: "act",
        input: { action: "click", ref: "m1" },
      });
      const updated = await manager.execute(task.id, { action: "observe" });
      assert.match(updated.snapshot!.text, /Updated/);
      rendering.capture = original;
      const recovered = await manager.execute(task.id, {
        action: "observe",
        screenshot: true,
      });
      assert.ok(recovered.image?.data);
      assert.equal(recovered.state.error, undefined);
    } finally {
      await manager.close();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
