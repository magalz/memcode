import { z } from "zod";
import { isActive } from "../src/domain";
import type { AppState } from "../src/shared";

const publishedRelease = z.object({
  version: z.string().min(1).max(80),
  publishedAt: z.iso.datetime({ offset: true }),
  title: z.string().max(300),
  notes: z.string().max(64000),
});
const releaseManifest = z.object({
  product: z.literal("MemCode"),
  channel: z.literal("beta"),
  releases: z.array(publishedRelease).max(50),
});
export async function appReleaseHistory(fetcher: typeof fetch = fetch) {
  const response = await fetcher(
    "https://www.memtrace.io/api/memcode/releases",
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok)
    throw new Error(
      "Release history is unavailable right now. Try again shortly.",
    );
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("The release service returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1_000_000)
        throw new Error("The release history response was too large.");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const manifest = releaseManifest.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  return manifest.releases
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 12);
}

/** Reserve an idle workspace for a verified installer without cancelling work. */
export class AppUpdateGate {
  preparing = false;
  constructor(private readonly state: () => AppState) {}
  context() {
    return {
      activeWorkers: this.state().tasks.filter(
        (task) => !task.example && isActive(task),
      ).length,
    };
  }
  preflight() {
    const active = this.state().tasks.filter(
      (task) => !task.example && isActive(task),
    );
    if (active.length)
      throw new Error(
        `Finish or stop ${active.length === 1 ? "the running worker" : `the ${active.length} running workers`} before updating MemCode.`,
      );
    return { ready: true };
  }
  assertMayStart() {
    if (this.preparing)
      throw new Error(
        "MemCode is preparing an app update. Try again after the update finishes.",
      );
  }
  reserve() {
    this.preflight();
    if (this.preparing)
      throw new Error("An app update is already preparing to install.");
    this.preparing = true;
  }
  release() {
    this.preparing = false;
  }
}

type Register = (
  name: string,
  schema: z.ZodType,
  handler: (input: any) => unknown,
) => void;
export function registerAppUpdates(
  register: Register,
  gate: AppUpdateGate,
  save: () => Promise<void>,
  resume: () => void,
) {
  register("app:update-context", z.undefined(), () => gate.context());
  register("app:update-history", z.undefined(), () => appReleaseHistory());
  register("app:update-preflight", z.undefined(), () => gate.preflight());
  register("app:update-prepare", z.undefined(), async () => {
    gate.reserve();
    try {
      await save();
    } catch (error) {
      gate.release();
      resume();
      throw error;
    }
    return { ready: true };
  });
  register("app:update-release", z.undefined(), () => {
    gate.release();
    resume();
  });
}
