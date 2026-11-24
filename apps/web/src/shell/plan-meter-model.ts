// The plan meter at the foot of the sidebar: how much of the person's Caveman Code plan's week is used, read from the
// same account.get that Settings > Account shows (Cloud's GET /api/v1/code/credits, broker.CreditsView). Pure, so
// the choices it makes (which limit shows, when it turns amber or red, how a reset reads) are tested here.
// A plan's limits show as a percent, a ring or a bar and a reset, never as dollars, and no
// dollars at all are said here: Cloud says each limit as a whole percent used and its reset
// (docs/ section 9), and the person's own money (credits, Pay as you go, a
// plan's price) lives in Settings > Plan alone. The sidebar shows the week, the limit people plan around; every
// limit Cloud sends is in Settings > Plan.

import { publicCredits, publicOffer, usageWindows, type AccountSummary, type CodeUsageWindow } from "@caveman-app/session-protocol";
import { planLabel, planWindows, shortDay, windowLabel } from "../routes/settings/account-model.ts";

export type Credits = NonNullable<AccountSummary["credits"]>;
/** One limit of the plan: whole percent used and when it starts over. */
export type UsageWindow = CodeUsageWindow;
/** What the meter needs from account.get: the plan's windows and credits, and the offer for the next size up. */
export type PlanUsage = Pick<AccountSummary, "signed_in" | "credits" | "offer">;

/** Under 80% used, 80% or more, or nothing left until the window resets. */
export type MeterTone = "normal" | "amber" | "cap";

export interface UsageRow {
  readonly window: string;
  /** "5 hours", "This week", "This month". */
  readonly label: string;
  /** 0 to 100, whole; 100 only at the cap. */
  readonly percent: number;
  readonly tone: MeterTone;
  /** "Resets Tue 3:00 PM"; absent when Cloud named no reset. */
  readonly resets: string | undefined;
}

export type PlanMeter =
  | {
      readonly kind: "windows";
      readonly plan: string;
      /** The ring in the sidebar: the week, or another limit once it is used up. */
      readonly bar: UsageRow;
      /** The ring in words, for its label: "Pro plan, this week: 58% used". */
      readonly words: string;
      /** The popover: the week, and any other limit only once it is used up (sidebarWindows). */
      readonly rows: ReadonlyArray<UsageRow>;
      /** At the cap with credits on and some left: turns carry on, paid from credits. */
      readonly creditsCarryOn: boolean;
      /** A free month running: "Free month from Julius · ends Nov 18". */
      readonly trial: string | undefined;
      /** Free months still to give friends. */
      readonly gifts: number;
    }
  /** A plan with no usage of its own (Free): its name and the way to a plan. Its credits are in Settings > Plan. */
  | { readonly kind: "credits"; readonly plan: string; readonly words: string };

/** A plan's name as the sidebar says it: without the price some carry in their label ("Max $100" is "Max"). */
export const planName = (label: string) => label.replace(/\s+\$[\d,.]+$/, "");

/** "58% · Resets Sat 7:44 AM", "Used up · Resets Sat 7:44 AM": one limit's row in the popover, beside its bar. */
export const rowText = (row: UsageRow) => [row.tone === "cap" ? "Used up" : `${row.percent}%`, row.resets].filter(Boolean).join(" · ");

const fullest = (a: UsageWindow | undefined, w: UsageWindow) => (!a || w.used_pct > a.used_pct ? w : a);

/**
 * The limits the sidebar shows, of the ones Cloud sends (planWindows), shortest first: the week, the one people plan
 * around (a plan with no week, its fullest limit), and the 5 hours or the month only once one is used up, as that is
 * then why turns stop. Settings > Plan shows them all.
 */
export function sidebarWindows(windows: ReadonlyArray<UsageWindow>): UsageWindow[] {
  const all = planWindows(windows);
  const main = all.find((w) => w.window === "week") ?? all.reduce<UsageWindow | undefined>(fullest, undefined);
  return all.filter((w) => w === main || w.used_pct >= 100);
}

/** When a limit starts over, as a time; one with no reset named holds longest. */
const resetsAt = (w: UsageWindow) => {
  const at = w.resets_at ? new Date(w.resets_at).getTime() : Number.NaN;
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
};

/**
 * The used-up limit that holds turns longest: with two used up at once, the one that resets last, as turns wait for
 * it. Undefined while nothing is used up.
 */
export function blocking(windows: ReadonlyArray<UsageWindow>): UsageWindow | undefined {
  let held: UsageWindow | undefined;
  for (const w of windows) if (w.used_pct >= 100 && (!held || resetsAt(w) > resetsAt(held))) held = w;
  return held;
}

/** Amber from 80% used, the cap at 100 (Cloud says 100 only once the limit is reached). */
export function windowTone(percent: number): MeterTone {
  if (percent >= 100) return "cap";
  return percent >= 80 ? "amber" : "normal";
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When a window starts over, in local time: "Resets today 3:00 PM", "Resets tomorrow 9:00 AM", "Resets Tue
 * 3:00 PM" within the week, else "Resets Nov 1". A time already past reads "Resetting now" until the next read.
 */
export function resetLabel(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  if (at.getTime() <= now.getTime()) return "Resetting now";
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Resets today ${time}`;
  if (days === 1) return `Resets tomorrow ${time}`;
  if (days < 7) return `Resets ${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `Resets ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function row(w: UsageWindow, now: Date): UsageRow {
  return {
    window: w.window,
    label: windowLabel(w.window),
    percent: w.used_pct,
    tone: windowTone(w.used_pct),
    resets: resetLabel(w.resets_at, now),
  };
}

/**
 * The meter, or null when there is nothing to show: no answer yet, signed out of Caveman, or a Caveman Cloud that
 * sells no Code plans (credits null). A plan with windows shows its week, or the limit that is used up; one without
 * (Free) the way to a plan.
 */
export function planMeter(usage: PlanUsage | null | undefined, now: Date): PlanMeter | null {
  if (!usage?.signed_in || !usage.credits) return null;
  const credits = usage.credits;
  const plan = planName(planLabel(credits.plan, usage.offer));
  const shown = sidebarWindows(credits.windows);
  const main = blocking(shown) ?? shown.find((w) => w.window === "week") ?? shown[0];
  if (!main) return { kind: "credits", plan, words: `${plan} plan` };
  const bar = row(main, now);
  const words =
    bar.tone === "cap"
      ? `${plan} plan, ${bar.label.toLowerCase()}: used up${bar.resets ? `. ${bar.resets}` : ""}`
      : `${plan} plan, ${bar.label.toLowerCase()}: ${bar.percent}% used`;
  return {
    kind: "windows",
    plan,
    bar,
    words,
    rows: shown.map((w) => row(w, now)),
    creditsCarryOn: bar.tone === "cap" && credits.use_balance && credits.balance_micros > 0,
    trial: trialNote(credits.subscription),
    gifts: credits.gifts?.open ?? 0,
  };
}

/** A free month in a few words for the popover; nothing outside one. */
export function trialNote(sub: Credits["subscription"]): string | undefined {
  if (!sub?.trial_end || sub.status !== "active") return undefined;
  const ends = shortDay(sub.trial_end);
  const from = sub.gift_from ? ` from ${sub.gift_from}` : "";
  return `Free month${from}${ends ? ` · ends ${ends}` : ""}${sub.cancel_at_period_end ? ", nothing charged" : ""}`;
}

/** The chats with a turn running now, as one comparable key ("a,b,c"). */
export function workingKey(workspaces: ReadonlyArray<{ readonly id: string; readonly state: string }>): string {
  return workspaces
    .filter((w) => w.state === "working")
    .map((w) => w.id)
    .sort()
    .join(",");
}

/** A turn ended between two keys: a chat that was working is no longer. */
export function turnEnded(before: string, after: string): boolean {
  if (before === "" || before === after) return false;
  const now = new Set(after === "" ? [] : after.split(","));
  return before.split(",").some((id) => !now.has(id));
}

/** The last answer kept for the next launch, so the meter paints with the sidebar; anything malformed reads as none. */
export function readKept(raw: string | null): PlanUsage | null {
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as PlanUsage;
    const c = kept?.credits;
    if (kept?.signed_in !== true || !c || typeof c.plan !== "string" || !Array.isArray(c.windows) || typeof c.balance_micros !== "number") return null;
    // What an earlier build kept held each limit in dollars: only the percent is read, and kept again. A limit that
    // says neither is no answer at all.
    if (usageWindows(c.windows).length !== c.windows.length) return null;
    const offer = kept.offer && Array.isArray(kept.offer.plans) ? publicOffer(kept.offer) : null;
    return { signed_in: true, credits: publicCredits(c), offer };
  } catch {
    return null;
  }
}
