import type {
  Evidence,
  Harness,
  HarnessRuntime,
  ModelTier,
  ReasoningEffort,
  RouteDecision,
  Settings,
  WorkItem,
} from "../src/shared";

const tierOrder: ModelTier[] = ["fast", "balanced", "frontier", "extreme"];
const effort: Record<ModelTier, ReasoningEffort> = {
  fast: "low",
  balanced: "medium",
  frontier: "high",
  extreme: "xhigh",
};
// Ported from the existing dogfood envelope-v2 policy. These are transparent,
// provisional thresholds, not calibrated probabilities or model benchmarks.
export const envelopes = [
  {
    tier: "fast" as const,
    cognitive: 15,
    cyclomatic: 12,
    nesting: 3,
    affected: 8,
    processes: 1,
    roots: 1,
  },
  {
    tier: "balanced" as const,
    cognitive: 90,
    cyclomatic: 75,
    nesting: 5,
    affected: 50,
    processes: 6,
    roots: 1,
  },
  {
    tier: "frontier" as const,
    cognitive: 300,
    cyclomatic: 180,
    nesting: 9,
    affected: 150,
    processes: 14,
    roots: 2,
  },
];
function maximum(values: Array<number | undefined>): number | null {
  const measured = values.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  return measured.length ? Math.max(...measured) : null;
}
function moduleRoot(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/");
  const at = parts.findIndex((part) =>
    ["src", "electron", "tests", "scripts", "crates"].includes(part),
  );
  const local = at < 0 ? parts.slice(-2) : parts.slice(at);
  return local[1]?.includes(".") ? local[0] : local.slice(0, 2).join("/");
}
export function routingInputs(evidence?: Evidence): RouteDecision["inputs"] {
  const symbols = evidence?.symbols ?? [];
  return {
    cognitive: maximum(
      symbols.map((s) => (s.metricSource === "ast" ? s.cognitive : undefined)),
    ),
    cyclomatic: maximum(
      symbols.map((s) => (s.metricSource === "ast" ? s.cyclomatic : undefined)),
    ),
    nesting: maximum(symbols.map((s) => s.nesting)),
    affected: evidence?.affected ?? null,
    processes: evidence?.affectedProcesses ?? null,
    moduleRoots: new Set(symbols.map((s) => moduleRoot(s.file))).size,
    incomplete:
      !evidence || evidence.incomplete || evidence.state !== "measured",
    sourceRevision: evidence?.sourceRevision,
    graphRevision: evidence?.graphRevision,
  };
}
export function qualifyTier(input: RouteDecision["inputs"]): ModelTier {
  for (const envelope of envelopes) {
    if (
      envelope.tier === "fast" &&
      (input.incomplete ||
        input.cognitive === null ||
        input.cyclomatic === null ||
        input.nesting === null ||
        input.affected === null ||
        input.processes === null ||
        input.moduleRoots === 0)
    )
      continue;
    if (
      (input.cognitive === null || input.cognitive <= envelope.cognitive) &&
      (input.cyclomatic === null || input.cyclomatic <= envelope.cyclomatic) &&
      (input.nesting === null || input.nesting <= envelope.nesting) &&
      (input.affected === null || input.affected <= envelope.affected) &&
      (input.processes === null || input.processes <= envelope.processes) &&
      input.moduleRoots <= envelope.roots
    )
      return envelope.tier;
  }
  return "extreme";
}
function surface(
  task: WorkItem,
  evidence?: Evidence,
): "ui" | "backend" | "verification" {
  if (task.kind === "test") return "verification";
  const paths = [
    ...(task.scope ?? []),
    ...(evidence?.symbols.map((s) => s.file) ?? []),
  ];
  if (
    paths.some((path) => /(?:^|[/\\])tests?[/\\]|\.(?:test|spec)\./i.test(path))
  )
    return "verification";
  if (paths.some((path) => /\.(?:tsx|jsx|css|scss|html)$/i.test(path)))
    return "ui";
  return "backend";
}
function preferredHarness(
  tier: ModelTier,
  kind: ReturnType<typeof surface>,
): Harness {
  if (kind === "verification") return "codex";
  if (tier === "extreme") return "claude";
  if (kind === "ui") return "cursor";
  return tier === "balanced" ? "codex" : "claude";
}

export function planRoute(
  task: WorkItem,
  evidence: Evidence | undefined,
  runtimes: HarnessRuntime[],
  settings: Settings,
): RouteDecision {
  const inputs = routingInputs(evidence);
  const tier = qualifyTier(inputs);
  const reasons: string[] = [];
  if (inputs.cognitive !== null)
    reasons.push(
      `AST cognitive ${inputs.cognitive}; cyclomatic ${inputs.cyclomatic ?? "unknown"}; maximum nesting ${inputs.nesting ?? "unknown"}.`,
    );
  if (inputs.affected !== null)
    reasons.push(
      `${inputs.affected}${inputs.incomplete ? "+" : ""} observed affected symbols; ${inputs.processes ?? "unknown"} affected processes.`,
    );
  if (inputs.incomplete)
    reasons.push(
      "Evidence is incomplete. Missing values remain unknown; the fast tier is ineligible.",
    );
  const pinnedModel = task.modelOverride || settings.model;
  if (settings.localModel && !pinnedModel)
    throw new Error(
      "Enter an installed Ollama model name in Settings before enabling local-model routing.",
    );
  const manual =
    task.assignment !== "auto" || !!pinnedModel || settings.localModel;
  const requested: Harness = settings.localModel
    ? "codex"
    : settings.model && !task.modelOverride
      ? settings.defaultHarness
      : task.harness;
  const wanted = manual
    ? requested
    : preferredHarness(tier, surface(task, evidence));
  const ranked = [
    wanted,
    ...(["codex", "claude", "cursor"] as Harness[]).filter(
      (id) => id !== wanted,
    ),
  ];
  for (const id of ranked) {
    if (manual && id !== requested) continue;
    const runtime = runtimes.find((r) => r.id === id && r.available);
    if (!runtime) continue;
    if (pinnedModel) {
      reasons.push(
        settings.localModel
          ? "Explicit local-model override; capability is not inferred from its name."
          : "Explicit model override takes precedence over automatic selection.",
      );
      return {
        policyVersion: "memcode-envelope-v2",
        tier,
        harness: id,
        model: pinnedModel,
        effort: effort[tier],
        mode: "manual",
        status: "provisional",
        inputs,
        reasons,
        plannedAt: new Date().toISOString(),
      };
    }
    const candidates = runtime.models
      .filter(
        (model) => tierOrder.indexOf(model.tier) >= tierOrder.indexOf(tier),
      )
      .sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));
    const model = candidates[0];
    if (!model) continue;
    const desired = effort[tier];
    const level =
      model.efforts && !model.efforts.includes(desired)
        ? ((["xhigh", "high", "medium", "low"] as ReasoningEffort[]).find((e) =>
            model.efforts!.includes(e),
          ) ?? "medium")
        : desired;
    reasons.push(
      `${manual ? "The assigned harness" : id === wanted ? `The ${surface(task, evidence)} policy` : "The eligible-harness fallback"} selects ${runtime.name} / ${model.id} at ${level} effort.`,
    );
    return {
      policyVersion: "memcode-envelope-v2",
      tier,
      harness: id,
      model: model.id,
      effort: level,
      mode: manual ? "manual" : "automatic",
      status: inputs.incomplete ? "provisional" : "measured",
      inputs,
      reasons,
      plannedAt: new Date().toISOString(),
    };
  }
  throw new Error(
    manual
      ? `No detected model in the assigned harness satisfies the ${tier} envelope. Choose Automatic, a different harness, or an explicit model.`
      : "No eligible installed harness has a discovered model for this task. Refresh the worker catalog or configure a model override.",
  );
}
