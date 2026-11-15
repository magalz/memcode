import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { AppState, Project } from "../src/shared";
import type {
  RepositoryDescriptor,
  RepositoryProgress,
} from "../src/repository";
import {
  bindRepository,
  checkRepositoryAccess,
  cloneRepository,
  findExistingRepositories,
  GitHubRepositorySignIn,
  inspectRepository,
  sanitizeRepositoryURL,
} from "./repository-onboarding";

type Register = (
  name: string,
  schema: z.ZodType,
  handle: (input: any) => unknown,
) => void;
const identifier = z.string().min(1).max(200);
const descriptor = z
  .object({
    url: z.string().min(1).max(3000),
    identity: z.string().max(3000),
    provider: z.enum(["github", "gitlab", "bitbucket", "git"]),
    name: z.string().max(500),
    defaultBranch: z.string().max(250).optional(),
  })
  .strict()
  .transform((value) => sanitizeRepositoryURL(value.url, value.defaultBranch));

export function registerRepositoryRoutes(
  register: Register,
  state: () => AppState,
  project: (id: string) => Project,
  approvedFolders: Set<string>,
  changed: () => Promise<void>,
  analyze: (id: string) => Promise<void>,
  repositoryFor: (id: string) => RepositoryDescriptor | undefined,
  openGitHub: () => Promise<unknown>,
) {
  const jobs = new Map<
    string,
    { controller: AbortController; progress: RepositoryProgress }
  >();
  const github = new GitHubRepositorySignIn();
  let githubOpened = false;
  const matching = (id: string, supplied: RepositoryDescriptor) => {
    const expected = repositoryFor(id);
    if (expected && expected.identity !== supplied.identity)
      throw Error(
        "The selected repository does not match this shared project.",
      );
    return expected ?? supplied;
  };
  const bind = async (id: string, path: string) => {
    const canonical = await realpath(path);
    const key = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    // Reuse is a deliberate user action on a checkout already managed locally.
    // Other paths still require the native folder picker.
    for (const local of state().projects) {
      if (!local.path) continue;
      const existing = await realpath(local.path).catch(() => null);
      if (existing && key(existing) === key(canonical)) {
        approvedFolders.add(canonical);
        break;
      }
    }
    const item = await bindRepository(state(), id, path, {
      approvedFolders,
      expected: repositoryFor(id),
    });
    await changed();
    void analyze(id).catch(() => undefined);
    return item;
  };
  register(
    "repository:inspect",
    z.object({ projectId: identifier }).strict(),
    ({ projectId }) => {
      const path = project(projectId).path;
      if (!path) throw Error("Connect a local repository folder first.");
      return inspectRepository(path);
    },
  );
  register(
    "repository:find-checkouts",
    z.object({ repository: descriptor }).strict(),
    ({ repository }) => findExistingRepositories(state(), repository),
  );
  register(
    "repository:access",
    z.object({ repository: descriptor }).strict(),
    ({ repository }) => checkRepositoryAccess(repository),
  );
  register(
    "project:bind-folder",
    z
      .object({ projectId: identifier, path: z.string().min(1).max(2000) })
      .strict(),
    ({ projectId, path }) => bind(projectId, path),
  );
  register(
    "repository:status",
    z.object({ projectId: identifier }).strict(),
    ({ projectId }) => {
      project(projectId);
      return jobs.get(projectId)?.progress ?? null;
    },
  );
  register(
    "repository:cancel",
    z.object({ projectId: identifier }).strict(),
    ({ projectId }) => {
      project(projectId);
      jobs.get(projectId)?.controller.abort();
    },
  );
  register(
    "repository:github-sign-in",
    z.object({ action: z.enum(["start", "status", "cancel"]) }).strict(),
    async ({ action }) => {
      if (action === "start") githubOpened = false;
      const value = await (action === "start"
        ? github.start()
        : action === "cancel"
          ? github.cancel()
          : github.status());
      if (
        value.state === "waiting" &&
        value.verificationUrl === "https://github.com/login/device" &&
        !githubOpened
      ) {
        githubOpened = true;
        await openGitHub().catch(() => {
          githubOpened = false;
        });
      }
      return value;
    },
  );
  register(
    "repository:clone",
    z
      .object({
        projectId: identifier,
        repository: descriptor,
        parent: z.string().min(1).max(2000),
        name: z.string().min(1).max(100),
      })
      .strict(),
    async ({ projectId, repository, parent, name }) => {
      const item = project(projectId);
      if (item.path)
        throw Error(
          "This project already has local code connected. Use its existing checkout.",
        );
      if (
        jobs.get(projectId)?.progress.phase === "cloning" ||
        jobs.get(projectId)?.progress.phase === "checking"
      )
        throw Error("Repository setup is already running for this project.");
      const controller = new AbortController(),
        job = {
          controller,
          progress: {
            phase: "checking",
            message: "Checking repository access…",
          } as RepositoryProgress,
        };
      jobs.set(projectId, job);
      try {
        const expected = matching(projectId, repository);
        const access = await checkRepositoryAccess(expected, {
          signal: controller.signal,
        });
        if (access.state !== "ready") throw Error(access.message);
        const cloned = await cloneRepository({
          repository: expected,
          parent,
          name,
          approvedFolders,
          signal: controller.signal,
          onProgress: (progress) => {
            job.progress = progress;
          },
        });
        if (controller.signal.aborted)
          throw Error(
            "Repository setup was cancelled. The folder is preserved.",
          );
        approvedFolders.add(await realpath(cloned.path));
        return await bind(projectId, cloned.path);
      } catch (error) {
        job.progress = {
          phase: controller.signal.aborted ? "cancelled" : "failed",
          message:
            error instanceof Error
              ? error.message
              : "Repository setup did not finish.",
        };
        throw error;
      }
    },
  );
  return {
    close: async () => {
      for (const job of jobs.values()) job.controller.abort();
      await github.close();
    },
  };
}
