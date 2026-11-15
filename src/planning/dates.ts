const dayMs = 86400000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const entries = Object.entries(options).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const key = JSON.stringify([locale, entries]);
  const saved = formatters.get(key);
  if (saved) return saved;
  const created = new Intl.DateTimeFormat(locale, options);
  // Custom labels and project time zones must not grow a permanent cache.
  if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
  formatters.set(key, created);
  return created;
}
export function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + count * dayMs)
    .toISOString()
    .slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / dayMs,
  );
}
export function dayAt(
  at = new Date().toISOString(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const parts = formatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join("-");
}
export function dateLabel(
  day: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
): string {
  return formatter("en-GB", {
    ...options,
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
}
export function timeLabel(at: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return date.toString();
  // Resolve the current locale/zone so OS changes still apply on the next render.
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  return formatter(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
export function isWorkday(day: string) {
  return ![0, 6].includes(new Date(day + "T00:00:00Z").getUTCDay());
}
export function dayRange(start: string, end: string): string[] {
  const count = Math.min(730, Math.max(0, daysBetween(start, end)));
  return Array.from({ length: count + 1 }, (_, i) => addDays(start, i));
}
