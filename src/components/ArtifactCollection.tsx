import { useState } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  FileCode2,
  FileText,
  Globe2,
  Image,
  Terminal,
} from "lucide-react";
import type { Artifact, WorkItem } from "../shared";
import { artifactTypeLabel } from "../artifact-format";
import { artifactPurpose, groupedArtifacts } from "../artifact-purpose";
import { ArtifactThumbnail } from "./ArtifactThumbnail";

interface Props {
  artifacts: Artifact[];
  onOpen: (artifact: Artifact) => void;
  layout?: "list" | "gallery";
  tasks?: Pick<WorkItem, "id" | "identifier">[];
}

/** Deliverables stay visible; the worker's investigation remains available on demand. */
export function ArtifactCollection({
  artifacts,
  onOpen,
  layout = "list",
  tasks = [],
}: Props) {
  const groups = groupedArtifacts(artifacts);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const identifiers = new Map(tasks.map((task) => [task.id, task.identifier]));
  const label = (artifact: Artifact) => {
    const type = artifactTypeLabel(artifact.name);
    return artifactPurpose(artifact) === "report" ? `Report · ${type}` : type;
  };
  const row = (artifact: Artifact, evidence = false) => (
    <button
      type="button"
      key={artifact.id}
      data-artifact-id={artifact.id}
      className={"artifact-row" + (evidence ? " artifact-evidence-row" : "")}
      onClick={() => onOpen(artifact)}
    >
      <span className={"artifact-kind " + artifact.kind}>
        {evidence ? (
          <Terminal size={17} />
        ) : artifactPurpose(artifact) === "report" ? (
          <FileText size={19} />
        ) : artifact.kind === "html" ? (
          <Globe2 size={19} />
        ) : artifact.kind === "image" ? (
          <Image size={19} />
        ) : (
          <FileCode2 size={19} />
        )}
      </span>
      <span>
        <strong>{artifact.name}</strong>
        <small>
          {artifact.source} · {label(artifact)}
          {identifiers.has(artifact.taskId)
            ? ` · ${identifiers.get(artifact.taskId)}`
            : ""}
        </small>
      </span>
      <ArrowUpRight size={15} />
    </button>
  );
  return (
    <div className={"artifact-collection artifact-collection-" + layout}>
      {groups.primary.length ? (
        <div
          className={
            layout === "gallery" ? "artifact-library" : "artifact-primary-list"
          }
        >
          {groups.primary.map((artifact) =>
            layout === "gallery" ? (
              <button
                type="button"
                data-artifact-id={artifact.id}
                className={"artifact-tile " + artifact.kind}
                key={artifact.id}
                onClick={() => onOpen(artifact)}
              >
                <ArtifactThumbnail artifact={artifact} />
                <div>
                  <span className="artifact-extension">{label(artifact)}</span>
                  <h3>{artifact.name}</h3>
                  <p>
                    {artifact.source}
                    {identifiers.has(artifact.taskId) && (
                      <>
                        <span>·</span>
                        {identifiers.get(artifact.taskId)}
                      </>
                    )}
                  </p>
                </div>
              </button>
            ) : (
              row(artifact)
            ),
          )}
        </div>
      ) : (
        <p className="artifact-primary-empty">
          Supporting files from the work are available below.
        </p>
      )}
      {groups.evidence.length > 0 && (
        <details
          className="artifact-evidence"
          onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}
        >
          <summary>
            <ChevronRight size={14} />
            <span>Supporting evidence</span>
            <span className="artifact-evidence-count">
              {groups.evidence.length}
            </span>
            <small>Logs, checks and investigation files</small>
          </summary>
          {evidenceOpen && (
            <div className="artifact-evidence-files">
              {groups.evidence.map((artifact) => row(artifact, true))}
            </div>
          )}
        </details>
      )}
    </div>
  );
}
