import type { ContextBinding, ContextPack } from "./contracts";
import { normalizedPath, visible } from "./source";
import type { Row } from "./query";

const pendingNote = "Saved source is not linked yet";
const text = (value: unknown, maximum = 240) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : null;
const line = (value: unknown) =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) <= 10_000_000
    ? Number(value)
    : null;
const array = (value: unknown): Row[] =>
  Array.isArray(value) ? value.slice(0, 64) : [];

/** Saved parse facts are not linked symbols, resolved calls or a readiness certificate. */
export function savedRead(result: Row | null, binding: ContextBinding) {
  const readCheck = result?._read_check;
  const omitted = Array.isArray(readCheck?.not_searched_yet)
    ? readCheck.not_searched_yet
    : [];
  const omittedCount =
    Number.isSafeInteger(readCheck?.not_searched_yet_count) &&
    readCheck.not_searched_yet_count > 0
      ? readCheck.not_searched_yet_count
      : omitted.length;
  if (!result || (!Object.hasOwn(result, "_saved_not_linked") && !omittedCount))
    return null;
  const raw = result._saved_not_linked ?? {};
  const root = normalizedPath(binding.project.path!);
  const file = (value: unknown) => {
    if (!text(value)) return null;
    let path = normalizedPath(value as string);
    if (path.startsWith(root + "/")) path = path.slice(root.length + 1);
    if (path.startsWith(binding.project.repoId + "/"))
      path = path.slice(binding.project.repoId!.length + 1);
    if (
      /^(?:\/|[A-Za-z]:)/.test(path) ||
      path.split("/").some((part) => part === "..") ||
      /(^|\/)(\.git|\.memcode|\.memdb|\.memtrace|node_modules|target|dist|dist-runtime)(\/|$)/.test(
        path,
      )
    )
      return null;
    return visible(path, binding.scope.map(normalizedPath)) ? path : null;
  };
  const declared = array(raw.declared)
    .flatMap((item) => {
      const path = file(item?.file),
        name = text(item?.name, 160),
        at = line(item?.line);
      return path && name && at
        ? [
            {
              name,
              kind: text(item.kind, 64) ?? "Declaration",
              file: path,
              line: at,
            },
          ]
        : [];
    })
    .slice(0, 8);
  const calls = array(raw.calls_to)
    .flatMap((item) => {
      const path = file(item?.file),
        name = text(item?.name, 160),
        caller = text(item?.caller, 160),
        at = line(item?.line),
        callAt = line(item?.call_line);
      return path && name && caller && at && callAt
        ? [{ name, caller, file: path, line: at, call_line: callAt }]
        : [];
    })
    .slice(0, 8);
  const visibleNames = new Set([
    ...declared.map((item) => item.name),
    ...calls.map((item) => item.name),
  ]);
  const paths = (value: unknown) =>
    [
      ...new Set(
        array(value)
          .map(file)
          .filter((path): path is string => !!path),
      ),
    ].slice(0, 8);
  const metadata = {
    current: false,
    note: omittedCount
      ? "Files currently being saved were not searched. Indexed rows exclude those files; these results are incomplete."
      : "Saved-file changes are not fully linked. Indexed rows may precede these saves; listed calls match names and are not resolved graph edges.",
    not_searched_yet: paths(omitted),
    not_searched_yet_count: Math.min(omittedCount, 10_000_000),
    files: paths(raw.files),
    gone: paths(raw.gone),
    names_in_flux: array(raw.names_in_flux)
      .map((value) => text(value, 160))
      .filter((value): value is string => !!value && visibleNames.has(value))
      .slice(0, 8),
    declared: [...declared],
    calls_to: calls,
    truncated:
      omittedCount > 8 ||
      ["files", "gone", "names_in_flux", "declared", "calls_to"].some(
        (key) => Array.isArray(raw[key]) && raw[key].length > 8,
      ),
  };
  while (JSON.stringify(metadata).length > 3000) {
    metadata.truncated = true;
    if (metadata.calls_to.length) metadata.calls_to.pop();
    else if (metadata.declared.length) metadata.declared.pop();
    else if (metadata.files.length) metadata.files.pop();
    else if (metadata.gone.length) metadata.gone.pop();
    else if (metadata.names_in_flux.length) metadata.names_in_flux.pop();
    else if (metadata.not_searched_yet.length) metadata.not_searched_yet.pop();
    else break;
  }
  return { metadata, declared };
}

export function recordSavedReadCoverage(
  result: Row | null,
  binding: ContextBinding,
  coverage: ContextPack["coverage"],
) {
  const saved = savedRead(result, binding);
  if (!saved) return;
  if (!hasSavedReadUncertainty(coverage))
    coverage.unknown.push(
      `${pendingNote}: ${
        saved.metadata.not_searched_yet_count
          ? "Files being saved were omitted from this read. Refresh before relying on its completeness or impact."
          : "Live text can be read, but these saved declarations and name-only calls are not confirmed graph relationships. Refresh before relying on their impact."
      }`,
    );
  coverage.canAct = false;
  if (
    saved.metadata.truncated &&
    !coverage.truncated.includes("Saved-file parse evidence was bounded.")
  )
    coverage.truncated.push("Saved-file parse evidence was bounded.");
}

export const hasSavedReadUncertainty = (coverage: ContextPack["coverage"]) =>
  coverage.unknown.some((reason) => reason.startsWith(pendingNote));

export function savedDeclarationRows(
  result: Row | null,
  binding: ContextBinding,
): Row[] {
  return (
    savedRead(result, binding)?.declared.map((item) => ({
      name: item.name,
      kind: item.kind,
      file_path: item.file,
      start_line: item.line,
      end_line: item.line + 20,
      // No node id: a declaration parsed from saved text has no graph authority.
      _memcode_saved_not_linked: true,
    })) ?? []
  );
}

export function recordSavedReadEvidence(
  result: Row | null,
  binding: ContextBinding,
  pack: ContextPack,
  tool: string,
) {
  const saved = savedRead(result, binding);
  if (!saved) return;
  const value = JSON.stringify(saved.metadata);
  if (
    !pack.evidence.some(
      (item) =>
        item.origin === "saved-file parse; not linked graph evidence" &&
        item.text === value,
    )
  )
    pack.evidence.push({
      id: `saved:${tool}:${pack.evidence.length}`,
      kind: "assessment",
      text: value,
      origin: "saved-file parse; not linked graph evidence",
    });
}
