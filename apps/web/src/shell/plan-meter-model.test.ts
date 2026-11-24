import { describe, expect, it } from "vitest";

import { usedPct } from "@caveman-app/session-protocol";
import { blocking, planMeter, planName, readKept, resetLabel, rowText, sidebarWindows, turnEnded, windowTone, workingKey, type Credits, type UsageWindow } from "./plan-meter-model.ts";

// Local times, so the labels read the same in every time zone: Thursday 22 October 2026, 10:00.
const NOW = new Date(2026, 9, 22, 10, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const $ = (dollars: number) => Math.round(dollars * 1e6);
/** A limit as the protocol carries it: whole percent used and a reset, never its size. */
const win = (window: string, used_pct: number, resets_at?: string): UsageWindow => ({ window, used_pct, ...(resets_at ? { resets_at } : {}) });
// Pro: the windows are whatever Cloud sends (a week and a month; a 5-hour window too while Cloud meters one).
const pro = (windows: ReadonlyArray<UsageWindow>, over: Partial<Credits> = {}): Credits => ({ plan: "pro", seats: 1, windows, balance_micros: 0, grants: [], use_balance: true, ...over });
const meter = (credits: Credits | null | undefined, signed_in = true) => planMeter(credits === undefined ? { signed_in } : { signed_in, credits }, NOW);

describe("which limits the sidebar shows", () => {
  const names = (ws: ReadonlyArray<UsageWindow>) => sidebarWindows(ws).map((w) => w.window);

  it("shows the week alone, however full the month or the 5 hours are", () => {
    expect(names([win("week", 58), win("month", 45)])).toEqual(["week"]);
    expect(names([win("week", 28), win("month", 80)])).toEqual(["week"]);
    expect(names([win("5h", 88), win("week", 7), win("month", 99)])).toEqual(["week"]);
  });

  it("adds the 5 hours or the month once it is used up: then it is why turns stop", () => {
    // A 5-hour window that straddles a weekly reset: the week just started over, the 5 hours still hold what was used.
    expect(names([win("5h", 100), win("week", 7), win("month", 33)])).toEqual(["5h", "week"]);
    expect(names([win("week", 60), win("month", 100)])).toEqual(["week", "month"]);
  });

  it("shows the fullest limit of a plan with no week, and none without windows", () => {
    expect(names([win("month", 42), win("5h", 12)])).toEqual(["month"]);
    expect(sidebarWindows([])).toEqual([]);
  });

  it("reads an older runtime's cap and use in dollars as the percent, and ignores a window with no cap", () => {
    const old = [{ window: "week", cap_micros: 0, used_micros: 0 }, { window: "month", cap_micros: $(20), used_micros: $(5) }] as unknown as ReadonlyArray<UsageWindow>;
    expect(sidebarWindows(old)).toEqual([{ window: "month", used_pct: 25 }]);
  });
});

describe("tone and percent", () => {
  it("turns amber at 80% used and red at the limit", () => {
    expect(windowTone(0)).toBe("normal");
    expect(windowTone(79)).toBe("normal");
    expect(windowTone(80)).toBe("amber");
    expect(windowTone(99)).toBe("amber");
    expect(windowTone(100)).toBe("cap");
  });

  it("rounds a percent down, so 99.5% reads 99 and 100 shows only once the limit is reached or passed", () => {
    expect(usedPct(0, $(7))).toBe(0);
    expect(usedPct($(2.8), $(7))).toBe(40);
    expect(usedPct($(5.6), $(7))).toBe(80);
    expect(usedPct($(6.965), $(7))).toBe(99);
    expect(usedPct($(6.999), $(7))).toBe(99);
    expect(usedPct($(7), $(7))).toBe(100);
    // Open holds can carry it past the limit.
    expect(usedPct($(9), $(7))).toBe(100);
    expect(usedPct(-5, $(7))).toBe(0);
  });
});

describe("reset labels, in local time", () => {
  it("says today, tomorrow, a weekday within the week, else the date", () => {
    expect(resetLabel(at(22, 15), NOW)).toBe("Resets today 3:00 PM");
    expect(resetLabel(at(23, 9, 30), NOW)).toBe("Resets tomorrow 9:30 AM");
    expect(resetLabel(at(27, 15), NOW)).toBe("Resets Tue 3:00 PM");
    expect(resetLabel(at(28, 23, 59), NOW)).toBe("Resets Wed 11:59 PM");
    // Seven days on is the same weekday as today: the date says it plainly.
    expect(resetLabel(at(29, 9), NOW)).toBe("Resets Oct 29");
    expect(resetLabel(new Date(2026, 10, 1, 0, 0).toISOString(), NOW)).toBe("Resets Nov 1");
  });

  it("says nothing without a time, and never a reset in the past", () => {
    expect(resetLabel(undefined, NOW)).toBeUndefined();
    expect(resetLabel("not a date", NOW)).toBeUndefined();
    expect(resetLabel(at(22, 9), NOW)).toBe("Resetting now");
  });
});

describe("the meter", () => {
  it("shows nothing without an answer, signed out, or on a Cloud that sells no plans", () => {
    expect(planMeter(null, NOW)).toBeNull();
    expect(planMeter(undefined, NOW)).toBeNull();
    expect(meter(pro([win("week", 14)]), false)).toBeNull();
    expect(meter(null)).toBeNull();
    expect(meter(undefined)).toBeNull();
  });

  it("shows the plan and its week as a share, never in dollars", () => {
    const m = meter(pro([win("week", 58, at(27, 15)), win("month", 47, at(31, 0))], { balance_micros: $(12.34) }));
    expect(m).toMatchObject({ kind: "windows", plan: "Pro", creditsCarryOn: false });
    if (m?.kind !== "windows") throw new Error("windows");
    expect(m.bar).toEqual({ window: "week", label: "This week", percent: 58, tone: "normal", resets: "Resets Tue 3:00 PM" });
    expect(m.words).toBe("Pro plan, this week: 58% used");
    // The popover: the week, its bar and when it resets; the month is in Settings > Plan.
    expect(m.rows.map((r) => [r.label, r.percent, r.resets])).toEqual([["This week", 58, "Resets Tue 3:00 PM"]]);
    // Each row in the popover reads its percent and its reset beside the bar.
    expect(m.rows.map(rowText)).toEqual(["58% · Resets Tue 3:00 PM"]);
    // No dollars at all: the person's credits are in Settings > Plan, not here.
    expect(JSON.stringify(m)).not.toMatch(/\$\d|12\.34|balance/);
  });

  it("reads an older runtime's answer in dollars as the same percent", () => {
    const old = [{ window: "week", cap_micros: $(7), used_micros: $(4.1), resets_at: at(27, 15) }] as unknown as ReadonlyArray<UsageWindow>;
    const m = meter(pro(old));
    expect(m?.kind === "windows" && [m.bar.percent, m.words]).toEqual([58, "Pro plan, this week: 58% used"]);
  });

  it("is amber from 80% used", () => {
    const m = meter(pro([win("week", 85, at(27, 15)), win("month", 60)]));
    expect(m?.kind === "windows" && [m.bar.tone, m.bar.percent]).toEqual(["amber", 85]);
  });

  it("is red at the cap, says when it resets, and whether credits carry on meanwhile", () => {
    const capped = pro([win("week", 100, at(27, 15)), win("month", 70)], { balance_micros: $(12.34) });
    const m = meter(capped);
    expect(m?.kind === "windows" && [m.bar.tone, m.bar.percent, m.bar.resets, m.creditsCarryOn]).toEqual(["cap", 100, "Resets Tue 3:00 PM", true]);
    expect(m?.words).toBe("Pro plan, this week: used up. Resets Tue 3:00 PM");
    expect(m?.kind === "windows" && rowText(m.bar)).toBe("Used up · Resets Tue 3:00 PM");
    expect(meter({ ...capped, use_balance: false })).toMatchObject({ creditsCarryOn: false });
    expect(meter({ ...capped, balance_micros: 0 })).toMatchObject({ creditsCarryOn: false });
  });

  it("shows the week while the 5 hours or the month have room, and the one used up once it is", () => {
    const m = meter(pro([win("month", 33), win("5h", 88, at(22, 13)), win("week", 40, at(29, 9))]));
    expect(m).toMatchObject({ words: "Pro plan, this week: 40% used" });
    expect(m?.kind === "windows" && m.rows.map((r) => [r.label, r.percent])).toEqual([["This week", 40]]);
    const five = meter(pro([win("month", 33), win("5h", 100, at(22, 13)), win("week", 40, at(29, 9))]));
    expect(five).toMatchObject({ words: "Pro plan, 5 hours: used up. Resets today 1:00 PM" });
    expect(five?.kind === "windows" && five.rows.map((r) => [r.label, r.percent])).toEqual([["5 hours", 100], ["This week", 40]]);
  });

  it("names the limit that holds turns longest when two are used up: the one that resets last", () => {
    // The 5 hours start over at 1 PM, the week on Tuesday: turns wait for the week.
    const both = meter(pro([win("5h", 100, at(22, 13)), win("week", 100, at(27, 15)), win("month", 60)]));
    expect(both).toMatchObject({ words: "Pro plan, this week: used up. Resets Tue 3:00 PM" });
    // The month at its cap outlasts a used-up week.
    expect(meter(pro([win("week", 100, at(27, 15)), win("month", 100, at(31, 0))]))).toMatchObject({ words: "Pro plan, this month: used up. Resets Oct 31" });
    // A limit with no reset named holds longest; nothing used up blocks nothing.
    expect(blocking([win("5h", 100), win("week", 100, at(27, 15))])?.window).toBe("5h");
    expect(blocking([win("week", 99, at(27, 15))])).toBeUndefined();
  });

  it("shows Free as its name alone: its credits are in Settings > Plan", () => {
    expect(meter(pro([], { plan: "free", balance_micros: $(12.34) }))).toEqual({ kind: "credits", plan: "Free", words: "Free plan" });
    expect(meter(pro([], { plan: "free" }))).toEqual({ kind: "credits", plan: "Free", words: "Free plan" });
  });

  it("names a plan without its price: what it costs is in Settings > Plan", () => {
    const offer = { catalog_version: 21, purchasable: true, top_up: { min_usd: 5, max_usd: 500, expires_days: 365 }, plans: [["pro", "Pro"], ["go", "Pro $60"], ["max", "Max $100"], ["max20", "Max $200"], ["team", "Team"]].map(([plan, label]) => ({ plan: plan!, label: label!, usd_month: 20, usd_year: 200, per_seat: false, up_to_usd: 60, on_sale: true })) };
    const plans = ["pro", "go", "max", "max20", "team"].map((plan) => planMeter({ signed_in: true, credits: pro([win("week", 14)], { plan }), offer }, NOW)?.plan);
    expect(plans).toEqual(["Pro", "Pro", "Max", "Max", "Team"]);
    expect(["Pro", "Pro $60", "Max $1,000", "Team", "Max 20"].map(planName)).toEqual(["Pro", "Pro", "Max", "Team", "Max 20"]);
  });
});

describe("freshness", () => {
  it("notices a turn ending, not one starting", () => {
    const rows = (pairs: ReadonlyArray<[string, string]>) => pairs.map(([id, state]) => ({ id, state }));
    expect(workingKey(rows([["b", "working"], ["a", "working"], ["c", "completed"]]))).toBe("a,b");
    expect(turnEnded("", "a")).toBe(false);
    expect(turnEnded("a", "a,b")).toBe(false);
    expect(turnEnded("a,b", "b")).toBe(true);
    expect(turnEnded("a", "")).toBe(true);
    // One ended as another started: still an end.
    expect(turnEnded("a", "b")).toBe(true);
  });

  it("keeps the last answer for the next launch, and reads anything else as none", () => {
    const kept = { signed_in: true, credits: pro([win("week", 14)]) };
    expect(readKept(JSON.stringify(kept))).toEqual({ ...kept, offer: null });
    // What a build from before 2026-11-09 kept, limits and plans in dollars: only the percent and the headline are read.
    const old = {
      signed_in: true,
      credits: { ...pro([]), windows: [{ window: "week", cap_micros: $(7), used_micros: $(4.1) }], models: [{ model: "z-ai/glm-5.3", rate_permille: 3000 }], computers: { kept: 1, kept_limit: 10, awake_gib: 16, awake_gib_limit: 160, max_size: "4x16", spent_micros: $(2.9) } },
      offer: { catalog_version: 21, purchasable: true, plans: [{ plan: "pro", label: "Pro", usd_month: 20, usd_year: 192, included_usd: 20, window_week_pct: 35, per_seat: false, up_to_usd: 60, on_sale: true }], rates: [{ model: "z-ai/glm-5.3", rate_permille: 3000 }], computer_minute_micros: { default: 3333 }, top_up: { min_usd: 5, max_usd: 500, expires_days: 365 } },
    };
    const read = readKept(JSON.stringify(old));
    expect(read?.credits?.windows).toEqual([win("week", 58)]);
    expect(JSON.stringify(read)).not.toMatch(/cap_micros|used_micros|spent_micros|included_usd|window_week_pct|rate_permille|computer_minute_micros|"rates"|"models"/);
    expect(read?.offer?.plans).toEqual([{ plan: "pro", label: "Pro", usd_month: 20, usd_year: 192, per_seat: false, up_to_usd: 60, on_sale: true }]);
    expect(readKept(null)).toBeNull();
    expect(readKept("{")).toBeNull();
    expect(readKept(JSON.stringify({ signed_in: false }))).toBeNull();
    expect(readKept(JSON.stringify({ signed_in: true, credits: null }))).toBeNull();
    expect(readKept(JSON.stringify({ signed_in: true, credits: { plan: "pro", windows: [{ window: "week" }], balance_micros: 0 } }))).toBeNull();
  });
});
