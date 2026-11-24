// Settings > Account on a phone: the plan as a percent used and its reset, one line per limit, in the person's own
// clock (a time zone is named here so the words are the same on any machine), and nothing where there is no plan to
// read.
import type { AccountSummary } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import { planLines } from "./account-model";

/** Tuesday Nov 10 2026, 3:00 PM in New York (8:00 PM UTC). */
const NOW = Date.parse("2026-11-10T20:00:00.000Z");
const NEW_YORK = "America/New_York";

type Credits = NonNullable<AccountSummary["credits"]>;
const account = (
  windows: Credits["windows"],
  patch: Partial<Credits> = {},
): Pick<AccountSummary, "credits"> => ({
  credits: {
    plan: "pro",
    seats: 1,
    windows,
    balance_micros: 12_340_000,
    grants: [],
    use_balance: true,
    ...patch,
  },
});
const words = (windows: Credits["windows"], zone = NEW_YORK) =>
  planLines(account(windows), NOW, zone).map((line) => line.words);

describe("the plan's lines", () => {
  it("say a percent used and its reset in the person's clock", () => {
    expect(
      planLines(
        account([{ window: "week", used_pct: 58, resets_at: "2026-11-14T12:44:00.000Z" }]),
        NOW,
        NEW_YORK,
      ),
    ).toEqual([
      { window: "week", label: "This week", words: "58% · resets Sat 7:44 AM", tone: "quiet" },
    ]);
  });

  it("follow the time zone they are given, and never name one", () => {
    const week = [{ window: "week", used_pct: 58, resets_at: "2026-11-14T12:44:00.000Z" }];
    expect(words(week, "UTC")).toEqual(["58% · resets Sat 12:44 PM"]);
    expect(words(week, "Europe/Amsterdam")).toEqual(["58% · resets Sat 1:44 PM"]);
    expect(words(week, "Asia/Tokyo")).toEqual(["58% · resets Sat 9:44 PM"]);
  });

  it("say only the time for a reset today, and the date for one more than a week off", () => {
    expect(words([{ window: "5h", used_pct: 12, resets_at: "2026-11-10T23:00:00.000Z" }])).toEqual([
      "12% · resets 6:00 PM",
    ]);
    expect(
      words([{ window: "month", used_pct: 31, resets_at: "2026-12-01T05:00:00.000Z" }]),
    ).toEqual(["31% · resets Dec 1"]);
  });

  it("are one per limit, the shortest first, each by its name", () => {
    const lines = planLines(
      account([
        { window: "month", used_pct: 31, resets_at: "2026-12-01T05:00:00.000Z" },
        { window: "week", used_pct: 58, resets_at: "2026-11-14T12:44:00.000Z" },
        { window: "5h", used_pct: 12, resets_at: "2026-11-10T23:00:00.000Z" },
        { window: "day", used_pct: 40 },
      ]),
      NOW,
      NEW_YORK,
    );
    expect(lines.map((line) => [line.label, line.words])).toEqual([
      ["5 hours", "12% · resets 6:00 PM"],
      ["This week", "58% · resets Sat 7:44 AM"],
      ["This month", "31% · resets Dec 1"],
      ["day", "40%"],
    ]);
  });

  it("say only the percent where no reset is named, and that it is resetting once the reset has passed", () => {
    expect(words([{ window: "week", used_pct: 58 }])).toEqual(["58%"]);
    expect(words([{ window: "week", used_pct: 58, resets_at: "not a time" }])).toEqual(["58%"]);
    expect(
      words([{ window: "week", used_pct: 100, resets_at: "2026-11-10T19:59:00.000Z" }]),
    ).toEqual(["100% · resetting now"]);
  });

  it("hold the percent to a whole number from 0 to 100, and turn amber from 80", () => {
    const tones = (used_pct: number) =>
      planLines(account([{ window: "week", used_pct }]), NOW, NEW_YORK).map((line) => [
        line.words,
        line.tone,
      ]);
    expect(tones(79.9)).toEqual([["79%", "quiet"]]);
    expect(tones(80)).toEqual([["80%", "warn"]]);
    expect(tones(100)).toEqual([["100%", "warn"]]);
    expect(tones(140)).toEqual([["100%", "warn"]]);
    expect(tones(-3)).toEqual([["0%", "quiet"]]);
  });

  it("say nothing where there is no plan to read", () => {
    expect(planLines(null, NOW, NEW_YORK)).toEqual([]);
    expect(planLines({}, NOW, NEW_YORK)).toEqual([]);
    expect(planLines({ credits: null }, NOW, NEW_YORK)).toEqual([]);
    expect(planLines(account([]), NOW, NEW_YORK)).toEqual([]);
  });

  it("never read dollars: a limit an older computer sent by its size is left out, and no money is said", () => {
    const old = [
      {
        window: "week",
        cap_micros: 60_000_000,
        used_micros: 34_800_000,
        resets_at: "2026-11-14T12:44:00.000Z",
      },
    ] as unknown as Credits["windows"];
    expect(planLines(account(old), NOW, NEW_YORK)).toEqual([]);
    const said = JSON.stringify(
      planLines(
        account([{ window: "week", used_pct: 58, resets_at: "2026-11-14T12:44:00.000Z" }], {
          balance_micros: 12_340_000,
          computers: {
            kept: 2,
            kept_limit: 5,
            awake_gib: 32,
            awake_gib_limit: 384,
            max_size: "16x64",
            used_pct: 12,
          },
        }),
        NOW,
        NEW_YORK,
      ),
    );
    expect(said).not.toMatch(/\$|12\.34|credit|GB|384|16x64|minute|UTC|pro/i);
  });
});
