import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { verifyTelemetryAuthorization } from "../runtime/telemetry-auth";
import {
  BETA_PROGRAM,
  BETA_TERMS,
  createBetaAuthorization,
  type BetaBinding,
  type BetaPublicKey,
  type BetaTokens,
} from "../runtime/beta-auth";
import { MemCodeBeta, type BetaStorage } from "../runtime/beta";
import { childEnv } from "../runtime/commands";

const pair = generateKeyPairSync("ed25519");
const publicKey = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "telemetry-test-key",
  alg: "EdDSA",
  use: "sig",
} as BetaPublicKey;
const account = { id: "verified-synthetic-person", name: "Synthetic member" };
function issue(
  binding: BetaBinding,
  purpose = "memcode-product-telemetry",
  patch: Record<string, unknown> = {},
) {
  const time = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://memtrace.io",
    aud: purpose,
    purpose,
    program: BETA_PROGRAM,
    terms_version: BETA_TERMS,
    sub: account.id,
    name: account.name,
    device_id: binding.deviceId,
    session_id: binding.sessionId,
    grant_id: randomBytes(32).toString("base64url"),
    scope: "telemetry:write",
    iat: time,
    exp: time + 900,
    jti: randomBytes(32).toString("base64url"),
    entitlements: {
      local_engine: true,
      graph_queries: "unlimited",
      cortex: true,
      improve: true,
      external_memdb: false,
      provider_credits: false,
    },
    ...patch,
  };
  const input =
    Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: publicKey.kid }),
    ).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(claims)).toString("base64url");
  return (
    input +
    "." +
    sign(null, Buffer.from(input), pair.privateKey).toString("base64url")
  );
}
const binding = {
  deviceId: "device-fixture-123456",
  sessionId: "session-fixture-123456",
};

test("only a distinct signed account/device/session-bound telemetry purpose authorizes counter delivery", () => {
  assert.equal(
    verifyTelemetryAuthorization(issue(binding), binding, account.id, publicKey)
      .accountId,
    account.id,
  );
  for (const token of [
    issue(binding, "memcode-engine-beta"),
    issue(binding, "memcode-team-identity"),
    issue(binding, undefined, { sub: "another-person" }),
    issue(binding, undefined, { session_id: "another-session" }),
    issue(binding, undefined, { device_id: "another-device" }),
    issue(binding, undefined, { exp: Math.floor(Date.now() / 1000) - 1 }),
    issue(binding) + "tampered",
  ])
    assert.throws(
      () => verifyTelemetryAuthorization(token, binding, account.id, publicKey),
      /Invalid usage-sharing grant/,
    );
});

test("beta refresh requests telemetry only after explicit opt-in and preserves old response compatibility", async () => {
  let enabled = false;
  const bodies: any[] = [];
  const authorization = createBetaAuthorization({
    openExternal: async () => {},
    telemetryOptIn: () => enabled,
    fetcher: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        access_token: "synthetic-engine-grant",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "r".repeat(32),
        refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
        terms_version: BETA_TERMS,
        account,
      });
    },
  });
  const first = await authorization.refresh("r".repeat(32), binding);
  assert.equal(first.telemetry_token, undefined);
  assert.equal(bodies[0].telemetry_opt_in, undefined);
  enabled = true;
  await authorization.refresh("r".repeat(32), binding);
  assert.equal(bodies[1].telemetry_opt_in, true);
});

test("host beta lifecycle keeps telemetry credentials out of engine files, storage, public status and worker environment", async () => {
  let enabled = false;
  const stored: string[] = [],
    proofs: string[] = [];
  const storage: BetaStorage = {
    read: async () => ({ configured: false, credentials: null }),
    write: async (value) => {
      stored.push(JSON.stringify(value));
    },
    writeAccess: async (value) => {
      proofs.push(value);
      return "C:/synthetic/private/access.jwt";
    },
    clearAccess: async () => {},
    markSignedOut: async () => {},
    clear: async () => {},
    forgetSession: async () => {},
  };
  const tokens = (b: BetaBinding): BetaTokens => ({
    access_token: issue(b, "memcode-engine-beta"),
    token_type: "Bearer",
    expires_in: 900,
    refresh_token: randomBytes(32).toString("base64url"),
    refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
    terms_version: BETA_TERMS,
    account,
    ...(enabled
      ? { telemetry_token: issue(b), telemetry_expires_in: 900 }
      : {}),
  });
  const manager = new MemCodeBeta({
    storage,
    authorization: {
      available: async () => true,
      cancel: () => {},
      authorize: async (b) => tokens(b),
      refresh: async (_r, b) => tokens(b),
      revoke: async () => {},
    },
    telemetryOptIn: () => enabled,
    loadKeys: async () => ({ keys: [publicKey] }),
    assertMayChange: () => {},
    beforeIdentityChange: async () => {},
  });
  try {
    await manager.connect();
    assert.equal(await manager.telemetryAuthorization(), null);
    enabled = true;
    const grant = await manager.telemetryAuthorization();
    assert.ok(grant);
    const environment = await manager.environment();
    assert.equal(JSON.stringify(environment).includes(grant.token), false);
    assert.equal(
      stored.some((value) => value.includes(grant.token)),
      false,
    );
    assert.equal(proofs.includes(grant.token), false);
    assert.equal(
      JSON.stringify(await manager.status()).includes(grant.token),
      false,
    );
    const previous = process.env.MEMCODE_TELEMETRY_TOKEN;
    process.env.MEMCODE_TELEMETRY_TOKEN = grant.token;
    try {
      assert.equal(childEnv().MEMCODE_TELEMETRY_TOKEN, undefined);
      assert.equal(
        childEnv({ engine: true }).MEMCODE_TELEMETRY_TOKEN,
        undefined,
      );
    } finally {
      if (previous === undefined) delete process.env.MEMCODE_TELEMETRY_TOKEN;
      else process.env.MEMCODE_TELEMETRY_TOKEN = previous;
    }
    await manager.signOut();
    assert.equal(await manager.telemetryAuthorization(), null);
  } finally {
    manager.close();
  }
});
