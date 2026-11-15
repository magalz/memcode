import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryDescriptor } from "../../src/repository";
import type {
  TeamInvitationPreview,
  TeamProjectDescriptor,
  WorkspaceTeam,
  WorkspaceTeamMember,
} from "../../src/team-space";
import type { VerifiedTeamIdentity } from "../team-identity";
import { TeamProtocolError } from "./protocol";
import { replaceWorkspace } from "../persistence";

export interface TeamSpaceCredential {
  teamId: string;
  memberId: string;
  deviceId: string;
  capability: string;
  subject: string;
}
export interface TeamSpaceSession {
  credential: TeamSpaceCredential;
  team: WorkspaceTeam;
  projectWorkspaceId?: string;
}
type Actor = { memberId: string; deviceId: string };
type StoredMember = WorkspaceTeamMember & {
  subject: string;
  revokedRevision?: number;
};
interface StoredInvite {
  id: string;
  hash: string;
  expiresAt: string;
  email?: string;
  projectWorkspaceId?: string;
  invitedBy?: string;
  issuedRevision?: number;
  usedAt?: string;
  revokedAt?: string;
  acceptedSubject?: string;
  acceptedDeviceId?: string;
}
interface StoredTeam {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  revision: number;
  members: StoredMember[];
  projects: TeamProjectDescriptor[];
  credentials: Record<string, Actor>;
  invitations: StoredInvite[];
  projectOperations: Record<string, { workspaceId: string; hash: string }>;
  creation?: { opId: string; deviceId: string; subject: string; name: string };
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (code: string, message: string, status = 403): never => {
  throw new TeamProtocolError(code, message, undefined, status);
};

/** Named teams own project rooms; the existing room journals remain authoritative for board data. */
export class TeamSpaceStore {
  private teams = new Map<string, StoredTeam>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory))
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const value = JSON.parse(
          await readFile(join(this.directory, name), "utf8"),
        ) as StoredTeam;
        if (
          value.version !== 1 ||
          value.id + ".json" !== name ||
          !Array.isArray(value.members) ||
          !Array.isArray(value.projects) ||
          !value.credentials ||
          !value.invitations
        )
          throw Error(
            "The saved Team directory is invalid; its files have been preserved.",
          );
        this.teams.set(value.id, value);
      }
  }
  private async save(value: StoredTeam) {
    const path = join(this.directory, value.id + ".json"),
      file = await open(path + ".next", "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await replaceWorkspace(path + ".next", path);
    this.teams.set(value.id, value);
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    // Directory changes are infrequent. One queue also makes moving a room
    // into a Team atomic across two owners racing to adopt the same room.
    id = "directory";
    const pending = (this.pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.pending.set(id, pending);
    void pending
      .finally(() => {
        if (this.pending.get(id) === pending) this.pending.delete(id);
      })
      .catch(() => {});
    return pending;
  }
  private get(id: string) {
    return (
      this.teams.get(id) ??
      fail("TEAM_NOT_FOUND", "This Team does not exist.", 404)
    );
  }
  private public(value: StoredTeam, memberId: string): WorkspaceTeam {
    const member = value.members.find((item) => item.id === memberId)!;
    return {
      id: value.id,
      name: value.name,
      role: member.role,
      identity: "memtrace",
      members: value.members.map(
        ({ subject: _subject, revokedRevision: _revokedRevision, ...member }) =>
          structuredClone(member),
      ),
      projects: structuredClone(value.projects),
      createdAt: value.createdAt,
      revision: value.revision,
      ...(member.role === "owner"
        ? {
            invitations: value.invitations
              .filter(
                (item) =>
                  !item.usedAt &&
                  !item.revokedAt &&
                  Date.parse(item.expiresAt) > Date.now(),
              )
              .map(({ id, email, projectWorkspaceId, expiresAt }) => ({
                id,
                email,
                projectWorkspaceId,
                expiresAt,
              })),
          }
        : {}),
    };
  }
  authenticate(
    teamId: string,
    capability: string,
  ): { actor: Actor; member: WorkspaceTeamMember } {
    const value = this.get(teamId),
      actor = value.credentials[digest(capability)];
    if (!actor)
      return fail("TEAM_AUTH", "This device is not authorized for this Team.");
    const member = value.members.find((member) => member.id === actor.memberId);
    if (!member || member.status !== "active")
      return fail(
        "TEAM_REVOKED",
        "Your Team membership has been revoked. Local files are preserved.",
      );
    return { actor, member };
  }
  private owner(value: StoredTeam, capability: string) {
    const { actor, member } = this.authenticate(value.id, capability);
    if (member.role !== "owner")
      return fail(
        "TEAM_FORBIDDEN",
        "Only a Team owner can manage membership and projects.",
      );
    return actor;
  }
  read(teamId: string, capability: string): WorkspaceTeam {
    const { actor } = this.authenticate(teamId, capability);
    return this.public(this.get(teamId), actor.memberId);
  }
  projectTeam(workspaceId: string): string | undefined {
    for (const team of this.teams.values())
      if (team.projects.some((project) => project.workspaceId === workspaceId))
        return team.id;
    return undefined;
  }
  project(
    teamId: string,
    workspaceId: string,
    capability: string,
  ): TeamProjectDescriptor {
    this.authenticate(teamId, capability);
    return (
      this.get(teamId).projects.find(
        (project) => project.workspaceId === workspaceId,
      ) ?? fail("TEAM_PROJECT", "This project is not in the Team.", 404)
    );
  }
  async create(
    name: string,
    identity: VerifiedTeamIdentity,
    device: { id: string; name: string },
    opId?: string,
  ): Promise<TeamSpaceSession> {
    return this.serial("directory", async () => {
      const prior =
        opId &&
        [...this.teams.values()].find(
          (team) =>
            team.creation?.opId === opId &&
            team.creation.deviceId === device.id,
        );
      if (prior) {
        if (
          prior.creation!.subject !== identity.subject ||
          prior.creation!.name !== name
        )
          return fail(
            "OP_ID_REUSE",
            "This Team creation was started with another account or name. Its original Team has been preserved.",
            409,
          );
        return this.connect(structuredClone(prior), identity, device);
      }
      if (this.teams.size >= 100)
        return fail(
          "TEAM_LIMIT",
          "This relay has reached its Team limit.",
          409,
        );
      const id = randomUUID(),
        memberId = randomUUID(),
        capability = secret(),
        at = new Date().toISOString();
      const member: StoredMember = {
        id: memberId,
        subject: identity.subject,
        name: identity.name,
        ...(identity.email ? { email: identity.email } : {}),
        role: "owner",
        status: "active",
        devices: [device],
        joinedAt: at,
      };
      const value: StoredTeam = {
        version: 1,
        id,
        name,
        createdAt: at,
        revision: 1,
        members: [member],
        projects: [],
        credentials: {
          [digest(capability)]: { memberId, deviceId: device.id },
        },
        invitations: [],
        projectOperations: {},
        ...(opId
          ? {
              creation: {
                opId,
                deviceId: device.id,
                subject: identity.subject,
                name,
              },
            }
          : {}),
      };
      await this.save(value);
      return {
        credential: {
          teamId: id,
          memberId,
          deviceId: device.id,
          capability,
          subject: identity.subject,
        },
        team: this.public(value, memberId),
      };
    });
  }
  async invite(
    teamId: string,
    capability: string,
    input: { email?: string; projectWorkspaceId?: string },
  ): Promise<{ invitation: string; expiresAt: string; invitedEmail?: string }> {
    return this.serial(teamId, async () => {
      const current = this.get(teamId),
        actor = this.owner(current, capability);
      if (
        input.projectWorkspaceId &&
        !current.projects.some(
          (project) => project.workspaceId === input.projectWorkspaceId,
        )
      )
        return fail("TEAM_PROJECT", "Choose a project in this Team.", 404);
      const value = structuredClone(current),
        now = Date.now();
      value.invitations = value.invitations.filter(
        (invite) => !invite.revokedAt && Date.parse(invite.expiresAt) > now,
      );
      if (value.invitations.filter((invite) => !invite.usedAt).length >= 100)
        return fail(
          "TEAM_LIMIT",
          "Use or revoke a pending Team invitation first.",
          409,
        );
      while (value.invitations.length >= 1000) {
        const used = value.invitations.findIndex((invite) => !!invite.usedAt);
        if (used < 0) break;
        value.invitations.splice(used, 1);
      }
      const invitation = secret(),
        expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
      value.invitations.push({
        id: randomUUID(),
        hash: digest(invitation),
        expiresAt,
        issuedRevision: value.revision + 1,
        invitedBy: current.members.find((item) => item.id === actor.memberId)
          ?.name,
        ...(input.email ? { email: input.email.toLowerCase() } : {}),
        ...(input.projectWorkspaceId
          ? { projectWorkspaceId: input.projectWorkspaceId }
          : {}),
      });
      value.revision++;
      await this.save(value);
      return {
        invitation,
        expiresAt,
        ...(input.email ? { invitedEmail: input.email.toLowerCase() } : {}),
      };
    });
  }
  preview(
    teamId: string,
    invitation: string,
    capability?: string,
  ): TeamInvitationPreview {
    const value = this.get(teamId),
      invite = value.invitations.find(
        (item) => item.hash === digest(invitation),
      );
    if (
      !invite ||
      invite.revokedAt ||
      Date.parse(invite.expiresAt) <= Date.now()
    )
      return fail("TEAM_INVITE", "This Team invitation is expired or revoked.");
    if (capability) this.authenticate(teamId, capability);
    const project = invite.projectWorkspaceId
      ? value.projects.find(
          (project) => project.workspaceId === invite.projectWorkspaceId,
        )
      : undefined;
    return {
      teamName: value.name,
      ...(project
        ? {
            projectWorkspaceId: project.workspaceId,
            projectName: project.name,
            ...(project.repository
              ? { repository: structuredClone(project.repository) }
              : {}),
          }
        : {}),
      ...(invite.invitedBy ? { invitedBy: invite.invitedBy } : {}),
      ...(invite.email ? { invitedEmail: invite.email } : {}),
      expiresAt: invite.expiresAt,
      identity: "memtrace",
    };
  }
  async accept(
    teamId: string,
    invitation: string,
    identity: VerifiedTeamIdentity,
    device: { id: string; name: string },
  ): Promise<TeamSpaceSession> {
    return this.serial(teamId, async () => {
      const current = this.get(teamId);
      this.preview(teamId, invitation);
      const value = structuredClone(current),
        invite = value.invitations.find(
          (item) => item.hash === digest(invitation),
        )!;
      if (invite.usedAt) {
        if (
          invite.acceptedSubject !== identity.subject ||
          invite.acceptedDeviceId !== device.id
        )
          return fail(
            "TEAM_INVITE",
            "This invitation was already accepted by another account or device.",
          );
        const recovered = await this.connect(value, identity, device);
        return {
          ...recovered,
          ...(invite.projectWorkspaceId
            ? { projectWorkspaceId: invite.projectWorkspaceId }
            : {}),
        };
      }
      if (invite.email && invite.email !== identity.email?.toLowerCase())
        return fail(
          "TEAM_INVITE_EMAIL",
          "Sign in to Memtrace with the account this invitation was sent to.",
        );
      let member = value.members.find(
        (item) => item.subject === identity.subject,
      );
      if (member?.status === "revoked") {
        if (
          !invite.email ||
          !invite.issuedRevision ||
          invite.issuedRevision <=
            (member.revokedRevision ?? Number.MAX_SAFE_INTEGER)
        )
          return fail(
            "TEAM_REVOKED",
            "This account’s Team membership was revoked. Ask an owner for a new invitation addressed to your verified email.",
          );
        // Only a fresh, explicitly targeted owner invitation restores access.
        // Previously issued capabilities must never become active again.
        for (const [hash, actor] of Object.entries(value.credentials))
          if (actor.memberId === member.id) delete value.credentials[hash];
        member.status = "active";
        delete member.revokedAt;
        delete member.revokedRevision;
        member.devices = [];
        member.name = identity.name;
        if (identity.email) member.email = identity.email;
      }
      if (!member) {
        if (value.members.length >= 100)
          return fail(
            "TEAM_LIMIT",
            "This Team has reached its member limit.",
            409,
          );
        member = {
          id: randomUUID(),
          subject: identity.subject,
          name: identity.name,
          ...(identity.email ? { email: identity.email } : {}),
          role: "member",
          status: "active",
          devices: [],
          joinedAt: new Date().toISOString(),
        };
        value.members.push(member);
      }
      if (!member.devices.some((item) => item.id === device.id)) {
        if (member.devices.length >= 20)
          return fail(
            "TEAM_LIMIT",
            "This account has reached its Team device limit.",
            409,
          );
        member.devices.push(device);
      }
      for (const [hash, actor] of Object.entries(value.credentials))
        if (actor.memberId === member.id && actor.deviceId === device.id)
          delete value.credentials[hash];
      const capability = secret();
      value.credentials[digest(capability)] = {
        memberId: member.id,
        deviceId: device.id,
      };
      invite.usedAt = new Date().toISOString();
      invite.acceptedSubject = identity.subject;
      invite.acceptedDeviceId = device.id;
      value.revision++;
      await this.save(value);
      return {
        credential: {
          teamId,
          memberId: member.id,
          deviceId: device.id,
          capability,
          subject: identity.subject,
        },
        team: this.public(value, member.id),
        ...(invite.projectWorkspaceId
          ? { projectWorkspaceId: invite.projectWorkspaceId }
          : {}),
      };
    });
  }
  async revokeInvitation(
    teamId: string,
    capability: string,
    invitationId: string,
  ): Promise<WorkspaceTeam> {
    return this.serial(teamId, async () => {
      const current = this.get(teamId),
        actor = this.owner(current, capability),
        value = structuredClone(current);
      const invitation = value.invitations.find(
        (item) => item.id === invitationId,
      );
      if (!invitation) return fail("TEAM_INVITE", "Invitation not found.", 404);
      invitation.revokedAt ??= new Date().toISOString();
      value.revision++;
      await this.save(value);
      return this.public(value, actor.memberId);
    });
  }
  async reconnect(
    teamId: string,
    identity: VerifiedTeamIdentity,
    device: { id: string; name: string },
  ): Promise<TeamSpaceSession> {
    return this.serial(teamId, async () => {
      return this.connect(structuredClone(this.get(teamId)), identity, device);
    });
  }
  private async connect(
    value: StoredTeam,
    identity: VerifiedTeamIdentity,
    device: { id: string; name: string },
  ): Promise<TeamSpaceSession> {
    const teamId = value.id,
      member = value.members.find((item) => item.subject === identity.subject);
    if (!member || member.status !== "active")
      return fail(
        "TEAM_REVOKED",
        "This Memtrace account does not have active access to this Team.",
      );
    if (!member.devices.some((item) => item.id === device.id)) {
      if (member.devices.length >= 20)
        return fail(
          "TEAM_LIMIT",
          "This account has reached its Team device limit.",
          409,
        );
      member.devices.push(device);
    }
    member.name = identity.name;
    if (identity.email) member.email = identity.email;
    else delete member.email;
    for (const [hash, actor] of Object.entries(value.credentials))
      if (actor.memberId === member.id && actor.deviceId === device.id)
        delete value.credentials[hash];
    const capability = secret();
    value.credentials[digest(capability)] = {
      memberId: member.id,
      deviceId: device.id,
    };
    value.revision++;
    await this.save(value);
    return {
      credential: {
        teamId,
        memberId: member.id,
        deviceId: device.id,
        capability,
        subject: identity.subject,
      },
      team: this.public(value, member.id),
    };
  }
  async revoke(
    teamId: string,
    capability: string,
    memberId: string,
  ): Promise<WorkspaceTeam> {
    return this.serial(teamId, async () => {
      const current = this.get(teamId),
        actor = this.owner(current, capability),
        value = structuredClone(current);
      const member = value.members.find((item) => item.id === memberId);
      if (!member) return fail("TEAM_MEMBER", "Team member not found.", 404);
      if (member.role === "owner")
        return fail(
          "TEAM_OWNER",
          "A Team owner cannot be revoked through the member action.",
          409,
        );
      member.status = "revoked";
      member.revokedAt ??= new Date().toISOString();
      member.revokedRevision = value.revision + 1;
      value.revision++;
      await this.save(value);
      return this.public(value, actor.memberId);
    });
  }
  async addProject(
    teamId: string,
    capability: string,
    input: {
      opId: string;
      workspaceId: string;
      name: string;
      repository?: RepositoryDescriptor;
    },
  ): Promise<TeamProjectDescriptor> {
    return this.serial(teamId, async () => {
      const current = this.get(teamId);
      this.owner(current, capability);
      const hash = digest(
          JSON.stringify({ name: input.name, repository: input.repository }),
        ),
        operation = current.projectOperations[input.opId];
      if (operation) {
        if (operation.hash !== hash)
          return fail(
            "OP_ID_REUSE",
            "This project operation was already used for different metadata.",
            409,
          );
        return structuredClone(
          current.projects.find(
            (project) => project.workspaceId === operation.workspaceId,
          )!,
        );
      }
      const other = this.projectTeam(input.workspaceId);
      if (other && other !== teamId)
        return fail(
          "TEAM_PROJECT",
          "This project already belongs to another Team.",
          409,
        );
      const existing = current.projects.find(
        (project) => project.workspaceId === input.workspaceId,
      );
      if (existing) return structuredClone(existing);
      if (current.projects.length >= 100)
        return fail(
          "TEAM_LIMIT",
          "This Team has reached its project limit.",
          409,
        );
      const value = structuredClone(current),
        descriptor = {
          workspaceId: input.workspaceId,
          name: input.name,
          ...(input.repository ? { repository: input.repository } : {}),
          createdAt: new Date().toISOString(),
        };
      value.projects.push(descriptor);
      value.projectOperations[input.opId] = {
        workspaceId: descriptor.workspaceId,
        hash,
      };
      value.revision++;
      await this.save(value);
      return descriptor;
    });
  }
  async settled() {
    await Promise.allSettled([...this.pending.values()]);
  }
}
