// A chat's place in the inbox, kept in the store and on disk (cc/v1/inbox): read or unread, done, snoozed, renamed,
// archived, and when it last moved. The rules that read it are the desktop's and stay in shell/inbox.ts (`useInbox`);
// this is the pure slice. A connected client reads the same marks from the thread projection (Workspace.inbox).
import type { Chat, Phase } from "../board/model";

export interface Mark {
  at: number;
  /** The phase it was in when marked: the mark holds only until the chat moves on from it. */
  phase: Phase;
}

/**
 * Your Mark done or Not done. Not done is a mark too: it holds a merged chat off the Done shelf, as the desktop's
 * settledOverride "active" does, until the chat moves on.
 */
export interface DoneMark extends Mark {
  done: boolean;
}

export interface InboxState {
  /** The phase each chat was in when you last had it open. */
  seen: Readonly<Record<string, Phase>>;
  /** Marked unread by hand, until it is opened again. */
  unread: Readonly<Record<string, true>>;
  /** When each chat last changed phase: its age in the queue. */
  since: Readonly<Record<string, number>>;
  done: Readonly<Record<string, DoneMark>>;
  snoozed: Readonly<Record<string, Mark & { until: number }>>;
  titles: Readonly<Record<string, string>>;
  /** Archived and still in Undo's reach: out of every list while the board keeps it a few seconds more. */
  archived: Readonly<Record<string, true>>;
  /**
   * What you tried of what each chat built (Ready to try's Works and Not right): the build tried, by its key (src/try
   * model.ts tryKey), so the next one it brings back is new to try again.
   */
  tried: Readonly<Record<string, string>>;
}

export const EMPTY_INBOX: InboxState = { seen: {}, unread: {}, since: {}, done: {}, snoozed: {}, titles: {}, archived: {}, tried: {} };

export type InboxAction =
  | { type: "inbox/rename"; id: string; title: string }
  | { type: "inbox/archive"; id: string }
  | { type: "inbox/restore"; id: string }
  | { type: "inbox/snooze"; id: string; phase: Phase; until: number }
  | { type: "inbox/wake"; id: string }
  /**
   * Done is settled: it is read too, and no longer snoozed (or pinned: store.ts). A chat that asks something can't be
   * settled until it is answered (the runtime refuses), so it stays as it was.
   */
  | { type: "inbox/done"; id: string; phase: Phase }
  /** Not done: held off the Done shelf in the phase it is in, merged or not, until it moves on. */
  | { type: "inbox/reopen"; id: string; phase: Phase }
  | { type: "inbox/unread"; id: string }
  /** Read: the hand-made unread mark goes, and the phase it is in counts as seen. */
  | { type: "inbox/read"; id: string; phase: Phase }
  /** You tried what it built (`key`), or took that back (no key). */
  | { type: "inbox/tried"; id: string; key: string | null }
  /** The board let a chat go: its marks go with it. */
  | { type: "inbox/forget"; id: string };

function without<T>(record: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> {
  if (!(id in record)) return record;
  const { [id]: _, ...rest } = record;
  return rest;
}

export function reduceInbox(state: InboxState, action: InboxAction | { type: string }): InboxState {
  const a = action as InboxAction;
  const now = Date.now();
  switch (a.type) {
    case "inbox/rename":
      return { ...state, titles: { ...state.titles, [a.id]: a.title } };
    case "inbox/archive":
      return state.archived[a.id] ? state : { ...state, archived: { ...state.archived, [a.id]: true } };
    case "inbox/restore":
      return state.archived[a.id] ? { ...state, archived: without(state.archived, a.id) } : state;
    case "inbox/snooze":
      return { ...state, snoozed: { ...state.snoozed, [a.id]: { at: now, phase: a.phase, until: a.until } } };
    case "inbox/wake":
      return { ...state, snoozed: without(state.snoozed, a.id) };
    case "inbox/done":
      if (a.phase === "needs") return state;
      return { ...state, snoozed: without(state.snoozed, a.id), done: { ...state.done, [a.id]: { at: now, phase: a.phase, done: true } }, seen: { ...state.seen, [a.id]: a.phase } };
    case "inbox/reopen":
      return { ...state, done: { ...state.done, [a.id]: { at: now, phase: a.phase, done: false } } };
    case "inbox/unread":
      return state.unread[a.id] ? state : { ...state, unread: { ...state.unread, [a.id]: true } };
    case "inbox/read":
      if (!state.unread[a.id] && state.seen[a.id] === a.phase) return state;
      return { ...state, unread: without(state.unread, a.id), seen: { ...state.seen, [a.id]: a.phase } };
    case "inbox/tried":
      if (a.key === null) return { ...state, tried: without(state.tried, a.id) };
      return state.tried[a.id] === a.key ? state : { ...state, tried: { ...state.tried, [a.id]: a.key } };
    case "inbox/forget":
      return {
        seen: without(state.seen, a.id),
        unread: without(state.unread, a.id),
        since: without(state.since, a.id),
        done: without(state.done, a.id),
        snoozed: without(state.snoozed, a.id),
        titles: without(state.titles, a.id),
        archived: without(state.archived, a.id),
        tried: without(state.tried, a.id),
      };
    default:
      return state;
  }
}

/**
 * A chat whose phase changed has moved just now; one seen for the first time keeps when it started. A phase change is
 * something new: what you last read of it and your done or snooze were about the phase it left, so they go, as the
 * runtime clears them when a new turn starts. Kept, they would hold again the next time the chat lands in that phase.
 */
export function trackSince(inbox: InboxState, before: readonly Chat[], after: readonly Chat[], now = Date.now()): InboxState {
  const was = new Map(before.map((c) => [c.id, c.phase]));
  let next: InboxState | null = null;
  for (const chat of after) {
    const phase = was.get(chat.id);
    if (phase === chat.phase) continue;
    if (phase === undefined && inbox.since[chat.id] !== undefined) continue;
    const s: InboxState = next ?? inbox;
    next = { ...s, since: { ...s.since, [chat.id]: phase === undefined ? chat.updatedAt : now } };
    if (phase !== undefined) next = { ...next, seen: without(next.seen, chat.id), done: without(next.done, chat.id), snoozed: without(next.snoozed, chat.id) };
  }
  return next ?? inbox;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const PHASES = new Set(["needs", "ready", "working", "done"]);
const isPhase = (v: unknown): v is Phase => typeof v === "string" && PHASES.has(v);
const isMark = (v: unknown): v is Mark => isObject(v) && typeof v.at === "number" && isPhase(v.phase);
// A done mark kept before Not done was one has no `done`: it was a Mark done.
const doneMark = (v: unknown): DoneMark | null => (isMark(v) ? { ...v, done: (v as { done?: unknown }).done !== false } : null);

function pick<T>(v: unknown, keep: (x: unknown) => x is T): Record<string, T> {
  return isObject(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => keep(x))) as Record<string, T>) : {};
}

export function inboxFromDisk(data: unknown): InboxState | null {
  if (!isObject(data)) return null;
  return {
    seen: pick(data.seen, isPhase),
    unread: pick(data.unread, (x): x is true => x === true),
    since: pick(data.since, (x): x is number => typeof x === "number"),
    done: Object.fromEntries(Object.entries(isObject(data.done) ? data.done : {}).flatMap(([id, v]) => { const m = doneMark(v); return m ? [[id, m]] : []; })),
    snoozed: pick(data.snoozed, (x): x is Mark & { until: number } => isMark(x) && typeof (x as { until?: unknown }).until === "number"),
    titles: pick(data.titles, (x): x is string => typeof x === "string"),
    archived: pick(data.archived, (x): x is true => x === true),
    tried: pick(data.tried, (x): x is string => typeof x === "string"),
  };
}

/**
 * Done: as you last said, while nothing new happened since; without your word, merged and not pinned (the runtime
 * marks a chat done when its pull request merges, never a pinned one, and pinning a done chat takes the mark off:
 * ThreadSettlementService, Orchestrator thread.pin). A chat that asks something (`phase`, its status with its
 * subagents') is never done.
 */
export function isDoneIn(inbox: Pick<InboxState, "done">, chat: Chat, phase: Phase = chat.phase): boolean {
  if (phase === "needs") return false;
  const said = inbox.done[chat.id];
  return said?.phase === chat.phase ? said.done : chat.phase === "done" && !chat.pinned;
}
