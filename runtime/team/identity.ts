import { createHash } from "node:crypto";
import type { TeamSnapshot, TeamStory, TeamComment } from "../../src/team";
import type { SharedProjection } from "./projection";

type Kind = "story" | "epic" | "cycle" | "comment" | "workflow" | "field" | "view";
export interface TeamLocalIds {
  toLocal: Record<string, string>;
  toRemote: Record<string, string>;
}
export interface TeamIdentityBinding {
  credential: { workspaceId: string };
  localIds?: TeamLocalIds;
}
export const emptyTeamLocalIds = (): TeamLocalIds => ({
  toLocal: {},
  toRemote: {},
});

/** A joined board never reuses IDs from a personal project in the same profile. */
export function localTeamId(
  binding: TeamIdentityBinding,
  kind: Kind,
  id: string,
): string {
  if (!binding.localIds) return id;
  const key = `${kind}:${id}`;
  const existing = binding.localIds.toLocal[key];
  if (existing) return existing;
  const local = `team_${createHash("sha256").update(`${binding.credential.workspaceId}\0${key}`).digest("hex").slice(0, 40)}`;
  binding.localIds.toLocal[key] = local;
  binding.localIds.toRemote[`${kind}:${local}`] = id;
  return local;
}

/** New local records retain their UUID; remote records round-trip via the private map. */
export function remoteTeamId(
  binding: TeamIdentityBinding,
  kind: Kind,
  id: string,
): string {
  if (!binding.localIds) return id;
  const existing = binding.localIds.toRemote[`${kind}:${id}`];
  if (existing) return existing;
  if (binding.localIds.toLocal[`${kind}:${id}`])
    throw Error(
      "This shared record uses its remote ID instead of its local binding.",
    );
  binding.localIds.toLocal[`${kind}:${id}`] = id;
  binding.localIds.toRemote[`${kind}:${id}`] = id;
  return id;
}

type Translate = (kind: Kind, id: string) => string;
const maybe = (
  translate: Translate,
  kind: Kind,
  id: string | null | undefined,
) => (id ? translate(kind, id) : id);
function story<T extends Partial<TeamStory>>(
  value: T,
  translate: Translate,
): T {
  return {
    ...value,
    ...(value.id ? { id: translate("story", value.id) } : {}),
    ...("epicId" in value
      ? { epicId: maybe(translate, "epic", value.epicId) }
      : {}),
    ...("cycleId" in value
      ? { cycleId: maybe(translate, "cycle", value.cycleId) }
      : {}),
    ...("parentId" in value
      ? { parentId: maybe(translate, "story", value.parentId) }
      : {}),
    ...(value.dependsOn
      ? { dependsOn: value.dependsOn.map((id) => translate("story", id)) }
      : {}),
  };
}
function comment<T extends Omit<TeamComment, "memberId" | "revision">>(
  value: T,
  translate: Translate,
): T {
  return {
    ...value,
    id: translate("comment", value.id),
    storyId: translate("story", value.storyId),
    ...(value.parentId
      ? { parentId: translate("comment", value.parentId) }
      : {}),
  };
}
function projection(
  value: SharedProjection,
  translate: Translate,
): SharedProjection {
  return {
    stories: value.stories.map((value) => story(value, translate)),
    epics: value.epics.map((value) => ({
      ...value,
      id: translate("epic", value.id),
    })),
    cycles: value.cycles.map((value) => ({
      ...value,
      id: translate("cycle", value.id),
    })),
    comments: value.comments.map((value) => comment(value, translate)),
  };
}
export function localTeamProjection(
  binding: TeamIdentityBinding,
  value: SharedProjection,
): SharedProjection {
  return projection(value, (kind, id) => localTeamId(binding, kind, id));
}
export function remoteTeamProjection(
  binding: TeamIdentityBinding,
  value: SharedProjection,
): SharedProjection {
  return projection(value, (kind, id) => remoteTeamId(binding, kind, id));
}
export function localTeamSnapshot(
  binding: TeamIdentityBinding,
  value: TeamSnapshot,
): TeamSnapshot {
  const translate: Translate = (kind, id) => localTeamId(binding, kind, id);
  return {
    ...value,
    ...projection(value, translate),
    comments: value.comments.map((value) => comment(value, translate)),
    claims: value.claims.map((value) => ({
      ...value,
      storyId: translate("story", value.storyId),
    })),
    results: value.results.map((value) => ({
      ...value,
      storyId: translate("story", value.storyId),
    })),
    activity: value.activity.map((value) => ({
      ...value,
      ...(value.entityId
        ? {
            entityId: value.type.startsWith("epic.")
              ? translate("epic", value.entityId)
              : value.type.startsWith("cycle.")
                ? translate("cycle", value.entityId)
                : /^(?:story|comment|claim|result)\./.test(value.type)
                  ? translate("story", value.entityId)
                  : value.entityId,
          }
        : {}),
    })),
  };
}
