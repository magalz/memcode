import { createPublicKey, verify } from "node:crypto";
import type { BetaBinding, BetaPublicKey } from "./beta-auth";
import { BETA_PROGRAM, BETA_TERMS } from "./beta-auth";
import type { TelemetryAuthorization } from "./telemetry";

/** This audience can ingest counters only. It cannot authorize native engine work. */
export function verifyTelemetryAuthorization(
  token: string,
  binding: BetaBinding,
  accountId: string,
  publicKey: BetaPublicKey,
  now = Date.now(),
): TelemetryAuthorization {
  if (typeof token !== "string" || token.length > 16384)
    throw Error("Invalid usage-sharing grant");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    throw Error("Invalid usage-sharing grant");
  const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ),
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (
    header.alg !== "EdDSA" ||
    header.typ !== "JWT" ||
    header.kid !== publicKey.kid ||
    claims.iss !== "https://memtrace.io" ||
    claims.aud !== "memcode-product-telemetry" ||
    claims.purpose !== "memcode-product-telemetry" ||
    claims.scope !== "telemetry:write" ||
    claims.program !== BETA_PROGRAM ||
    claims.terms_version !== BETA_TERMS ||
    claims.sub !== accountId ||
    claims.device_id !== binding.deviceId ||
    claims.session_id !== binding.sessionId ||
    typeof claims.grant_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,200}$/.test(claims.grant_id) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat * 1000 > now + 30000 ||
    claims.exp * 1000 <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 900
  )
    throw Error("Invalid usage-sharing grant");
  const key = createPublicKey({
    key: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
    format: "jwk",
  });
  if (
    !verify(
      null,
      Buffer.from(parts[0] + "." + parts[1]),
      key,
      Buffer.from(parts[2], "base64url"),
    )
  )
    throw Error("Invalid usage-sharing grant");
  return { token, accountId, expiresAt: claims.exp * 1000 };
}
