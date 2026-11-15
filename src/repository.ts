/** Portable source identity. Absolute paths and credentials are device-local. */
export interface RepositoryDescriptor {
  url: string;
  identity: string;
  provider: "github" | "gitlab" | "bitbucket" | "git";
  name: string;
  defaultBranch?: string;
}

export interface RepositoryInspection {
  path: string;
  repositoryRoot: string;
  branch: string;
  revision?: string;
  dirty: boolean;
  remotes: Array<{ name: string; repository: RepositoryDescriptor }>;
  repository?: RepositoryDescriptor;
}

export interface RepositoryAccess {
  state: "ready" | "needs-sign-in" | "no-access" | "offline" | "unknown";
  repository: RepositoryDescriptor;
  accountLabel?: string;
  method: "git" | "github-cli";
  /** Read access does not establish branch protection or permission to push. */
  writeAccess?: boolean;
  message: string;
}

export interface RepositoryProgress {
  phase: "checking" | "cloning" | "ready" | "failed" | "cancelled";
  message: string;
}

export interface RepositoryGitHubSignIn {
  state: "idle" | "waiting" | "signed-in" | "failed" | "cancelled";
  verificationUrl?: string;
  userCode?: string;
  accountLabel?: string;
  message: string;
}
