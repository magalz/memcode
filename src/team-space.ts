import type { RepositoryDescriptor } from "./repository";
import type { TeamWorkspaceState } from "./shared";

export type WorkspaceTeamRole = "owner" | "member";
export interface WorkspaceTeamMember {
  id: string;
  name: string;
  email?: string;
  role: WorkspaceTeamRole;
  status: "active" | "revoked";
  devices: Array<{ id: string; name: string }>;
  joinedAt: string;
  revokedAt?: string;
}
export interface TeamProjectDescriptor {
  workspaceId: string;
  name: string;
  repository?: RepositoryDescriptor;
  createdAt: string;
  /** Device-local binding, added by the client and never stored at the relay. */
  localProjectId?: string;
}
export interface WorkspaceTeam {
  id: string;
  name: string;
  role: WorkspaceTeamRole;
  identity: "memtrace" | "invite-preview";
  members: WorkspaceTeamMember[];
  projects: TeamProjectDescriptor[];
  createdAt: string;
  revision: number;
  invitations?: Array<{
    id: string;
    email?: string;
    projectWorkspaceId?: string;
    expiresAt: string;
  }>;
  connection?: "online" | "offline" | "revoked" | "signed-out";
  error?: string;
}
export interface TeamDirectory {
  teams: WorkspaceTeam[];
  configured: boolean;
  canCreate: boolean;
  identityAvailable: boolean;
  detail?: string;
}
export interface TeamInvitationPreview {
  teamName: string;
  projectName?: string;
  projectWorkspaceId?: string;
  repository?: RepositoryDescriptor;
  invitedBy?: string;
  invitedEmail?: string;
  expiresAt: string;
  identity: "memtrace" | "invite-preview";
}
export interface TeamMemberInvitation {
  url: string;
  expiresAt: string;
  invitedEmail?: string;
}
export interface AcceptedTeamInvitation {
  team: WorkspaceTeam;
  project?: TeamWorkspaceState;
}
