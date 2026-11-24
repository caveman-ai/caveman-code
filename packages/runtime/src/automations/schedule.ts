// When an automation file's on.schedule fires next. The file's schedule is read as a scheduled task's schedule and
// goes through the same resolver (scheduledTasks/Schedule.ts), so a file and an app task agree on every rule: a time a
// DST change skips runs an hour later that day, a time that happens twice runs once, a month without the day skips it.
// Pure, so the scheduler source and the list's next run agree.
import { calendarStep, civilDate, durationMs, LAST_DAY, MIN_EVERY_MS, type ScheduleTrigger } from "@caveman-app/automations";
import type { ScheduledTaskSchedule } from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";

import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";

const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;

/** The instant a wall clock in `timeZone` reads `hh:mm` on `date` ("YYYY-MM-DD"). */
function wallClock(date: string, time: string, timeZone: string): number | undefined {
  const day = civilDate(date);
  const clock = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(time);
  if (day === undefined || clock === null) return undefined;
  return DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      { ...day, hour: Number(clock[1]), minute: Number(clock[2]), second: 0, millisecond: 0 },
      { timeZone, adjustForTimeZone: true, disambiguation: "compatible" },
    ),
  );
}

const isoOf = (ms: number) => new Date(ms).toISOString();

/**
 * The file's schedule as a scheduled task's: start is the first moment of its day in the zone, until the last.
 * Undefined when it cannot fire (no time, no zone where one is needed, a zone that is not one).
 */
export function scheduleOf(schedule: ScheduleTrigger): ScheduledTaskSchedule | undefined {
  const zone = schedule.timezone;
  if (zone !== undefined) {
    try {
      DateTime.makeZonedUnsafe(0, { timeZone: zone });
    } catch {
      return undefined;
    }
  }
  if ((schedule.start !== undefined || schedule.until !== undefined) && zone === undefined) return undefined;
  const startAt = schedule.start === undefined || zone === undefined ? undefined : wallClock(schedule.start, "00:00", zone);
  // The last moment of until's day: a millisecond before the next day starts there.
  const untilDay = schedule.until === undefined ? undefined : civilDate(schedule.until);
  const dayAfter = untilDay === undefined ? undefined : new Date(Date.UTC(untilDay.year, untilDay.month - 1, untilDay.day + 1)).toISOString().slice(0, 10);
  const untilEnd = dayAfter === undefined || zone === undefined ? undefined : wallClock(dayAfter, "00:00", zone);
  const until = untilEnd === undefined ? undefined : untilEnd - 1;
  const bounds = {
    ...(startAt === undefined ? {} : { startAt: isoOf(startAt) }),
    ...(until === undefined ? {} : { until: isoOf(until) }),
    ...(schedule.count === undefined ? {} : { maxRuns: schedule.count }),
  };
  if (schedule.once !== undefined) {
    if (zone === undefined) return undefined;
    const runAt = wallClock(schedule.once.slice(0, 10), schedule.once.slice(11), zone);
    return runAt === undefined ? undefined : { type: "once", runAt: isoOf(runAt) };
  }
  if (schedule.cron !== undefined) return zone === undefined ? undefined : { type: "cron", expression: schedule.cron, timeZone: zone, ...bounds };
  const step = calendarStep(schedule.every);
  if (schedule.every !== undefined && step === undefined) {
    const every = durationMs(schedule.every);
    return every === undefined ? undefined : { type: "interval", everyMs: Math.max(every, MIN_EVERY_MS), ...bounds };
  }
  if (schedule.at === undefined || zone === undefined) return undefined;
  if (schedule.monthdays !== undefined) {
    return { type: "monthly", timeOfDay: schedule.at, days: schedule.monthdays.map((d) => (d === LAST_DAY ? -1 : d)), timeZone: zone, ...bounds };
  }
  return {
    type: "fixed_time",
    timeOfDay: schedule.at,
    ...(schedule.weekdays === undefined ? {} : { weekdays: schedule.weekdays.map((d) => WEEKDAY[d]) }),
    ...(step?.unit === "day" ? { everyDays: step.n } : {}),
    ...(step?.unit === "week" ? { everyWeeks: step.n } : {}),
    timeZone: zone,
    ...bounds,
  };
}

/**
 * The first fire strictly after `from` (epoch ms), with `runs` scheduled runs made since the schedule last changed;
 * undefined when the schedule cannot fire or has no fire left (a once that passed, past until, count reached).
 */
export function nextFire(schedule: ScheduleTrigger, from: number, runs = 0): number | undefined {
  const resolved = scheduleOf(schedule);
  if (resolved === undefined) return undefined;
  const next = nextScheduledRunAt(resolved, DateTime.makeZonedUnsafe(from, { timeZone: schedule.timezone ?? "UTC" }), { scheduledRunCount: runs });
  return next === null ? undefined : DateTime.toEpochMillis(next);
}

/** A schedule that follows the wall clock (a time of day, a once, a cron), so a fire missed by more than LATE_GRACE_MS is skipped. */
export const isWallClock = (schedule: ScheduleTrigger): boolean => schedule.at !== undefined || schedule.once !== undefined || schedule.cron !== undefined;

/** How late a wall-clock fire may still run (the runtime was asleep or closed): later than this, it waits for the next one. */
export const LATE_GRACE_MS = 10 * 60_000;
