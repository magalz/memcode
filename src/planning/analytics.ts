import type { AppState } from "../shared";
import type { Cycle, CycleSnapshot } from "./types";
import { addDays, dayAt, dayRange, daysBetween, isWorkday } from "./dates";

export interface BurnPoint {
  date: string;
  scope: number | null;
  completed: number | null;
  remaining: number | null;
  ideal: number | null;
}
export function cycleSeries(
  cycle: Cycle,
  unit: "issues" | "points",
  now = new Date().toISOString(),
): BurnPoint[] {
  const today = dayAt(now, cycle.timeZone),
    closed = cycle.completedAt
      ? dayAt(cycle.completedAt, cycle.timeZone)
      : today;
  const first = cycle.snapshots[0]
    ? dayAt(cycle.snapshots[0].at, cycle.timeZone)
    : today;
  const start = cycle.startDate < first ? cycle.startDate : first;
  const end = cycle.endDate > closed ? cycle.endDate : closed;
  const scope = (snapshot: CycleSnapshot) =>
    unit === "points" ? snapshot.points : snapshot.total;
  const complete = (snapshot: CycleSnapshot) =>
    unit === "points" ? snapshot.completedPoints : snapshot.completed;
  const baseline = cycle.baseline;
  const eligible = dayRange(cycle.startDate, cycle.endDate).filter(
    (day) => cycle.calendar === "calendar" || isWorkday(day),
  );
  const denominator = Math.max(1, eligible.length - 1);
  return dayRange(start, end).map((date) => {
    const observed =
      date <= closed
        ? cycle.snapshots
            .filter((snapshot) => dayAt(snapshot.at, cycle.timeZone) <= date)
            .at(-1)
        : undefined;
    const elapsed = eligible.filter((day) => day <= date).length - 1;
    const ideal =
      baseline && date >= cycle.startDate && date <= cycle.endDate
        ? Math.max(
            0,
            (scope(baseline) - complete(baseline)) *
              (1 - Math.max(0, elapsed) / denominator),
          )
        : null;
    return {
      date,
      scope: observed ? scope(observed) : null,
      completed: observed ? complete(observed) : null,
      remaining: observed ? scope(observed) - complete(observed) : null,
      ideal,
    };
  });
}
export function deliverySeries(
  state: AppState,
  projectId: string,
  days = 28,
  now = new Date().toISOString(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const today = dayAt(now, timeZone),
    start = addDays(today, 1 - days),
    observedStart = dayAt(state.planning.startedAt, timeZone);
  const events = state.planning.events.filter(
    (event) =>
      event.projectId === projectId &&
      event.kind === "changed" &&
      event.before?.stage !== "done" &&
      event.after.stage === "done",
  );
  return dayRange(start, today).map((date) => {
    const completed = events.filter(
      (event) => dayAt(event.at, timeZone) === date,
    );
    return {
      date,
      issues: date < observedStart ? null : completed.length,
      points:
        date < observedStart
          ? null
          : completed.reduce(
              (sum, event) => sum + (event.after.estimate ?? 0),
              0,
            ),
    };
  });
}
export function projectForecast(
  state: AppState,
  projectId: string,
  now = new Date().toISOString(),
): { days: number; date: string; pace: number } | null {
  const observed = deliverySeries(state, projectId, 28, now).filter(
    (point) => point.issues !== null,
  );
  const completed = observed.reduce(
    (sum, point) => sum + (point.issues ?? 0),
    0,
  );
  const productiveDays = observed.filter(
    (point) => (point.issues ?? 0) > 0,
  ).length;
  if (observed.length < 7 || productiveDays < 3 || completed < 5) return null;
  const remaining = state.tasks.filter(
    (task) =>
      task.projectId === projectId && !task.archivedAt && task.stage !== "done",
  ).length;
  const pace = completed / observed.length,
    days = Math.ceil(remaining / pace);
  return { days, date: addDays(dayAt(now), days), pace };
}
export function cycleAge(cycle: Cycle, now = new Date().toISOString()) {
  return Math.max(
    0,
    daysBetween(cycle.startDate, dayAt(now, cycle.timeZone)) + 1,
  );
}
