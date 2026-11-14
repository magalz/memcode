import { createPortal } from "react-dom";
import { GitBranch, RefreshCw } from "lucide-react";
import type { CodeFinding, IntelligenceDetail } from "../intelligence";
import { Modal } from "./Dialogs";
import { IntelligenceDetails } from "./IntelligenceDetails";
import { Spinner } from "./UI";

export function ImpactPanel({
  finding,
  detail,
  error,
  retry,
  close,
}: {
  finding: CodeFinding;
  detail: IntelligenceDetail | null;
  error: string | null;
  retry: () => void;
  close: () => void;
}) {
  const summary = detail?.items.find((item) => item.group === "Impact summary");
  const relationships = detail
    ? {
        ...detail,
        items: detail.items.filter((item) => item.group !== "Impact summary"),
      }
    : null;
  return createPortal(
    <Modal
      title="Blast radius"
      kicker="UNDERSTAND THE CHANGE"
      description="See which other code a change to this function could affect."
      close={close}
    >
      <div className="impact-panel-content">
        <section className="impact-selected-source">
          <span className="impact-source-icon">
            <GitBranch size={18} />
          </span>
          <div>
            <small>SELECTED FUNCTION</small>
            <strong className="blast-target-name">{finding.name}</strong>
            <code>
              {finding.file}
              {finding.line ? ":" + finding.line : ""}
            </code>
          </div>
        </section>
        {summary && (
          <div
            className="impact-observed-summary"
            data-risk={summary.description.toLowerCase()}
          >
            <div>
              <small>Observed reach</small>
              <strong>
                {summary.title.replace(
                  /^1 affected symbols$/,
                  "1 affected symbol",
                )}
              </strong>
            </div>
            <span>Engine risk: {summary.description.toLowerCase()}</span>
          </div>
        )}
        <p className="impact-reading-guide">
          Review the affected symbols to decide what else needs inspection and
          testing. This is static code analysis; it does not prove runtime
          behavior or complete coverage.
        </p>
        {error ? (
          <div className="impact-load-error" role="alert">
            <strong>Could not read this change’s impact.</strong>
            <p>{error}</p>
            <button className="button secondary" onClick={retry}>
              <RefreshCw size={13} />
              Try again
            </button>
          </div>
        ) : relationships ? (
          <IntelligenceDetails
            detail={relationships}
            hideHeading
            initialGroup="Affected symbols"
          />
        ) : (
          <div className="impact-loading" role="status">
            <Spinner size={21} />
            <p>Tracing indexed callers and dependencies…</p>
          </div>
        )}
      </div>
      <footer className="impact-panel-footer">
        <span>Source-backed evidence · no code is changed</span>
        <button className="button secondary" onClick={close}>
          Close
        </button>
      </footer>
    </Modal>,
    document.body,
  );
}
