import { useState } from "react";
import { ChartNoAxesCombined, Network } from "lucide-react";
import type { AppState, Project, WorkItem } from "../shared";
import { CodeInsights } from "./CodeInsights";
import { Insights as DeliveryInsights } from "./Insights";
export function InsightsPage(props: {
  state: AppState;
  project: Project;
  open: (task: WorkItem) => void;
  notify: (message: string) => void;
}) {
  const [tab, setTab] = useState<"code" | "delivery">("code");
  return (
    <div className="insights-page">
      <div className="insights-mode" role="tablist" aria-label="Insights mode">
        <button
          role="tab"
          aria-selected={tab === "code"}
          className={tab === "code" ? "active" : ""}
          onClick={() => setTab("code")}
        >
          <Network size={14} />
          Code intelligence
        </button>
        <button
          role="tab"
          aria-selected={tab === "delivery"}
          className={tab === "delivery" ? "active" : ""}
          onClick={() => setTab("delivery")}
        >
          <ChartNoAxesCombined size={14} />
          Delivery
        </button>
      </div>
      {tab === "code" ? (
        <CodeInsights {...props} />
      ) : (
        <DeliveryInsights {...props} />
      )}
    </div>
  );
}
