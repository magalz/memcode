const SERVICES_URL = "https://www.memtrace.io/api/memcode/services";
let cached: { expires: number; value: { endpoint: string } | undefined } | undefined;
let pending: Promise<{ endpoint: string } | undefined> | undefined;

/** Public endpoint discovery only; sends no identity, credentials or local project data. */
export async function discoverOfficialTeamService(requestFetch: typeof fetch = fetch): Promise<{ endpoint: string } | undefined> {
  if (requestFetch === fetch && cached && cached.expires > Date.now()) return cached.value;
  const load = async () => {
    const response = await requestFetch(SERVICES_URL, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 4096) throw Error("The MemCode Team service directory is unavailable.");
    const reader = response.body?.getReader();
    if (!reader) throw Error("The MemCode Team service directory is empty.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 4096) throw Error("The MemCode Team service directory is invalid."); chunks.push(chunk.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown; teamRelay?: unknown };
    if (value?.version !== 1 || !Object.hasOwn(value, "teamRelay")) throw Error("The MemCode Team service directory is invalid.");
    if (value.teamRelay === null) return undefined;
    const service = value.teamRelay as { endpoint?: unknown };
    if (!service || typeof service.endpoint !== "string") throw Error("The MemCode Team service directory is invalid.");
    const url = new URL(service.endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port ||
        service.endpoint !== url.origin || !url.hostname.includes(".") || url.hostname === "localhost" || /^127\.|^\[/.test(url.hostname))
      throw Error("The official Team service must use a public HTTPS origin.");
    return { endpoint: url.origin };
  };
  if (requestFetch !== fetch) return load();
  pending ??= load().then((value) => { cached = { expires: Date.now() + 60_000, value }; return value; }).finally(() => { pending = undefined; });
  return pending;
}
