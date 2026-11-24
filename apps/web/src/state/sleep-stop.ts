// A turn that stopped because the computer slept or the lid closed: its stop marker says so and offers
// Continue, which sends a follow-up carrying the note the runtime builds for a chat that carries on after this.
//
// How the page knows a stop came from sleep, from two sources:
//  1. The runtime writes a "Paused when the lid closed" note into the chat just before it stops the turn
//     (handlers.ts pausedByLid). It is in the chat's history, so it survives a reload; transcript.ts reads it.
//  2. The desktop's lid outcome names the chats whose turn the lid stopped here and when (apps/desktop/src/lid.ts), which
//     also covers a chat the runtime was never asked about (signed out of Caveman Cloud: the desktop interrupts it). It is
//     kept per device in local storage so a reload keeps it; a stop counts when it landed between the lid closing and a
//     minute after the Mac woke.
import type { TranscriptItem } from "./transcript-model.ts";

/** The title of the runtime's note in a chat the lid stopped (packages/runtime/src/session-protocol/handlers.ts pausedByLid). */
export const LID_NOTE_TITLE = "Paused when the lid closed";

/** What the stop marker says. */
export const SLEEP_STOP_LABEL = "Stopped when your computer slept";

/** What a sleep-stop follow-up shows in the chat in place of the whole note (a quiet row; state/generated.ts). */
export const CONTINUED_LINE = "Continued after your computer slept";

/** Slack either side of the lid window, for clocks and a stop that lands as the Mac wakes. */
const BEFORE_MS = 2_000;
const AFTER_WAKE_MS = 60_000;
/** A lid record is kept this long, then dropped. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = "caveman.lid-stops.v1";

/** What the desktop says after the Mac woke (cavemanDesktop.onLidOutcome). `chats` and `at` come from apps/desktop/src/lid.ts. */
export interface LidOutcomeView {
  readonly moving: number;
  readonly paused: number;
  /** The chats whose turn the lid stopped on this Mac. */
  readonly chats?: ReadonlyArray<string> | undefined;
  /** When the lid closed (ms since the epoch). */
  readonly at?: number | undefined;
}

/** One lid for one chat: the lid closed at `at`, the Mac woke at `woke` (both ms since the epoch). */
export interface LidStop {
  readonly at: number;
  readonly woke: number;
}

export type LidStops = Readonly<Record<string, ReadonlyArray<LidStop>>>;

/** Whether a turn that ended at `endedAt` (ISO) ended inside one of the chat's lid windows. */
export function stoppedByLid(endedAt: string, lids: ReadonlyArray<LidStop> | undefined): boolean {
  const ended = Date.parse(endedAt);
  if (!lids || Number.isNaN(ended)) return false;
  return lids.some((lid) => inWindow(ended, lid));
}

const inWindow = (ended: number, lid: LidStop) =>
  ended >= lid.at - BEFORE_MS && ended <= lid.woke + AFTER_WAKE_MS;

/**
 * The turn ends the chat's lids stopped. A lid stops the one turn that was running when it closed: per lid, the first
 * interrupted turn that ended in its window and was not started by a message sent after the Mac woke. A turn the person
 * starts and stops in that window (Continue, then Stop) is their own stop, said as "Stopped".
 */
export function lidStoppedEnds(
  items: ReadonlyArray<TranscriptItem>,
  lids: ReadonlyArray<LidStop> | undefined,
): ReadonlySet<string> {
  const ends = new Set<string>();
  if (!lids || lids.length === 0) return ends;
  const taken = new Set<LidStop>();
  let sent: number | undefined;
  for (const item of items) {
    if (item.kind === "user" && sent === undefined) sent = Date.parse(item.at);
    if (item.kind !== "turn_end") continue;
    const ended = Date.parse(item.at);
    const started = sent;
    sent = undefined;
    if (item.outcome !== "interrupted" || Number.isNaN(ended)) continue;
    const lid = lids.find(
      (l) => !taken.has(l) && inWindow(ended, l) && !(started !== undefined && started > l.woke),
    );
    if (lid === undefined) continue;
    taken.add(lid);
    ends.add(item.id);
  }
  return ends;
}

/** The records after one lid outcome: its chats added under their id, records past a week dropped. */
export function withLidOutcome(kept: LidStops, outcome: LidOutcomeView, woke: number): LidStops {
  const next: Record<string, ReadonlyArray<LidStop>> = {};
  for (const [id, lids] of Object.entries(kept)) {
    const fresh = lids.filter((l) => woke - l.woke < KEEP_MS);
    if (fresh.length > 0) next[id] = fresh;
  }
  if (outcome.at === undefined) return next;
  for (const id of outcome.chats ?? []) next[id] = [...(next[id] ?? []), { at: outcome.at, woke }];
  return next;
}

function read(): LidStops {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as LidStops) : {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let snapshot: LidStops | null = null;

/** The kept lid records, one object until it changes (for useSyncExternalStore). */
export function lidStops(): LidStops {
  return (snapshot ??= read());
}

/** Nothing kept, for a render with no page (tests that render to a string). */
export const noLidStops = (): LidStops => ({});

export function subscribeLidStops(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Keeps what a lid stopped, as the Mac wakes (called with the desktop's outcome). */
export function recordLidOutcome(outcome: LidOutcomeView, now = Date.now()): void {
  if (outcome.at === undefined || (outcome.chats?.length ?? 0) === 0) return;
  const next = withLidOutcome(lidStops(), outcome, now);
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full disk: the marker shows for this page's life.
  }
  for (const listener of [...listeners]) listener();
}

/** Forgets what was read, so the next read sees the store (tests). */
export function resetLidStops(): void {
  snapshot = null;
  for (const listener of [...listeners]) listener();
}

/** Continue's button: ready, sending, or sent (the follow-up went: it stays down until the chat runs and the marker goes). */
export type ContinueState = "idle" | "sending" | "sent";

/**
 * A press of Continue: ignored while one is in flight or after one went, so one follow-up goes out however many
 * presses land before the chat starts running. Only a send that failed lets it be pressed again.
 */
export async function pressContinue(
  state: { current: ContinueState },
  send: () => Promise<unknown> | void,
  shown: (state: ContinueState) => void,
): Promise<void> {
  if (state.current !== "idle") return;
  const to = (next: ContinueState) => {
    state.current = next;
    shown(next);
  };
  to("sending");
  try {
    await send();
    to("sent");
  } catch {
    // The send failed: the button is there to try again.
    to("idle");
  }
}

/** A tool as a line of the note: the runtime's own say (moveEngines.ts restartNote). */
const LISTED_TOOLS = 20;

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The follow-up Continue sends for the turn that ended at `endId`: the same words as the runtime's note for a chat
 * that carries on after its computer slept (packages/runtime/src/cloudLink/moveEngines.ts restartNote with cause
 * "stopped", which this page cannot import: it is in the runtime, and a copy of its words is pinned by
 * sleep-stop.test.ts). Built from the turn's own rows: the tools that ran and what the person asked. Undefined when
 * `endId` is not a turn's end here.
 */
export function continueNote(
  items: ReadonlyArray<TranscriptItem>,
  endId: string,
): string | undefined {
  const end = items.findIndex((i) => i.kind === "turn_end" && i.id === endId);
  if (end < 0) return undefined;
  let start = end;
  while (start > 0 && items[start - 1]!.kind !== "turn_end") start--;
  const turn = items.slice(start, end);
  // Every tool that ran in the turn, a subagent's too, in order: restartNote lists every tool.started of the turn.
  const toolsIn = (
    rows: ReadonlyArray<TranscriptItem>,
  ): Array<Extract<TranscriptItem, { kind: "tool" }>> =>
    rows.flatMap((i) => (i.kind === "tool" ? [i] : i.kind === "subagent" ? toolsIn(i.items) : []));
  const tools = toolsIn(turn);
  const first = turn.find((i) => i.kind === "user" && !i.generated);
  const asked =
    first?.kind === "user"
      ? first.from
        ? `The message that started it, from ${oneLine(first.from.title, 160)} (not the person):\n${first.text}`
        : `The person asked:\n${first.text}`
      : undefined;
  const line = (t: (typeof tools)[number]) => {
    // A shell command says itself; any other tool says its row.
    const title = oneLine(
      t.command ?? ([t.verb, t.subject].filter(Boolean).join(" ") || t.name),
      160,
    );
    const how =
      t.status === "done"
        ? "completed"
        : t.status === "failed"
          ? "failed"
          : t.status === "denied"
            ? "declined"
            : "stopped before it finished";
    return `- ${title} (${how})`;
  };
  return [
    "[Caveman Code] Your last turn stopped when this computer went to sleep, and continues now.",
    tools.length > 0
      ? `These tools already ran before it stopped; their effects on files are here:\n${[...tools.slice(0, LISTED_TOOLS).map(line), ...(tools.length > LISTED_TOOLS ? [`- and ${tools.length - LISTED_TOOLS} more`] : [])].join("\n")}`
      : "No tool had run yet.",
    ...(asked !== undefined ? [asked] : []),
    "Carry on from where it stopped. Don't run a command again unless you need its result again.",
  ].join("\n\n");
}

/** A note that begins as `continueNote` does: the chat draws it as one quiet row (state/generated.ts). */
export const isContinueNote = (text: string) =>
  text
    .trimStart()
    .startsWith(
      "[Caveman Code] Your last turn stopped when this computer went to sleep, and continues now.",
    );
