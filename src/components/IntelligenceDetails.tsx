import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Code2,
  Layers3,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { IntelligenceDetail, IntelligenceItem } from "../intelligence";
import { ResultPager } from "./ResultPager";

function EvidenceItem({
  item,
  selectFlow,
}: {
  item: IntelligenceItem;
  selectFlow?: (id: string) => void;
}) {
  return (
    <div className="intelligence-detail-row">
      <span className="intelligence-detail-glyph">
        {item.action === "flow" ? (
          <ArrowRight size={15} />
        ) : item.group === "Modules" ? (
          <Layers3 size={15} />
        ) : (
          <Code2 size={15} />
        )}
      </span>
      <div>
        <strong>{item.title}</strong>
        <p>{item.description}</p>
        {item.file && (
          <code title={item.file}>
            {item.file}
            {item.line ? ":" + item.line : ""}
          </code>
        )}
      </div>
      {item.badge && <span className="detail-data-badge">{item.badge}</span>}
      {item.value && <span className="detail-data-value">{item.value}</span>}
      {item.action === "flow" && selectFlow && (
        <button
          title={`Inspect ${item.title}`}
          onClick={() => selectFlow(item.id)}
        >
          <ArrowUpRight size={15} />
        </button>
      )}
    </div>
  );
}
export function IntelligenceDetails({
  detail,
  selectFlow,
  back,
}: {
  detail: IntelligenceDetail;
  selectFlow?: (id: string) => void;
  back?: () => void;
}) {
  const groups = [
    ...new Set(detail.items.map((item) => item.group ?? "Source evidence")),
  ];
  const [selected, setSelected] = useState(""),
    [page, setPage] = useState(0),
    [query, setQuery] = useState("");
  useEffect(() => {
    setSelected("");
    setPage(0);
    setQuery("");
  }, [detail.section, detail.capturedAt]);
  const group = groups.includes(selected) ? selected : groups[0],
    items = detail.items.filter(
      (item) =>
        (item.group ?? "Source evidence") === group &&
        `${item.title} ${item.description} ${item.file ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ),
    size = 8,
    currentPage = Math.min(
      page,
      Math.max(0, Math.ceil(items.length / size) - 1),
    );
  const warning = detail.notes.find((note) =>
    /could not be verified|unavailable|failed|MCP error/i.test(note),
  );
  return (
    <div className="intelligence-detail-results visual-detail-results">
      {detail.section === "flow" && back && (
        <button className="detail-back" onClick={back}>
          <ArrowLeft size={13} />
          All execution flows
        </button>
      )}
      <div className="intelligence-detail-heading">
        <h3>{detail.title}</h3>
        <p>{detail.summary}</p>
      </div>
      {warning && (
        <div className="visual-coverage-warning" role="status">
          <ShieldCheck size={14} />
          {warning}
        </div>
      )}
      {groups.length > 0 && (
        <div className="detail-browser-controls">
          <div
            className="detail-group-picker"
            role="group"
            aria-label="Evidence groups"
          >
            {groups.map((name) => (
              <button
                key={name}
                aria-pressed={group === name}
                className={group === name ? "active" : ""}
                onClick={() => {
                  setSelected(name);
                  setPage(0);
                  setQuery("");
                }}
              >
                {name}
                <span>
                  {
                    detail.items.filter(
                      (item) => (item.group ?? "Source evidence") === name,
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <label>
            <Search size={12} />
            <input
              aria-label="Filter intelligence results"
              placeholder="Find in this group…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </label>
        </div>
      )}
      <section className="intelligence-detail-group">
        <div
          className={
            "detail-visible-items " +
            (group === "Modules" || group === "Execution flows"
              ? "detail-card-grid"
              : "")
          }
        >
          {items
            .slice(currentPage * size, (currentPage + 1) * size)
            .map((item) => (
              <EvidenceItem key={item.id} item={item} selectFlow={selectFlow} />
            ))}
        </div>
        {!items.length && (
          <div className="intelligence-small-empty">
            <Code2 size={20} />
            <p>
              {query
                ? "No records match this search."
                : "No records returned in this view."}
            </p>
          </div>
        )}
      </section>
      <ResultPager page={currentPage} total={items.length} change={setPage} />
      {detail.notes.length > 0 && (
        <details className="visual-evidence-notes">
          <summary>
            Evidence & coverage notes <span>{detail.notes.length}</span>
          </summary>
          {detail.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </details>
      )}
      <footer className="intelligence-detail-footer">
        Observed{" "}
        {new Date(detail.capturedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
        {detail.graphRevision && (
          <code>Graph {detail.graphRevision.slice(0, 18)}</code>
        )}
      </footer>
    </div>
  );
}
