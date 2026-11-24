// The later offers (docs/ "When to offer it"): only where a plan unlocks something
// the person just reached, one at a time, each quiet for 7 days after Not now. Pure: components/Offers.tsx draws it.

import type { AccountSummary, EngineDescriptor } from "@caveman-app/session-protocol";
import { planLabel } from "../routes/settings/account-model.ts";
import { engineReady } from "../state/engines.ts";
import { offersUnlock, paidPlan, planColumns } from "./unlock-model.ts";

export type OfferId = "lid" | "window" | "gift";
export type Offer = { readonly id: OfferId; readonly title: string; readonly body: string; readonly action: "unlock" | "gift" };

/** Not now keeps an offer away this long. */
export const QUIET_MS = 7 * 24 * 60 * 60 * 1000;
/** After any offer is answered, none comes back for this long: never one straight after another. */
export const BETWEEN_MS = 24 * 60 * 60 * 1000;

const WHO: Record<string, string> = { "claude-agent": "Claude", codex: "ChatGPT" };

/**
 * A subscription login whose window is used up (Claude's five hours or week, Codex's): who, and when it resets. A
 * window past its reset is stale, and Codex running on compact credits keeps going: neither counts.
 */
export function fullWindow(engines: ReadonlyArray<EngineDescriptor>, now = new Date()): { readonly who: string; readonly resetsAt?: string } | null {
  for (const e of engines) {
    const who = WHO[e.id];
    if (!who || !engineReady(e) || e.usage_on_credits) continue;
    const full = (e.usage_limits ?? []).filter((l) => l.used_percent >= 100 && (l.resets_at === undefined || Date.parse(l.resets_at) > now.getTime()));
    if (full.length === 0) continue;
    // The one that keeps it shut longest is when it opens again.
    const resets = full.map((l) => l.resets_at).filter((r): r is string => r !== undefined).toSorted().at(-1);
    return resets ? { who, resetsAt: resets } : { who };
  }
  return null;
}

const when = (iso: string, now: Date) => {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  return at.toLocaleString("en-US", sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "long", hour: "numeric", minute: "2-digit" });
};

/** The one offer to show now, if any: the lid first (it just happened), then a full window, then a gift to give. */
export function pickOffer(input: {
  readonly account: AccountSummary | null;
  readonly engines: ReadonlyArray<EngineDescriptor>;
  /** Chats paused when the lid closed, from the desktop after the Mac woke. */
  readonly lidPaused: number;
  /** A pull request merged since this computer first looked, not yet answered with the gift offer. */
  readonly merged: boolean;
  /** Free months still to give (account.gifts with status open; sent ones are not). */
  readonly giftsToGive: number;
  readonly quiet: (id: OfferId) => boolean;
  readonly now?: Date;
}): Offer | null {
  const { account, quiet } = input;
  const now = input.now ?? new Date();
  const sell = offersUnlock(account);
  const cheapest = sell && account?.offer ? planColumns(account.offer)[0] : undefined;
  if (sell && input.lidPaused > 0 && !quiet("lid")) {
    const n = input.lidPaused;
    return { id: "lid", title: `${n} chat${n === 1 ? "" : "s"} paused while your Mac slept`, body: "With a plan, they move to a Cloud computer and keep going with the lid shut.", action: "unlock" };
  }
  const full = sell ? fullWindow(input.engines, now) : null;
  if (full && !quiet("window")) {
    const reset = full.resetsAt ? `It opens again ${when(full.resetsAt, now)}. ` : "";
    const plan = cheapest ? `$${cheapest.usdMonth} a month comes with up to $${cheapest.upTo} of usage.` : "A plan comes with usage of its own.";
    return { id: "window", title: `Your ${full.who} limit is used up`, body: `${reset}Keep going on the Caveman engine: ${plan}`, action: "unlock" };
  }
  const gifts = input.giftsToGive;
  if (paidPlan(account) && gifts > 0 && input.merged && !quiet("gift")) {
    const plan = account?.offer?.gift ? planLabel(account.offer.gift.plan, account.offer) : "Pro";
    return { id: "gift", title: "Your pull request merged", body: `Give a friend a free month of ${plan}. You have ${gifts} to give.`, action: "gift" };
  }
  return null;
}
