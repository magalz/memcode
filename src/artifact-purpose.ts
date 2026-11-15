import type { Artifact } from "./shared";

type NamedArtifact = Pick<Artifact, "name" | "path" | "purpose">;
export const supportingArtifactFolders = [
  "evidence",
  "supporting-evidence",
  "diagnostics",
  "tests",
  "probes",
] as const;
const script = /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|ps1|rb)$/i;

/** Group by producer intent and diagnostic naming, never by code extension alone. */
export function artifactPurpose(
  artifact: NamedArtifact,
): "deliverable" | "report" | "evidence" {
  if (artifact.purpose) return artifact.purpose;
  const name = artifact.name.toLowerCase();
  const path = artifact.path.replaceAll("\\", "/").toLowerCase();
  const root = path.lastIndexOf("/artifacts/");
  const relative = root < 0 ? name : path.slice(root + "/artifacts/".length);
  if (
    /(?:^|\/)(?:evidence|supporting-evidence|diagnostics|tests|probes)\//.test(
      relative,
    )
  )
    return "evidence";
  if (
    /\.(?:log|trace)$/.test(name) ||
    /\.(?:inspect|diagnostics?)\.(?:json|jsonl|ndjson)$/.test(name)
  )
    return "evidence";
  if (
    script.test(name) &&
    (/(?:^|[._-])(?:tests?|specs?)(?:[._-]|$)/.test(name) ||
      /^(?:probe|explore|investigate|debug|verify|smoke|benchmark|bench)[._-]/.test(
        name,
      ) ||
      /^live-(?:freshness|owner-restart|watch|branch)(?:[._-]|$)/.test(name))
  )
    return "evidence";
  if (
    /\.(?:md|markdown|mdown|pdf|docx|txt|html?)$/.test(name) &&
    /(?:^|[._-])(?:report|summary|findings|readme|verification)(?:[._-]|$)/.test(
      name,
    )
  )
    return "report";
  return "deliverable";
}

export function groupedArtifacts(artifacts: Artifact[]): {
  primary: Artifact[];
  evidence: Artifact[];
} {
  const reports: Artifact[] = [],
    deliverables: Artifact[] = [],
    evidence: Artifact[] = [];
  for (const artifact of artifacts) {
    const purpose = artifactPurpose(artifact);
    (purpose === "report"
      ? reports
      : purpose === "evidence"
        ? evidence
        : deliverables
    ).push(artifact);
  }
  return { primary: [...reports, ...deliverables], evidence };
}
