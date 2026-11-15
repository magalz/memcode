/** Cross-repository contract check. Uses synthetic users and ephemeral keys only.
 * node --import tsx scripts/test-memtrace-identity.ts /path/to/memtrace-ui/src/server/memcode-identity-core.ts
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startTeamRelay } from "../runtime/team/relay";
import { createMemtraceIdentityProofProvider, createMemtraceIdentityVerifier, type TeamIdentityChallenge } from "../runtime/team-identity";

const source = process.argv[2];
if (!source) throw Error("Pass the actual Memtrace web memcode-identity-core.ts path. No production identity is used.");
const { createMemcodeIdentitySigner, createMemcodeIdentityHandlers } = await import(pathToFileURL(resolve(source)).href);
const pair = generateKeyPairSync("ed25519"), signer = createMemcodeIdentitySigner(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
let user = { id: "test-memtrace-alice", name: "Alice Contract Test", email: "alice@example.test", emailVerified: true };
const records = new Map<string, { value: any; expiry: number }>();
const issuer = createMemcodeIdentityHandlers({ session: async () => user, signer: () => signer,
  store: {
    allowAuthorization: async () => true,
    put: async (key: string, value: unknown, expiry: Date) => { records.set(key, { value: structuredClone(value), expiry: expiry.getTime() }); },
    read: async (key: string) => { const value = records.get(key); return value && value.expiry > Date.now() ? structuredClone(value.value) : null; },
    consume: async (key: string, value: any) => { const row = records.get(key); return !!row && row.expiry > Date.now() && JSON.stringify(row.value) === JSON.stringify(value) && records.delete(key); },
  },
});
const verifyIdentity = createMemtraceIdentityVerifier({ loadKeys: async () => (await issuer.jwks()).json() });
const provider = createMemtraceIdentityProofProvider({ ready: async () => true,
  openExternal: async (url) => {
    const authorize = await issuer.authorize(new Request(url)); assert.equal(authorize.status, 200);
    const consent = /name="consent" value="([A-Za-z0-9_-]+)"/.exec(await authorize.text())?.[1]; assert.ok(consent);
    const approval = await issuer.authorize(new Request(url, { method: "POST", headers: { origin: "https://memtrace.io", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent, action: "approve" }) }));
    assert.equal(approval.status, 303);
    const callback = approval.headers.get("location")!; assert.ok(!callback.includes("id_token"));
    assert.equal((await fetch(callback)).status, 200);
  },
  exchange: async (input) => {
    const response = await issuer.token(new Request("https://www.memtrace.io/api/memcode/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));
    assert.equal(response.status, 200); return response.json();
  },
});
const directory = await mkdtemp(join(tmpdir(), "memcode-identity-contract-"));
const relay = await startTeamRelay({ dataDir: directory, port: 0, verifyIdentity });
const request = async (path: string, body?: unknown, capability?: string) => {
  const response = await fetch(relay.url + path, { method: body === undefined ? "GET" : "POST", headers: {
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...(capability ? { authorization: `Bearer ${capability}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() as any };
};
const identity = async () => {
  const response = await request("/v1/team-auth/challenge"); assert.equal(response.status, 200);
  const challenge = response.value as TeamIdentityChallenge;
  return { proof: await provider(challenge), nonce: challenge.nonce };
};
try {
  const firstProof = await identity();
  const created = await request("/v1/teams", { name: "Verified identity contract", ...firstProof, deviceId: randomUUID(), deviceName: "Alice test device" }, relay.adminCapability);
  assert.equal(created.status, 201); const alice = created.value;
  assert.equal(alice.credential.subject, "test-memtrace-alice"); assert.equal(alice.team.identity, "memtrace");
  assert.equal(alice.team.members[0].name, "Alice Contract Test");
  assert.equal(alice.team.members[0].email, "alice@example.test");
  const replay = await request("/v1/teams", { name: "Must not replay", ...firstProof, deviceId: randomUUID(), deviceName: "Replay" }, relay.adminCapability);
  assert.notEqual(replay.status, 201);
  const invited = await request("/v1/teams/invites", { teamId: alice.team.id, email: "bob@example.test" }, alice.credential.capability);
  assert.equal(invited.status, 201);
  user = { id: "test-memtrace-bob", name: "Bob Contract Test", email: "bob@example.test", emailVerified: false };
  const unverified = await request("/v1/teams/invites/accept", { teamId: alice.team.id, invitation: invited.value.invitation, ...await identity(), deviceId: randomUUID(), deviceName: "Bob" });
  assert.notEqual(unverified.status, 200);
  user.emailVerified = true;
  const joined = await request("/v1/teams/invites/accept", { teamId: alice.team.id, invitation: invited.value.invitation, ...await identity(), deviceId: randomUUID(), deviceName: "Bob" });
  assert.equal(joined.status, 200); const bob = joined.value;
  assert.equal(bob.credential.subject, "test-memtrace-bob"); assert.equal(bob.team.members.length, 2);
  const members = await request(`/v1/teams?teamId=${alice.team.id}`, undefined, alice.credential.capability);
  assert.equal(members.value.members[1].name, "Bob Contract Test");
  await request("/v1/teams/members/revoke", { teamId: alice.team.id, memberId: bob.credential.memberId }, alice.credential.capability);
  assert.notEqual((await request(`/v1/teams?teamId=${alice.team.id}`, undefined, bob.credential.capability)).status, 200);
  assert.equal(records.size, 0);
  console.log("PASS: actual Memtrace issuer -> browser approval -> PKCE code -> actual MemCode verifier -> named Team owner/member; replay, unverified email and revoked membership rejected. Synthetic identities only.");
} finally {
  provider.cancel(); await relay.close();
  const root = resolve(tmpdir()), target = resolve(directory);
  assert.ok(target.startsWith(root + (process.platform === "win32" ? "\\" : "/")) && target.includes("memcode-identity-contract-"));
  await rm(target, { recursive: true, force: true });
}
