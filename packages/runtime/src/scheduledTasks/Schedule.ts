// ), apps/server/src/scheduledTasks/Schedule.ts @ ab3a3cd1; the once schedule @ 4ac97be2b6 (#28104).
// Monthly, every-N-days/weeks, cron and the start/until/maxRuns bounds are ours.
import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@caveman-app/protocol";
import { Cron } from "croner";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** How far a repeat has got: the runs its schedule started since it last changed. */
export interface ScheduleProgress {
  readonly scheduledRunCount?: number | undefined;
}

type Repeating = Exclude<ScheduledTaskSchedule, { type: "webhook" } | { type: "once" }>;
type WallClock = Extract<ScheduledTaskSchedule, { type: "fixed_time" | "monthly" | "cron" }>;

/** A calendar date with no zone: what a wall clock reads on one day. */
interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const epochDay = (d: CivilDate) => Math.floor(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS);
const civilOfEpochDay = (n: number): CivilDate => {
  const date = new Date(n * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};
/** 0 is Sunday, like the schedule's weekdays. */
const weekdayOf = (d: CivilDate) => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const millis = (value: DateTime.DateTime) => DateTime.toEpochMillis(value);
const instant = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * The zone a wall-clock schedule reads: its own, else the zone `from` is in
 * (the runtime's local zone, as every schedule before `timeZone` assumed).
 */
type Zone = string | DateTime.TimeZone;

function zoneOf(
  schedule: { readonly timeZone?: string | undefined },
  from: DateTime.DateTime,
): Zone {
  if (schedule.timeZone !== undefined) return schedule.timeZone;
  return DateTime.isZoned(from) ? from.zone : "UTC";
}

function civilAt(epochMs: number, timeZone: Zone): CivilDate {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(epochMs, { timeZone }));
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * The instant a wall clock in `timeZone` reads `time` on `date`. A time a DST
 * change skips runs an hour later that day; a time that happens twice runs at
 * the first of the two.
 */
function wallClock(
  date: CivilDate,
  time: { hour: number; minute: number },
  timeZone: Zone,
): DateTime.Zoned {
  return DateTime.makeZonedUnsafe(
    { ...date, hour: time.hour, minute: time.minute, second: 0, millisecond: 0 },
    { timeZone, adjustForTimeZone: true, disambiguation: "compatible" },
  );
}

/** The day a repeat counts every N days or weeks from: `startAt`'s day in the zone, else 1970-01-01. */
function anchorDay(startAt: number | undefined, timeZone: Zone): number {
  return startAt === undefined ? 0 : epochDay(civilAt(startAt, timeZone));
}

function fixedTimeMatches(
  schedule: Extract<ScheduledTaskSchedule, { type: "fixed_time" }>,
  date: CivilDate,
  anchor: number,
): boolean {
  const day = epochDay(date);
  if (schedule.everyDays !== undefined && schedule.everyDays > 1) {
    const since = day - anchor;
    return since >= 0 && since % schedule.everyDays === 0;
  }
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  if (weekdays !== null && !weekdays.has(weekdayOf(date))) return false;
  if (schedule.everyWeeks !== undefined && schedule.everyWeeks > 1) {
    // Weeks start on Monday; the anchor's week is week 0.
    const monday = (n: number) => n - ((weekdayOf(civilOfEpochDay(n)) + 6) % 7);
    const weeks = Math.floor((monday(day) - monday(anchor)) / 7);
    return weeks >= 0 && weeks % schedule.everyWeeks === 0;
  }
  return true;
}

/** The first wall-clock occurrence strictly after `after` (epoch ms), or null. */
function nextWallClock(schedule: WallClock, after: number, timeZone: Zone): number | null {
  const startAt = instant(schedule.startAt);
  if (schedule.type === "cron") {
    const cron = new Cron(schedule.expression, {
      timezone: typeof timeZone === "string" ? timeZone : DateTime.zoneToString(timeZone),
      mode: "5-part",
    });
    const next = cron.nextRun(new Date(after));
    return next === null ? null : next.getTime();
  }
  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const first = civilAt(after, timeZone);
  if (schedule.type === "monthly") {
    // A day a month lacks (the 31st in April) is skipped, like cron; -1 is always the last day.
    for (let offset = 0; offset <= 14; offset += 1) {
      const year = first.year + Math.floor((first.month - 1 + offset) / 12);
      const month = ((first.month - 1 + offset) % 12) + 1;
      const last = daysInMonth(year, month);
      const days = [...new Set(schedule.days.map((d) => (d === -1 ? last : d)))]
        .filter((d) => d <= last)
        .toSorted((a, b) => a - b);
      for (const day of days) {
        const candidate = millis(wallClock({ year, month, day }, time, timeZone));
        if (candidate > after) return candidate;
      }
    }
    return null;
  }
  const anchor = anchorDay(startAt, timeZone);
  const span = 7 * (schedule.everyWeeks ?? 1) + (schedule.everyDays ?? 1) + 7;
  const firstDay = epochDay(first);
  for (let offset = 0; offset <= span; offset += 1) {
    const date = civilOfEpochDay(firstDay + offset);
    if (!fixedTimeMatches(schedule, date, anchor)) continue;
    const candidate = millis(wallClock(date, time, timeZone));
    if (candidate > after) return candidate;
  }
  return null;
}

function nextRepeat(
  schedule: Repeating,
  from: DateTime.DateTime,
  progress: ScheduleProgress | undefined,
): DateTime.DateTime | null {
  if (schedule.maxRuns !== undefined && (progress?.scheduledRunCount ?? 0) >= schedule.maxRuns) {
    return null;
  }
  const startAt = instant(schedule.startAt);
  const until = instant(schedule.until);
  const fromMs = millis(from);
  let next: number | null;
  if (schedule.type === "interval") {
    // Persisted rows created before the one-minute floor remain readable, but
    // they must not retain their old high-frequency execution rate.
    // Intervals advance elapsed time, including across daylight-saving changes.
    // A start in the future is the first run.
    next =
      startAt !== undefined && startAt > fromMs
        ? startAt
        : fromMs + Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS);
  } else {
    const timeZone = zoneOf(schedule, from);
    // Strictly after `from`, and no earlier than the start.
    const after = startAt !== undefined && startAt - 1 > fromMs ? startAt - 1 : fromMs;
    next = nextWallClock(schedule, after, timeZone);
  }
  if (next === null || (until !== undefined && next > until)) return null;
  // Keep `from`'s zone so callers that read parts see their own clock.
  return DateTime.isZoned(from)
    ? DateTime.makeZonedUnsafe(next, { timeZone: from.zone })
    : DateTime.makeUnsafe(next);
}

/**
 * The first run strictly after `from`, or null when the schedule has none left
 * (a webhook, a one-time run that has passed, a repeat past `until` or at its
 * `maxRuns`).
 */
export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
  progress?: ScheduleProgress,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "once") {
    const runAt = DateTime.make(schedule.runAt);
    return Option.isSome(runAt) && millis(runAt.value) > millis(from) ? runAt.value : null;
  }
  return nextRepeat(schedule, from, progress);
}

/**
 * Why a schedule cannot be saved, beyond its shape: a cron expression croner
 * cannot read, or a time zone this runtime does not know. Undefined when fine.
 */
export function scheduleProblem(schedule: ScheduledTaskSchedule): string | undefined {
  if (schedule.type === "cron") {
    try {
      new Cron(schedule.expression, { timezone: schedule.timeZone, mode: "5-part" });
    } catch (error) {
      return `The cron expression "${schedule.expression}" is not valid: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

/**
 * Canonical form of a weekday mask, mirroring how `nextScheduledRunAt` reads
 * it: order and duplicates are irrelevant, and an empty/omitted mask means the
 * same as explicitly listing all seven days — daily.
 */
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

function boundsKey(schedule: Repeating): string {
  return [
    instant(schedule.startAt) ?? "",
    instant(schedule.until) ?? "",
    schedule.maxRuns ?? "",
  ].join("|");
}

/** Semantic equality for schedules: true iff both fire at the same times. */
export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs && boundsKey(a) === boundsKey(b);
  }
  // Webhook tasks never have a next run, whatever their signature settings.
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "once") return b.type === "once" && Date.parse(a.runAt) === Date.parse(b.runAt);
  if (a.type === "cron") {
    return (
      b.type === "cron" &&
      a.expression.trim().split(/\s+/).join(" ") === b.expression.trim().split(/\s+/).join(" ") &&
      a.timeZone === b.timeZone &&
      boundsKey(a) === boundsKey(b)
    );
  }
  if (b.type !== a.type) return false;
  // The contract accepts padded and unpadded hours ("9:00" and "09:00"), so
  // compare the parsed time — string equality would treat a format-only edit
  // as a schedule change and recompute the pending run.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  if (
    aTime === null ||
    bTime === null ||
    aTime.hour !== bTime.hour ||
    aTime.minute !== bTime.minute ||
    a.timeZone !== b.timeZone ||
    boundsKey(a) !== boundsKey(b)
  ) {
    return false;
  }
  if (a.type === "monthly" && b.type === "monthly") {
    const days = (s: typeof a) => [...new Set(s.days)].toSorted((x, y) => x - y).join(",");
    return days(a) === days(b);
  }
  if (a.type !== "fixed_time" || b.type !== "fixed_time") return false;
  return (
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
    (a.everyDays ?? 1) === (b.everyDays ?? 1) &&
    (a.everyWeeks ?? 1) === (b.everyWeeks ?? 1)
  );
}

/**
 * How late a wall-clock run may fire before it counts as missed. Covers poll
 * jitter and short sleeps, while a server booted hours after the slot skips
 * to the next occurrence instead of firing stale work at a random time.
 */
export const MISSED_RUN_GRACE_MS = 10 * MINUTE_MS;

/**
 * True when a due wall-clock run (a time of day, a month day, a cron time or a
 * one-time run) was missed by more than the grace window. A repeat is
 * rescheduled to its next occurrence instead of firing now; a one-time run is
 * recorded as missed and does not fire. Interval schedules are never missed:
 * an overdue interval task catching up with a single run is the desired
 * behaviour.
 */
export function isMissedRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type === "interval" || schedule.type === "webhook") return false;
  return millis(now) - millis(dueAt) > MISSED_RUN_GRACE_MS;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ordinal(day: number): string {
  if (day === -1) return "last day";
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return `${day}${suffix}`;
}

/** A schedule in a few words: "At 09:00 every weekday", "Once at 2026-11-09T08:00:00.000Z". */
export function describeSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "once") return `Once at ${schedule.runAt}`;
  const zone = (s: { readonly timeZone?: string | undefined }) =>
    s.timeZone ? ` (${s.timeZone})` : "";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / MINUTE_MS;
    if (Number.isInteger(minutes)) {
      return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
    }
    return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
  }
  if (schedule.type === "cron") return `Cron ${schedule.expression}${zone(schedule)}`;
  if (schedule.type === "monthly") {
    const days = [...new Set(schedule.days)].toSorted(
      (a, b) => (a === -1 ? 32 : a) - (b === -1 ? 32 : b),
    );
    return `At ${schedule.timeOfDay} on the ${days.map(ordinal).join(", ")} of each month${zone(schedule)}`;
  }
  if (schedule.everyDays !== undefined && schedule.everyDays > 1) {
    return `At ${schedule.timeOfDay} every ${schedule.everyDays} days${zone(schedule)}`;
  }
  const weekdays = schedule.weekdays ?? [];
  const weekdayCount = new Set(weekdays).size;
  const days =
    weekdayCount === 0 || weekdayCount === 7
      ? "day"
      : weekdayCount === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "weekday"
        : weekdays.map((d) => WEEKDAY_NAMES[d]).join(", ");
  const weeks =
    schedule.everyWeeks !== undefined && schedule.everyWeeks > 1
      ? ` of every ${schedule.everyWeeks} weeks`
      : "";
  return `At ${schedule.timeOfDay} every ${days}${weeks}${zone(schedule)}`;
}
