// Labelled driver-owned browser workload. A response stays pending only until
// the host queues the user's review, giving a genuine original-pass boundary.
// It does not ask a worker to execute commands or modify permission policy.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function createReviewQueueGate(root, runId) {
  const directory = join(root, ".memcode", "queue-gates", runId),
    pending = new Map();
  await mkdir(directory, { recursive: true });
  const server = createServer(async (request, response) => {
    const match = new RegExp("^/" + runId + "/(claude|cursor|codex)/?$").exec(
      new URL(request.url, "http://localhost").pathname,
    );
    if (!match) {
      response.writeHead(404);
      response.end("Not a queue fixture");
      return;
    }
    const harness = match[1];
    if (pending.has(harness)) {
      response.writeHead(409);
      response.end("An original gate is already pending");
      return;
    }
    const source = join(root, "reviews", runId, harness + ".md"),
      before = await readFile(source, "utf8"),
      startedAt = new Date().toISOString();
    const timer = setTimeout(() => {
      pending.delete(harness);
      response.writeHead(504);
      response.end("Queue test gate expired; do not claim pass");
    }, 12000);
    pending.set(harness, { response, source, before, startedAt, timer });
    await writeFile(
      join(directory, harness + ".ready.json"),
      JSON.stringify({
        runId,
        harness,
        driverPid: process.pid,
        startedAt,
        mechanism: "managed browser request",
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: (harness) =>
      `http://127.0.0.1:${server.address().port}/${runId}/${harness}`,
    async release(harness) {
      const entry = pending.get(harness);
      if (!entry) throw Error("No live browser gate for " + harness);
      clearTimeout(entry.timer);
      pending.delete(harness);
      const unchanged = (await readFile(entry.source, "utf8")) === entry.before,
        result = {
          runId,
          harness,
          driverPid: process.pid,
          startedAt: entry.startedAt,
          releasedAt: new Date().toISOString(),
          sourceUnchanged: unchanged,
          mechanism: "managed browser request",
        };
      await writeFile(
        join(directory, harness + ".completed.json"),
        JSON.stringify(result),
      );
      entry.response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      entry.response.end(
        "<!doctype html><title>Queue test first pass</title><h1>Original browser workload completed</h1><p>Source unchanged: " +
          unchanged +
          "</p><p>The original pass can now save its receipt and finish.</p>",
      );
      if (!unchanged)
        throw Error("Source changed before the queued second pass");
      return result;
    },
    close: () => new Promise((done) => server.close(done)),
  };
}
