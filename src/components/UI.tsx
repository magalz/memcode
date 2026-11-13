import {
  Check,
  Circle,
  CircleDashed,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import type { Harness, Stage } from "../shared";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={"brand-mark " + (small ? "small" : "")} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path
          d="M9 27V13l11 9 11-9v14M9 20l11 9 11-9"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="11" r="2.1" fill="var(--mint)" />
      </svg>
    </span>
  );
}

export function HarnessMark({
  id,
  small = false,
}: {
  id: Harness;
  small?: boolean;
}) {
  return (
    <span
      title={{ codex: "Codex", claude: "Claude Code", amp: "Amp" }[id]}
      className={`harness-mark ${id} ${small ? "small" : ""}`}
    >
      {id === "codex" ? (
        <svg viewBox="0 0 20 20" fill="none">
          <path
            d="m8 4-5 6 5 6m4-12 5 6-5 6m-1-13-2 14"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : id === "claude" ? (
        <Sparkles size={small ? 11 : 15} />
      ) : (
        <span>a</span>
      )}
    </span>
  );
}

export function StageIcon({ stage }: { stage: Stage }) {
  return stage === "done" ? (
    <span className="done-check">
      <Check size={11} />
    </span>
  ) : stage === "working" ? (
    <CircleDashed size={14} className="status-working" />
  ) : stage === "review" ? (
    <span className="review-dot" />
  ) : (
    <Circle size={14} className="status-planned" />
  );
}

export function PriorityMark({ value }: { value: string }) {
  return (
    <span
      className={`priority-mark ${value}`}
      title={`${value} priority`}
      aria-label={`${value} priority`}
    >
      <i />
      <i />
      <i />
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" />;
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Time({ at }: { at: string }) {
  return (
    <time dateTime={at}>
      {new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
