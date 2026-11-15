import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createMemtraceIdentityProofProvider, createMemtraceIdentityVerifier, teamIdentityAudience,
  type MemtraceIdentityPublicKey, type TeamIdentityChallenge } from "../runtime/team-identity";

const now = Date.now(), nonce = () => randomBytes(32).toString("base64url");
const challenge = (): TeamIdentityChallenge => ({ audience: "https://team.example.test", nonce: nonce(), expiresAt: new Date(now + 300_000).toISOString() });
const pair = generateKeyPairSync("ed25519");
const key = { ...pair.publicKey.export({ format: "jwk" }), kid: "memtrace-key", alg: "EdDSA", use: "sig" } as MemtraceIdentityPublicKey;
function proof(challenge: TeamIdentityChallenge, override: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const head = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: key.kid, ...header })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "https://memtrace.io", aud: challenge.audience, nonce: challenge.nonce,
    purpose: "memcode-team", sub: "stable-memtrace-person", name: "Alex Holmberg", email: "alex@example.test", email_verified: true,
    iat: Math.floor(now / 1000), exp: Math.floor((now + 290_000) / 1000), jti: nonce(), ...override })).toString("base64url");
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), pair.privateKey).toString("base64url")}`;
}
const verifier = () => createMemtraceIdentityVerifier({ now: () => now, loadKeys: async () => ({ keys: [key] }) });

test("real signed Memtrace user identity is independent of the client display name and license", async () => {
  const c = challenge(), verify = verifier();
  assert.deepEqual(await verify(proof(c), c), { issuer: "memtrace", subject: "stable-memtrace-person", name: "Alex Holmberg", email: "alex@example.test" });
  assert.equal((await verify(proof(c, { email_verified: false }), c)).email, undefined);
});

test("identity proof rejects wrong issuer, relay, nonce, purpose, time and unsupported signing headers", async () => {
  const c = challenge(), verify = verifier();
  for (const change of [{ iss: "https://other.test" }, { aud: "https://another-team.test" }, { nonce: nonce() },
    { purpose: "license" }, { sub: "" }, { name: "" }, { jti: "missing" }, { iat: Math.floor(now / 1000) + 60 },
    { exp: Math.floor(now / 1000) - 1 }, { exp: Math.floor(now / 1000) + 600 }, { nbf: Math.floor(now / 1000) + 60 }]) {
    await assert.rejects(verify(proof(c, change), c), /could not be verified/);
  }
  for (const change of [{ alg: "none" }, { alg: "HS256" }, { jku: "https://attacker.test/jwks" }, { jwk: key }, { crit: ["custom"] }]) {
    await assert.rejects(verify(proof(c, {}, change), c), /could not be verified/);
  }
  const signed = proof(c).split("."); signed[1] = Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url");
  await assert.rejects(verify(signed.join("."), c));
  await assert.rejects(verify("a".repeat(20_000), c));
});

test("only a trusted public Ed25519 key may verify assertions", async () => {
  const c = challenge();
  for (const keys of [[], [key, key], [{ ...key, d: "private" }], [{ ...key, crv: "X25519" }], [{ ...key, key_ops: ["sign"] }]]) {
    await assert.rejects(createMemtraceIdentityVerifier({ now: () => now, loadKeys: async () => ({ keys }) })(proof(c), c));
  }
  const different = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  await assert.rejects(createMemtraceIdentityVerifier({ now: () => now, loadKeys: async () => ({ keys: [{ ...key, ...different } as MemtraceIdentityPublicKey] }) })(proof(c), c));
});

test("identity audience only permits canonical HTTPS or local development origins", () => {
  assert.equal(teamIdentityAudience("https://team.example.test/"), "https://team.example.test");
  assert.equal(teamIdentityAudience("http://127.0.0.1:12345"), "http://127.0.0.1:12345");
  for (const value of ["http://remote.test", "https://user:secret@remote.test", "https://remote.test/path", "https://remote.test?a=1", "javascript:alert(1)"]) assert.throws(() => teamIdentityAudience(value));
});

test("browser PKCE hands off only an opaque code and exchanges at Memtrace without CLI credentials", async () => {
  const c = challenge(); let opened: URL | undefined, intercepted = false;
  const provider = createMemtraceIdentityProofProvider({ now: () => now, ready: async () => true,
    openExternal: async (value) => {
      opened = new URL(value); assert.equal(opened.origin, "https://memtrace.io"); assert.equal(opened.pathname, "/api/memcode/authorize");
      assert.equal(opened.searchParams.get("audience"), c.audience);
      const callback = new URL(opened.searchParams.get("redirect_uri")!);
      assert.equal(callback.hostname, "127.0.0.1");
      const invalid = new URL(callback); invalid.searchParams.set("state", nonce()); invalid.searchParams.set("code", nonce());
      assert.equal((await fetch(invalid)).status, 404); intercepted = true;
      callback.searchParams.set("state", opened.searchParams.get("state")!); callback.searchParams.set("code", "x".repeat(43));
      assert.equal((await fetch(callback)).status, 200);
    },
    exchange: async (input) => {
      assert.equal(input.code, "x".repeat(43));
      assert.equal(input.redirect_uri, opened!.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(input.code_verifier).digest("base64url"), opened!.searchParams.get("code_challenge"));
      assert.equal(opened!.searchParams.get("code_challenge_method"), "S256");
      assert.deepEqual(Object.keys(input).sort(), ["code", "code_verifier", "redirect_uri"]);
      return { id_token: proof(c) };
    },
  });
  const token = await provider(c); assert.ok(intercepted);
  assert.equal((await verifier()(token, c)).subject, "stable-memtrace-person");
  await assert.rejects(fetch(opened!.searchParams.get("redirect_uri")!), /fetch failed/);
});

test("browser cancellation and failure close the one-shot listener without adopting a profile", async () => {
  const c = challenge(); let exchanges = 0;
  const cancelled = createMemtraceIdentityProofProvider({ now: () => now, ready: async () => true,
    openExternal: async (value) => {
      const open = new URL(value), callback = new URL(open.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", open.searchParams.get("state")!); callback.searchParams.set("error", "access_denied");
      await fetch(callback);
    }, exchange: async () => { exchanges++; return { id_token: "never" }; },
  });
  await assert.rejects(cancelled(c), /cancelled/); assert.equal(exchanges, 0);
  await assert.rejects(createMemtraceIdentityProofProvider({ now: () => now, ready: async () => true, openExternal: async () => { throw Error("no browser"); } })(c), /Could not open/);
  await assert.rejects(cancelled({ ...c, expiresAt: new Date(now - 1).toISOString() }), /could not be verified/);
});

test("unavailable identity service fails before opening a browser, and app cancellation releases pending login", async () => {
  let opened = 0;
  const unavailable = createMemtraceIdentityProofProvider({ ready: async () => false, openExternal: async () => { opened++; } });
  await assert.rejects(unavailable(challenge()), /not enabled/); assert.equal(opened, 0);
  let openedSignal!: () => void; const didOpen = new Promise<void>((resolve) => { openedSignal = resolve; });
  const provider = createMemtraceIdentityProofProvider({ ready: async () => true, openExternal: async () => { openedSignal(); } });
  const waiting = provider(challenge()); await didOpen;
  await assert.rejects(provider(challenge()), /Finish the current/);
  provider.cancel(); await assert.rejects(waiting, /cancelled/);
});
