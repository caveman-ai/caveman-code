import { describe, expect, it } from "vitest";

import { nextFire } from "./schedule.ts";

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const at = (text: string) => Date.parse(text);

describe("schedule next fire", () => {
  it("fires at a time of day in the file's time zone, not the machine's", () => {
    expect(iso(nextFire({ at: "09:00", timezone: "Europe/Amsterdam" }, at("2026-10-20T06:00:00Z")))).toBe("2026-10-20T07:00:00.000Z");
    expect(iso(nextFire({ at: "09:00", timezone: "America/New_York" }, at("2026-10-20T06:00:00Z")))).toBe("2026-10-20T13:00:00.000Z");
    expect(iso(nextFire({ at: "09:00", timezone: "Asia/Tokyo" }, at("2026-10-20T06:00:00Z")))).toBe("2026-10-21T00:00:00.000Z");
  });

  it("skips to the next listed weekday", () => {
    // Friday 2026-10-23 15:00 in New York: the next weekday morning is Monday.
    expect(iso(nextFire({ at: "09:00", timezone: "America/New_York", weekdays: ["mon", "tue", "wed", "thu", "fri"] }, at("2026-10-23T19:00:00Z")))).toBe(
      "2026-10-26T13:00:00.000Z",
    );
    expect(iso(nextFire({ at: "16:00", timezone: "Europe/Amsterdam", weekdays: ["fri"] }, at("2026-10-20T12:00:00Z")))).toBe("2026-10-23T14:00:00.000Z");
  });

  it("holds the wall-clock time across a DST change", () => {
    // Amsterdam leaves summer time on 2026-10-25: 09:00 is 07:00Z before and 08:00Z after.
    expect(iso(nextFire({ at: "09:00", timezone: "Europe/Amsterdam" }, at("2026-10-24T12:00:00Z")))).toBe("2026-10-25T08:00:00.000Z");
    // 02:30 happens twice that night; it fires once.
    const first = nextFire({ at: "02:30", timezone: "Europe/Amsterdam" }, at("2026-10-24T12:00:00Z"))!;
    expect(iso(first)).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(nextFire({ at: "02:30", timezone: "Europe/Amsterdam" }, first + 1))).toBe("2026-10-26T01:30:00.000Z");
    // 02:30 does not exist on 2026-03-29; it runs an hour later that day.
    expect(iso(nextFire({ at: "02:30", timezone: "Europe/Amsterdam" }, at("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:30:00.000Z");
  });

  it("repeats an interval from the last fire, never faster than 5 minutes", () => {
    expect(nextFire({ every: "6h" }, 1_000)).toBe(1_000 + 6 * 3_600_000);
    expect(nextFire({ every: "1m" }, 0)).toBe(5 * 60_000);
  });

  it("fires a once at its date and time in the file's zone, then never again", () => {
    const once = { once: "2026-11-09 09:00", timezone: "Europe/Amsterdam" } as const;
    expect(iso(nextFire(once, at("2026-11-05T00:00:00Z")))).toBe("2026-11-09T08:00:00.000Z");
    expect(nextFire(once, at("2026-11-09T08:00:00Z"))).toBeUndefined();
    expect(iso(nextFire({ once: "2026-11-09T09:00", timezone: "UTC" }, at("2026-11-05T00:00:00Z")))).toBe("2026-11-09T09:00:00.000Z");
  });

  it("fires on month days, the last day included", () => {
    const monthEnd = { at: "18:00", timezone: "UTC", monthdays: ["last"] } as const;
    expect(iso(nextFire(monthEnd, at("2028-02-01T00:00:00Z")))).toBe("2028-02-29T18:00:00.000Z");
    const the31st = { at: "09:00", timezone: "UTC", monthdays: [31] } as const;
    expect(iso(nextFire(the31st, at("2027-04-01T00:00:00Z")))).toBe("2027-05-31T09:00:00.000Z");
  });

  it("fires every other week from its start", () => {
    const fortnightly = { at: "10:00", timezone: "UTC", weekdays: ["mon"], every: "2w", start: "2026-11-09" } as const;
    expect(iso(nextFire(fortnightly, at("2026-11-01T00:00:00Z")))).toBe("2026-11-09T10:00:00.000Z");
    expect(iso(nextFire(fortnightly, at("2026-11-09T10:00:00Z")))).toBe("2026-11-23T10:00:00.000Z");
  });

  it("reads cron in the file's zone", () => {
    expect(iso(nextFire({ cron: "0 9 * * 1-5", timezone: "America/New_York" }, at("2026-10-30T14:00:00Z")))).toBe("2026-11-02T14:00:00.000Z");
  });

  it("stops at until's last moment and after count runs", () => {
    const daily = { at: "23:30", timezone: "Europe/Amsterdam", start: "2026-11-09", until: "2026-11-10" } as const;
    expect(iso(nextFire(daily, at("2026-11-01T00:00:00Z")))).toBe("2026-11-09T22:30:00.000Z");
    expect(iso(nextFire(daily, at("2026-11-09T22:30:00Z")))).toBe("2026-11-10T22:30:00.000Z");
    expect(nextFire(daily, at("2026-11-10T22:30:00Z"))).toBeUndefined();
    expect(nextFire({ every: "6h", count: 2 }, 0, 1)).toBe(6 * 3_600_000);
    expect(nextFire({ every: "6h", count: 2 }, 0, 2)).toBeUndefined();
  });

  it("cannot fire without a valid zone or a time", () => {
    expect(nextFire({ at: "09:00", timezone: "Mars/Olympus" }, 0)).toBeUndefined();
    expect(nextFire({ at: "09:00" }, 0)).toBeUndefined();
    expect(nextFire({}, 0)).toBeUndefined();
  });
});
