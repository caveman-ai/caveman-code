// Closing the lid (powerMonitor "suspend") hands the chats working on this Mac to a Cloud computer, where they keep
// going as the same chats (Caveman Cloud the spec; sync design 2026-10-21 S12): Caveman chats, and Claude Agent and
// Codex chats too where the person has a Cloud login for that engine (a key in Caveman Cloud's vault or a sign-in
// made on a Cloud computer), unless Settings keeps those on this Mac. One word to the runtime does it
// (`cloud.suspend`): Cloud hears that this Mac is going to sleep, and for each working chat the runtime first checks
// it may move (moves on, a GitHub repository, Cloud computers, a Cloud login for a Claude Agent or Codex chat: that
// chat says how to make it continue next time), then stops and parks it, copies it whole and hands it off, so one
// computer writes it at a time; a chat that can't go stops its turn here. Every other synced chat's copy is flushed.
// The Mac gives seconds, so the budget is all the lid waits; a working chat the runtime did not answer for (signed
// out of Caveman Cloud) stops its turn here. Electron-free, so it tests without Electron; main.ts calls it.
import type { Client } from "@caveman-app/session-protocol/client";

/** The lid's whole budget before the Mac sleeps. */
export const LID_BUDGET_MS = 3_000;
/** Kept back from the budget for the runtime's answer to reach the lid. */
const ANSWER_MARGIN_MS = 250;

const RUNNING = new Set(["starting", "working", "needs_input", "waiting"]);

export interface LidOutcome {
  readonly moving: number;
  readonly paused: number;
  /** The chats whose turn stopped here (the `paused` ones), so the page can say "Stopped when your computer slept" on them. */
  readonly chats?: ReadonlyArray<string>;
  /** When the lid closed (ms since the epoch): the page matches a chat's stop to it. */
  readonly at?: number;
}

/** Hands the chats working on this Mac to Cloud, or stops the turns of those that can't go; resolves within `budgetMs` whatever the runtime still does. Just the counts (the shape Cloud's lid tests hold it to); `closeLid` also says which chats stopped and when. */
export async function onLidClose(client: Pick<Client, "call">, requestId: () => string, budgetMs = LID_BUDGET_MS): Promise<LidOutcome> {
  const { moving, paused } = await closeLid(client, requestId, budgetMs);
  return { moving, paused };
}

/** onLidClose plus the chats whose turn stopped here and when the lid closed, for the page's "Stopped when your computer slept". */
export async function closeLid(client: Pick<Client, "call">, requestId: () => string, budgetMs = LID_BUDGET_MS): Promise<LidOutcome> {
  const at = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), budgetMs)));
  try {
    // Asked at once, beside the list: the runtime's handoff has the whole budget.
    const suspending = client.call("cloud.suspend", { request_id: requestId(), budget_ms: Math.max(0, budgetMs - ANSWER_MARGIN_MS) }).then(
      (out) => out,
      () => "failed" as const,
    );
    const listed = await Promise.race([client.call("workspace.list", {}), budget]);
    if (listed === "late") return { moving: 0, paused: 0 };
    const here = listed.workspaces.filter((w) => RUNNING.has(w.status) && w.computer.kind === "this_mac");
    const suspended = await Promise.race([suspending, budget]);
    // Past the budget the runtime is still handing them off (it carries on as the Mac wakes): none is stopped here,
    // which would race the handoff.
    if (suspended === "late") return { moving: here.length, paused: 0 };
    const handed = new Set(suspended === "failed" ? [] : suspended.handed_off);
    const stopped = new Set(suspended === "failed" ? [] : suspended.paused);
    // A working chat the runtime answered nothing for (signed out of Caveman Cloud, or the call failed): its turn stops.
    const left = here.filter((w) => !handed.has(w.session_id) && !stopped.has(w.session_id));
    await Promise.race([Promise.allSettled(left.map((w) => client.call("turn.interrupt", { request_id: requestId(), session_id: w.session_id }))), budget]);
    const stayed = here.filter((w) => !handed.has(w.session_id)).map((w) => w.session_id);
    return { moving: here.length - stayed.length, paused: stayed.length, chats: stayed, at };
  } finally {
    clearTimeout(timer);
  }
}

/** What main.ts does with the lid's outcome: the page hears it when the Mac wakes, if a chat moved or stopped. */
export interface LidReport {
  /** The Mac is going to sleep (powerMonitor "suspend"): returns where onLidClose's outcome goes once it answers. */
  readonly sleeping: () => (outcome: LidOutcome) => void;
  /** The Mac woke (powerMonitor "resume"): the kept outcome is sent now, or as soon as onLidClose answers. */
  readonly woke: () => void;
}

/**
 * Keeps the last lid's outcome until the Mac wakes, then hands it to `send` once (only when a chat moved or stopped).
 * The handoff may still be answering as the Mac wakes: the outcome goes out when it arrives. A newer sleep replaces
 * an older one's outcome, which then never goes out.
 */
export function lidReport(send: (outcome: LidOutcome) => void): LidReport {
  let round = 0;
  let awake = true;
  let kept: LidOutcome | undefined;
  const deliver = () => {
    if (!awake || kept === undefined) return;
    const outcome = kept;
    kept = undefined;
    if (outcome.moving > 0 || outcome.paused > 0)
      send({ moving: outcome.moving, paused: outcome.paused, ...(outcome.chats !== undefined && outcome.chats.length > 0 ? { chats: outcome.chats } : {}), ...(outcome.at !== undefined ? { at: outcome.at } : {}) });
  };
  return {
    sleeping: () => {
      const mine = ++round;
      awake = false;
      kept = undefined;
      return (outcome) => {
        if (mine !== round) return;
        kept = outcome;
        deliver();
      };
    },
    woke: () => {
      awake = true;
      deliver();
    },
  };
}
