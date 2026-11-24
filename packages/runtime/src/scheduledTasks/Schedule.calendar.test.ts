// One-time runs, calendar repeats, cron, bounds, and their DST and calendar edges.
import type { ScheduledTaskSchedule } from "@caveman-app/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  describeSchedule,
  isSameSchedule,
  nextScheduledRunAt,
  scheduleProblem,
  type ScheduleProgress,
} from "./Schedule.ts";

/** The next run after `from` as UTC ISO, or null. */
const next = (schedule: ScheduledTaskSchedule, from: string, progress?: ScheduleProgress) => {
  const at = nextScheduledRunAt(schedule, DateTime.makeUnsafe(from), progress);
  return at === null ? null : DateTime.formatIso(DateTime.toUtc(at));
};

/** The next `count` runs, each computed from the one before with the run counted, as the scheduler does. */
const runs = (schedule: ScheduledTaskSchedule, from: string, count: number) => {
  const out: string[] = [];
  let at: string | null = from;
  for (let i = 0; i < count && at !== null; i += 1) {
    at = next(schedule, at, { scheduledRunCount: i });
    if (at !== null) out.push(at);
  }
  return out;
};

describe("one-time runs", () => {
  const once = { type: "once", runAt: "2026-11-09T08:00:00.000+01:00" } as const;

  it("runs at its instant, then never again", () => {
    expect(next(once, "2026-11-05T12:00:00.000Z")).toBe("2026-11-09T07:00:00.000Z");
    expect(next(once, "2026-11-09T07:00:00.000Z")).toBeNull();
    expect(next(once, "2026-12-01T00:00:00.000Z")).toBeNull();
  });
});

describe("every N days and weeks", () => {
  it("counts days from the start's date in the schedule's zone", () => {
    const everyThird = {
      type: "fixed_time",
      timeOfDay: "09:00",
      everyDays: 3,
      timeZone: "Europe/Amsterdam",
      startAt: "2026-11-05T10:00:00.000Z",
    } as const;
    // 09:00 on Nov 5 is before the start, so the first run is three days on.
    expect(runs(everyThird, "2026-11-05T10:00:00.000Z", 3)).toEqual([
      "2026-11-08T08:00:00.000Z",
      "2026-11-11T08:00:00.000Z",
      "2026-11-14T08:00:00.000Z",
    ]);
  });

  it("counts weeks from the Monday of the start's week (RFC 5545, WKST=MO)", () => {
    const fortnightly = {
      type: "fixed_time",
      timeOfDay: "10:00",
      weekdays: [1, 4],
      everyWeeks: 2,
      timeZone: "UTC",
      startAt: "2026-11-04T00:00:00.000Z", // a Wednesday
    } as const;
    expect(runs(fortnightly, "2026-11-04T00:00:00.000Z", 4)).toEqual([
      "2026-11-05T10:00:00.000Z", // Thu, week 0
      "2026-11-16T10:00:00.000Z", // Mon, week 2
      "2026-11-19T10:00:00.000Z", // Thu, week 2
      "2026-11-30T10:00:00.000Z", // Mon, week 4
    ]);
  });

  it("steps over a leap day like any other day", () => {
    const everyOther = {
      type: "fixed_time",
      timeOfDay: "12:00",
      everyDays: 2,
      timeZone: "UTC",
      startAt: "2028-02-27T00:00:00.000Z",
    } as const;
    expect(runs(everyOther, "2028-02-26T00:00:00.000Z", 3)).toEqual([
      "2028-02-27T12:00:00.000Z",
      "2028-02-29T12:00:00.000Z",
      "2028-03-02T12:00:00.000Z",
    ]);
  });
});

describe("monthly", () => {
  it("skips months without the 31st", () => {
    const the31st = { type: "monthly", timeOfDay: "09:00", days: [31], timeZone: "UTC" } as const;
    expect(runs(the31st, "2027-01-31T10:00:00.000Z", 3)).toEqual([
      "2027-03-31T09:00:00.000Z",
      "2027-05-31T09:00:00.000Z",
      "2027-07-31T09:00:00.000Z",
    ]);
  });

  it("runs on the last day of every month, leap February included", () => {
    const last = { type: "monthly", timeOfDay: "18:00", days: [-1], timeZone: "UTC" } as const;
    expect(runs(last, "2027-12-31T19:00:00.000Z", 3)).toEqual([
      "2028-01-31T18:00:00.000Z",
      "2028-02-29T18:00:00.000Z",
      "2028-03-31T18:00:00.000Z",
    ]);
    expect(next(last, "2027-02-01T00:00:00.000Z")).toBe("2027-02-28T18:00:00.000Z");
  });

  it("runs once when the 31st and the last day fall on the same day", () => {
    const both = { type: "monthly", timeOfDay: "09:00", days: [31, -1], timeZone: "UTC" } as const;
    expect(runs(both, "2027-01-01T00:00:00.000Z", 3)).toEqual([
      "2027-01-31T09:00:00.000Z",
      "2027-02-28T09:00:00.000Z",
      "2027-03-31T09:00:00.000Z",
    ]);
  });

  it("finds the 29th of February only in a leap year", () => {
    const the29th = { type: "monthly", timeOfDay: "09:00", days: [29], timeZone: "UTC" } as const;
    expect(next(the29th, "2027-01-29T10:00:00.000Z")).toBe("2027-03-29T09:00:00.000Z");
    expect(next(the29th, "2028-01-29T10:00:00.000Z")).toBe("2028-02-29T09:00:00.000Z");
  });
});

describe("daylight saving time", () => {
  const ny = "America/New_York";

  it("runs a time spring-forward skips an hour later that day", () => {
    // 2026-03-08: clocks go from 02:00 EST to 03:00 EDT, so 02:30 never happens.
    const daily = { type: "fixed_time", timeOfDay: "02:30", timeZone: ny } as const;
    expect(runs(daily, "2026-03-07T08:00:00.000Z", 3)).toEqual([
      "2026-03-08T07:30:00.000Z", // 03:30 EDT: the skipped 02:30, an hour on
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
      "2026-03-10T06:30:00.000Z",
    ]);
  });

  it("runs a time fall-back repeats once, at its first occurrence", () => {
    // 2026-11-01: clocks go from 02:00 EDT back to 01:00 EST, so 01:30 happens twice.
    const daily = { type: "fixed_time", timeOfDay: "01:30", timeZone: ny } as const;
    expect(runs(daily, "2026-10-31T12:00:00.000Z", 3)).toEqual([
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-02T06:30:00.000Z", // 01:30 EST; never the repeated 01:30 on Nov 1
      "2026-11-03T06:30:00.000Z",
    ]);
  });

  it("keeps a wall-clock time across both changes, where an interval keeps elapsed time", () => {
    const nine = { type: "fixed_time", timeOfDay: "09:00", timeZone: "Europe/Amsterdam" } as const;
    expect(runs(nine, "2026-10-24T12:00:00.000Z", 2)).toEqual([
      "2026-10-25T08:00:00.000Z", // 09:00 CET, the day summer time ends
      "2026-10-26T08:00:00.000Z",
    ]);
    expect(next(nine, "2026-03-28T12:00:00.000Z")).toBe("2026-03-29T07:00:00.000Z"); // 09:00 CEST
    const day = { type: "interval", everyMs: 86_400_000 } as const;
    expect(next(day, "2026-10-24T07:00:00.000Z")).toBe("2026-10-25T07:00:00.000Z");
  });

  it("keeps a month day's time across a change", () => {
    const first = { type: "monthly", timeOfDay: "09:00", days: [1], timeZone: ny } as const;
    expect(runs(first, "2026-10-15T00:00:00.000Z", 2)).toEqual([
      "2026-11-01T14:00:00.000Z", // 09:00 EST, the day clocks fall back
      "2026-12-01T14:00:00.000Z",
    ]);
  });

  it("follows the runtime's own zone for schedules saved without one", () => {
    const legacy = { type: "fixed_time", timeOfDay: "02:30" } as const;
    const from = DateTime.makeZonedUnsafe("2026-03-07T08:00:00.000Z", { timeZone: ny });
    const at = nextScheduledRunAt(legacy, from);
    expect(at ? DateTime.formatIso(DateTime.toUtc(at)) : null).toBe("2026-03-08T07:30:00.000Z");
  });

  it("reads cron in its zone, through croner's DST rules", () => {
    const weekdays = { type: "cron", expression: "0 9 * * 1-5", timeZone: ny } as const;
    expect(runs(weekdays, "2026-10-30T14:00:00.000Z", 2)).toEqual([
      "2026-11-02T14:00:00.000Z", // Mon 09:00 EST
      "2026-11-03T14:00:00.000Z",
    ]);
    // A cron time inside the spring-forward gap runs an hour later, as a time of day does.
    const gap = { type: "cron", expression: "30 2 * * *", timeZone: ny } as const;
    expect(runs(gap, "2026-03-07T08:00:00.000Z", 2)).toEqual([
      "2026-03-08T07:30:00.000Z", // 03:30 EDT
      "2026-03-09T06:30:00.000Z",
    ]);
    // A repeated hour runs once.
    const overlap = { type: "cron", expression: "30 1 * * *", timeZone: ny } as const;
    expect(runs(overlap, "2026-10-31T12:00:00.000Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("reads cron's last day of the month and a leap day", () => {
    const lastDay = { type: "cron", expression: "0 9 L * *", timeZone: "UTC" } as const;
    expect(next(lastDay, "2028-02-01T00:00:00.000Z")).toBe("2028-02-29T09:00:00.000Z");
    const leapDay = { type: "cron", expression: "0 9 29 2 *", timeZone: "UTC" } as const;
    expect(next(leapDay, "2026-03-01T00:00:00.000Z")).toBe("2028-02-29T09:00:00.000Z");
  });
});

describe("start, until and a run count", () => {
  it("waits for the start, then stops after until", () => {
    const daily = {
      type: "fixed_time",
      timeOfDay: "09:00",
      timeZone: "UTC",
      startAt: "2026-11-10T00:00:00.000Z",
      until: "2026-11-11T23:59:59.999Z",
    } as const;
    expect(runs(daily, "2026-11-05T00:00:00.000Z", 5)).toEqual([
      "2026-11-10T09:00:00.000Z",
      "2026-11-11T09:00:00.000Z",
    ]);
  });

  it("starts an interval at its start, then counts from each run", () => {
    const hourly = {
      type: "interval",
      everyMs: 3_600_000,
      startAt: "2026-11-10T09:00:00.000Z",
      maxRuns: 3,
    } as const;
    expect(runs(hourly, "2026-11-05T00:00:00.000Z", 5)).toEqual([
      "2026-11-10T09:00:00.000Z",
      "2026-11-10T10:00:00.000Z",
      "2026-11-10T11:00:00.000Z",
    ]);
  });

  it("has no next run once maxRuns scheduled runs have happened", () => {
    const cron = { type: "cron", expression: "*/5 * * * *", timeZone: "UTC", maxRuns: 2 } as const;
    expect(next(cron, "2026-11-05T00:00:00.000Z", { scheduledRunCount: 1 })).toBe(
      "2026-11-05T00:05:00.000Z",
    );
    expect(next(cron, "2026-11-05T00:00:00.000Z", { scheduledRunCount: 2 })).toBeNull();
  });

  it("treats a changed bound as a changed schedule, and a reworded one as the same", () => {
    const base = { type: "monthly", timeOfDay: "09:00", days: [1, -1] } as const;
    expect(isSameSchedule(base, { ...base, days: [-1, 1, 1] })).toBe(true);
    expect(isSameSchedule(base, { ...base, maxRuns: 3 })).toBe(false);
    expect(
      isSameSchedule(
        { ...base, until: "2026-12-01T00:00:00Z" },
        { ...base, until: "2026-12-01T01:00:00+01:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "cron", expression: "0  9 * * *", timeZone: "UTC" },
        { type: "cron", expression: "0 9 * * *", timeZone: "UTC" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", everyDays: 1 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", timeZone: "UTC" },
      ),
    ).toBe(false);
  });
});

describe("schedule problems and words", () => {
  it("reports a cron expression croner cannot read", () => {
    expect(scheduleProblem({ type: "cron", expression: "0 25 * * *", timeZone: "UTC" })).toMatch(
      /not valid/,
    );
    expect(
      scheduleProblem({ type: "cron", expression: "@weekly", timeZone: "UTC" }),
    ).toBeUndefined();
  });

  it("says each schedule in words", () => {
    expect(describeSchedule({ type: "monthly", timeOfDay: "09:00", days: [-1, 1] })).toBe(
      "At 09:00 on the 1st, last day of each month",
    );
    expect(
      describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1], everyWeeks: 2 }),
    ).toBe("At 09:00 every Mon of every 2 weeks");
  });
});
