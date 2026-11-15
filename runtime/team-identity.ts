import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";

/** Identity comes from Memtrace's browser session, never a license or CLI status. */
export interface TeamIdentityChallenge {
  audience: string;
  nonce: string;
  expiresAt: string;
}
export interface VerifiedTeamIdentity {
  subject: string;
  name: string;
  email?: string;
  issuer: "memtrace";
}
export type TeamIdentityProofProvider = (challenge: TeamIdentityChallenge) => Promise<string>;
export type TeamIdentityProofVerifier = (proof: string, challenge: TeamIdentityChallenge) => Promise<VerifiedTeamIdentity>;
export interface MemtraceIdentityPublicKey {
  kty: string; crv: string; x: string; kid?: string; d?: string;
  alg?: string; use?: string; key_ops?: string[];
}

const ISSUER = "https://memtrace.io";
// The production apex redirects to www. Pin API calls directly to the official
// canonical host so token exchanges never follow a redirect carrying a code.
const API_ORIGIN = "https://www.memtrace.io";
const MAX_BODY = 32_768;
const failure = () => new Error("Memtrace identity could not be verified. Sign in again and retry.");
const string = (value: unknown, max = 500): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{32,200}$/.test(value);

export function teamIdentityAudience(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) {
    throw new Error("Team identity requires an HTTPS relay origin or a loopback relay.");
  }
  return url.origin;
}
function challengeValid(challenge: TeamIdentityChallenge, now: number) {
  if (teamIdentityAudience(challenge.audience) !== challenge.audience || !opaque(challenge.nonce) ||
      !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= now ||
      Date.parse(challenge.expiresAt) > now + 305_000) throw failure();
}
async function json(response: Response): Promise<any> {
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_BODY) throw failure();
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength; if (length > MAX_BODY) throw failure(); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

let readiness: { checkedAt: number; available: boolean } | undefined;
export async function memtraceTeamIdentityAvailable(): Promise<boolean> {
  if (readiness && Date.now() - readiness.checkedAt < 30_000) return readiness.available;
  let available = false;
  try {
    const data = await json(await fetch(`${API_ORIGIN}/api/memcode/jwks`, {
      redirect: "error", signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" },
    }));
    available = Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= 10 && data.keys.some((key: any) =>
      key?.kty === "OKP" && key.crv === "Ed25519" && string(key.kid, 120) && string(key.x, 100) && !key.d);
  } catch {}
  readiness = { checkedAt: Date.now(), available }; return available;
}

export interface MemtraceIdentityVerifierOptions {
  /** Trusted loader seam; production always retrieves the fixed official URL. */
  loadKeys?: () => Promise<{ keys: MemtraceIdentityPublicKey[] }>;
  now?: () => number;
}
export function createMemtraceIdentityVerifier(options: MemtraceIdentityVerifierOptions = {}): TeamIdentityProofVerifier {
  let keys: MemtraceIdentityPublicKey[] = [], fetchedAt = 0;
  const clock = options.now ?? Date.now;
  const load = options.loadKeys ?? (async () => json(await fetch(`${API_ORIGIN}/api/memcode/jwks`, {
    redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" },
  })));
  return async (proof, challenge) => {
    try {
      const now = clock(); challengeValid(challenge, now);
      if (proof.length > 16_384) throw failure();
      const parts = proof.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw failure();
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (header.alg !== "EdDSA" || header.typ !== "JWT" || !string(header.kid, 120) ||
          header.jku || header.jwk || header.x5u || header.crit) throw failure();
      if (claims.iss !== ISSUER || claims.aud !== challenge.audience || claims.nonce !== challenge.nonce ||
          claims.purpose !== "memcode-team" || !string(claims.sub, 200) || !string(claims.name, 240) ||
          !opaque(claims.jti) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
          claims.iat > Math.floor(now / 1000) + 15 || claims.exp <= Math.floor(now / 1000) ||
          claims.exp <= claims.iat || claims.exp - claims.iat > 300 ||
          claims.exp * 1000 > Date.parse(challenge.expiresAt) + 1000 ||
          (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf * 1000 > now + 15_000))) throw failure();
      if (!keys.length || now - fetchedAt > 60_000) {
        const loaded = await load();
        if (!Array.isArray(loaded.keys) || loaded.keys.length > 10) throw failure();
        keys = loaded.keys; fetchedAt = now;
      }
      const matching = keys.filter((key) => key.kid === header.kid && key.kty === "OKP" && key.crv === "Ed25519" &&
        !key.d && (!key.alg || key.alg === "EdDSA") && (!key.use || key.use === "sig") &&
        (!key.key_ops || key.key_ops.includes("verify")));
      if (matching.length !== 1 || Buffer.from(parts[2], "base64url").length !== 64 ||
          !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: matching[0], format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw failure();
      return { subject: claims.sub, name: claims.name.trim() || "Memtrace member", issuer: "memtrace",
        ...(claims.email_verified === true && string(claims.email, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
          ? { email: claims.email } : {}) };
    } catch { throw failure(); }
  };
}

export interface MemtraceIdentityProviderOptions {
  /** Opens only the fixed official approval URL in the user's browser. */
  openExternal: (url: string) => Promise<unknown>;
  /** Test seam. It never receives CLI/provider credentials. */
  exchange?: (input: { code: string; code_verifier: string; redirect_uri: string }) => Promise<{ id_token: string }>;
  ready?: () => Promise<boolean>;
  now?: () => number;
}
export function createMemtraceIdentityProofProvider(options: MemtraceIdentityProviderOptions): TeamIdentityProofProvider & { available(): Promise<boolean>; cancel(): void } {
  let pending = false, cancel: (() => void) | undefined;
  const ready = options.ready ?? memtraceTeamIdentityAvailable;
  const provider: TeamIdentityProofProvider = async (challenge) => {
    if (pending) throw new Error("Finish the current Memtrace sign-in in your browser first.");
    challengeValid(challenge, (options.now ?? Date.now)()); pending = true;
    let cancelled = false;
    const abort = new AbortController();
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    const path = `/memcode-identity/${state}`;
    let settle!: (code: string) => void, reject!: (error: Error) => void;
    const result = new Promise<string>((resolve, fail) => { settle = resolve; reject = fail; });
    // Preflight can fail before the browser callback is awaited. Keep cancellation
    // handled in that window without changing the eventual await's rejection.
    void result.catch(() => undefined);
    cancel = () => { cancelled = true; abort.abort(); reject(new Error("Memtrace team sign-in was cancelled.")); };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== path || url.searchParams.get("state") !== state) {
        response.writeHead(404); response.end(); return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      const denied = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (denied || !opaque(code)) {
        response.end("<title>MemCode sign-in cancelled</title><p>Sign-in was cancelled. Return to MemCode.</p>");
        reject(new Error("Memtrace team sign-in was cancelled.")); return;
      }
      response.end("<title>Return to MemCode</title><body style='font:17px system-ui;padding:48px;background:#f8fbf7;color:#153b2d'><h1>You're connected.</h1><p>Return to MemCode to continue. You can close this tab.</p></body>");
      settle(code);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!await ready()) throw new Error("Memtrace team sign-in is not enabled on the service yet. No browser was opened. Try again after it is enabled.");
      if (cancelled) throw new Error("Memtrace team sign-in was cancelled.");
      await new Promise<void>((resolve, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address(); if (!address || typeof address === "string") throw failure();
      const redirect = `http://127.0.0.1:${address.port}${path}`;
      const authorize = new URL(`${ISSUER}/api/memcode/authorize`);
      for (const [key, value] of Object.entries({ audience: challenge.audience, nonce: challenge.nonce,
        expires_at: challenge.expiresAt, redirect_uri: redirect, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
      timer = setTimeout(() => reject(new Error("Memtrace sign-in timed out. Retry when you're ready.")), Math.max(1, Date.parse(challenge.expiresAt) - (options.now ?? Date.now)()));
      // Attach the rejection handler before opening a browser, which can reply immediately.
      const opened = options.openExternal(authorize.href).catch(() => { reject(new Error("Could not open Memtrace sign-in. Check your default browser and retry.")); });
      const code = await result; await opened;
      if (cancelled) throw new Error("Memtrace team sign-in was cancelled.");
      const input = { code, code_verifier: verifier, redirect_uri: redirect };
      const token = options.exchange ? await options.exchange(input) : await json(await fetch(`${API_ORIGIN}/api/memcode/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]), headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }));
      if (!string(token.id_token, 16_384)) throw failure();
      return token.id_token;
    } finally {
      pending = false; cancel = undefined; if (timer) clearTimeout(timer);
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  return Object.assign(provider, { available: ready, cancel: () => cancel?.() });
}
