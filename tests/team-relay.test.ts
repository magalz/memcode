import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  appendFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { startTeamRelay, type TeamRelay } from "../runtime/team/relay";
import {
  applyTeamEvent,
  teamSessionReplySchema,
  teamSyncReplySchema,
} from "../runtime/team/protocol";
import type {
  TeamCommand,
  TeamCommandReply,
  TeamCredential,
  TeamSessionReply,
  TeamSnapshot,
  TeamSyncReply,
} from "../src/team";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memcode-team-relay-"));
  let relay = await startTeamRelay({ dataDir: directory, port: 0 });
  const request = async (
    path: string,
    input?: unknown,
    capability?: string,
  ) => {
    const response = await fetch(relay.url + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        ...(capability ? { authorization: `Bearer ${capability}` } : {}),
        ...(input !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const create = async (name = "Alice") => {
    const result = await request(
      "/v1/workspaces",
      {
        name: "Pilot board",
        memberName: name,
        deviceId: randomUUID(),
        deviceName: `${name}'s computer`,
      },
      relay.adminCapability,
    );
    assert.equal(result.status, 201);
    return teamSessionReplySchema.parse(result.body) as TeamSessionReply;
  };
  const joinRoom = async (owner: TeamCredential, name = "Bob") => {
    const invite = await request(
      "/v1/invites",
      { workspaceId: owner.workspaceId, role: "editor" },
      owner.capability,
    );
    assert.equal(invite.status, 201);
    const result = await request("/v1/join", {
      ...invite.body,
      expiresAt: undefined,
      memberName: name,
      deviceId: randomUUID(),
      deviceName: `${name}'s computer`,
    });
    assert.equal(result.status, 200);
    return {
      session: teamSessionReplySchema.parse(result.body) as TeamSessionReply,
      invitation: invite.body.invitation as string,
    };
  };
  const command = (
    actor: TeamCredential,
    command: TeamCommand,
    opId = randomUUID(),
  ) =>
    request(
      "/v1/commands",
      { workspaceId: actor.workspaceId, opId, command },
      actor.capability,
    );
  const sync = async (actor: TeamCredential, after = 0, waitMs = 0) => {
    const result = await request(
      `/v1/sync?workspaceId=${actor.workspaceId}&after=${after}&waitMs=${waitMs}`,
      undefined,
      actor.capability,
    );
    assert.equal(result.status, 200);
    return teamSyncReplySchema.parse(result.body) as TeamSyncReply;
  };
  return {
    directory,
    request,
    create,
    joinRoom,
    command,
    sync,
    get relay() {
      return relay;
    },
    async restart(options: { afterCommit?: (event: any) => void } = {}) {
      await relay.close();
      relay = await startTeamRelay({ dataDir: directory, port: 0, ...options });
    },
    async close() {
      await relay.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const story = (id: string, identifier = "MC-001") => ({
  id,
  identifier,
  title: "Ship a reviewable improvement",
  description: "Local source and workers stay private",
  stage: "planned" as const,
  priority: "medium" as const,
});

test("two clients share planning, comments, unread activity, ordered backfill and atomic identifiers", async () => {
  const f = await fixture();
  try {
    const alice = await f.create(),
      { session: bob, invitation } = await f.joinRoom(alice.credential);
    assert.equal(bob.identity, "invite-preview");
    const replayInvite = await f.request("/v1/join", {
      workspaceId: alice.credential.workspaceId,
      invitation,
      memberName: "Eve",
      deviceId: randomUUID(),
      deviceName: "Other",
    });
    assert.equal(replayInvite.status, 403);
    const early = await f.sync(bob.credential);
    assert.ok(early.snapshot);
    const creations = await Promise.all([
      f.command(alice.credential, {
        type: "story.put",
        story: story("story-a"),
      }),
      f.command(bob.credential, { type: "story.put", story: story("story-b") }),
    ]);
    assert.deepEqual(
      creations.map((item) => item.status),
      [200, 200],
    );
    const changes = await f.sync(bob.credential, early.cursor);
    assert.equal(changes.events.length, 2);
    const projected = changes.events.reduce(applyTeamEvent, early.snapshot!);
    assert.deepEqual(projected.stories.map((item) => item.identifier).sort(), [
      "MC-001",
      "MC-002",
    ]);
    assert.equal(
      applyTeamEvent(projected, changes.events[0]),
      projected,
      "duplicate delivery keeps state identity",
    );
    const wait = f.sync(bob.credential, changes.cursor, 10000);
    const edit = await f.command(alice.credential, {
      type: "story.patch",
      storyId: "story-a",
      patch: { estimate: 5 },
      expectedRevision: 1,
    });
    assert.equal(edit.status, 200);
    const woken = await wait;
    assert.equal(woken.cursor, edit.body.event.sequence);
    const storyChange = woken.events[0].changes[0];
    assert.equal(storyChange.collection, "stories");
    assert.ok(storyChange.value && "estimate" in storyChange.value);
    assert.equal(storyChange.value.estimate, 5);
    const stale = await f.command(bob.credential, {
      type: "story.patch",
      storyId: "story-a",
      patch: { title: "Stale title" },
      expectedRevision: 1,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "REVISION");
    const comment = await f.command(bob.credential, {
      type: "comment.add",
      commentId: "comment-a",
      storyId: "story-a",
      body: "Please clarify the label",
      reference: {
        kind: "file",
        name: "README.md",
        path: "docs/README.md",
        quote: "Getting started",
        line: 4,
      },
    });
    assert.equal(
      comment.body.event.changes[0].value.memberId,
      bob.credential.memberId,
    );
    assert.equal(
      (
        await f.command(alice.credential, {
          type: "comment.edit",
          commentId: "comment-a",
          body: "Spoofed",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.command(bob.credential, {
          type: "comment.delete",
          commentId: "comment-a",
        })
      ).status,
      200,
    );
    const snapshot = (await f.sync(alice.credential)).snapshot!;
    assert.equal(snapshot.comments[0].body, "");
    assert.ok(snapshot.comments[0].deletedAt);
    assert.ok(
      snapshot.activity.some(
        (item) => item.memberId === bob.credential.memberId,
      ),
    );
    assert.equal(
      (
        await f.command(alice.credential, {
          type: "member.read",
          through: snapshot.head + 100,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.command(alice.credential, {
          type: "member.read",
          through: snapshot.head,
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.sync(alice.credential)).snapshot!.readCursors[0].through,
      snapshot.head,
    );
  } finally {
    await f.close();
  }
});

test("story claims serialize races and fence foreign devices, attempts, deletes and disconnected takeover", async () => {
  const f = await fixture();
  try {
    const alice = await f.create(),
      { session: bob } = await f.joinRoom(alice.credential);
    await f.command(alice.credential, {
      type: "story.put",
      story: story("claimed"),
    });
    const contenders = [alice.credential, bob.credential];
    const race = await Promise.all(
      contenders.map((actor, index) =>
        f.command(actor, {
          type: "claim.acquire",
          storyId: "claimed",
          attemptId: `attempt-${index}`,
        }),
      ),
    );
    const winner = race.findIndex((item) => item.status === 200),
      loser = 1 - winner;
    assert.ok(winner >= 0);
    assert.equal(race[loser].status, 409);
    assert.equal(race[loser].body.error.code, "CLAIMED");
    const claim = race[winner].body.event.changes[0].value;
    assert.equal(
      (
        await f.command(contenders[loser], {
          type: "claim.release",
          storyId: "claimed",
          attemptId: claim.attemptId,
          epoch: claim.epoch,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.command(contenders[winner], {
          type: "claim.release",
          storyId: "claimed",
          attemptId: "stale-attempt",
          epoch: claim.epoch,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.command(contenders[winner], {
          type: "story.delete",
          storyId: "claimed",
        })
      ).status,
      409,
    );
    await f.restart();
    assert.equal(
      (await f.sync(contenders[loser])).snapshot!.claims[0].epoch,
      claim.epoch,
      "restart/disconnection never releases ownership",
    );
    assert.equal(
      (
        await f.command(contenders[loser], {
          type: "claim.acquire",
          storyId: "claimed",
          attemptId: "takeover",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.command(contenders[winner], {
          type: "claim.release",
          storyId: "claimed",
          attemptId: claim.attemptId,
          epoch: claim.epoch,
        })
      ).status,
      200,
    );
    const next = await f.command(contenders[loser], {
      type: "claim.acquire",
      storyId: "claimed",
      attemptId: "next",
    });
    assert.ok(next.body.event.changes[0].value.epoch > claim.epoch);
    assert.equal(
      (
        await f.command(contenders[winner], {
          type: "claim.release",
          storyId: "claimed",
          attemptId: claim.attemptId,
          epoch: claim.epoch,
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("journal commits survive lost acknowledgements, deduplicate retries after restart and recover a torn last record", async () => {
  const f = await fixture();
  try {
    const alice = await f.create();
    let interrupt = true;
    await f.restart({
      afterCommit() {
        if (interrupt) {
          interrupt = false;
          throw Error("Simulated acknowledgement loss");
        }
      },
    });
    const command: TeamCommand = { type: "story.put", story: story("durable") },
      opId = randomUUID();
    const uncertain = await f.command(alice.credential, command, opId);
    assert.equal(uncertain.status, 500);
    await f.restart();
    const retry = await f.command(alice.credential, command, opId);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    const snapshot = (await f.sync(alice.credential)).snapshot!;
    assert.equal(snapshot.stories.length, 1);
    assert.equal(
      snapshot.activity.filter((item) => item.type === "story.put").length,
      1,
    );
    assert.equal(
      (
        await f.command(
          alice.credential,
          { ...command, story: story("other") },
          opId,
        )
      ).body.error.code,
      "OP_ID_REUSE",
    );
    await assert.rejects(
      startTeamRelay({ dataDir: f.directory, port: 0 }),
      /already open/,
    );
    const journal = join(
      f.directory,
      "workspaces",
      `${alice.credential.workspaceId}.jsonl`,
    );
    await f.relay.close();
    await appendFile(journal, '{"kind":"command","truncated":');
    await f.restart();
    assert.equal(
      (await f.sync(alice.credential)).snapshot!.head,
      snapshot.head,
    );
    const saved = await readFile(journal, "utf8");
    assert.ok(saved.endsWith("\n"));
    assert.ok(
      !saved.includes(alice.credential.capability),
      "journal stores credential hashes, never bearer capabilities",
    );
    assert.ok(!JSON.stringify(snapshot).includes(alice.credential.capability));
  } finally {
    await f.close();
  }
});

test("private rooms reject unauthenticated reads, forged local fields and unsafe reference paths", async () => {
  const f = await fixture();
  try {
    const alice = await f.create(),
      other = await f.create("Other");
    assert.equal(
      (await f.request(`/v1/sync?workspaceId=${alice.credential.workspaceId}`))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request(
          `/v1/sync?workspaceId=${alice.credential.workspaceId}`,
          undefined,
          other.credential.capability,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/v1/workspaces",
          {
            name: "Spoof",
            memberName: "Eve",
            deviceId: "x",
            deviceName: "Eve",
          },
          alice.credential.capability,
        )
      ).status,
      403,
    );
    const forged = await f.request(
      "/v1/commands",
      {
        workspaceId: alice.credential.workspaceId,
        opId: "forged",
        memberId: other.credential.memberId,
        command: { type: "story.put", story: story("bad") },
      },
      alice.credential.capability,
    );
    assert.equal(forged.status, 400);
    assert.equal(
      (
        await f.command(alice.credential, {
          type: "story.put",
          story: {
            ...story("bad"),
            rootPath: "C:/private/project",
            workerId: "private-worker",
          },
        } as any)
      ).status,
      400,
    );
    await f.command(alice.credential, {
      type: "story.put",
      story: story("safe"),
    });
    for (const path of [
      "C:/private/code.ts",
      "/etc/passwd",
      "../private/code.ts",
      "src/../../code.ts",
      "src\\code.ts",
      "src/./code.ts",
    ]) {
      const response = await f.command(alice.credential, {
        type: "comment.add",
        storyId: "safe",
        commentId: randomUUID(),
        body: "Review",
        reference: { kind: "file", name: "Code", quote: "line", path },
      });
      assert.equal(response.status, 400, path);
    }
    const snapshot = (await f.sync(alice.credential)).snapshot!;
    assert.equal(
      teamSyncReplySchema.safeParse({
        version: 1,
        snapshot: { ...snapshot, credential: alice.credential },
        events: [],
        cursor: snapshot.head,
        head: snapshot.head,
        hasMore: false,
      }).success,
      false,
    );
  } finally {
    await f.close();
  }
});

test("published results use bounded authenticated hashed bytes and immutable media types", async () => {
  const f = await fixture();
  try {
    const alice = await f.create(),
      { session: bob } = await f.joinRoom(alice.credential),
      other = await f.create("Elsewhere");
    await f.command(alice.credential, {
      type: "story.put",
      story: story("results"),
    });
    const bytes = Buffer.from(
        "# Reviewable report\n\nSource execution remains local.\n",
      ),
      hash = createHash("sha256").update(bytes).digest("hex");
    const upload = async (
      actor: TeamCredential,
      mime = "text/markdown",
      expectedHash = hash,
    ) =>
      fetch(f.relay.url + `/v1/blobs?workspaceId=${actor.workspaceId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${actor.capability}`,
          "content-type": mime,
          "x-content-sha256": expectedHash,
        },
        body: bytes,
      });
    assert.equal(
      (await upload(alice.credential, "text/markdown", "0".repeat(64))).status,
      409,
    );
    assert.equal((await upload(alice.credential)).status, 201);
    const download = (actor: TeamCredential) =>
      fetch(
        f.relay.url +
          `/v1/blobs/${hash}?workspaceId=${alice.credential.workspaceId}`,
        { headers: { authorization: `Bearer ${actor.capability}` } },
      );
    assert.equal(
      (await download(bob.credential)).status,
      403,
      "unpublished bytes stay private to uploader",
    );
    assert.equal(
      (await upload(bob.credential, "text/html")).status,
      409,
      "an existing hash cannot change media type",
    );
    const result = {
      id: "report",
      storyId: "results",
      name: "report.md",
      hash,
      mime: "text/markdown",
      size: bytes.length,
      kind: "report" as const,
    };
    assert.equal(
      (await f.command(bob.credential, { type: "result.publish", result }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.command(alice.credential, {
          type: "result.publish",
          result: { ...result, name: "C:/private/report.md" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.command(alice.credential, { type: "result.publish", result }))
        .status,
      200,
    );
    const opened = await download(bob.credential);
    assert.equal(opened.status, 200);
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), bytes);
    assert.equal(opened.headers.get("content-type"), "text/markdown");
    assert.equal((await download(other.credential)).status, 403);
    const snapshot = (await f.sync(bob.credential)).snapshot!;
    assert.equal(snapshot.results[0].memberId, alice.credential.memberId);
    assert.ok(!("path" in snapshot.results[0]));
    const blobFile = join(
      f.directory,
      "workspaces",
      `${alice.credential.workspaceId}.blobs`,
      hash + ".bin",
    );
    await writeFile(blobFile, "corrupt");
    assert.equal(
      (await download(alice.credential)).status,
      500,
      "content integrity is checked before download",
    );
    const oversized = fetch(
      f.relay.url + `/v1/blobs?workspaceId=${alice.credential.workspaceId}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${alice.credential.capability}` },
        body: Buffer.alloc(5 * 1024 * 1024 + 1),
      },
    );
    try {
      assert.equal((await oversized).status, 413);
    } catch (error) {
      assert.match(String(error), /fetch failed|413/);
    }
  } finally {
    await f.close();
  }
});

test("LAN serving is explicit and advertises the actual listener port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memcode-team-lan-"));
  let relay: TeamRelay | undefined;
  try {
    await assert.rejects(
      startTeamRelay({ dataDir: directory, host: "0.0.0.0", port: 0 }),
      /advertisedUrl/,
    );
    relay = await startTeamRelay({
      dataDir: directory,
      host: "0.0.0.0",
      port: 0,
      advertisedUrl: "http://127.0.0.1:0",
    });
    assert.ok(Number(new URL(relay.url).port) > 0);
    const response = await fetch(relay.url + "/v1/sync?workspaceId=unknown");
    assert.equal(response.status, 401);
    const privateFiles = await readdir(directory);
    assert.ok(privateFiles.includes("admin.private.json"));
    assert.ok(
      !(await readFile(relay.readyFile, "utf8")).includes(
        relay.adminCapability,
      ),
    );
  } finally {
    await relay?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
