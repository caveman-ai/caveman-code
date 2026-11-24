// The sidebar's lists, worked out with no React and no store, so they are the same on every render and can be tested
// alone. Two ways to read the chats (shell/drawer.ts SidebarMode): by project, for clean mobile navigation
// (Pinned, a folder per project, Recent), or as the queue, upstream standard sidebar sorted by state (its
// resolveSidebarThreadSection: pinned, active, working, snoozed, settled). The Chiefs lead both, the ones you opened
// last first.
//
// A chat's status is the store's one vocabulary (store/select.ts phaseOf): a subagent never gets a row of its own, its
// ask lights up its parent, and a tap on that parent opens the ask (nav/ref.ts openRow). Its subagents are drawn under
// it only when you open its group.
//
// What is folded or opened past its cut-off is kept in the drawer's two lists (shell/drawer.ts), by key:
// - folded: "chiefs", "pinned", "recent", "project:<repo>", "shelf:<name>": the section is shut;
// - expanded: "chiefs", "recent", "project:<repo>", "shelf:settled": shown past its cut-off; "agents:<id>": a parent's
// subagents are open (they start shut, for clean mobile navigation); "more:agents:<id>": and past their cut-off; "open:<key>": a
//   section that starts shut (a quiet project) was opened.
import type { Chat, Phase } from "../board/model";
import { kidsWord } from "../live/seams";
import type { PrState } from "../screens/pages/review-model";
import { type InboxState, isDoneIn } from "../store/inbox";
import { askerOf, phaseOf } from "../store/select";

/** How many rows a section shows before its "Load more" (Chiefs: before "Show N more"). */
export const CUT = { chiefs: 3, project: 5, recent: 8, agents: 8, settled: 10 } as const;

/** A project with nothing going on and nothing for this long starts folded. */
export const QUIET_AFTER = 3 * 86_400_000;

/** A chat's pull request, as its glyph shows it: green while open, grey as a draft, merged as Review draws it. */
export interface PrMark {
  state: PrState;
  number: number;
}

/** A chat as the sidebar draws it: the parts of it a row shows, worked out once. */
export interface SideChat {
  id: string;
  /** The name you gave it, else its own. */
  title: string;
  repo: string;
  /** Its status as every row shows it (phaseOf): a subagent that asks makes its parent ask. */
  phase: Phase;
  /** Something new since you last had it open (shell/inbox.ts): full ink. */
  unread: boolean;
  pinned: boolean;
  /** When something last happened in it or in one of its subagents: the projects' and Recent's order. */
  at: number;
  /** When it came into its phase: the Working shelf's order, which holds still while lines land. */
  since: number;
  /** When it started waiting on you: the queue's order for what asks, oldest first (store/select.ts askQueue). */
  askedAt: number;
  /** The chat a tap opens: the subagent whose ask lit it up, else itself (nav/ref.ts openRow). */
  opens: string;
  pr: PrMark | null;
  /** Its subagents, in the order they were spawned; empty for a subagent. */
  agents: readonly SideChat[];
  /** Snoozed until then (the desktop's rule: it wakes early when it raises its hand), else null. */
  snoozedUntil: number | null;
  /** Settled: it is over, or you marked it done and nothing new happened since. */
  done: boolean;
  /** When it settled, for the Done shelf's newest-first. */
  doneAt: number;
  /** A builder on a real computer: what became of it, in its row's words and that state's colour (Chat.fate). */
  fate?: Chat["fate"];
}

export interface SideInputs {
  chats: readonly Chat[];
  inbox: Pick<InboxState, "seen" | "unread" | "since" | "done" | "snoozed" | "titles" | "archived">;
  /** Each chat's pull request, by chat id. */
  prs: ReadonlyMap<string, PrMark>;
  /** The chat in the main panel, which reads as read while it shows. */
  open: string | null;
  now: number;
}

function sideChat(chat: Chat, agents: readonly SideChat[], x: SideInputs): SideChat {
  const { inbox } = x;
  const phase = phaseOf(chat, x.chats);
  const asker = phase === "needs" ? askerOf(chat, x.chats) : chat;
  const since = inbox.since[chat.id] ?? chat.updatedAt ?? chat.startedAt;
  const snooze = inbox.snoozed[chat.id];
  // The desktop's rules (shell/inbox.ts useInbox): a snooze lets go at its time, when it asks, or when its turn moved on.
  const snoozedUntil = snooze && snooze.until > x.now && phase !== "needs" && chat.phase === snooze.phase ? snooze.until : null;
  const marked = inbox.done[chat.id];
  const done = isDoneIn(inbox, chat, phase);
  return {
    id: chat.id,
    title: inbox.titles[chat.id] ?? chat.title,
    repo: chat.repo,
    phase,
    unread: chat.id !== x.open && (!!inbox.unread[chat.id] || ((phase === "needs" || phase === "ready") && inbox.seen[chat.id] !== phase)),
    pinned: !!chat.pinned,
    at: Math.max(chat.updatedAt, ...agents.map((a) => a.at)),
    since,
    askedAt: asker.need?.at ?? since,
    opens: asker.id !== chat.id && asker.phase === "needs" ? asker.id : chat.id,
    pr: x.prs.get(chat.id) ?? null,
    agents,
    snoozedUntil,
    done,
    doneAt: marked?.at ?? chat.updatedAt,
    ...(chat.fate ? { fate: chat.fate } : {}),
  };
}

/** Every chat that gets a row (not a subagent, not archived), in board order, each with its subagents under it. */
export function sideChats(x: SideInputs): SideChat[] {
  const live = x.chats.filter((c) => !x.inbox.archived[c.id]);
  const kids = new Map<string, Chat[]>();
  for (const chat of live) {
    if (!chat.parent) continue;
    const list = kids.get(chat.parent) ?? [];
    list.push(chat);
    kids.set(chat.parent, list);
  }
  return live.filter((c) => !c.parent).map((chat) => sideChat(chat, (kids.get(chat.id) ?? []).map((kid) => sideChat(kid, [], x)), x));
}

// ---------------------------------------------------------------- folds

export interface Folds {
  folded: readonly string[];
  expanded: readonly string[];
}

/** Whether a section is shut: folded by you, or (`startsShut`) shut until you open it. */
export function isShut(f: Folds, key: string, startsShut = false): boolean {
  if (f.folded.includes(key)) return true;
  if (f.expanded.includes(`open:${key}`)) return false;
  return startsShut;
}

/** The folds with a section opened if it was shut, or shut if it was open. */
export function toggledFold(f: Folds, key: string, startsShut = false): Folds {
  const shut = isShut(f, key, startsShut);
  const folded = f.folded.filter((k) => k !== key);
  const expanded = f.expanded.filter((k) => k !== `open:${key}`);
  if (shut) return { folded, expanded: startsShut ? [...expanded, `open:${key}`] : expanded };
  return { folded: startsShut ? folded : [...folded, key], expanded };
}

/** The first `n` of a list, unless it is shown in full; the row in the main panel is kept in view past the cut. */
export function cutOff<T extends { id: string }>(rows: readonly T[], n: number, all: boolean, keep: string | null = null): { shown: readonly T[]; hidden: number } {
  if (all || rows.length <= n) return { shown: rows, hidden: 0 };
  const shown = rows.slice(0, n);
  const kept = keep ? rows.slice(n).find((r) => r.id === keep || (r as { agents?: readonly { id: string }[] }).agents?.some((a) => a.id === keep)) : undefined;
  return kept ? { shown: [...shown, kept], hidden: rows.length - n - 1 } : { shown, hidden: rows.length - n };
}

// ---------------------------------------------------------------- the Chiefs

export interface ChiefInput {
  id: string;
  needs: number;
  working: number;
  ready: number;
}

/**
 * The Chiefs, the one you opened last first; the ones never opened keep their own order after them. The first three
 * show until you drop the rest open; the Chief in the main panel always shows.
 */
export function chiefsView<T extends ChiefInput>(chiefs: readonly T[], opened: Readonly<Record<string, number>>, all: boolean, here: string | null = null): { shown: readonly T[]; hidden: number } {
  const order = chiefs.map((chief, i) => ({ chief, i, at: opened[chief.id] ?? 0 }));
  order.sort((a, b) => b.at - a.at || a.i - b.i);
  return cutOff(
    order.map((o) => o.chief),
    CUT.chiefs,
    all,
    here,
  );
}

// ---------------------------------------------------------------- what is on screen

/** What the main panel shows, as the sidebar marks it: a chat (a subagent's too) or a Chief. */
export interface Here {
  chat: string | null;
  chief: string | null;
}

export const NOWHERE: Here = { chat: null, chief: null };

/** The main panel's top screen as the sidebar marks it: a chat, a Chief, or a chat's guide (its id is the chat's). */
export function hereOf(focused: { name: string; id?: string } | null, chatIds: ReadonlySet<string>): Here {
  if (!focused?.id) return NOWHERE;
  if (focused.name === "Chief") return { chat: null, chief: focused.id };
  if (focused.name === "Thread" || (focused.name === "Guide" && chatIds.has(focused.id))) return { chat: focused.id, chief: null };
  return NOWHERE;
}

/**
 * Whether a row wears the selection: it is the chat on screen, or (`groupOpen` false) one of its subagents is, so where
 * you are still shows while its group is shut.
 */
export function isHere(row: SideChat, here: Here, groupOpen: boolean): boolean {
  if (!here.chat) return false;
  if (row.id === here.chat) return true;
  return !groupOpen && row.agents.some((a) => a.id === here.chat);
}

// ---------------------------------------------------------------- by project

export type SectionKind = "pinned" | "project" | "recent" | "queue" | "working" | "snoozed" | "settled";

export interface Section {
  /** Its key in the drawer's folds. */
  key: string;
  kind: SectionKind;
  title: string;
  /** Every row it holds. */
  total: number;
  /** The rows it shows, open or not (the screen leaves them out when it is shut). */
  rows: readonly SideChat[];
  /** Past the cut-off, not shown until "Load more". */
  hidden: number;
  /** Shown past its cut-off. */
  all: boolean;
  /** How many it shows before "Load more", or null when it shows them all. */
  cut: number | null;
  shut: boolean;
  /** It starts shut until opened (a quiet project), so its fold toggles against that. */
  startsShut: boolean;
}

const newestFirst = (a: SideChat, b: SideChat) => b.at - a.at;

/** Nothing going on (no ask, nothing at work or new to look at) and nothing for a while. */
export function isQuiet(rows: readonly SideChat[], now: number): boolean {
  return rows.every((r) => r.phase === "done" || (r.phase === "ready" && !r.unread)) && rows.every((r) => now - r.at > QUIET_AFTER);
}

function section(kind: SectionKind, key: string, title: string, rows: readonly SideChat[], f: Folds, here: Here, cut: number | null, startsShut = false): Section {
  const all = f.expanded.includes(key);
  const { shown, hidden } = cut === null ? { shown: rows, hidden: 0 } : cutOff(rows, cut, all, here.chat);
  return { key, kind, title, total: rows.length, rows: shown, hidden, all, cut, shut: isShut(f, key, startsShut), startsShut };
}

/**
 * the compact layout: Pinned (in the board's order, so pins hold still), then a folder per project with the chats not
 * pinned, the one with the newest activity first, and each folder's chats newest first; then Recent, every chat
 * newest first. A project with nothing going on for a while starts folded.
 */
export function projectsView(chats: readonly SideChat[], f: Folds, here: Here, now: number): Section[] {
  const out: Section[] = [];
  const pinned = chats.filter((c) => c.pinned);
  if (pinned.length) out.push(section("pinned", "pinned", "Pinned", pinned, f, here, null));
  const byRepo = new Map<string, SideChat[]>();
  for (const chat of chats) {
    if (chat.pinned) continue;
    const list = byRepo.get(chat.repo) ?? [];
    list.push(chat);
    byRepo.set(chat.repo, list);
  }
  const projects = [...byRepo.entries()].map(([repo, rows]) => ({ repo, rows: [...rows].sort(newestFirst) }));
  projects.sort((a, b) => (b.rows[0]?.at ?? 0) - (a.rows[0]?.at ?? 0));
  for (const p of projects) out.push(section("project", `project:${p.repo}`, p.repo, p.rows, f, here, CUT.project, isQuiet(p.rows, now)));
  if (chats.length) out.push(section("recent", "recent", "Recent", [...chats].sort(newestFirst), f, here, CUT.recent));
  return out;
}

// ---------------------------------------------------------------- the queue

/**
 * upstream sidebar sorted by state (Sidebar.logic.ts resolveSidebarThreadSection, the desktop's queueSections): Pinned;
 * then the queue, what asks first and the oldest ask first, then what is ready, new before looked-at; then the shelves:
 * Working (by when it started, so rows hold still while lines land), Snoozed (the next to wake first) and Done (the
 * newest first, ten before "Load more"). Snoozed and Done start folded (shell/drawer.ts).
 */
export function queueView(chats: readonly SideChat[], f: Folds, here: Here): Section[] {
  const pinned: SideChat[] = [];
  const asks: SideChat[] = [];
  const ready: SideChat[] = [];
  const working: SideChat[] = [];
  const snoozed: SideChat[] = [];
  const settled: SideChat[] = [];
  for (const chat of chats) {
    if (chat.snoozedUntil !== null) snoozed.push(chat);
    else if (chat.done) settled.push(chat);
    else if (chat.pinned) pinned.push(chat);
    else if (chat.phase === "needs") asks.push(chat);
    else if (chat.phase === "working") working.push(chat);
    else ready.push(chat);
  }
  asks.sort((a, b) => a.askedAt - b.askedAt);
  ready.sort((a, b) => Number(b.unread) - Number(a.unread) || b.at - a.at);
  working.sort((a, b) => b.since - a.since);
  snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  settled.sort((a, b) => b.doneAt - a.doneAt);
  const out: Section[] = [];
  if (pinned.length) out.push(section("pinned", "pinned", "Pinned", pinned, f, here, null));
  const queue = [...asks, ...ready];
  // What waits on you never folds away.
  if (queue.length) out.push({ ...section("queue", "queue", "Queue", queue, f, here, null), shut: false });
  if (working.length) out.push(section("working", "shelf:working", "Working", working, f, here, null));
  if (snoozed.length) out.push(section("snoozed", "shelf:snoozed", "Snoozed", snoozed, f, here, null));
  if (settled.length) out.push(section("settled", "shelf:settled", "Done", settled, f, here, CUT.settled));
  return out;
}

/**
 * A queue row's state word and its tone (upstream row labels): Ready says nothing, its check already does, and a shelf
 * that says the word in its head (Working, Done) doesn't say it again on every row.
 */
export function stateWord(row: Pick<SideChat, "phase" | "pr">, shelf?: SectionKind): { word: string; tone: "needs" | "quiet" } | null {
  if (row.phase === "needs") return { word: "Needs you", tone: "needs" };
  if (row.phase === "working") return shelf === "working" ? null : { word: "Working", tone: "quiet" };
  if (row.phase === "done") return row.pr?.state === "merged" ? { word: "Merged", tone: "quiet" } : shelf === "settled" ? null : { word: "Done", tone: "quiet" };
  return null;
}

/** What a screen reader hears for a row: its title and its state, and whether it is new. */
export function spokenRow(row: Pick<SideChat, "title" | "phase" | "unread" | "agents" | "fate">): string {
  // A builder's state is what became of it, in its own words; one that asks still says so first.
  const state = row.phase === "needs" ? "Needs you" : (row.fate?.words ?? (row.phase === "working" ? "Working" : row.phase === "ready" ? "Ready" : "Done"));
  const agents = row.agents.length ? `${row.agents.length} ${kidsWord(row.agents.length, "subagent")}` : "";
  return [row.title, state, row.unread ? "Unread" : "", agents].filter(Boolean).join(", ");
}
