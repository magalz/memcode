import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/seed.ts";
import { LatestWorkspacePublisher } from "../runtime/workspace-publisher.ts";

class Clock {
  now = 0;
  private next = 0;
  private timers = new Map<number, { at: number; run(): void }>();
  schedule = (run: () => void, delay: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, run });
    return id;
  };
  cancel = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(milliseconds: number) {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].run();
    }
    this.now = target;
  }
}

function fixture() {
  const state = initialState();
  state.tasks = state.tasks.slice(0, 3);
  for (const task of state.tasks) task.run.state = "running";
  const clock = new Clock();
  const sent: Array<{ at: number; json: string }> = [];
  let backpressure = false;
  let rejectNext = false;
  let listener: (() => void) | undefined;
  const publisher = new LatestWorkspacePublisher(
    {
      write: (payload) => {
        sent.push({ at: clock.now, json: JSON.stringify(payload) });
        if (rejectNext) {
          rejectNext = false;
          backpressure = true;
        }
        return !backpressure;
      },
      needsDrain: () => backpressure,
      onDrain: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
    { now: () => clock.now, schedule: clock.schedule, cancel: clock.cancel },
  );
  return {
    state,
    clock,
    sent,
    publisher,
    blockNextWrite: () => {
      rejectNext = true;
    },
    drain: () => {
      backpressure = false;
      listener?.();
    },
  };
}

test("three worker bursts share one publication budget and retain the final update", () => {
  const f = fixture();
  f.publisher.publish(f.state);
  for (let index = 1; index <= 300; index++) {
    f.clock.advance(1);
    f.state.tasks[index % 3].messages[0].text = `worker update ${index}`;
    f.publisher.publish(f.state);
  }
  f.clock.advance(150);
  assert.equal(f.sent.length, 4);
  assert.deepEqual(
    f.sent.map((item) => item.at),
    [0, 150, 300, 450],
  );
  const final = JSON.parse(f.sent.at(-1)!.json);
  for (let index = 0; index < 3; index++)
    assert.equal(
      final.tasks[index].messages[0].text,
      f.state.tasks[index].messages[0].text,
    );
  f.publisher.dispose();
});

test("blocked stdout does not serialize queued snapshots and final state flush waits for drain", async () => {
  const f = fixture();
  f.blockNextWrite();
  f.publisher.publish(f.state);
  for (let index = 0; index < 500; index++) {
    f.clock.advance(1);
    f.state.tasks[0].messages[0].text = `latest ${index}`;
    f.publisher.publish(f.state);
  }
  f.state.tasks[0].run.state = "finished";
  f.publisher.publish(f.state);
  assert.equal(f.sent.length, 1, "Backpressure must prevent JSON encoding too");
  let finished = false;
  const flush = f.publisher.flush().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  f.drain();
  await flush;
  assert.equal(f.sent.length, 2);
  const final = JSON.parse(f.sent[1].json);
  assert.equal(final.tasks[0].run.state, "finished");
  assert.equal(final.tasks[0].messages[0].text, "latest 499");
  f.publisher.dispose();
});

test("worker completion bypasses only the interval, and shutdown flush includes trailing state", async () => {
  const f = fixture();
  f.publisher.publish(f.state);
  f.clock.advance(20);
  f.state.tasks[0].run.state = "finished";
  f.publisher.publish(f.state);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].at, 20);
  f.clock.advance(10);
  f.state.tasks[0].messages[0].text = "Final report attached";
  f.publisher.publish(f.state);
  assert.equal(f.sent.length, 2);
  await f.publisher.flush();
  assert.equal(f.sent.length, 3);
  assert.equal(
    JSON.parse(f.sent[2].json).tasks[0].messages[0].text,
    "Final report attached",
  );
  f.clock.advance(1000);
  assert.equal(f.sent.length, 3, "No duplicate stale timer publication");
  f.publisher.dispose();
});

test("forced final publication reports a synchronous output failure", async () => {
  const clock = new Clock();
  const failure = new Error("Output closed");
  const reported: unknown[] = [];
  let writes = 0;
  const publisher = new LatestWorkspacePublisher(
    {
      write: () => {
        if (++writes > 1) throw failure;
        return true;
      },
      needsDrain: () => false,
      onDrain: () => () => {},
    },
    {
      now: () => clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      onError: (error) => reported.push(error),
    },
  );
  publisher.publish(initialState());
  clock.advance(1);
  publisher.publish(initialState());
  await assert.rejects(publisher.flush(), (error) => error === failure);
  assert.deepEqual(reported, [failure]);
  publisher.dispose();
});
