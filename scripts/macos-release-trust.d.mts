export interface MacReleasePolicy {
  mode: "public-release" | "private-candidate" | "manual-approval-beta";
  publicReady: false;
  manualApprovalRequired?: boolean;
  betaDistributionAllowed?: boolean;
  teamId?: string;
  identity?: string;
  authentication?: "api-key" | "apple-id";
}
export function macReleasePolicy(
  env?: Record<string, string | undefined>,
): MacReleasePolicy;
export function assertPublicMacTrust<T>(proof: T): T;
