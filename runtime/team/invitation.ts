export interface ParsedTeamInvitation {
  kind: "team" | "project";
  endpoint: string;
  id: string;
  invitation: string;
}
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const token = /^[A-Za-z0-9_-]{32,200}$/;
function origin(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("This invitation has an invalid relay address.");
  return url.origin;
}
/** The access token stays in the fragment, outside ordinary URL request logs. */
export function formatTeamInvitation(
  endpoint: string,
  teamId: string,
  invitation: string,
): string {
  if (!id.test(teamId) || !token.test(invitation))
    throw Error("This Team invitation is incomplete.");
  return `${origin(endpoint)}/join/team/${encodeURIComponent(teamId)}#invite=${invitation}`;
}
export function parseTeamInvitation(value: string): ParsedTeamInvitation {
  const text = value.trim();
  if (text.startsWith("{")) {
    let legacy: {
      endpoint?: string;
      workspaceId?: string;
      invitation?: string;
    };
    try {
      legacy = JSON.parse(text);
    } catch {
      throw Error("Paste a complete MemCode invitation link.");
    }
    if (
      !legacy.endpoint ||
      !legacy.workspaceId ||
      !legacy.invitation ||
      !id.test(legacy.workspaceId) ||
      !token.test(legacy.invitation)
    )
      throw Error("This project invitation is incomplete.");
    return {
      kind: "project",
      endpoint: origin(legacy.endpoint),
      id: legacy.workspaceId,
      invitation: legacy.invitation,
    };
  }
  try {
    const url = new URL(text),
      match = /^\/join\/(team|project)\/([^/]+)$/.exec(url.pathname);
    const invitation = new URLSearchParams(url.hash.slice(1)).get("invite"),
      scopeId = match && decodeURIComponent(match[2]);
    if (
      !match ||
      !scopeId ||
      !id.test(scopeId) ||
      !invitation ||
      !token.test(invitation) ||
      url.username ||
      url.password ||
      url.search
    )
      throw Error();
    return {
      kind: match[1] as "team" | "project",
      endpoint: origin(url.origin),
      id: scopeId,
      invitation,
    };
  } catch {
    throw Error(
      "Paste a complete MemCode invitation link, including its private fragment.",
    );
  }
}
