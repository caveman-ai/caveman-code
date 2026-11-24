// What the lists read, on top of the store's one status (store/select.ts): each Chief as a character row (its ask if
// something waits on you, else what it is doing), the chats no Chief runs, which device is your usual one, and the
// words a chat's or a device's second line says. Nothing here counts on its own: every number is a slice of `rows`,
// so the Chiefs, the workspaces and the devices always add up to the same agents (home/reconcile.test.ts).
import { useEffect, useState } from "react";
import { type Chat, type Chief, CHIEFS, type Device, DEVICES, deviceById, type Phase } from "../board/model";
import { memoLast, shallow } from "../store/core";
import { askerOf, askOf, atWork, questionOf, rows, type Row, type Seen, unseenReady } from "../store/select";
import { type AppState, useStore } from "../store/store";

const rowsOf = (s: AppState) => rows(s.board.chats, s.inbox.archived);

/** Now, moved on each minute, so "4m" ages and "last seen" lines stay true on a screen left open. */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ---------------------------------------------------------------- asks

/** The chat that asks (store/select.ts, the one status function, words every ask). */
export { askerOf };

/** What a chat asks, as the one question every screen uses ("Deploy the site to production?"). */
export const askWords = (asker: Chat) => questionOf(asker);

/**
 * An ask as every row, title and line says it: short, the verb and the kind of thing ("Add a package?"), whole at 28
 * characters or fewer (store/select.ts shortAsk). The command or package itself is the command chip's to spell out.
 */
export const askQuestion = (asker: Chat): string => askOf(asker).question;

// ---------------------------------------------------------------- Chiefs

export interface ChiefCard {
  /** Null for your own chats, the ones no Chief runs. */
  chief: Chief | null;
  needs: number;
  ready: number;
  working: number;
  total: number;
  /** One live line: the oldest ask while something waits on you, else what it is doing, else where it rests. */
  line: string;
  /** The line is work in progress: it shimmers. */
  live: boolean;
  /** The chat the line is about, if one. */
  about: string | null;
  /** When something last happened on its board. */
  at: number;
}

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function cardOf(chief: Chief | null, mine: readonly Row[], chats: readonly Chat[], thought: string | null, seen?: Seen): ChiefCard {
  const n = (p: Phase) => mine.filter((r) => (p === "ready" ? unseenReady(r, seen) : p === "working" ? atWork(r) : r.phase === p)).length;
  const at = Math.max(0, ...mine.map((r) => r.chat.updatedAt));
  const base = { chief, needs: n("needs"), ready: n("ready"), working: n("working"), total: mine.length, at };
  // Asks oldest first: the one that has waited longest is the one it raises.
  const asking = mine.filter((r) => r.phase === "needs").sort((a, b) => a.chat.updatedAt - b.chat.updatedAt)[0];
  if (asking) {
    const who = askerOf(asking.chat, chats);
    return { ...base, line: askQuestion(who), live: false, about: asking.chat.id };
  }
  if (thought) return { ...base, line: thought, live: true, about: null };
  // At Home's height the work is the chats it runs, not their steps: the one that started first (so the line holds
  // still while steps land), and how many more.
  const busy = mine.filter((r) => r.phase === "working").sort((a, b) => a.chat.startedAt - b.chat.startedAt);
  if (busy[0]) return { ...base, line: busy.length > 1 ? `${busy[0].chat.title} and ${busy.length - 1} more` : busy[0].chat.title, live: true, about: busy[0].chat.id };
  // Only a change you haven't looked at is "ready to try" here; a seen one waits on the Ready list's Seen shelf.
  const ready = mine.filter((r) => unseenReady(r, seen)).sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)[0];
  if (ready) return { ...base, line: `${ready.chat.title} is ready to try`, live: false, about: ready.chat.id };
  const last = [...mine].sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)[0];
  if (last) return { ...base, line: last.chat.line ? `${last.chat.title}: ${lower(last.chat.line)}` : last.chat.title, live: false, about: last.chat.id };
  return { ...base, line: chief ? "All quiet" : "Nothing yet", live: false, about: null };
}

/** Every Chief in its own order (never re-sorted, so a row never moves under a thumb), each with its live line. */
// `made`: the board's own Chiefs (New Chief), so a new one is a new answer even before any chat moves.
export const chiefCards = memoLast((all: readonly Row[], chats: readonly Chat[], thinking: Readonly<Record<string, string>>, seen?: Seen, _made?: readonly Chief[]): readonly ChiefCard[] =>
  CHIEFS.map((chief) =>
    cardOf(
      chief,
      all.filter((r) => r.chief === chief.id),
      chats,
      thinking[chief.id] ?? null,
      seen,
    ),
  ),
);

/** The chats no Chief runs, as one character row of their own, or null while there are none. */
export const yourCard = memoLast((all: readonly Row[], chats: readonly Chat[], seen?: Seen): ChiefCard | null => {
  const mine = all.filter((r) => r.chief === null || !CHIEFS.some((c) => c.id === r.chief));
  return mine.length ? cardOf(null, mine, chats, null, seen) : null;
});

const sameCards = (a: readonly ChiefCard[], b: readonly ChiefCard[]) => a.length === b.length && a.every((x, i) => shallow(x, b[i]));
export const useChiefCards = () => useStore((s) => chiefCards(rowsOf(s), s.board.chats, s.board.thinking, s.inbox, s.board.chiefs), sameCards);

// ---------------------------------------------------------------- devices

/** The device most of your chats run on: a row names its device only when it isn't this one. */
export const usualDevice = memoLast((all: readonly Row[]): string => {
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.chat.device, (counts.get(r.chat.device) ?? 0) + 1);
  let best = DEVICES.find((d) => d.self)?.id ?? DEVICES[0]?.id ?? "";
  for (const [id, n] of counts) if (n > (counts.get(best) ?? 0)) best = id;
  return best;
});
export const useUsualDevice = () => useStore((s) => usualDevice(rowsOf(s)));

/** A device that can't run work right now: its chats wait for it. */
export const away = (d: Device) => d.status === "asleep" || d.status === "offline";

/** "18 min ago", "3 h ago", "2 days ago": how long since a device answered. */
export function seenAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** A chat's device when it is worth saying: not your usual one, or one that is away. */
export function deviceNote(chat: Chat, usual: string): { device: Device; waiting: boolean } | null {
  const device = deviceById(chat.device);
  if (away(device)) return { device, waiting: true };
  return chat.device === usual ? null : { device, waiting: false };
}
