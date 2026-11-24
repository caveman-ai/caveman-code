// What the sidebar reads, gathered once for both modes: every chat as a row (sidebar/model.ts), each with its pull
// request; what the main panel shows; the Chiefs with their counts; and the drawer's folds. The rows keep their
// identity while what they show doesn't move, so a chat streaming its live line re-renders nothing here.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "../board/model";
import { findPr } from "../review/lookup";
import { automations } from "../screens/pages/Automations";
import { toneOf } from "../screens/pages/automations-model";
import { queueOf, reviews, settled, waitingOnYou } from "../screens/pages/review-model";
import { useDrawer } from "../shell/drawer";
import { useUi } from "../shell/ui";
import { store, useStore } from "../store/store";
import { type Folds, type Here, hereOf, type PrMark, type SideChat, sideChats } from "./model";

/** Now, moved on each minute: a quiet project folds, a snooze lets go. */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Each chat's pull request, as Review and the guide know it (screens/pages/review-model.ts queueOf, review/source.ts
 * findPr): a ready chat has one open on its branch, a merged one says so, and what was merged from this phone counts.
 * Worked out again only when one of those can have changed, not as lines stream.
 */
function usePrs(chats: readonly Chat[]): ReadonlyMap<string, PrMark> {
  const sent = reviews.use();
  const done = settled.use();
  const key = chats.map((c) => (c.phase === "ready" && c.moment ? `${c.id}>${c.moment.branch}` : c.phase === "done" && /^Merged #/.test(c.line) ? `${c.id}:${c.line}` : "")).join("|");
  return useMemo(() => {
    const all = store.get().board.chats;
    const prs = queueOf(all, sent, Date.now());
    const marks = new Map<string, PrMark>();
    for (const chat of all) {
      const pr = findPr(prs, chat.id);
      if (pr) marks.set(chat.id, { state: pr.state, number: pr.number });
    }
    return marks;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the chats: worked out again when a pull request can have changed, not as lines stream.
  }, [key, sent, done]);
}

/** The pull requests that wait on your review, as Review's own header counts them: the top row's count. */
export function useWaitingPrs(): number {
  const sent = reviews.use();
  const chats = useStore((st) => st.board.chats);
  return useMemo(() => waitingOnYou(queueOf(chats, sent, Date.now())), [chats, sent]);
}

/** The automations whose last run failed: the top row's count. */
export function useFailingAutomations(): number {
  const list = automations.use();
  return useMemo(() => list.filter((a) => toneOf(a) === "error").length, [list]);
}

/** Two rows the same to the eye: what a row draws didn't move. */
function same(a: SideChat, b: SideChat): boolean {
  return (
    a.title === b.title &&
    a.repo === b.repo &&
    a.phase === b.phase &&
    a.unread === b.unread &&
    a.pinned === b.pinned &&
    a.at === b.at &&
    a.since === b.since &&
    a.askedAt === b.askedAt &&
    a.opens === b.opens &&
    a.snoozedUntil === b.snoozedUntil &&
    a.done === b.done &&
    a.doneAt === b.doneAt &&
    a.fate?.words === b.fate?.words &&
    a.pr?.state === b.pr?.state &&
    a.pr?.number === b.pr?.number &&
    a.agents.length === b.agents.length &&
    a.agents.every((x, i) => x === b.agents[i])
  );
}

/** The rows, each the object it was last time unless something it shows moved. */
function useStable(rows: readonly SideChat[]): readonly SideChat[] {
  const kept = useRef(new Map<string, SideChat>());
  return useMemo(() => {
    const was = kept.current;
    const next = new Map<string, SideChat>();
    const keep = (row: SideChat): SideChat => {
      const agents = row.agents.map(keep);
      const fresh = agents.every((a, i) => a === row.agents[i]) ? row : { ...row, agents };
      const old = was.get(fresh.id);
      const out = old && same(old, fresh) ? old : fresh;
      next.set(out.id, out);
      return out;
    };
    const out = rows.map(keep);
    kept.current = next;
    return out;
  }, [rows]);
}

const sameFocus = (a: { name: string; id?: string } | null, b: { name: string; id?: string } | null) => a?.name === b?.name && a?.id === b?.id;

/** What the main panel shows: the chat (a subagent's too) or the Chief the sidebar marks. */
export function useHere(): Here {
  const focused = useUi((s) => s.focused, sameFocus);
  const chats = useStore((s) => s.board.chats);
  const ids = useMemo(() => new Set(chats.map((c) => c.id)), [chats]);
  const chat = hereOf(focused, ids).chat;
  const chief = focused?.name === "Chief" ? (focused.id ?? null) : null;
  return useMemo(() => ({ chat, chief }), [chat, chief]);
}

/** Every chat that gets a row, in board order, with its subagents under it. */
export function useSideChats(open: string | null, now: number): readonly SideChat[] {
  const chats = useStore((s) => s.board.chats);
  const inbox = useStore((s) => s.inbox);
  const prs = usePrs(chats);
  const rows = useMemo(() => sideChats({ chats, inbox, prs, open, now }), [chats, inbox, prs, open, now]);
  return useStable(rows);
}

const sameFolds = (a: Folds, b: Folds) => a.folded === b.folded && a.expanded === b.expanded;

/** The drawer's folds: which sections are shut, which show past their cut-off. */
export const useFolds = (): Folds => useDrawer((s) => ({ folded: s.folded, expanded: s.expanded }), sameFolds);
