import type { StyleProfile } from "./intelligence";

export function styleProfile(value: unknown): StyleProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, any>;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const entries =
    data.by_language && typeof data.by_language === "object"
      ? Object.entries(data.by_language)
      : [];
  return {
    samples: count(data.function_count),
    sampleThreshold: count(data.sample_threshold),
    languages: entries
      .filter(([, value]) => value && typeof value === "object")
      .map(([language, value]) => {
        const row = value as Record<string, any>;
        return {
          language,
          samples: count(row.function_count),
          ratios: Object.fromEntries(
            Object.entries(row.ratios ?? {}).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" &&
                Number.isFinite(entry[1]) &&
                entry[1] >= 0 &&
                entry[1] <= 1,
            ),
          ),
        };
      })
      .sort((a, b) => (b.samples ?? -1) - (a.samples ?? -1)),
  };
}
const names: Record<string, string> = {
  arrow_fn_share: "Arrow functions",
  const_share: "Const over let",
  await_share: "Async / await",
  early_return_share: "Early returns",
  ternary_share: "Ternary expressions",
  try_op_share: "? error propagation",
  iflet_share: "If-let bindings",
  strict_eq_share: "Strict equality",
  short_decl_share: "Short declarations",
  comprehension_share: "Comprehensions",
  go_exported_share: "Exported symbols",
};
const scopes = [
  "naming_variables_",
  "naming_functions_",
  "naming_types_",
  "naming_constants_",
  "naming_files_",
  "config_keys_",
];
const casing: Record<string, string> = {
  camel: "camelCase",
  snake: "snake_case",
  pascal: "PascalCase",
  screaming_snake: "SCREAMING_SNAKE",
  kebab: "kebab-case",
};
export function styleRows(ratios: Record<string, number>) {
  const chosen = new Map<
    string,
    { key: string; label: string; share: number }
  >();
  for (const [key, share] of Object.entries(ratios)) {
    if (!Number.isFinite(share) || share < 0 || share > 1) continue;
    const prefix = scopes.find((scope) => key.startsWith(scope)),
      scope = prefix ?? key;
    const label = prefix
      ? `${prefix.replace("naming_", "").replaceAll("_", " ").trim()} · ${casing[key.slice(prefix.length).replace(/_share$/, "")] ?? key.slice(prefix.length).replace(/_share$/, "")}`
      : (names[key] ?? key.replace(/_share$/, "").replaceAll("_", " "));
    if (!chosen.has(scope) || chosen.get(scope)!.share < share)
      chosen.set(scope, { key, label, share });
  }
  return [...chosen.values()].sort((a, b) => b.share - a.share);
}
