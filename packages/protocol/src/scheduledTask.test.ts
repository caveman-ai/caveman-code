// ), packages/contracts/src/scheduledTask.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  isWebhookDedupeTemplate,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
  ScheduledTaskWebhookDeliverySummary,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const decodeDeliverySummary = Schema.decodeSync(ScheduledTaskWebhookDeliverySummary);
const decodeDeliveryList = Schema.decodeUnknownSync(ScheduledTaskListWebhookDeliveriesResult);

it("rejects a long unterminated dotted dedupe key without excessive backtracking", () => {
  const template = "{{body." + "a.".repeat(5000) + "x";
  const startedAt = performance.now();
  const valid = isWebhookDedupeTemplate(template);
  const elapsedMs = performance.now() - startedAt;
  expect(valid).toBe(false);
  expect(elapsedMs).toBeLessThan(50);
  for (const field of ["replayKey", "coalesceKey"]) {
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { [field]: template } }),
    ).toThrow();
  }
});

it.each(["duplicate", "coalesced", "future_outcome"])("decodes delivery outcome %s", (outcome) => {
  expect(
    decodeDeliverySummary({
      id: "delivery:test",
      taskId: "scheduled-task:test",
      receivedAt: "2026-10-20T00:00:00.000Z",
      method: "POST",
      contentType: null,
      bodyBytes: 0,
      outcome,
      signatureVerified: false,
      missingFields: [],
      error: null,
    }).outcome,
  ).toBe(outcome);
});

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("schedules added after the first release", () => {
  it("still reads every schedule persisted before them", () => {
    for (const stored of [
      { type: "interval", everyMs: 300_000 },
      { type: "fixed_time", timeOfDay: "9:00" },
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      { type: "webhook", signature: null },
    ]) {
      expect(decodeSchedule(stored)).toEqual(stored);
    }
  });

 // Ports upstream 4ac97be2b6 (#28104).
  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });

  it("accepts every-N-days and every-N-weeks only in their own shape", () => {
    const base = { type: "fixed_time", timeOfDay: "09:00" } as const;
    expect(decodeUpsertSchedule({ ...base, everyDays: 3 })).toEqual({ ...base, everyDays: 3 });
    expect(decodeUpsertSchedule({ ...base, everyWeeks: 2, weekdays: [1] })).toEqual({
      ...base,
      everyWeeks: 2,
      weekdays: [1],
    });
    expect(() => decodeUpsertSchedule({ ...base, everyWeeks: 2 })).toThrow(/needs weekdays/);
    expect(() => decodeUpsertSchedule({ ...base, everyDays: 2, weekdays: [1] })).toThrow(
      /no weekdays/,
    );
    expect(() => decodeUpsertSchedule({ ...base, everyDays: 2, everyWeeks: 2 })).toThrow();
    expect(() => decodeUpsertSchedule({ ...base, everyDays: 0 })).toThrow();
  });

  it("accepts month days 1 to 31 and -1 for the last day", () => {
    const monthly = { type: "monthly", timeOfDay: "08:30", days: [1, 15, 31, -1] } as const;
    expect(decodeUpsertSchedule(monthly)).toEqual(monthly);
    for (const days of [[], [0], [32], [-2]]) {
      expect(() => decodeUpsertSchedule({ ...monthly, days })).toThrow();
    }
  });

  it("takes a cron expression only with a real time zone", () => {
    const cron = { type: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/Amsterdam" } as const;
    expect(decodeUpsertSchedule(cron)).toEqual(cron);
    expect(decodeUpsertSchedule({ ...cron, expression: "@daily" })).toEqual({
      ...cron,
      expression: "@daily",
    });
    expect(() => decodeUpsertSchedule({ ...cron, timeZone: "Mars/Olympus" })).toThrow();
    expect(() => decodeUpsertSchedule({ type: "cron", expression: "0 9 * * 1" })).toThrow();
    expect(() => decodeUpsertSchedule({ ...cron, expression: "0 9 * *" })).toThrow();
  });

  it("takes a start, an end and a run count on repeats, in order", () => {
    const bounded = {
      type: "interval",
      everyMs: 3_600_000,
      startAt: "2026-11-09T09:00:00.000Z",
      until: "2026-11-30T09:00:00.000Z",
      maxRuns: 5,
    } as const;
    expect(decodeUpsertSchedule(bounded)).toEqual(bounded);
    expect(() => decodeUpsertSchedule({ ...bounded, until: "2026-11-01T09:00:00.000Z" })).toThrow(
      /until is before startAt/,
    );
    expect(() => decodeUpsertSchedule({ ...bounded, maxRuns: 0 })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "fixed_time", timeOfDay: "09:00", timeZone: "Nowhere/City" }),
    ).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("keeps valid filters", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "in", value: ["opened", "labeled"] },
      { path: "body.label.name", op: "startsWith", value: "agent:" },
      { path: "query.source", op: "exists" },
    ];
    expect(decodeUpsertSchedule({ type: "webhook", filters })).toEqual({
      type: "webhook",
      filters,
    });
    expect(decodeSchedule({ type: "webhook", signature: null, filters })).toMatchObject({
      filters,
    });
  });

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });

  it("allows at most 16 filters", () => {
    const sixteen = Array.from({ length: 16 }, () => ({ path: "body.action", op: "exists" }));
    expect(accepts(sixteen)).toBe(true);
    expect(accepts([...sixteen, { path: "body.action", op: "exists" }])).toBe(false);
  });
});

describe("ScheduledTaskWebhookDeliverySummary", () => {
  it("decodes an outcome this client does not know yet", () => {
    const summary = {
      id: "delivery:1",
      taskId: "scheduled-task:1",
      receivedAt: "2026-10-20T00:00:00.000Z",
      method: "POST",
      contentType: null,
      bodyBytes: 0,
      outcome: "some_future_outcome",
      signatureVerified: false,
      missingFields: [],
      error: null,
    };
    expect(decodeDeliveryList({ deliveries: [summary] }).deliveries[0]?.outcome).toBe(
      "some_future_outcome",
    );
  });
});
