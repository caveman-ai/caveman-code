// What screens read from the store, derived in one place so every count agrees: the counts across every Chief, the
// Chiefs list, the workspaces and devices, a filtered list of chats, subagents and their parent, and search. A chat's status is
// `phaseOf` and nothing else: a subagent's ask lights up its parent, and subagents are never rows of their own (they
// are reached from their parent). Each selector is remembered by the identity of the slices it reads, so reading it
// on every render costs nothing until a chat moves; the `use…` hooks re-render only when the answer changes.
import { type Chat, type Chief, CHIEFS, chiefById, chiefForRepo, chiefOf, type Device, DEVICES, deviceById, ENGINE_NAME, type Need, type Phase, PROJECTS } from "../board/model";
import { PLAIN_ASK, saysOnly } from "./asked";
import { memoLast, shallow } from "./core";
import { type AppState, store, useStore } from "./store";

/** Most urgent first: what needs you, what is ready to try, what is at work, what is over. */
export const URGENCY: Readonly<Record<Phase, number>> = { needs: 0, ready: 1, working: 2, done: 3 };

// ---------------------------------------------------------------- one status

/** Each chat's subagents, by parent id. */
const childIndex = memoLast((chats: readonly Chat[]) => {
  const index = new Map<string, Chat[]>();
  for (const chat of chats) {
    if (!chat.parent) continue;
    const list = index.get(chat.parent) ?? [];
    list.push(chat);
    index.set(chat.parent, list);
  }
  return index;
});

/**
 * A chat's status, everywhere: its own phase, raised by its subagents. A subagent that needs you makes the parent need
 * you; one still at work keeps a resting parent working.
 */
export function phaseOf(chat: Chat, chats: readonly Chat[] = store.get().board.chats): Phase {
  const children = childIndex(chats).get(chat.id);
  if (!children?.length || chat.phase === "needs") return chat.phase;
  const kids = children.map((c) => phaseOf(c, chats));
  if (kids.includes("needs")) return "needs";
  if (chat.phase !== "working" && kids.includes("working")) return "working";
  return chat.phase;
}

const NONE: readonly Chat[] = [];

/** A chat's subagents, in the order they were spawned. */
export const childrenOf = (s: AppState, id: string): readonly Chat[] => childIndex(s.board.chats).get(id) ?? NONE;

/** A subagent's parent, or null for a chat of its own. */
export function parentOf(s: AppState, id: string): Chat | null {
  const parent = s.board.chats.find((c) => c.id === id)?.parent;
  return (parent && s.board.chats.find((c) => c.id === parent)) || null;
}

export const chatOf = (s: AppState, id: string): Chat | undefined => s.board.chats.find((c) => c.id === id);

// ---------------------------------------------------------------- one ask

/**
 * The chat that asks, for a chat that needs you: the chat itself, or the subagent under it whose ask lit it up (a
 * parent needs you when a child does, phaseOf above).
 */
export function askerOf(chat: Chat, chats: readonly Chat[] = store.get().board.chats, depth = 0): Chat {
  if (chat.phase === "needs" || depth > 6) return chat;
  for (const kid of chats) {
    if (kid.parent !== chat.id) continue;
    const found = askerOf(kid, chats, depth + 1);
    if (found.phase === "needs") return found;
  }
  return chat;
}

/**
 * An ask as the one question every screen asks it with, in the person's verb: "Deploy the site to production?", "Add
 * react-native-keyboard-controller?". An engine's own "wants to deploy…" becomes the question; words that already
 * ask stay as they are; a bare command becomes "Run <command>?".
 */
export function questionOf(asker: Pick<Chat, "line" | "ask">): string {
  const words = (asker.line ?? "").trim();
  const wants = /^wants to\s+(.+?)[.?]?$/i.exec(words);
  if (wants) return `${wants[1]!.charAt(0).toUpperCase()}${wants[1]!.slice(1)}?`;
  if (words) return /[?]$/.test(words) ? words : `${words}?`;
  return asker.ask ? `Run ${asker.ask}?` : "Run this command?";
}

/** A subagent by the part of its title that names it ("Audit: the composer" is "the composer"). */
export function childName(child: Pick<Chat, "title">): string {
  const at = child.title.indexOf(": ");
  return at > 0 ? child.title.slice(at + 2) : child.title;
}

/** The longest a short ask runs, so it fits line 2 of a row whole beside where the chat lives. */
export const SHORT_ASK = 28;

/**
 * An ask in at most 28 characters, the verb and the kind of thing it acts on ("Add a package?", "Deploy to
 * production?", "Run a staging migration?"), and the thing itself apart (`object`: the package, the target), which only
 * the command chip and the Needs you list's mono line spell out. Read from the command when there is one, else the
 * question as it is when it is short enough, else its first words cut at a word. An ask whose words are only its
 * command again ("echo smoke?") reads "Run this command?".
 */
export function shortAsk(asker: Pick<Chat, "line" | "ask">, command: string | null = asker.ask ?? null): { ask: string; object: string | null } {
  const full = questionOf(asker);
  const cmd = (command ?? "").trim();
  if (cmd) {
    const words = cmd.split(/\s+/);
    const tool = words[0] ?? "";
    const where = /\bstaging\b/.test(cmd) ? "staging" : /--prod\b|\bprod(uction)?\b/.test(cmd) ? "production" : null;
    const adding = /^(pnpm|npm|yarn|bun|npx)$/.test(tool) && words.some((w) => w === "add" || w === "install" || w === "i");
    if (adding) {
      const verb = words.findIndex((w) => w === "add" || w === "install" || w === "i");
      const pkgs = words.slice(verb + 1).filter((w) => !w.startsWith("-"));
      return { ask: pkgs.length > 1 ? "Add packages?" : "Add a package?", object: pkgs.join(" ") || null };
    }
    if (/\bdeploy\b/.test(cmd)) return { ask: where ? `Deploy to ${where}?` : "Deploy the site?", object: where };
    if (/migrat/.test(cmd)) return { ask: where ? `Run a ${where} migration?` : "Run a migration?", object: where };
    if (/^git\s+push\b/.test(cmd)) {
      const branch = words.filter((w) => !w.startsWith("-")).slice(3)[0] ?? null;
      const ask = branch ? `Push to ${branch}?` : "Push the branch?";
      return { ask: ask.length <= SHORT_ASK ? ask : "Push the branch?", object: branch };
    }
    if (/^(rm|git\s+clean)\b/.test(cmd)) return { ask: "Delete files?", object: null };
    if (/\b(test|vitest|jest|e2e|soak)\b/.test(cmd)) return { ask: "Run the tests?", object: null };
    // A bare command is never its own title: the command chip prints it, once (asked.ts).
    if (saysOnly(full, cmd)) return { ask: PLAIN_ASK, object: null };
    if (full.length <= SHORT_ASK) return { ask: full, object: null };
    return { ask: "Run a command?", object: tool || null };
  }
  if (full.length <= SHORT_ASK) return { ask: full, object: null };
  // A question with no command, cut at a word (never inside a number, a path or a name) and asked again.
  const cut = full.slice(0, SHORT_ASK - 2).replace(/\s+\S*$/, "");
  return { ask: `${cut}…?`, object: null };
}

/** Words as a summary says them: no markdown, no chat references, one space between words. */
const flat = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/\[\[[^\]]+\]\]/g, "it").replace(/\s+/g, " ").trim();

/** The first sentence or two of what it said last while it worked, for an ask that came without a summary. */
function lastSaid(chat: Chat): string {
  const said = chat.items.findLast((i): i is Extract<Chat["items"][number], { kind: "text" }> => i.kind === "text");
  if (!said) return "";
  const sentences = flat(said.text).match(/[^.!?]+[.!?]+/g) ?? [flat(said.text)];
  return sentences.slice(0, 2).join(" ").trim();
}

/**
 * What a chat that asks waits on you for (board/model.ts Need): its own, or for a chat from before asks carried one (read
 * back from disk), its command as an approval, summed up by what it said last. Null when it doesn't ask.
 */
export function needOf(asker: Chat): Need | null {
  if (asker.phase !== "needs") return null;
  if (asker.need) return asker.need;
  const open = asker.items.findLast((i): i is Extract<Chat["items"][number], { kind: "ask" }> => i.kind === "ask" && !i.answer);
  const command = asker.ask ?? (open?.command || null);
  const summary = lastSaid(asker);
  if (command) return { kind: "approval", command, summary, at: asker.updatedAt };
  if (open?.question) return { kind: "question", question: open.question, options: [], summary, at: asker.updatedAt };
  return null;
}

export interface Ask {
  /**
   * The ask, short ("Add a package?"), the same on Home, the lists, Search, the sheets, the dock's title and the Chief:
   * at most 28 characters (shortAsk).
   */
  question: string;
  /** The ask in full, as the transcript's waiting line says it ("Add react-native-keyboard-controller?"). */
  full: string;
  /** What it acts on, apart from the short ask: the package, the target ("production"), when there is one. */
  object: string | null;
  /** What Allow lets run, when the ask is a command. */
  command: string | null;
  /** Who asks, when it is a subagent: said after the question in the tertiary grey ("· the composer"). */
  by: string | null;
  asker: Chat;
  /** What it waits on, in full: the approval or the question with its options, and what it did so far. */
  need: Need | null;
}

/** A chat's ask, worded once: what its asker wants, the command, and which subagent it is, if one. */
export function askOf(chat: Chat, chats: readonly Chat[] = store.get().board.chats): Ask {
  const asker = askerOf(chat, chats);
  const command = asker.ask ?? asker.items.findLast((i): i is Extract<Chat["items"][number], { kind: "ask" }> => i.kind === "ask" && !i.answer)?.command ?? null;
  const short = shortAsk(asker, command);
  return { question: short.ask, full: questionOf(asker), object: short.object, command, by: asker.id !== chat.id ? childName(asker) : null, asker, need: needOf(asker) };
}

// ---------------------------------------------------------------- line 2

/** Line 2 of a chat's row, in parts (DECISIONS.md O7), the same in a list, a sheet and a card. */
export interface LineTwo {
  /** What is going on: the short ask, the live sentence (no counts), how it ended; empty for Ready, whose diff says it. */
  said: string;
  /** Ready only: lines added and removed. */
  diff: { add: number; del: number } | null;
  /** Where it lives. */
  where: string;
  /** Its computer, only when it isn't where these chats usually run, or is asleep or offline. */
  device: string | null;
}

/** Counts a live sentence may carry ("+61 −4"): Working says what it is doing, never how big. */
const COUNTS = /\s*[·,]?\s*[+]\d+\s*[−-]\d+\b/g;

/**
 * Line 2 of a chat, worded once for every row that shows one (ChatRow, the thread's and the Chief's agents sheets, the
 * Chief's Ready card): Ready is "+38 −12 · workspace", Working the live sentence with no counts, Needs you the short
 * ask, Done how it ended; the device only when it isn't `usual` (where these chats usually run) or is away.
 */
export function lineTwo(chat: Chat, phase: Phase, usual: string, chats: readonly Chat[] = store.get().board.chats): LineTwo {
  const device = deviceById(chat.device);
  const away = device.status === "asleep" || device.status === "offline";
  const shown = away || chat.device !== usual ? device.name : null;
  if (phase === "ready") {
    const sum = chat.moment ? chat.moment.files.reduce((n, f) => ({ add: n.add + f.add, del: n.del + f.del }), { add: 0, del: 0 }) : null;
    return { said: "", diff: sum && (sum.add || sum.del) ? sum : null, where: chat.repo, device: shown };
  }
  if (phase === "needs") return { said: askOf(chat, chats).question, diff: null, where: chat.repo, device: shown };
  if (phase === "working") return { said: (chat.line ?? "").replace(COUNTS, "").trim() || "Working", diff: null, where: chat.repo, device: shown };
  return { said: /^Merged\b/.test(chat.line) ? chat.line : "Done", diff: null, where: chat.repo, device: shown };
}

// ---------------------------------------------------------------- rows

/** A row: a chat that is not a subagent and not archived, with its status. */
export interface Row {
  chat: Chat;
  phase: Phase;
  /** The Chief that started it, or null for one of your own (Home's "Your chats"). */
  chief: string | null;
}

// A row keeps its identity while its chat and status do, so a list whose rows didn't move is the same list.
const rowCache = new WeakMap<Chat, Row>();

/** Every row, in board order. The base of every list and count below. */
export const rows = memoLast((chats: readonly Chat[], archived: Readonly<Record<string, true>>): readonly Row[] =>
  chats
    .filter((c) => !c.parent && !archived[c.id])
    .map((chat) => {
      const phase = phaseOf(chat, chats);
      const chief = chiefOf(chat);
      const was = rowCache.get(chat);
      if (was?.phase === phase && was.chief === chief) return was;
      const row = { chat, phase, chief };
      rowCache.set(chat, row);
      return row;
    }),
);
const rowsOf = (s: AppState) => rows(s.board.chats, s.inbox.archived);

/** Who a chat is on, by name: its Chief's, or "you" for one of your own. */
const chiefNameOf = (chat: Chat) => {
  const id = chiefOf(chat);
  return id ? chiefById(id).name : "you";
};

const chiefOrder = (ids: Iterable<string | null>) => {
  const set = new Set(ids);
  return CHIEFS.filter((c) => set.has(c.id)).map((c) => c.id);
};

// ---------------------------------------------------------------- at work

/**
 * At work, as Working counts it: a working chat on a device that is asleep or offline isn't (DECISIONS.md Home 6): it
 * reads "Waiting for Studio" and waits, so no Working tile, Chief, workspace or device line counts it.
 */
export function atWork(r: Row): boolean {
  if (r.phase !== "working") return false;
  const status = deviceById(r.chat.device).status;
  return status !== "asleep" && status !== "offline";
}

// ---------------------------------------------------------------- seen

/** What the inbox knows of what you've looked at: the phase each chat was in when you saw it, and hand-made unreads. */
export interface Seen {
  seen: Readonly<Record<string, Phase>>;
  unread: Readonly<Record<string, true>>;
}
const NOTHING_SEEN: Seen = { seen: {}, unread: {} };

/**
 * Ready counts only what you haven't looked at (SPEC: Ready is unseen): opening a Ready chat, or Mark all seen, takes
 * it out of every Ready count. A seen one is still ready (it isn't Done until it ships or is archived), so the lists
 * keep it, folded under "Seen".
 */
export function unseenReady(r: Row, seen: Seen = NOTHING_SEEN): boolean {
  return r.phase === "ready" && (!!seen.unread[r.chat.id] || seen.seen[r.chat.id] !== "ready");
}

/**
 * The ready rows among `rows`, as the two numbers they are: `unseen`, the only one any live count labelled "ready"
 * shows (Home, a Chief's row and capsule, the agents sheets, the Ready page), and `seen`, ready but looked at, which
 * keeps its place folded under "Seen" until it ships or is archived.
 */
export function readyOf(rows: readonly Row[], seen: Seen = NOTHING_SEEN): { unseen: number; seen: number } {
  let unseen = 0;
  let looked = 0;
  for (const r of rows) {
    if (r.phase !== "ready") continue;
    if (unseenReady(r, seen)) unseen++;
    else looked++;
  }
  return { unseen, seen: looked };
}

// ---------------------------------------------------------------- Home

export type TileKey = "needs" | "working" | "ready" | "all";
export interface Tile {
  key: TileKey;
  count: number;
  /** The Chiefs whose chats are in it, in the Chiefs' order: the sprites the tile stacks. */
  chiefs: readonly string[];
}

/**
 * The counts across every Chief (the console's and home/reconcile.test.ts's check): what needs you, what is at work,
 * what is ready, and everything.
 */
export const tiles = memoLast((all: readonly Row[], seen: Seen = NOTHING_SEEN): Record<TileKey, Tile> => {
  const tile = (key: TileKey, keep: (r: Row) => boolean): Tile => {
    const list = all.filter(keep);
    return { key, count: list.length, chiefs: chiefOrder(list.map((r) => r.chief)) };
  };
  return {
    needs: tile("needs", (r) => r.phase === "needs"),
    working: tile("working", atWork),
    ready: tile("ready", (r) => unseenReady(r, seen)),
    all: tile("all", () => true),
  };
});
export const tilesOf = (s: AppState) => tiles(rowsOf(s), s.inbox);

/** "1 needs you · 2 working", or null when nothing is going on. */
export function countsLine(c: { needs: number; ready: number; working: number }): string | null {
  const parts = [c.needs ? `${c.needs} ${c.needs === 1 ? "needs" : "need"} you` : "", c.ready ? `${c.ready} ready` : "", c.working ? `${c.working} working` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export interface ChiefRow {
  chief: Chief;
  needs: number;
  ready: number;
  working: number;
  total: number;
  /** What it is doing right now (its thought bubble), if anything. */
  thinking: string | null;
  /** Ready and already looked at: not in any "ready" count, still waiting to ship. */
  seenReady: number;
  /** Its live line: its thought, else its counts, else "All quiet". */
  line: string;
  /** When something last happened on its board. */
  updatedAt: number;
}

/** The Chiefs, in order, each with its counts and its live line. */
export const chiefList = memoLast((all: readonly Row[], thinking: Readonly<Record<string, string>>, seen: Seen = NOTHING_SEEN): readonly ChiefRow[] =>
  CHIEFS.map((chief) => {
    const mine = all.filter((r) => r.chief === chief.id);
    const ready = readyOf(mine, seen);
    const counts = { needs: mine.filter((r) => r.phase === "needs").length, ready: ready.unseen, working: mine.filter(atWork).length };
    const thought = thinking[chief.id] ?? null;
    return { chief, ...counts, seenReady: ready.seen, total: mine.length, thinking: thought, line: thought ?? countsLine(counts) ?? "All quiet", updatedAt: Math.max(0, ...mine.map((r) => r.chat.updatedAt)) };
  }),
);
export const chiefListOf = (s: AppState) => chiefList(rowsOf(s), s.board.thinking, s.inbox);

export interface WorkspaceRow {
  name: string;
  /** The Chief that watches it: the one that would start a chat there. */
  chief: string;
  total: number;
  needs: number;
  ready: number;
  working: number;
  /** Its most urgent chat's status, or null with no chats. */
  status: Phase | null;
  updatedAt: number;
}

/** The projects (each one Home calls a workspace), with their counts and most urgent status, in PROJECTS order. */
export const workspaces = memoLast((all: readonly Row[], seen: Seen = NOTHING_SEEN): readonly WorkspaceRow[] => {
  // A project added on the phone is a workspace as soon as a chat runs in it.
  const names = [...new Set<string>([...PROJECTS, ...all.map((r) => r.chat.repo)])];
  return names.map((name) => {
    const mine = all.filter((r) => r.chat.repo === name);
    const n = (p: Phase) => mine.filter((r) => (p === "ready" ? unseenReady(r, seen) : p === "working" ? atWork(r) : r.phase === p)).length;
    const status = mine.reduce<Phase | null>((most, r) => (most === null || URGENCY[r.phase] < URGENCY[most] ? r.phase : most), null);
    return { name, chief: chiefForRepo(name), total: mine.length, needs: n("needs"), ready: n("ready"), working: n("working"), status, updatedAt: Math.max(0, ...mine.map((r) => r.chat.updatedAt)) };
  });
});
export const workspacesOf = (s: AppState) => workspaces(rowsOf(s), s.inbox);

export interface DeviceRow {
  device: Device;
  total: number;
  needs: number;
  working: number;
}

/** Every device, with how many chats run on it and how many work or need you. */
export const devices = memoLast((all: readonly Row[]): readonly DeviceRow[] =>
  DEVICES.map((device) => {
    const mine = all.filter((r) => r.chat.device === device.id);
    return { device, total: mine.length, needs: mine.filter((r) => r.phase === "needs").length, working: mine.filter(atWork).length };
  }),
);
export const devicesOf = (s: AppState) => devices(rowsOf(s));

// ---------------------------------------------------------------- lists

export type ListFilter = Phase | "all";
export interface ListQuery {
  filter: ListFilter;
  chief?: string;
  workspace?: string;
  device?: string;
}

/** Most urgent first (needs, ready, working), the rest by what happened last. */
const byUrgency = (a: Row, b: Row) => {
  const ua = a.phase === "done" ? 3 : URGENCY[a.phase];
  const ub = b.phase === "done" ? 3 : URGENCY[b.phase];
  return ua - ub || b.chat.updatedAt - a.chat.updatedAt;
};

const lists = new Map<string, { all: readonly Row[]; value: readonly Row[] }>();

/** The rows a list shows, in order. The same array comes back until one of its rows changes. */
export function listOf(s: AppState, q: ListQuery): readonly Row[] {
  const all = rowsOf(s);
  const key = `${q.filter}|${q.chief ?? ""}|${q.workspace ?? ""}|${q.device ?? ""}`;
  const was = lists.get(key);
  if (was?.all === all) return was.value;
  const value = all
    .filter((r) => (q.filter === "all" || r.phase === q.filter) && (!q.chief || r.chief === q.chief) && (!q.workspace || r.chat.repo === q.workspace) && (!q.device || r.chat.device === q.device))
    .sort(byUrgency);
  const same = was && shallow(was.value, value) ? was.value : value;
  lists.set(key, { all, value: same });
  return same;
}

// ---------------------------------------------------------------- the asks, in one order

export interface Asking {
  row: Row;
  /** The chat that asks: the row's own, or the subagent under it whose ask lit it up. */
  asker: Chat;
  /** When it started waiting on you: when it asked, so an ask taken back with Undo is in its old place again. */
  since: number;
}

/** An ask in full, as a summary card shows it (src/asks): the row it lights up, who asks, and what it waits on. */
export interface AskView extends Asking {
  need: Need;
}

const queues = new Map<string, { all: readonly Row[]; since: object; value: readonly Asking[] }>();

/**
 * Every ask waiting on you, the longest-waiting first: the one order the Needs you list, Search's Needs you, the
 * collapsed bar's sprites and the fleet-wide Next ("1 of 2") all use, so the same asks never read in three orders.
 */
export function askQueue(s: AppState): readonly Asking[] {
  const all = rowsOf(s);
  const was = queues.get("all");
  if (was && was.all === all && was.since === s.inbox.since) return was.value;
  const value = all
    .filter((r) => r.phase === "needs")
    .map((row) => {
      const asker = askerOf(row.chat, s.board.chats);
      return { row, asker, since: asker.need?.at ?? s.inbox.since[row.chat.id] ?? row.chat.updatedAt ?? row.chat.startedAt };
    })
    .sort((a, b) => a.since - b.since);
  queues.set("all", { all, since: s.inbox.since, value });
  return value;
}

const viewsOf = memoLast((queue: readonly Asking[]): readonly AskView[] =>
  queue.flatMap((a) => {
    const need = needOf(a.asker);
    return need ? [{ ...a, need }] : [];
  }),
);

/**
 * Every ask waiting on you in full, the longest-waiting first (askQueue's one order): what the summary cards show, on
 * the Queue, the Needs you list and a Chief's deck. An ask answered leaves it at once; one taken back with Undo comes
 * back in its place.
 */
export const asksOf = (s: AppState): readonly AskView[] => viewsOf(askQueue(s));

// ---------------------------------------------------------------- search

export interface SearchHit {
  chat: Chat;
  phase: Phase;
  /** Where it matched: the title, where it is (project, Chief, device, engine), or something said in it. */
  field: "title" | "place" | "message";
  /** The message it matched in, to open the chat there. */
  itemId?: string;
  /** The words around the match, the match itself apart so it can be marked. */
  snippet?: { before: string; match: string; after: string };
}

const plain = (text: string) => text.replace(/\*\*|__|`|\[\[[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim();

function snippetOf(text: string, word: string): SearchHit["snippet"] {
  const flat = plain(text);
  const at = flat.toLowerCase().indexOf(word);
  if (at < 0) return undefined;
  const start = Math.max(0, at - 36);
  const end = Math.min(flat.length, at + word.length + 64);
  // Cut at a word, never through one.
  const before = start > 0 ? `…${flat.slice(start, at).replace(/^\S*\s/, "")}` : flat.slice(0, at);
  const after = flat.slice(at + word.length, end) + (end < flat.length ? "…" : "");
  return { before, match: flat.slice(at, at + word.length), after };
}

/** What a chat says, newest first: its live line, your messages, its words, the commands it asked to run, its steps. */
function sayings(chat: Chat): { id?: string; text: string }[] {
  const out: { id?: string; text: string }[] = chat.line ? [{ text: chat.line }] : [];
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const item = chat.items[i]!;
    if (item.kind === "you" || item.kind === "text") out.push({ id: item.id, text: item.text });
    else if (item.kind === "ask") out.push({ id: item.id, text: item.question ?? item.command });
    else if (item.kind === "work") for (const step of item.steps) out.push({ id: item.id, text: `${step.text} ${step.detail ?? ""}` });
  }
  return out;
}

const searches = new Map<string, { chats: readonly Chat[]; archived: object; titles: object; value: readonly SearchHit[] }>();

/**
 * Chats that match every word of `query`: by title first, then by where they are, then by something said in them
 * (with the words around it). Subagents are found too; their `parent` says where they live. Most urgent first within
 * each kind of match.
 */
export function search(s: AppState, query: string): readonly SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const was = searches.get(q);
  // A rename changes what a title matches, so the names you gave are part of what a remembered answer was made from.
  if (was && was.chats === s.board.chats && was.archived === s.inbox.archived && was.titles === s.inbox.titles) return was.value;
  const words = q.split(/\s+/);
  const all = s.board.chats.filter((c) => !s.inbox.archived[c.id]);
  const hits: (SearchHit & { rank: number })[] = [];
  for (const chat of all) {
    const phase = phaseOf(chat, s.board.chats);
    const title = (s.inbox.titles[chat.id] ?? chat.title).toLowerCase();
    if (words.every((w) => title.includes(w))) {
      // A word that starts the title, or a word in it, beats a match inside a word.
      const start = title.startsWith(words[0]!) || title.includes(` ${words[0]}`);
      hits.push({ chat, phase, field: "title", rank: start ? 0 : 1 });
      continue;
    }
    const place = `${title} ${chat.repo} ${chiefNameOf(chat)} ${deviceById(chat.device).name} ${ENGINE_NAME[chat.engine]} ${chat.model}`.toLowerCase();
    if (words.every((w) => place.includes(w))) {
      hits.push({ chat, phase, field: "place", rank: 2 });
      continue;
    }
    // A message that says every word beats one that leans on where the chat is for some of them.
    const lines = sayings(chat);
    const said =
      lines.find((x) => words.every((w) => x.text.toLowerCase().includes(w))) ??
      lines.find((x) => {
        const text = x.text.toLowerCase();
        return words.every((w) => text.includes(w) || place.includes(w)) && words.some((w) => text.includes(w));
      });
    if (said) {
      // The snippet marks the longest word the message says: "composer", not "the".
      const text = said.text.toLowerCase();
      const word = words.filter((w) => text.includes(w)).sort((a, b) => b.length - a.length)[0] ?? words[0]!;
      hits.push({ chat, phase, field: "message", itemId: said.id, snippet: snippetOf(said.text, word), rank: 3 });
    }
  }
  const value = hits
    .sort((a, b) => a.rank - b.rank || URGENCY[a.phase] - URGENCY[b.phase] || b.chat.updatedAt - a.chat.updatedAt)
    .map(({ rank: _, ...hit }) => hit);
  if (searches.size > 20) searches.clear();
  searches.set(q, { chats: s.board.chats, archived: s.inbox.archived, titles: s.inbox.titles, value });
  return value;
}

// ---------------------------------------------------------------- hooks

/** Lists of flat records with the same members: a count that didn't move doesn't re-render. */
const sameEach = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => shallow(x, b[i]));

export const useRows = () => useStore(rowsOf);
export const useChiefList = () => useStore(chiefListOf, sameEach);
export const useWorkspaces = () => useStore(workspacesOf, sameEach);
export const useDevices = () => useStore(devicesOf, sameEach);
/** A list's rows; re-renders only when its membership, order or one of its chats changes. */
export const useList = (q: ListQuery) => useStore((s) => listOf(s, q));
export const useSearch = (query: string) => useStore((s) => search(s, query));
export const useAskQueue = () => useStore(askQueue);
/** One chat, re-rendered only when that chat changes. */
export const useChat = (id: string | null | undefined) => useStore((s) => (id ? chatOf(s, id) : undefined));
export const useChildren = (id: string) => useStore((s) => childrenOf(s, id));
export const useParent = (id: string) => useStore((s) => parentOf(s, id));
