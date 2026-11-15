import type { Project } from "../src/shared";

type Json = Record<string, any>;
interface PeerIndexClient {
  call(project: Project, name: string, args: Json): Promise<any>;
}
export interface PeerIndexWaitOptions {
  discoveryMs?: number;
  timeoutMs?: number;
  readTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const pathKey = (value: string) => {
  const normalized = value
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const jobPath = (job: Json) =>
  job.runtime_context?.requested_path ?? job.path ?? job.result?.path;
const jobBranch = (job: Json) => job.branch ?? job.result?.branch;
const usable = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 500;

/** Follow an existing owner's job. Never enqueue, clear a store or infer completion from a lease. */
export async function waitForPeerIndex(
  client: PeerIndexClient,
  project: Project,
  response: Json,
  existingRepoId: string | undefined,
  update: (note: string) => void,
  options: PeerIndexWaitOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now,
    sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    started = now(),
    discoveryDeadline = started + (options.discoveryMs ?? 8000),
    deadline = started + (options.timeoutMs ?? 900000),
    pollMs = options.pollMs ?? 1000;
  const repoId = existingRepoId ?? response.repo_id;
  if (!usable(repoId) || !project.path)
    throw Error(
      "Memtrace reported a peer index without a verified repository identity and local checkout.",
    );
  if (
    (response.repo_id && response.repo_id !== repoId) ||
    (response.branch && response.branch !== project.branch)
  )
    throw Error(
      "The reported Memtrace index belongs to another repository or branch. This project's analysis was not adopted.",
    );
  const read = async (name: string, args: Json): Promise<any> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.call(project, name, args),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  `Memtrace ${name} did not respond while inspecting the existing index.`,
                ),
              ),
            options.readTimeoutMs ?? 8000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const belongs = (job: Json) =>
    !!job &&
    typeof job === "object" &&
    job.repo_id === repoId &&
    typeof jobPath(job) === "string" &&
    pathKey(jobPath(job)) === pathKey(project.path!) &&
    (!jobBranch(job) || jobBranch(job) === project.branch);
  const hint = response.job_id ?? response.blocking_job?.id;
  const fail = (job: Json): never => {
    throw Error(
      `Memtrace indexing job ${job.id} failed: ${job.error ?? job.message ?? "The engine did not provide an error."}`,
    );
  };
  const binding = async () => {
    const value = await read("get_query_revision", { repo_id: repoId });
    return value?.ready === true && value.branch === project.branch
      ? value
      : null;
  };
  let current: Json | undefined;
  while (now() <= discoveryDeadline && now() <= deadline) {
    const listed = await read("list_jobs", {});
    const jobs: Json[] = Array.isArray(listed)
      ? listed
      : Array.isArray(listed?.jobs)
        ? listed.jobs
        : [];
    const scoped = [
      ...new Map(
        jobs
          .filter(belongs)
          .filter((job) => usable(job.id))
          .map((job) => [job.id, job]),
      ).values(),
    ];
    if (usable(hint)) {
      const hinted =
        jobs.find((job) => job.id === hint) ??
        (await read("check_job_status", { job_id: hint }).catch(() => null));
      if (hinted && !belongs(hinted))
        throw Error(
          "The existing Memtrace job does not match this local checkout and branch. Its result was not adopted.",
        );
      if (hinted?.status === "failed") fail(hinted);
      if (
        hinted &&
        ["pending", "running", "paused", "completed"].includes(hinted.status)
      )
        current = hinted;
    }
    if (!current) {
      const active = scoped.filter((job) =>
        ["pending", "running", "paused"].includes(job.status),
      );
      if (active.length > 1)
        throw Error(
          "Memtrace lists multiple active jobs for this checkout. Inspect its jobs before reconnecting; no index was queued again.",
        );
      current = active[0];
    }
    if (current) break;
    if (await binding()) return repoId;
    const acquired =
      typeof response.acquired_at === "string"
        ? Date.parse(response.acquired_at)
        : Number.NaN;
    const failed = scoped
      .filter(
        (job) =>
          job.status === "failed" &&
          Number.isFinite(Date.parse(job.updated_at)) &&
          Date.parse(job.updated_at) >=
            (Number.isFinite(acquired) ? acquired : started - 15000),
      )
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    if (failed[0]) fail(failed[0]);
    if (now() >= discoveryDeadline) break;
    update(
      "Memtrace reported an index owner; checking for this checkout's active job…",
    );
    await sleep(Math.min(pollMs, Math.max(0, discoveryDeadline - now())));
  }
  if (!current)
    throw Error(
      "Memtrace reported another index owner, but no active job for this local checkout and branch could be verified. The owner may still be starting or its lease may be stale. Retry when it is ready; no duplicate index was queued.",
    );
  let followed: Json = current;
  const trackedId = followed.id;
  while (now() <= deadline) {
    if (!belongs(followed))
      throw Error(
        "The existing Memtrace job changed repository or checkout scope. Its result was not adopted.",
      );
    if (followed.status === "failed") fail(followed);
    if (followed.status === "paused")
      throw Error(
        `Memtrace indexing job ${followed.id} is paused: ${followed.message ?? followed.stage ?? "Check the engine diagnostics."}`,
      );
    if (followed.status === "completed") {
      // Current Rust jobs omit branch while active. Their completion is useful
      // only after the engine independently certifies this exact branch/source.
      for (let attempt = 0; attempt < 3 && now() <= deadline; attempt++) {
        if (await binding()) return repoId;
        if (attempt < 2) await sleep(pollMs);
      }
      throw Error(
        `Memtrace job ${followed.id} completed, but current source on branch ${project.branch} is not verified. Its result was not treated as ready.`,
      );
    }
    if (!["pending", "running"].includes(followed.status))
      throw Error(
        `Memtrace indexing job ${followed.id} is ${followed.status ?? "unavailable"}. Check the engine diagnostics before reconnecting.`,
      );
    const progress = followed.progress;
    const measured =
      typeof progress?.completed === "number" &&
      typeof progress.total === "number" &&
      progress.total > 0
        ? ` · ${progress.completed}/${progress.total} ${progress.unit ?? "items"}`
        : "";
    update(
      `Following Memtrace job ${followed.id} · ${followed.stage ?? followed.status}${measured}${followed.message ? " · " + String(followed.message).slice(0, 300) : ""}`,
    );
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    const status = await read("check_job_status", { job_id: trackedId });
    if (!status || status.id !== trackedId)
      throw Error(
        `Memtrace could not verify status for indexing job ${trackedId}. Its result was not adopted.`,
      );
    followed = status;
  }
  throw Error(
    `Memtrace job ${followed.id} is still running. Reconnect to follow that existing job; no duplicate index was queued.`,
  );
}
