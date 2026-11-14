const dayMs = 86400000;
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
  const parts = new Intl.DateTimeFormat("en-CA", {
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
  return new Intl.DateTimeFormat("en-GB", {
    ...options,
    timeZone: "UTC",
  }).format(new Date(day + "T12:00:00Z"));
}
export function isWorkday(day: string) {
  return ![0, 6].includes(new Date(day + "T00:00:00Z").getUTCDay());
}
export function dayRange(start: string, end: string): string[] {
  const count = Math.min(730, Math.max(0, daysBetween(start, end)));
  return Array.from({ length: count + 1 }, (_, i) => addDays(start, i));
}
