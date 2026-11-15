import { test } from "node:test";
import assert from "node:assert/strict";
import { dateLabel, dayAt, timeLabel } from "../src/planning/dates.ts";

test("calendar days preserve project time zones across midnight and DST", () => {
  const cases = [
    ["2026-03-28T23:30:00Z", "Europe/Copenhagen", "2026-03-29"],
    ["2026-03-29T01:30:00Z", "Europe/Copenhagen", "2026-03-29"],
    ["2026-10-25T00:30:00Z", "Europe/Copenhagen", "2026-10-25"],
    ["2026-10-25T01:30:00Z", "Europe/Copenhagen", "2026-10-25"],
    ["2026-11-15T00:30:00Z", "America/Los_Angeles", "2026-11-14"],
    ["2026-11-15T00:30:00Z", "Pacific/Kiritimati", "2026-11-15"],
  ];
  for (let repeat = 0; repeat < 3; repeat++)
    for (const [at, zone, expected] of cases)
      assert.equal(dayAt(at, zone), expected);
  assert.throws(
    () => dayAt("2026-11-15T00:30:00Z", "Invalid/Zone"),
    RangeError,
  );
});

test("calendar labels remain UTC dates and honor each requested format", () => {
  assert.equal(dateLabel("2026-01-01"), "1 Jan");
  assert.equal(
    dateLabel("2026-01-01", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Pacific/Honolulu",
    }),
    "Thursday, 1 January 2026",
  );
  assert.equal(dateLabel("2026-11-15", { month: "long" }), "November");
  assert.equal(dateLabel("2026-11-15", { day: "2-digit" }), "15");
  assert.equal(dateLabel("2026-01-01"), "1 Jan");
  assert.throws(() => dateLabel("not-a-day"), RangeError);
});

test("local message times match the platform and preserve invalid-date output", () => {
  for (const at of [
    "2026-03-29T00:30:00Z",
    "2026-03-29T01:30:00Z",
    "2026-11-15T18:05:00Z",
  ])
    assert.equal(
      timeLabel(at),
      new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  assert.equal(timeLabel("not-a-date"), "Invalid Date");
  assert.equal(
    dayAt("2026-11-15T00:30:00Z"),
    dayAt(
      "2026-11-15T00:30:00Z",
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
  );
});
