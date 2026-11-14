import { useState } from "react";
import { Code2, Layers3, ShieldCheck } from "lucide-react";
import type { IntelligenceDetail, StyleLanguage } from "../intelligence";
import { styleRows } from "../style-profile";
import { countLabel } from "./IntelligenceUI";

const languageNames: Record<string, string> = {
  tsx: "React / TSX",
  typescript: "TypeScript",
  javascript: "JavaScript",
  rust: "Rust",
  python: "Python",
  go: "Go",
  csharp: "C#",
  cpp: "C++",
  java: "Java",
  toml: "TOML",
  css: "CSS",
  html: "HTML",
};
function LanguageCard({
  language,
  threshold,
}: {
  language: StyleLanguage;
  threshold: number | null;
}) {
  const [expanded, setExpanded] = useState(false),
    rows = styleRows(language.ratios),
    visible = expanded ? rows : rows.slice(0, 7);
  return (
    <section className="style-language-card">
      <header>
        <span className="style-language-icon">
          <Code2 size={16} />
        </span>
        <div>
          <h4>{languageNames[language.language] ?? language.language}</h4>
          <span>
            {countLabel(language.samples)} style samples
            {threshold !== null &&
            language.samples !== null &&
            language.samples < threshold
              ? " · small sample"
              : ""}
          </span>
        </div>
        <small>{rows.length} patterns</small>
      </header>
      <div className="style-language-bars">
        {visible.map((row) => (
          <div className="style-bar-row" key={row.key}>
            <div>
              <span>{row.label}</span>
              <strong>
                {Math.round(row.share * 100)}
                <small>%</small>
              </strong>
            </div>
            <div
              className={
                "style-bar-track " +
                (row.share >= 0.85 || row.share <= 0.15 ? "settled" : "mixed")
              }
              role="meter"
              aria-label={`${languageNames[language.language] ?? language.language}: ${row.label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(row.share * 100)}
            >
              <i style={{ width: `${row.share * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      {rows.length > 7 && (
        <button
          className="style-show-patterns"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show fewer patterns"
            : `Show ${rows.length - 7} more patterns`}
        </button>
      )}
    </section>
  );
}
export function StyleProfile({ detail }: { detail: IntelligenceDetail }) {
  const [selected, setSelected] = useState("all"),
    profile = detail.style;
  if (!profile) return null;
  const warning = detail.notes.find((note) =>
    /could not be verified|unavailable|failed|MCP error/i.test(note),
  );
  const languages = profile.languages.filter(
      (language) => styleRows(language.ratios).length,
    ),
    visible =
      selected === "all"
        ? languages
        : languages.filter((language) => language.language === selected);
  return (
    <div className="style-profile">
      {warning && (
        <div className="visual-coverage-warning" role="status">
          <ShieldCheck size={14} />
          {warning}
        </div>
      )}
      <div className="style-profile-heading">
        <div>
          <span className="intelligence-kicker">
            THE WAY THIS CODE IS WRITTEN
          </span>
          <h3>One codebase. Its own conventions.</h3>
          <p>
            See the patterns your workers should recognize before they write.
          </p>
        </div>
        <div className="style-sample-total">
          <Layers3 size={16} />
          <strong>{countLabel(profile.samples)}</strong>
          <span>indexed style samples</span>
        </div>
      </div>
      <div
        className="style-language-picker"
        role="group"
        aria-label="Style languages"
      >
        <button
          aria-pressed={selected === "all"}
          className={selected === "all" ? "active" : ""}
          onClick={() => setSelected("all")}
        >
          All languages <span>{languages.length}</span>
        </button>
        {languages.map((language) => (
          <button
            key={language.language}
            aria-pressed={selected === language.language}
            className={selected === language.language ? "active" : ""}
            onClick={() => setSelected(language.language)}
          >
            {languageNames[language.language] ?? language.language}
          </button>
        ))}
      </div>
      {visible.length ? (
        <div className="style-language-grid">
          {visible.map((language) => (
            <LanguageCard
              key={language.language}
              language={language}
              threshold={profile.sampleThreshold}
            />
          ))}
        </div>
      ) : (
        <div className="intelligence-small-empty">
          No supported style ratios were returned. Refresh analysis to check
          coverage.
        </div>
      )}
      <div className="style-profile-legend">
        <span>
          <i />
          Concentrated preference
        </span>
        <span>
          <i />
          Mixed usage
        </span>
        <p>
          Observed habits, not a quality score or an enforced rule. Shares refer
          to eligible indexed samples.
        </p>
      </div>
      {detail.notes.length > 0 && (
        <details className="visual-evidence-notes">
          <summary>Source coverage & notes</summary>
          {detail.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </details>
      )}
    </div>
  );
}
