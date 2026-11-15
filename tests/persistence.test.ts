import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  observePersistence,
  replaceWorkspace,
} from "../runtime/persistence.ts";
import { within } from "../runtime/local.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-persistence-"));
  const destination = join(directory, "workspace.json");
  const temporary = join(directory, "workspace.json.next");
  await writeFile(destination, '{"version":"saved"}');
  await writeFile(temporary, '{"version":"latest"}');
  return {
    destination,
    temporary,
    cleanup: async () => {
      assert.ok(within(tmpdir(), directory));
      assert.ok(basename(directory).startsWith("memcode-persistence-"));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("workspace replacement survives transient sharing violations without removing saved data", async () => {
  const files = await fixture();
  try {
    let attempts = 0;
    const waits: number[] = [];
    await replaceWorkspace(files.temporary, files.destination, {
      rename: async (source, destination) => {
        assert.equal(await readFile(destination, "utf8"), '{"version":"saved"}');
        assert.equal(await readFile(source, "utf8"), '{"version":"latest"}');
        if (++attempts <= 3)
          throw Object.assign(new Error("sharing violation"), {
            code: ["EPERM", "EACCES", "EBUSY"][attempts - 1],
          });
        await rename(source, destination);
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.equal(attempts, 4);
    assert.deepEqual(waits, [25, 50, 100]);
    assert.equal(await readFile(files.destination, "utf8"), '{"version":"latest"}');
    await assert.rejects(readFile(files.temporary), { code: "ENOENT" });
  } finally {
    await files.cleanup();
  }
});

test("persistent sharing failure is bounded and preserves both saved and pending snapshots", async () => {
  const files = await fixture();
  try {
    const failure = Object.assign(new Error("access denied"), { code: "EACCES" });
    let attempts = 0;
    const waits: number[] = [];
    await assert.rejects(
      replaceWorkspace(files.temporary, files.destination, {
        rename: async () => {
          attempts++;
          throw failure;
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
      (error) => error === failure,
    );
    assert.equal(attempts, 10);
    assert.equal(waits.reduce((sum, delay) => sum + delay, 0), 4575);
    assert.equal(await readFile(files.destination, "utf8"), '{"version":"saved"}');
    assert.equal(await readFile(files.temporary, "utf8"), '{"version":"latest"}');
    // Once the lock is released the same pending snapshot can be committed.
    await replaceWorkspace(files.temporary, files.destination);
    assert.equal(await readFile(files.destination, "utf8"), '{"version":"latest"}');
  } finally {
    await files.cleanup();
  }
});

test("non-sharing errors fail immediately without retrying", async () => {
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  let attempts = 0;
  await assert.rejects(
    replaceWorkspace("pending", "saved", {
      rename: async () => {
        attempts++;
        throw failure;
      },
      wait: async () => {
        assert.fail("disk errors must not be retried");
      },
    }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test("background save rejection is observed and awaited callers still receive the failure", async () => {
  const failure = new Error("workspace could not be replaced");
  const failures: unknown[] = [];
  // Matches fire-and-forget worker activity updates. The test runner also fails
  // on an unhandled rejection if the observer is accidentally removed.
  void observePersistence(Promise.reject(failure), (error) => failures.push(error));
  await setImmediate();
  assert.deepEqual(failures, [failure]);
  const pending = Promise.reject(failure);
  assert.equal(observePersistence(pending, () => {}), pending);
  await assert.rejects(pending, (error) => error === failure);
});
