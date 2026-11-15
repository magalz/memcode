import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTeamRelay } from "../runtime/team/relay";
import { TeamSyncClient } from "../runtime/team/client";
import {
  formatTeamInvitation,
  parseTeamInvitation,
} from "../runtime/team/invitation";
import type {
  TeamIdentityChallenge,
  TeamIdentityProofVerifier,
} from "../runtime/team-identity";
import type { TeamSpaceSession } from "../runtime/team/spaces";
import type { AppState, Project } from "../src/shared";
import { initialState } from "../src/seed";
import { sanitizeRepositoryURL } from "../runtime/repository-onboarding";

const verifyIdentity: TeamIdentityProofVerifier = async (proof, challenge) => {
  const value = JSON.parse(proof);
  assert.equal(value.nonce, challenge.nonce);
  assert.equal(value.audience, challenge.audience);
  if (!["alice", "bob", "mallory"].includes(value.subject))
    throw Error("Unknown test identity");
  return {
    issuer: "memtrace",
    subject: value.subject,
    name: value.subject.toUpperCase(),
    email: value.subject + "@example.test",
  };
};
function workspace(id: string): AppState {
  const state = initialState(),
    at = "2026-11-15T12:00:00Z";
  const project: Project = {
    id,
    name: id,
    description: "Private description",
    path: null,
    branch: "main",
    analysis: "idle",
    createdAt: at,
  };
  state.projects = [project];
  state.activeProjectId = id;
  state.tasks = [
    {
      ...state.tasks[0],
      id: "seeded-story",
      identifier: "MC-001",
      projectId: id,
      title: id + " story",
      example: false,
      epicId: null,
      cycleId: null,
      parentId: null,
      scope: [],
      messages: [
        { id: "secret", role: "tool", text: "PRIVATE TOOL OUTPUT", at },
      ],
      run: { state: "idle" },
    },
  ];
  state.epics = [];
  state.cycles = [];
  state.artifacts = [];
  state.storyComments = [];
  state.reviewComments = [];
  state.team = [];
  return state;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memcode-team-spaces-"));
  let relay = await startTeamRelay({
    dataDir: join(root, "relay"),
    port: 0,
    verifyIdentity,
  });
  const request = async (path: string, body?: unknown, capability?: string) => {
    const response = await fetch(relay.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(capability ? { authorization: `Bearer ${capability}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const proof = async (subject: string) => {
    const { body } = await request("/v1/team-auth/challenge");
    return { nonce: body.nonce, proof: JSON.stringify({ ...body, subject }) };
  };
  const create = async () => {
    const result = await request(
      "/v1/teams",
      {
        name: "Orbit team",
        ...(await proof("alice")),
        deviceId: randomUUID(),
        deviceName: "Windows",
      },
      relay.adminCapability,
    );
    assert.equal(result.status, 201);
    return result.body as TeamSpaceSession;
  };
  return {
    root,
    request,
    proof,
    create,
    get relay() {
      return relay;
    },
    async restart() {
      const port = Number(new URL(relay.url).port);
      await relay.close();
      relay = await startTeamRelay({
        dataDir: join(root, "relay"),
        port,
        verifyIdentity,
      });
    },
    async close() {
      await relay.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("verified named Teams contain multiple projects, targeted invitations and revocable membership across restart", async () => {
  const f = await fixture();
  try {
    const owner = await f.create(),
      teamId = owner.team.id,
      cap = owner.credential.capability;
    const repo = sanitizeRepositoryURL(
      "https://user:secret@github.com/syncable-dev/memcode.git?token=secret",
      "main",
    );
    const first = await f.request(
      "/v1/teams/projects",
      { teamId, opId: randomUUID(), name: "MemCode", repository: repo },
      cap,
    );
    const second = await f.request(
      "/v1/teams/projects",
      { teamId, opId: randomUUID(), name: "Orbit" },
      cap,
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.identity, "memtrace");
    const invite = await f.request(
      "/v1/teams/invites",
      {
        teamId,
        email: "bob@example.test",
        projectWorkspaceId: first.body.project.workspaceId,
      },
      cap,
    );
    const preview = await f.request("/v1/teams/invites/preview", {
      teamId,
      invitation: invite.body.invitation,
    });
    assert.equal(preview.body.teamName, "Orbit team");
    assert.equal(preview.body.invitedBy, "ALICE");
    assert.equal(preview.body.repository.identity, repo.identity);
    assert.doesNotMatch(
      JSON.stringify(preview.body),
      /secret|capability|PRIVATE/,
    );
    const wrong = await f.request("/v1/teams/invites/accept", {
      teamId,
      invitation: invite.body.invitation,
      ...(await f.proof("mallory")),
      deviceId: randomUUID(),
      deviceName: "Mac",
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, "TEAM_INVITE_EMAIL");
    const accepted = await f.request("/v1/teams/invites/accept", {
      teamId,
      invitation: invite.body.invitation,
      ...(await f.proof("bob")),
      deviceId: randomUUID(),
      deviceName: "Mac",
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.team.role, "member");
    assert.equal(accepted.body.team.projects.length, 2);
    assert.equal(
      accepted.body.projectWorkspaceId,
      first.body.project.workspaceId,
    );
    const bob = accepted.body.credential;
    const opened = await f.request(
      "/v1/teams/projects/open",
      { teamId, workspaceId: first.body.project.workspaceId },
      bob.capability,
    );
    assert.equal(opened.status, 200);
    assert.equal(opened.body.credential.memberId, bob.memberId);
    assert.equal(
      (await f.request("/v1/teams/invites", { teamId }, bob.capability)).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/v1/teams/members/revoke",
          { teamId, memberId: owner.credential.memberId },
          cap,
        )
      ).status,
      409,
    );
    const nextInvite = await f.request(
      "/v1/teams/invites",
      { teamId, email: "bob@example.test" },
      cap,
    );
    const otherDevice = await f.request("/v1/teams/invites/accept", {
      teamId,
      invitation: nextInvite.body.invitation,
      ...(await f.proof("bob")),
      deviceId: randomUUID(),
      deviceName: "Linux",
    });
    assert.equal(otherDevice.body.credential.memberId, bob.memberId);
    assert.equal(
      otherDevice.body.team.members.find((m: any) => m.id === bob.memberId)
        .devices.length,
      2,
    );
    const wait = f.request(
      `/v1/sync?workspaceId=${first.body.project.workspaceId}&after=${opened.body.snapshot.head}&waitMs=20000`,
      undefined,
      bob.capability,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      (
        await f.request(
          "/v1/teams/members/revoke",
          { teamId, memberId: bob.memberId },
          cap,
        )
      ).status,
      200,
    );
    assert.equal((await wait).status, 403);
    assert.equal(
      (
        await f.request(
          "/v1/teams/projects/open",
          { teamId, workspaceId: first.body.project.workspaceId },
          otherDevice.body.credential.capability,
        )
      ).body.error.code,
      "TEAM_REVOKED",
    );
    assert.equal(
      (
        await f.request(
          "/v1/commands",
          {
            workspaceId: first.body.project.workspaceId,
            opId: randomUUID(),
            command: { type: "member.read", through: 0 },
          },
          bob.capability,
        )
      ).status,
      403,
    );
    await f.restart();
    assert.equal(
      (await f.request(`/v1/teams?teamId=${teamId}`, undefined, cap)).body
        .projects.length,
      2,
    );
    assert.equal(
      (await f.request(`/v1/teams?teamId=${teamId}`, undefined, bob.capability))
        .body.error.code,
      "TEAM_REVOKED",
    );
  } finally {
    await f.close();
  }
});

test("identity challenge replay, invitation cancellation and reused project operation IDs fail closed", async () => {
  const f = await fixture();
  try {
    const owner = await f.create(),
      teamId = owner.team.id,
      cap = owner.credential.capability;
    const identity = await f.proof("bob"),
      invite = await f.request("/v1/teams/invites", { teamId }, cap);
    const info = await f.request(`/v1/teams?teamId=${teamId}`, undefined, cap);
    const id = info.body.invitations[0].id;
    assert.equal(
      (
        await f.request(
          "/v1/teams/invites/revoke",
          { teamId, invitationId: id },
          cap,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/v1/teams/invites/preview", {
          teamId,
          invitation: invite.body.invitation,
        })
      ).status,
      403,
    );
    const payload = {
      teamId,
      invitation: invite.body.invitation,
      ...identity,
      deviceId: randomUUID(),
      deviceName: "Mac",
    };
    assert.equal(
      (await f.request("/v1/teams/invites/accept", payload)).status,
      403,
    );
    assert.equal(
      (await f.request("/v1/teams/invites/accept", payload)).body.error.code,
      "IDENTITY_CHALLENGE",
    );
    const opId = randomUUID();
    const first = await f.request(
      "/v1/teams/projects",
      { teamId, opId, name: "First" },
      cap,
    );
    const retry = await f.request(
      "/v1/teams/projects",
      { teamId, opId, name: "First" },
      cap,
    );
    assert.equal(
      first.body.project.workspaceId,
      retry.body.project.workspaceId,
    );
    assert.equal(
      (
        await f.request(
          "/v1/teams/projects",
          { teamId, opId, name: "Changed" },
          cap,
        )
      ).body.error.code,
      "OP_ID_REUSE",
    );
    const malicious = {
      ...sanitizeRepositoryURL("https://github.com/org/repo"),
      identity: "github.com/other/repo",
    };
    assert.equal(
      (
        await f.request(
          "/v1/teams/projects",
          {
            teamId,
            opId: randomUUID(),
            name: "Bad repo",
            repository: malicious,
          },
          cap,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("Team clients join invitation-first, keep personal planning private, roundtrip namespaced edits and retain offline outbox after revocation", async () => {
  const f = await fixture(),
    aState = workspace("owner-project"),
    bState = workspace("personal-project");
  const aDir = join(f.root, "a"),
    bDir = join(f.root, "b");
  const options = (subject: string) => ({
    background: false,
    identityProof: async (challenge: TeamIdentityChallenge) =>
      JSON.stringify({ ...challenge, subject }),
  });
  let offline = false;
  const a = new TeamSyncClient(
    () => aState,
    aDir,
    async () => {},
    options("alice"),
  );
  let b = new TeamSyncClient(
    () => bState,
    bDir,
    async () => {},
    {
      ...options("bob"),
      fetch: (input, init) =>
        offline ? Promise.reject(Error("Offline")) : fetch(input, init),
    },
  );
  try {
    await a.initialize();
    await b.initialize();
    await mkdir(join(aDir, "team"), { recursive: true });
    await writeFile(
      join(aDir, "team", "service.private.json"),
      JSON.stringify({
        endpoint: f.relay.url,
        bootstrapSecret: f.relay.adminCapability,
      }),
    );
    const team = await a.createTeamWorkspace({ name: "Team collaboration" });
    const shared = await a.shareProject({
      teamId: team.id,
      projectId: "owner-project",
      repository: sanitizeRepositoryURL("https://github.com/org/repo", "main"),
    });
    const invitation = await a.inviteTeamMember({
      teamId: team.id,
      email: "bob@example.test",
      projectWorkspaceId: shared.workspace.workspaceId,
    });
    assert.match(invitation.url, /\/join\/team\//);
    assert.doesNotMatch(invitation.url, /\{/);
    const personal = structuredClone(bState.tasks[0]);
    const accepted = await b.acceptTeamInvitation({ invite: invitation.url }),
      projectId = accepted.project!.projectId;
    assert.equal(bState.projects.find((p) => p.id === projectId)?.path, null);
    assert.deepEqual(
      bState.tasks.find((t) => t.projectId === "personal-project"),
      personal,
    );
    const linked = bState.tasks.find((t) => t.projectId === projectId)!;
    assert.notEqual(linked.id, personal.id);
    assert.equal(linked.title, "owner-project story");
    assert.equal(
      b.repositoryForProject(projectId)?.identity,
      "github.com/org/repo",
    );
    assert.doesNotMatch(
      JSON.stringify(accepted),
      /PRIVATE TOOL OUTPUT|bootstrapSecret|capability|subject/,
    );
    linked.title = "Changed by teammate";
    await b.capture();
    await b.synchronize(projectId);
    await a.synchronize("owner-project");
    assert.equal(aState.tasks[0].title, "Changed by teammate");
    await b.acquire(linked.id, projectId);
    await b.release(linked.id, projectId);
    assert.equal(
      (await b.acceptTeamInvitation({ invite: invitation.url })).project!
        .projectId,
      projectId,
    );
    offline = true;
    linked.description = "Offline teammate note";
    await b.capture();
    await b.close();
    b = new TeamSyncClient(
      () => bState,
      bDir,
      async () => {},
      {
        ...options("bob"),
        fetch: (input, init) =>
          offline ? Promise.reject(Error("Offline")) : fetch(input, init),
      },
    );
    await b.initialize();
    assert.equal(b.status(projectId)!.pendingCount, 1);
    await a.revokeTeamMember({
      teamId: team.id,
      memberId: accepted.project!.memberId,
    });
    offline = false;
    await assert.rejects(b.synchronize(projectId), /revoked/);
    assert.equal(b.status(projectId)!.pendingCount, 1);
    const directory = await b.teamsList();
    assert.equal(directory.teams[0].connection, "revoked");
    assert.equal(directory.teams[0].projects[0].localProjectId, projectId);
    assert.equal(
      JSON.parse(await readFile(join(bDir, "team", "connections.json"), "utf8"))
        .connections[0].outbox.length,
      1,
    );
    const restore = await a.inviteTeamMember({
      teamId: team.id,
      email: "bob@example.test",
      projectWorkspaceId: shared.workspace.workspaceId,
    });
    assert.equal(
      (await b.previewTeamInvitation({ invite: restore.url }))
        .projectWorkspaceId,
      shared.workspace.workspaceId,
    );
    const restored = await b.acceptTeamInvitation({ invite: restore.url });
    assert.equal(restored.project!.projectId, projectId);
    assert.equal(b.status(projectId)!.pendingCount, 1);
    await b.synchronize(projectId);
    await a.synchronize("owner-project");
    assert.equal(aState.tasks[0].description, "Offline teammate note");
    assert.equal(b.status(projectId)!.pendingCount, 0);
  } finally {
    await a.close();
    await b.close();
    await f.close();
  }
});

test("invitation links keep secrets in fragments and accept legacy invitations explicitly", () => {
  const token = "x".repeat(43),
    teamId = randomUUID(),
    url = formatTeamInvitation("https://relay.example.test", teamId, token);
  assert.equal(new URL(url).pathname, `/join/team/${teamId}`);
  assert.equal(new URL(url).search, "");
  assert.deepEqual(parseTeamInvitation(url), {
    kind: "team",
    endpoint: "https://relay.example.test",
    id: teamId,
    invitation: token,
  });
  assert.equal(
    parseTeamInvitation(
      JSON.stringify({
        endpoint: "https://relay.example.test",
        workspaceId: teamId,
        invitation: token,
      }),
    ).kind,
    "project",
  );
  assert.throws(
    () => parseTeamInvitation(url.replace("https://", "https://secret@")),
    /complete/,
  );
});

test("existing members open the invited second project and account locks persist until the original verified person reconnects", async () => {
  const f = await fixture(),
    ownerState = workspace("owner"),
    memberState = workspace("private"),
    aDir = join(f.root, "a"),
    bDir = join(f.root, "b");
  let person = "bob",
    calls = 0;
  const identityProof = async (challenge: TeamIdentityChallenge) =>
    JSON.stringify({ ...challenge, subject: person });
  const a = new TeamSyncClient(
    () => ownerState,
    aDir,
    async () => {},
    {
      background: false,
      identityProof: async (c) => JSON.stringify({ ...c, subject: "alice" }),
    },
  );
  let b = new TeamSyncClient(
    () => memberState,
    bDir,
    async () => {},
    {
      background: false,
      identityProof,
      fetch: (input, init) => {
        calls++;
        return fetch(input, init);
      },
    },
  );
  try {
    await a.initialize();
    await b.initialize();
    await writeFile(
      join(aDir, "team", "service.private.json"),
      JSON.stringify({
        endpoint: f.relay.url,
        bootstrapSecret: f.relay.adminCapability,
      }),
    );
    const team = await a.createTeamWorkspace({ name: "Named team" }),
      first = await a.shareProject({ teamId: team.id, projectId: "owner" });
    ownerState.projects.push({
      ...ownerState.projects[0],
      id: "second",
      name: "Second project",
    });
    const second = await a.shareProject({
      teamId: team.id,
      projectId: "second",
    });
    const invite = await a.inviteTeamMember({
      teamId: team.id,
      projectWorkspaceId: first.workspace.workspaceId,
      email: "bob@example.test",
    });
    const accepted = await b.acceptTeamInvitation({ invite: invite.url });
    const secondInvite = await a.inviteTeamMember({
      teamId: team.id,
      projectWorkspaceId: second.workspace.workspaceId,
      email: "bob@example.test",
    });
    const opened = await b.acceptTeamInvitation({ invite: secondInvite.url });
    assert.equal(
      opened.project!.workspace.workspaceId,
      second.workspace.workspaceId,
    );
    assert.equal(
      memberState.projects.find((p) => p.id === opened.project!.projectId)
        ?.name,
      "Second project",
    );
    await b.suspendAccount();
    const before = calls;
    assert.equal((await b.teamsList()).teams[0].connection, "signed-out");
    assert.equal(calls, before);
    await assert.rejects(
      b.synchronize(accepted.project!.projectId),
      /Reconnect/,
    );
    await b.close();
    b = new TeamSyncClient(
      () => memberState,
      bDir,
      async () => {},
      { background: false, identityProof },
    );
    await b.initialize();
    assert.equal((await b.teamsList()).teams[0].connection, "signed-out");
    person = "mallory";
    await assert.rejects(
      b.reauthenticateTeam({ teamId: team.id }),
      /active access/,
    );
    assert.equal((await b.teamsList()).teams[0].connection, "signed-out");
    person = "alice";
    await assert.rejects(
      b.reauthenticateTeam({ teamId: team.id }),
      /another Memtrace account/,
    );
    assert.equal((await b.teamsList()).teams[0].connection, "signed-out");
    person = "bob";
    assert.equal(
      (await b.reauthenticateTeam({ teamId: team.id })).connection,
      "online",
    );
    await b.synchronize(accepted.project!.projectId);
    await b.synchronize(opened.project!.projectId);
    assert.equal(
      (await b.teamsList()).teams[0].members.find(
        (m) => m.id === accepted.project!.memberId,
      )?.name,
      "BOB",
    );
  } finally {
    await a.close();
    await b.close();
    await f.close();
  }
});

test("moving an existing preview room into a verified Team keeps its board and denies old preview capabilities", async () => {
  const f = await fixture(),
    state = workspace("owner"),
    dir = join(f.root, "owner");
  const owner = new TeamSyncClient(
    () => state,
    dir,
    async () => {},
    {
      background: false,
      identityProof: async (c) => JSON.stringify({ ...c, subject: "alice" }),
    },
  );
  try {
    await owner.initialize();
    await writeFile(
      join(dir, "team", "service.private.json"),
      JSON.stringify({
        endpoint: f.relay.url,
        bootstrapSecret: f.relay.adminCapability,
      }),
    );
    const preview = await owner.create({
      projectId: "owner",
      endpoint: f.relay.url,
      bootstrapSecret: f.relay.adminCapability,
      displayName: "Unverified preview name",
    });
    const saved = JSON.parse(
      await readFile(join(dir, "team", "connections.json"), "utf8"),
    );
    const old = saved.connections[0].credential;
    const team = await owner.createTeamWorkspace({ name: "Real team" }),
      shared = await owner.shareProject({
        teamId: team.id,
        projectId: "owner",
      });
    assert.equal(shared.workspace.workspaceId, preview.workspace.workspaceId);
    assert.equal(shared.workspace.stories[0].title, "owner story");
    assert.equal(state.tasks[0].messages[0].text, "PRIVATE TOOL OUTPUT");
    assert.equal(
      (
        await f.request(
          `/v1/sync?workspaceId=${old.workspaceId}`,
          undefined,
          old.capability,
        )
      ).status,
      403,
    );
    await owner.synchronize("owner");
    assert.equal((await owner.teamsList()).teams[0].projects.length, 1);
    await f.restart();
    await owner.synchronize("owner");
    assert.equal(owner.status("owner")!.workspace.stories.length, 1);
  } finally {
    await owner.close();
    await f.close();
  }
});

test("concurrent Team creation is guarded and an account switch during browser proof cannot establish a stale connection", async () => {
  const f = await fixture(),
    state = workspace("owner"),
    dir = join(f.root, "owner");
  let resolveProof!: (proof: string) => void,
    markStarted!: () => void,
    challenge: TeamIdentityChallenge | undefined,
    createRequests = 0;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const client = new TeamSyncClient(
    () => state,
    dir,
    async () => {},
    {
      background: false,
      identityProof: async (value) => {
        challenge = value;
        markStarted();
        return new Promise<string>((resolve) => {
          resolveProof = resolve;
        });
      },
      fetch: (input, init) => {
        if (String(input).endsWith("/v1/teams") && init?.method === "POST")
          createRequests++;
        return fetch(input, init);
      },
    },
  );
  try {
    await client.initialize();
    await writeFile(
      join(dir, "team", "service.private.json"),
      JSON.stringify({
        endpoint: f.relay.url,
        bootstrapSecret: f.relay.adminCapability,
      }),
    );
    const creating = client.createTeamWorkspace({ name: "In progress" });
    await started;
    await assert.rejects(
      client.createTeamWorkspace({ name: "Second click" }),
      /already being created/,
    );
    await client.suspendAccount();
    resolveProof(JSON.stringify({ ...challenge, subject: "alice" }));
    await assert.rejects(creating, /account changed/);
    assert.equal(createRequests, 0);
    assert.equal((await client.teamsList()).teams.length, 0);
  } finally {
    await client.close();
    await f.close();
  }
});

test("a late accepted Team response after account switch stays private and never unlocks the new account", async () => {
  const f = await fixture(),
    state = workspace("owner"),
    dir = join(f.root, "owner");
  let release!: () => void, markAccepted!: () => void;
  const accepted = new Promise<void>((resolve) => {
      markAccepted = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const client = new TeamSyncClient(
    () => state,
    dir,
    async () => {},
    {
      background: false,
      identityProof: async (c) => JSON.stringify({ ...c, subject: "alice" }),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/v1/teams") && init?.method === "POST") {
          markAccepted();
          await gate;
        }
        return response;
      },
    },
  );
  try {
    await client.initialize();
    await writeFile(
      join(dir, "team", "service.private.json"),
      JSON.stringify({
        endpoint: f.relay.url,
        bootstrapSecret: f.relay.adminCapability,
      }),
    );
    const creating = client.createTeamWorkspace({ name: "Late response" });
    await accepted;
    await client.suspendAccount();
    release();
    await assert.rejects(creating, /account changed|aborted/i);
    assert.equal((await client.teamsList()).teams.length, 0);
    const saved = JSON.parse(
      await readFile(join(dir, "team", "connections.json"), "utf8"),
    );
    assert.equal(saved.teams?.length ?? 0, 0);
    assert.equal(saved.connections.length, 0);
  } finally {
    release?.();
    await client.close();
    await f.close();
  }
});

test("lost Team-create acknowledgements retry the same durable operation across restart", async () => {
  const f = await fixture(),
    state = workspace("owner"),
    dir = join(f.root, "owner");
  let drop = true,
    createdId = "";
  const options = {
    background: false,
    identityProof: async (c: TeamIdentityChallenge) =>
      JSON.stringify({ ...c, subject: "alice" }),
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const response = await fetch(input, init);
      if (
        drop &&
        String(input).endsWith("/v1/teams") &&
        init?.method === "POST"
      ) {
        drop = false;
        createdId = ((await response.json()) as any).team.id;
        throw Error("Dropped accepted response");
      }
      return response;
    },
  };
  let client = new TeamSyncClient(
    () => state,
    dir,
    async () => {},
    options,
  );
  try {
    await client.initialize();
    await writeFile(
      join(dir, "team", "service.private.json"),
      JSON.stringify({
        endpoint: f.relay.url,
        bootstrapSecret: f.relay.adminCapability,
      }),
    );
    await assert.rejects(
      client.createTeamWorkspace({ name: "Durable Team" }),
      /Dropped/,
    );
    assert.equal((await client.teamsList()).teams.length, 0);
    const saved = JSON.parse(
      await readFile(join(dir, "team", "connections.json"), "utf8"),
    );
    assert.equal(saved.teamCreates.length, 1);
    await client.close();
    await f.restart();
    client = new TeamSyncClient(
      () => state,
      dir,
      async () => {},
      options,
    );
    await client.initialize();
    const team = await client.createTeamWorkspace({ name: "Durable Team" });
    assert.equal(team.id, createdId);
    assert.equal((await client.teamsList()).teams.length, 1);
    assert.equal(
      JSON.parse(await readFile(join(dir, "team", "connections.json"), "utf8"))
        .teamCreates.length,
      0,
    );
  } finally {
    await client.close();
    await f.close();
  }
});

test("only a fresh owner invitation for the verified email can restore a revoked member and old capabilities stay denied", async () => {
  const f = await fixture();
  try {
    const owner = await f.create(),
      teamId = owner.team.id,
      cap = owner.credential.capability;
    const initial = await f.request(
        "/v1/teams/invites",
        { teamId, email: "bob@example.test" },
        cap,
      ),
      oldPending = await f.request(
        "/v1/teams/invites",
        { teamId, email: "bob@example.test" },
        cap,
      );
    const bob = await f.request("/v1/teams/invites/accept", {
      teamId,
      invitation: initial.body.invitation,
      ...(await f.proof("bob")),
      deviceId: randomUUID(),
      deviceName: "Mac",
    });
    const credential = bob.body.credential;
    await f.request(
      "/v1/teams/members/revoke",
      { teamId, memberId: credential.memberId },
      cap,
    );
    const accept = async (invitation: string, subject = "bob") =>
      f.request("/v1/teams/invites/accept", {
        teamId,
        invitation,
        ...(await f.proof(subject)),
        deviceId: randomUUID(),
        deviceName: "New Mac",
      });
    assert.equal(
      (await accept(oldPending.body.invitation)).body.error.code,
      "TEAM_REVOKED",
    );
    const broad = await f.request("/v1/teams/invites", { teamId }, cap);
    assert.equal(
      (await accept(broad.body.invitation)).body.error.code,
      "TEAM_REVOKED",
    );
    const targeted = await f.request(
      "/v1/teams/invites",
      { teamId, email: "bob@example.test" },
      cap,
    );
    assert.equal(
      (await accept(targeted.body.invitation, "mallory")).body.error.code,
      "TEAM_INVITE_EMAIL",
    );
    const restored = await accept(targeted.body.invitation);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.credential.memberId, credential.memberId);
    assert.equal(
      (
        await f.request(
          `/v1/teams?teamId=${teamId}`,
          undefined,
          credential.capability,
        )
      ).status,
      403,
    );
    await f.restart();
    assert.equal(
      (
        await f.request(
          `/v1/teams?teamId=${teamId}`,
          undefined,
          credential.capability,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/v1/teams?teamId=${teamId}`,
          undefined,
          restored.body.credential.capability,
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("invitation URLs serve a private copy-and-open landing page without consuming membership", async () => {
  const f = await fixture();
  try {
    const owner = await f.create(),
      teamId = owner.team.id,
      cap = owner.credential.capability;
    const invite = await f.request(
      "/v1/teams/invites",
      { teamId, email: "bob@example.test" },
      cap,
    );
    const url = formatTeamInvitation(
        f.relay.url,
        teamId,
        invite.body.invitation,
      ),
      response = await fetch(url),
      html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /script-src 'nonce-/,
    );
    assert.doesNotMatch(
      response.headers.get("content-security-policy") ?? "",
      /unsafe-inline/,
    );
    assert.match(html, /Copy invitation/);
    assert.match(html, /Join a team project/);
    assert.match(html, /location.href/);
    assert.doesNotMatch(html, new RegExp(invite.body.invitation));
    assert.doesNotMatch(html, /bob@example|Orbit team|capability|https?:\/\//);
    const directory = await f.request(
      `/v1/teams?teamId=${teamId}`,
      undefined,
      cap,
    );
    assert.equal(directory.body.members.length, 1);
    assert.equal(directory.body.invitations.length, 1);
    assert.equal(
      (
        await f.request("/v1/teams/invites/preview", {
          teamId,
          invitation: invite.body.invitation,
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("a lost membership-accept response recovers after restart only for its verified person and original device", async () => {
  const f = await fixture(),
    state = workspace("private"),
    dir = join(f.root, "member");
  const owner = await f.create(),
    teamId = owner.team.id;
  const shared = await f.request(
    "/v1/teams/projects",
    { teamId, opId: randomUUID(), name: "Existing project" },
    owner.credential.capability,
  );
  const invite = await f.request(
    "/v1/teams/invites",
    {
      teamId,
      email: "bob@example.test",
      projectWorkspaceId: shared.body.project.workspaceId,
    },
    owner.credential.capability,
  );
  const url = formatTeamInvitation(f.relay.url, teamId, invite.body.invitation);
  let drop = true;
  const options = {
    background: false,
    identityProof: async (c: TeamIdentityChallenge) =>
      JSON.stringify({ ...c, subject: "bob" }),
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const response = await fetch(input, init);
      if (drop && String(input).endsWith("/v1/teams/invites/accept")) {
        drop = false;
        await response.arrayBuffer();
        throw Error("Lost membership response");
      }
      return response;
    },
  };
  let client = new TeamSyncClient(
    () => state,
    dir,
    async () => {},
    options,
  );
  try {
    await client.initialize();
    await assert.rejects(
      client.acceptTeamInvitation({ invite: url }),
      /Lost membership/,
    );
    assert.equal((await client.teamsList()).teams.length, 0);
    // Issuing another invitation must not erase the first acceptance receipt.
    await f.request(
      "/v1/teams/invites",
      { teamId },
      owner.credential.capability,
    );
    await client.close();
    await f.restart();
    client = new TeamSyncClient(
      () => state,
      dir,
      async () => {},
      options,
    );
    await client.initialize();
    assert.equal(
      (await client.previewTeamInvitation({ invite: url })).teamName,
      "Orbit team",
    );
    const recovered = await client.acceptTeamInvitation({ invite: url });
    assert.equal(
      recovered.project!.workspace.workspaceId,
      shared.body.project.workspaceId,
    );
    assert.equal(
      recovered.team.members.filter((m) => m.email === "bob@example.test")
        .length,
      1,
    );
    const wrong = await f.request("/v1/teams/invites/accept", {
      teamId,
      invitation: invite.body.invitation,
      ...(await f.proof("bob")),
      deviceId: randomUUID(),
      deviceName: "Another device",
    });
    assert.equal(wrong.status, 403);
  } finally {
    await client.close();
    await f.close();
  }
});
