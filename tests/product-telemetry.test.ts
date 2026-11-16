import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProductTelemetry,
  telemetryMutationTargets,
  observeTelemetryMutation,
  type TelemetryOptions,
} from "../runtime/telemetry";
import { telemetryBatchSchema } from "../src/telemetry";
import type { AppState, WorkItem } from "../src/shared";

function stateFixture() {
  const task = {
    id: "private-story-identifier",
    projectId: "private-project-identifier",
    title: "SECRET story title",
    description: "SECRET prompt",
    stage: "planned",
    harness: "codex",
    scope: ["SECRET/path.ts"],
    messages: [{ text: "SECRET transcript" }],
    run: {
      state: "running",
      changeRunId: "private-run",
      branch: "SECRET branch",
    },
    route: {
      policyVersion: "memcode-envelope-v2",
      tier: "balanced",
      harness: "codex",
      model: "private-custom-model/SECRET",
      effort: "medium",
      mode: "automatic",
      status: "measured",
      reasons: ["SECRET reason"],
      inputs: {
        cognitive: 17,
        cyclomatic: 9,
        nesting: 3,
        affected: 12,
        processes: 2,
        moduleRoots: 1,
        incomplete: false,
        sourceRevision: "SECRET hash",
        graphRevision: "SECRET graph",
      },
    },
    evidence: {
      state: "measured",
      symbols: [
        {
          name: "SECRET symbol",
          file: "SECRET/path.ts",
          line: 1,
          cognitive: 17,
          cyclomatic: 9,
          nesting: 3,
          metricSource: "ast",
        },
      ],
      affected: 12,
      affectedFiles: 3,
      incomplete: false,
      note: "SECRET note",
      binding: {
        index: "current",
        branch: "SECRET branch",
        sources: { "SECRET/path.ts": "SECRET hash" },
        staleFiles: [],
      },
    },
  } as unknown as WorkItem;
  const state = {
    projects: [
      {
        id: task.projectId,
        name: "SECRET project name",
        description: "SECRET project brief",
        path: "SECRET local path",
      },
    ],
    tasks: [task],
    epics: [],
    cycles: [],
  } as unknown as AppState;
  return { state, task };
}
async function fixture(extra: Partial<TelemetryOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "memcode-telemetry-"));
  let time = Date.now(),
    subject = "account-A";
  const data = stateFixture(),
    bodies: any[] = [],
    headers: Headers[] = [];
  const options: TelemetryOptions = {
    background: false,
    now: () => time,
    eligible: () => true,
    authorization: async () => ({
      token: "test-telemetry-grant-" + subject,
      accountId: subject,
      expiresAt: time + 900000,
    }),
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      return Response.json({ accepted: 1 });
    },
    ...extra,
  };
  const telemetry = new ProductTelemetry(directory, () => data.state, options);
  await telemetry.initialize();
  return {
    ...data,
    telemetry,
    directory,
    bodies,
    headers,
    options,
    advance: (ms: number) => {
      time += ms;
    },
    setSubject: (value: string) => {
      subject = value;
    },
    close: async () => {
      await telemetry.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("default off and excluded QA profiles collect or send nothing", async () => {
  for (const excluded of [false, true]) {
    const f = await fixture({ excluded });
    try {
      assert.equal(f.telemetry.status().enabled, false);
      assert.equal(
        f.telemetry.started(f.task, f.state.projects[0], "initial"),
        undefined,
      );
      await f.telemetry.flush();
      assert.equal(f.bodies.length, 0);
      if (excluded)
        await assert.rejects(f.telemetry.setEnabled(true), /excluded/);
      assert.equal(f.telemetry.status().pending, 0);
    } finally {
      await f.close();
    }
  }
});

test("a verified beta session is required for explicit account-bound opt-in; local use is unaffected", async () => {
  const f = await fixture({
    eligible: () => false,
    authorization: async () => {
      throw Error("must not request auth");
    },
  });
  try {
    await assert.rejects(f.telemetry.setEnabled(true), /Connect MemCode beta/);
    assert.equal(f.telemetry.status().enabled, false);
    assert.equal(f.telemetry.status().pending, 0);
  } finally {
    await f.close();
  }
});

test("actual producer-to-HTTP payload contains only allowlisted frozen numeric context and opaque references", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    const handle = f.telemetry.started(f.task, f.state.projects[0], "initial");
    f.task.route!.inputs.cognitive = 999;
    f.task.route!.model = "opus";
    f.task.evidence!.symbols[0].name = "NEW SECRET";
    f.advance(1234);
    f.task.run.state = "finished";
    f.task.run.exitCode = 0;
    f.task.run.error = "SECRET error text";
    f.task.stage = "review";
    f.task.changesRevision = "SECRET reviewed revision";
    f.telemetry.finished(handle, f.task);
    f.telemetry.finished(handle, f.task);
    const before = f.telemetry.planning();
    f.task.stage = "done";
    f.telemetry.observeLocal("task:update", before, new Set([f.task.id]));
    await f.telemetry.flush();
    assert.equal(f.bodies.length, 1);
    const body = telemetryBatchSchema.parse(f.bodies[0]);
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "SECRET",
      "private-story-identifier",
      "private-project-identifier",
      "private-run",
      "account-A",
      "sources",
      "sourceRevision",
      "graphRevision",
      "reasons",
      "sessionId",
    ])
      assert.equal(
        serialized.includes(forbidden),
        false,
        forbidden + " never reaches the HTTP body",
      );
    const start = body.events.find((e) => e.type === "attempt.started")!;
    assert.equal(start.evidence.cognitive, 17);
    assert.equal(start.requestedModel, "other");
    assert.equal(start.evidence.alignment, "aligned");
    assert.equal(start.historyComplete, false);
    const finished = body.events.filter((e) => e.type === "attempt.finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].processOutcome, "exited");
    assert.equal(finished[0].durationMs, 1234);
    assert.equal(finished[0].reportedModel, null);
    assert.equal(finished[0].usage, null);
    assert.equal(finished[0].verification, null);
    const review = body.events.find((e) => e.type === "story.review")!;
    assert.equal(review.attemptRef, start.attemptRef);
    assert.equal(review.decision, "accepted");
    assert.match(
      f.headers[0].get("authorization")!,
      /^Bearer test-telemetry-grant-/,
    );
  } finally {
    await f.close();
  }
});

test("unknown and partial scopes stay unknown/partial instead of inheriting a whole-repo maximum", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    f.task.evidence = undefined;
    Object.assign(f.task.route!.inputs, {
      cognitive: null,
      cyclomatic: null,
      nesting: null,
      affected: null,
      processes: null,
      moduleRoots: 0,
      incomplete: true,
    });
    f.telemetry.started(f.task, f.state.projects[0], "initial");
    f.task.evidence = {
      state: "partial",
      symbols: [],
      incomplete: true,
      affected: 2,
      note: "private",
      measuredAt: "private",
    };
    Object.assign(f.task.route!.inputs, { affected: 2 });
    f.telemetry.started(f.task, f.state.projects[0], "followup");
    await f.telemetry.flush();
    const starts = f.bodies[0].events.filter(
      (e: any) => e.type === "attempt.started",
    );
    assert.equal(starts[0].evidence.state, "unknown");
    assert.equal(starts[0].evidence.cognitive, null);
    assert.equal(starts[0].evidence.alignment, "unknown");
    assert.equal(starts[0].evidence.impactLowerBound, null);
    assert.equal(starts[1].evidence.state, "partial");
    assert.equal(starts[1].evidence.affectedSymbols, 2);
    assert.equal(starts[1].evidence.impactLowerBound, true);
  } finally {
    await f.close();
  }
});

test("only explicitly targeted local mutations produce lifecycle/review events; remote concurrent changes do not", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    const before = f.telemetry.planning();
    const remote = { ...f.task, id: "remote-story", stage: "done" } as WorkItem;
    f.state.tasks.push(remote);
    f.telemetry.observeLocal("task:update", before, new Set([f.task.id]));
    assert.equal(f.telemetry.tracks("team:read"), false);
    const beforeCreate = f.telemetry.planning(),
      local = { ...f.task, id: "locally-created" };
    f.state.tasks.push(local);
    f.telemetry.observeLocal(
      "task:create",
      beforeCreate,
      telemetryMutationTargets("task:create", { title: "SECRET" }, local),
    );
    const handle = f.telemetry.started(local, f.state.projects[0], "initial");
    local.run = { ...local.run, state: "finished" };
    f.telemetry.finished(handle, local);
    const beforeDone = f.telemetry.planning();
    local.stage = "done";
    f.telemetry.observeLocal("task:update", beforeDone, new Set([local.id]));
    await f.telemetry.flush();
    const events = f.bodies[0].events;
    assert.equal(
      events.filter((e: any) => e.type === "entity.lifecycle").length,
      1,
    );
    assert.equal(
      events.find((e: any) => e.type === "attempt.started").historyComplete,
      true,
    );
    assert.equal(
      events.find((e: any) => e.type === "story.review").attemptRef,
      null,
      "No revision means no verified attribution to a prior attempt",
    );
  } finally {
    await f.close();
  }
});

test("failed offline uploads retain the same event IDs across restart, then acknowledge without duplication", async () => {
  let accepted = false;
  const sent: any[] = [];
  const f = await fixture({
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      if (!accepted) throw Error("offline SECRET network error");
      return new Response(null, { status: 204 });
    },
  });
  let reopened: ProductTelemetry | undefined;
  try {
    await f.telemetry.setEnabled(true);
    await f.telemetry.flush();
    assert.equal(f.telemetry.status().pending, 1);
    await f.telemetry.close();
    accepted = true;
    reopened = new ProductTelemetry(f.directory, () => f.state, f.options);
    await reopened.initialize();
    await reopened.flush();
    assert.deepEqual(
      sent[0].events.map((e: any) => e.eventId),
      sent[1].events.map((e: any) => e.eventId),
    );
    assert.equal(reopened.status().pending, 0);
    assert.equal(reopened.status().sent, 1);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("disable deletes the queue while an authorization request is waiting and prevents its later upload", async () => {
  let release!: (value: any) => void,
    calls = 0,
    cleared = 0;
  const f = await fixture({
    clearAuthorization: () => {
      cleared++;
    },
    authorization: async () =>
      ++calls === 1
        ? { token: "initial", accountId: "A", expiresAt: Date.now() + 900000 }
        : new Promise((resolve) => {
            release = resolve;
          }),
  });
  try {
    await f.telemetry.setEnabled(true);
    const sending = f.telemetry.flush();
    await new Promise((resolve) => setImmediate(resolve));
    await f.telemetry.setEnabled(false);
    release({ token: "late", accountId: "A", expiresAt: Date.now() + 900000 });
    await sending;
    assert.equal(f.bodies.length, 0);
    assert.equal(f.telemetry.status().pending, 0);
    assert.equal(f.telemetry.status().enabled, false);
    assert.ok(cleared > 0);
    const disk = JSON.parse(
      await readFile(join(f.directory, "telemetry/queue.private.json"), "utf8"),
    );
    assert.deepEqual(disk.queue, []);
    assert.equal(disk.accountHash, null);
  } finally {
    await f.close();
  }
});

test("account switching aborts pending delivery, erases A's observations, and requires B to opt in explicitly", async () => {
  let release!: (value: Response) => void, signal: AbortSignal | undefined;
  const f = await fixture({
    fetch: async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await f.telemetry.setEnabled(true);
    const pending = f.telemetry.flush();
    await new Promise((resolve) => setImmediate(resolve));
    await f.telemetry.accountChanged();
    f.setSubject("account-B");
    assert.equal(signal!.aborted, true);
    release(new Response(null, { status: 204 }));
    await pending;
    assert.equal(f.telemetry.status().enabled, false);
    assert.equal(f.telemetry.status().pending, 0);
    assert.equal(
      f.telemetry.started(f.task, f.state.projects[0], "followup"),
      undefined,
    );
    await f.telemetry.setEnabled(true);
    assert.equal(f.telemetry.status().pending, 1);
  } finally {
    await f.close();
  }
});

test("a restored A queue cannot be uploaded by a different account even if lifecycle notification is missed", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    f.setSubject("account-B");
    await f.telemetry.flush();
    assert.equal(f.bodies.length, 0);
    assert.equal(f.telemetry.status().enabled, false);
    assert.equal(f.telemetry.status().pending, 0);
  } finally {
    await f.close();
  }
});

test("queue is bounded and test-channel batches cannot be mislabeled as production", async () => {
  const f = await fixture({ channel: "test" });
  try {
    await f.telemetry.setEnabled(true);
    for (let i = 0; i < 1200; i++) {
      const before = f.telemetry.planning();
      f.task.stage = i % 2 ? "done" : "planned";
      f.telemetry.observeLocal("task:update", before, new Set([f.task.id]));
    }
    assert.ok(f.telemetry.status().pending <= 1000);
    await (f.telemetry as any).persist();
    const persisted = JSON.parse(
      await readFile(join(f.directory, "telemetry/queue.private.json"), "utf8"),
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(persisted.queue)) > 65536,
      "Exercise a real persisted queue larger than the ingestion body cap",
    );
    await f.telemetry.flush();
    assert.equal(f.bodies[0].channel, "test");
    assert.ok(f.bodies[0].events.length <= 50);
    assert.ok(Buffer.byteLength(JSON.stringify(f.bodies[0])) <= 60000);
    assert.ok(
      f.telemetry.status().pending > 0,
      "Only the acknowledged bounded batch leaves the larger queue",
    );
  } finally {
    await f.close();
  }
});

test("measurements freeze before process launch and publish only after launch actually succeeds", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    const publish = f.telemetry.prepare(f.task, f.state.projects[0], "initial");
    assert.equal(
      f.telemetry.status().pending,
      1,
      "Preparation alone emits no fictitious launched attempt",
    );
    f.task.route!.inputs.cognitive = 999;
    f.task.route!.model = "opus";
    const handle = publish!();
    f.task.run.state = "failed";
    f.telemetry.finished(handle, f.task);
    await f.telemetry.flush();
    const start = f.bodies[0].events.find(
      (e: any) => e.type === "attempt.started",
    );
    assert.equal(start.evidence.cognitive, 17);
    assert.equal(start.requestedModel, "other");
    const suppressed = f.telemetry.prepare(
      f.task,
      f.state.projects[0],
      "followup",
    );
    await f.telemetry.setEnabled(false);
    assert.equal(
      suppressed!(),
      undefined,
      "A later disable invalidates prepared observations before launch",
    );
  } finally {
    await f.close();
  }
});

test("a late enable response cannot overwrite a more recent account's explicit opt-in", async () => {
  let finishA!: (value: any) => void,
    calls = 0;
  const f = await fixture({
    authorization: async () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : { token: "B", accountId: "B", expiresAt: Date.now() + 900000 },
  });
  try {
    const first = f.telemetry.setEnabled(true);
    await new Promise((resolve) => setImmediate(resolve));
    await f.telemetry.accountChanged();
    await f.telemetry.setEnabled(true);
    finishA({ token: "A", accountId: "A", expiresAt: Date.now() + 900000 });
    await assert.rejects(first, /account changed/);
    assert.equal(f.telemetry.status().enabled, true);
    assert.equal(f.telemetry.status().pending, 1);
  } finally {
    await f.close();
  }
});

test("the opt-out marker survives a queue-save failure and prevents old consent from returning after restart", async () => {
  const f = await fixture();
  let reopened: ProductTelemetry | undefined;
  try {
    await f.telemetry.setEnabled(true);
    const persist = (f.telemetry as any).persist;
    (f.telemetry as any).persist = async () => {
      throw Error("synthetic locked queue");
    };
    await assert.rejects(f.telemetry.setEnabled(false), /locked queue/);
    assert.equal(f.telemetry.status().enabled, false);
    reopened = new ProductTelemetry(f.directory, () => f.state, f.options);
    await reopened.initialize();
    assert.equal(reopened.status().enabled, false);
    assert.equal(reopened.status().pending, 0);
    await reopened.flush();
    assert.equal(f.bodies.length, 0);
    (f.telemetry as any).persist = persist;
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("strict wire validation rejects additional content fields and arbitrary model/version labels", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    f.telemetry.started(f.task, f.state.projects[0], "initial");
    await f.telemetry.flush();
    for (const mutate of [
      (body: any) => {
        body.prompt = "secret";
      },
      (body: any) => {
        body.events[1].title = "secret";
      },
      (body: any) => {
        body.events[1].evidence.sources = { "private/path": "hash" };
      },
      (body: any) => {
        body.events[1].requestedModel = "custom-personal-model";
      },
      (body: any) => {
        body.events[0].appVersion = "0.4.0-private-company-name";
      },
    ]) {
      const copy = structuredClone(f.bodies[0]);
      mutate(copy);
      assert.equal(telemetryBatchSchema.safeParse(copy).success, false);
    }
  } finally {
    await f.close();
  }
});

test("queued events retain their originating app version across a later application launch", async () => {
  const f = await fixture();
  let reopened: ProductTelemetry | undefined;
  try {
    await f.telemetry.setEnabled(true);
    await f.telemetry.close();
    const file = join(f.directory, "telemetry/queue.private.json"),
      disk = JSON.parse(await readFile(file, "utf8"));
    disk.queue[0].appVersion = "0.3.0";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(disk));
    reopened = new ProductTelemetry(f.directory, () => f.state, f.options);
    await reopened.initialize();
    await reopened.flush();
    assert.equal(f.bodies[0].events[0].appVersion, "0.3.0");
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("concurrent Done and unrelated card edits produce one human acceptance, not duplicate outcomes", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const edit = (input: any) => {
      if (input.patch.stage) f.task.stage = input.patch.stage;
      return saved;
    };
    const first = observeTelemetryMutation(
      f.telemetry,
      "task:update",
      { id: f.task.id, patch: { stage: "done" } },
      edit,
    );
    const second = observeTelemetryMutation(
      f.telemetry,
      "task:update",
      { id: f.task.id, patch: { stage: "done" } },
      edit,
    );
    const priority = observeTelemetryMutation(
      f.telemetry,
      "task:update",
      { id: f.task.id, patch: { priority: "high" } },
      edit,
    );
    release();
    await Promise.all([first, second, priority]);
    await f.telemetry.flush();
    const reviews = f.bodies[0].events.filter(
      (event: any) => event.type === "story.review",
    );
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].decision, "accepted");
  } finally {
    await f.close();
  }
});

test("a remote stage change while an unrelated local edit persists never becomes a local acceptance", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = observeTelemetryMutation(
      f.telemetry,
      "task:update",
      { id: f.task.id, patch: { priority: "high" } },
      () => saved,
    );
    f.task.stage = "done";
    release();
    await pending;
    await f.telemetry.flush();
    assert.equal(
      f.bodies[0].events.some((event: any) => event.type === "story.review"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("an old account's pending local mutation cannot become the next account's review outcome", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    let release!: () => void;
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = observeTelemetryMutation(
      f.telemetry,
      "task:update",
      { id: f.task.id, patch: { stage: "done" } },
      () => {
        f.task.stage = "done";
        return saved;
      },
    );
    await f.telemetry.accountChanged();
    f.setSubject("account-B");
    await f.telemetry.setEnabled(true);
    release();
    await pending;
    await f.telemetry.flush();
    assert.equal(
      f.bodies[0].events.some((event: any) => event.type === "story.review"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("native model/token measurements reach the wire and later checks enrich the same immutable attempt", async () => {
  const f = await fixture();
  try {
    await f.telemetry.setEnabled(true);
    const handle = f.telemetry.started(f.task, f.state.projects[0], "initial");
    f.task.run.measurements = {
      modelId: "gpt-6.1-terra",
      modelIds: ["gpt-6.1-terra", "private/SECRET-model"],
      modelSource: "codex-thread",
      effort: "medium",
      usage: {
        inputTokens: 1200,
        outputTokens: 240,
        cachedInputTokens: 800,
        cacheCreationInputTokens: 40,
        reasoningOutputTokens: 100,
        totalTokens: 1440,
        scope: "attempt",
        source: "codex-thread-total",
      },
    };
    f.advance(1500);
    f.task.run.state = "finished";
    f.task.run.exitCode = 0;
    f.task.changesRevision = "SECRET verified revision";
    f.telemetry.finished(handle, f.task);
    f.advance(5000);
    const result = {
      runId: f.task.run.changeRunId!,
      revision: f.task.changesRevision,
      sessionId: "SECRET-terminal",
      passed: 19,
      failed: 0,
      exitCode: 0,
      source: "memcode_check" as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      linked: true,
      timedOut: false,
    };
    assert.equal(f.telemetry.verified(f.task, result), true);
    f.task.run.changeRunId = "different-run";
    assert.equal(f.telemetry.verified(f.task, result), false);
    await f.telemetry.flush();
    const body = telemetryBatchSchema.parse(f.bodies[0]),
      finishes = body.events.filter((e) => e.type === "attempt.finished");
    assert.equal(finishes.length, 2);
    assert.equal(finishes[0].attemptRef, finishes[1].attemptRef);
    assert.notEqual(finishes[0].eventId, finishes[1].eventId);
    assert.equal(finishes[0].reportedModelId, "gpt-6.1-terra");
    assert.deepEqual(finishes[0].reportedModelIds, ["gpt-6.1-terra"]);
    assert.deepEqual(finishes[0].reportedModels, ["gpt-6.1-terra", "other"]);
    assert.deepEqual(finishes[0].usage, finishes[1].usage);
    assert.equal(finishes[1].durationMs, 1500);
    assert.equal(finishes[0].verification, null);
    assert.deepEqual(finishes[1].verification, {
      passed: 19,
      failed: 0,
      source: "memcode_check",
      exitCode: 0,
    });
    assert.equal(JSON.stringify(body).includes("SECRET"), false);
  } finally {
    await f.close();
  }
});
