// Desktop notifications for the stored Settings.notifications: a session that
// needs you (a question or an approval), a session that finished, a Chief's
// reply and a Chief's item that waits on you. Shown only while the app is in the
// background; the inbox and the sidebar already say it in the foreground. The
// desktop's Dock badge counts what was posted since the app was last in front.
// Modelled on upstream ThreadNotificationCoordinator.

import type { Client } from "@caveman-app/session-protocol/client";
import type { ChiefItem, Settings, Workspace } from "@caveman-app/session-protocol";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { plainRefs, workTitle, WORK_REF_PATTERN } from "../routes/chief/work-model.ts";
import { chiefPath, useChiefs, type ChiefLatest } from "./chiefs.ts";
import { useChatList, useRuntimeClient, useRuntimeSelector, useSyncHub } from "./runtime.tsx";
import { noticeable } from "./sync/chats-view.ts";

export interface WorkspaceNotice {
  readonly title: string;
  readonly body: string;
}

/** A notice as posted: `tag` makes a newer one with the same tag replace it; a click opens `path`. */
export interface PostedNotice extends WorkspaceNotice {
  readonly tag: string;
  readonly path: string;
  /** A Chief's word about one of its chats (its tag is that chat's): it speaks for the chat (`yields`). */
  readonly chief?: true;
  /** A chat's Finished or Stopped: under its tag, a Chief's word about that chat stays, and this says nothing. */
  readonly yields?: true;
}

/** Notices posted as a Chief's word about one of its chats. */
const chiefsWord = new WeakSet<Notification>();

const RUNNING = new Set<Workspace["status"]>(["starting", "working", "waiting"]);

/** A chat that speaks for another (a delegated agent's lead, the chat whose Mac mail another runs) is at work. */
const atWork = (w: Workspace | undefined) => w !== undefined && (RUNNING.has(w.status) || w.status === "needs_input");

/**
 * What a status change says to someone away from the app, or null when it says nothing. `lead`: a delegated
 * agent's lead, as the list has it now. `asker`: for a chat running mail from a chat on another of the person's Macs
 * (asked_by_session_id), that chat, as the list has it now.
 */
export function noticeFor(before: Workspace | undefined, after: Workspace, settings: Settings["notifications"], lead?: Workspace, asker?: Workspace): WorkspaceNotice | null {
  // Nothing on first sight (the app just opened), nor for the Chief's own workspace, which workspace.changed pushes
  // carry but the list leaves out: chiefNotices speaks for it.
  if (!before || after.kind !== undefined) return null;
  // A lead's agents, and a chat running another Mac's chat's mail (decision 33): the chat they work for speaks for them,
  // except one that waits on the person while that chat is not at work. Neither can answer an approval for it, and a
  // chat that has stopped answers nothing. Never "Finished": that chat says how the work went.
  const speaker = after.parent_workspace_id ? lead : after.asked_by_session_id ? asker : undefined;
  if (after.parent_workspace_id || after.asked_by_session_id) {
    if (atWork(speaker) || after.status !== "needs_input" || before.status === "needs_input" || !settings.needs_input) return null;
    if (speaker === undefined) return { title: "Needs you", body: after.title };
    return { title: "Needs you", body: `${after.title} · ${after.parent_workspace_id ? "agent of" : "asked by"} ${speaker.title}` };
  }
  if (after.status === "needs_input" && before.status !== "needs_input")
    return settings.needs_input ? { title: "Needs you", body: after.title } : null;
  // A turn that ended while work that will wake it still runs (activity.awaiting) has not finished the chat's work. It
  // finishes when that work settles without waking it (a watched pull request merged): that is its Finished.
  if (RUNNING.has(before.status) && after.status === "idle" && after.activity?.awaiting) return null;
  if (before.status === "idle" && before.activity?.awaiting && after.status === "idle" && !after.activity?.awaiting)
    return settings.turn_done ? { title: "Finished", body: after.title } : null;
  if (RUNNING.has(before.status) && (after.status === "idle" || after.status === "failed"))
    return settings.turn_done ? { title: after.status === "failed" ? "Stopped with an error" : "Finished", body: after.title } : null;
  return null;
}

const away = () => document.visibilityState !== "visible" || !document.hasFocus();

/** What changed between two views of the chats, one notice per chat whose status moved (noticeFor). */
export function noticesBetween(before: ReadonlyMap<string, Workspace>, after: ReadonlyMap<string, Workspace>, settings: Settings["notifications"]): Array<{ readonly workspace: Workspace; readonly notice: WorkspaceNotice }> {
  const out: Array<{ readonly workspace: Workspace; readonly notice: WorkspaceNotice }> = [];
  for (const w of after.values()) {
    const notice = noticeFor(before.get(w.id), w, settings, w.parent_workspace_id ? after.get(w.parent_workspace_id) : undefined, askerOf(after, w));
    if (notice) out.push({ workspace: w, notice });
  }
  return out;
}

/** The chat on another of the person's Macs whose mail `w` runs (asked_by_session_id), when the list has it. */
function askerOf(workspaces: ReadonlyMap<string, Workspace>, w: Workspace): Workspace | undefined {
  if (!w.asked_by_session_id) return undefined;
  for (const other of workspaces.values()) if (other.session_id === w.asked_by_session_id) return other;
  return undefined;
}

/**
 * Posts notices while the app is away, each replacing the one posted before it with its tag, and badges the Dock with
 * how many are up; clicking one brings the window back and opens its page.
 */
export function post(notices: ReadonlyArray<PostedNotice>, shown: Map<string, Notification>, open: (path: string) => void): void {
  if (notices.length === 0 || typeof Notification === "undefined" || Notification.permission !== "granted" || !away()) return;
  const count = shown.size;
  for (const notice of notices) {
    const held = shown.get(notice.tag);
    if (notice.yields && held !== undefined && chiefsWord.has(held)) continue;
    try {
      held?.close();
      const n = new Notification(notice.title, { body: notice.body, tag: notice.tag, silent: true });
      shown.set(notice.tag, n);
      if (notice.chief) chiefsWord.add(n);
      n.addEventListener("click", () => {
        n.close();
        // The desktop window may be closed (hidden): only the shell can bring it back.
        window.cavemanDesktop?.showWindow?.();
        window.focus();
        open(notice.path);
      });
    } catch {
      // Some browsers expose Notification but refuse to show one.
    }
  }
  if (shown.size !== count) window.cavemanDesktop?.setBadge?.(shown.size);
}

/** Posts what changed in the chats while the app is away, one notice per chat; clicking one opens its session. */
export function postNotices(
  before: ReadonlyMap<string, Workspace>,
  after: ReadonlyMap<string, Workspace>,
  settings: Settings["notifications"],
  shown: Map<string, Notification>,
  open: (path: string) => void,
): void {
  post(
    noticesBetween(before, after, settings).map(({ workspace: w, notice }) => ({ ...notice, tag: `workspace:${w.id}`, path: `/w/${w.id}`, ...(w.status === "needs_input" ? {} : { yields: true as const }) })),
    shown,
    open,
  );
}

/**
 * A Chief's item that waits on the person: it needs you (a failed or stopped chat, a pull request to fix, a question
 * report) or its Chief asked about it. As the sidebar's amber dot has it (ChiefList.tsx).
 */
export const waitsOnYou = (item: ChiefItem): boolean => item.state !== "done" && item.state !== "dropped" && (item.state === "needs_you" || item.asked !== undefined);

/** One of the item's chats asks the person itself (needs_input): that chat's own notice and count speak for it. */
const chatAsks = (item: ChiefItem, chats: ReadonlyMap<string, Workspace>) => item.workspace_ids.some((id) => chats.get(id)?.status === "needs_input");

/**
 * How many wait on the person: each asking chat once, and a lead's agent (or a chat running another Mac's chat's
 * mail) only when the chat it works for is not at work (then that chat speaks for it, as noticeFor has it); then each
 * Chief's item that waits on them (waitsOnYou), unless one of its chats already asks.
 */
export function needsYouCount(workspaces: ReadonlyMap<string, Workspace>, chiefItems: ReadonlyArray<ChiefItem> = []): number {
  let n = 0;
  for (const w of workspaces.values()) {
    if (w.status !== "needs_input" || w.kind !== undefined) continue;
    const lead = w.parent_workspace_id ? workspaces.get(w.parent_workspace_id) : undefined;
    if (atWork(lead) || atWork(askerOf(workspaces, w))) continue;
    n++;
  }
  for (const item of chiefItems) if (waitsOnYou(item) && !chatAsks(item, workspaces)) n++;
  return n;
}

/** A Chief as its notices read it: its name and page, what it last said, and whether it is thinking now. */
export interface ChiefNow {
  readonly name: string;
  readonly path: string;
  /** The home Chief: a one-Chief runtime's items (no chief_id) are its. */
  readonly home: boolean;
  /** Its latest reply and when its conversation last moved (chiefs.ts latestOf); undefined until read. */
  readonly latest: ChiefLatest | undefined;
  readonly working: boolean;
}

/** The Chiefs as the app has them now: each by its id, and every Chief's items (the one board; null until read). */
export interface ChiefsNow {
  readonly chiefs: ReadonlyMap<string, ChiefNow>;
  readonly items: ReadonlyArray<ChiefItem> | null;
}

/** What the person has already been told, or was there when the app started, carried from one look to the next. */
export interface ChiefsHeard {
  /** Each Chief's reply when its last turn ended, or when the app first read it. */
  readonly replies: ReadonlyMap<string, string | undefined>;
  /** The items that already wait on the person; null until the board was first read. */
  readonly waiting: ReadonlySet<string> | null;
}

/** Longest notice body: about two lines of a notification banner. */
const BODY_MAX = 160;

/** On one line, at most `max` characters, cut at a word where one is near, with an ellipsis. */
export function clip(text: string, max = BODY_MAX): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const breakAt = cut.lastIndexOf(" ");
  return `${(breakAt > max * 0.6 ? cut.slice(0, breakAt) : cut).trimEnd()}…`;
}

const REFS = new RegExp(WORK_REF_PATTERN.source, "g");
const CHAT_ID = /^\[\[(?:chat:)?([a-f\d-]{36})\]\]$/;

/**
 * A Chief's words as plain text: each [[12]] as its item's title (plainRefs), a [[chat:…]] as its chat's, and a
 * reference the board no longer has as "#12" or "a chat".
 */
function readable(text: string, mine: ReadonlyArray<ChiefItem>, chats: ReadonlyMap<string, Workspace>): string {
  return plainRefs(text, mine).replace(REFS, (ref) => {
    const id = CHAT_ID.exec(ref)?.[1];
    if (id === undefined) return `#${ref.slice(2, -2)}`;
    return (mine.some((i) => i.workspace_ids.includes(id)) ? chats.get(id)?.title : undefined) ?? "a chat";
  });
}

/** The Chief whose board an item is on: no chief_id is a one-Chief runtime's, the home Chief's. */
function chiefOf(item: ChiefItem, chiefs: ReadonlyMap<string, ChiefNow>): Pick<ChiefNow, "name" | "path"> {
  const chief = item.chief_id !== undefined ? chiefs.get(item.chief_id) : [...chiefs.values()].find((c) => c.home);
  return chief ?? { name: "Chief", path: item.chief_id === undefined ? "/chief" : chiefPath({ id: item.chief_id, home: false }) };
}

/**
 * What the Chiefs say to someone away from the app, and what has been heard after it. A Chief's reply: once its turn
 * ends with a reply it had not given before, newer than the person last read its conversation (`readAt`), titled with
 * its name, its words as the body (chief_messages). An item that starts waiting on the person (waitsOnYou): once,
 * titled with its Chief's name, its title and what it asks as the body (needs_input), unless one of its chats asks
 * itself. Nothing on first sight: what was there when the app started is not news.
 */
export function chiefNotices(
  heard: ChiefsHeard | null,
  now: ChiefsNow,
  settings: Settings["notifications"],
  chats: ReadonlyMap<string, Workspace>,
  readAt: (chiefId: string) => string | null = () => null,
): { readonly notices: PostedNotice[]; readonly heard: ChiefsHeard } {
  const notices: PostedNotice[] = [];
  const replies = new Map<string, string | undefined>();
  for (const [id, chief] of now.chiefs) {
    const known = heard?.replies.has(id) === true;
    const said = heard?.replies.get(id);
    // Not read yet: its first reading is first sight.
    if (chief.latest === undefined) {
      if (known) replies.set(id, said);
      continue;
    }
    const reply = chief.latest.reply;
    if (!known) {
      replies.set(id, reply);
      continue;
    }
    // Mid-turn its words may still grow: it has spoken when its turn ends.
    if (chief.working) {
      replies.set(id, said);
      continue;
    }
    replies.set(id, reply);
    if (reply === undefined || reply === said || settings.chief_messages === false) continue;
    const read = readAt(id);
    if (read !== null && Date.parse(chief.latest.at) <= Date.parse(read)) continue;
    const mine = (now.items ?? []).filter((i) => (i.chief_id === undefined ? chief.home : i.chief_id === id));
    notices.push({ tag: `chief:${id}`, title: chief.name, body: clip(readable(reply, mine, chats)), path: chief.path });
  }
  // No board (none read yet on this connection's runtime): its first reading is first sight.
  let waiting: Set<string> | null = null;
  if (now.items !== null) {
    const before = heard?.waiting ?? null;
    const next = new Set<string>();
    for (const item of now.items) {
      if (!waitsOnYou(item)) continue;
      next.add(item.id);
      if (before === null || before.has(item.id) || !settings.needs_input || chatAsks(item, chats)) continue;
      const chief = chiefOf(item, now.chiefs);
      const mine = now.items.filter((i) => i.chief_id === item.chief_id);
      const name = workTitle(item);
      const ask = item.asked?.question ?? item.detail;
      const body = ask === undefined || ask === name ? name : `${clip(name, 60)} · ${readable(ask, mine, chats)}`;
      // About one of its chats: it takes that chat's notice's place, and that chat's own Finished or Stopped, coming
      // before or after, leaves it there (a failed chat says it once, as its Chief's).
      const chat = item.asked?.workspace_id ?? item.workspace_ids.at(-1);
      const said = { title: chief.name, body: clip(body), path: chief.path };
      notices.push(chat === undefined ? { ...said, tag: `chief-item:${item.id}` } : { ...said, tag: `workspace:${chat}`, chief: true });
    }
    waiting = next;
  }
  return { notices, heard: { replies, waiting } };
}

/** The tab's (and window's) title: "(2) Caveman Code" while two wait on you, so a background tab says so. */
export function titleFor(needsYou: number, base = "Caveman Code"): string {
  return needsYou > 0 ? `(${needsYou}) ${base}` : base;
}

/**
 * Every chat of the person's, on any computer, as a workspace: this runtime's own, and the rest from Cloud's list
 * (sync/chats-view.ts noticeable). Without Cloud, this runtime's.
 */
function useAllChats(): ReadonlyMap<string, Workspace> {
  const raw = useRuntimeSelector((v) => v.raw);
  const hub = useSyncHub();
  const list = useChatList(hub);
  const home = hub?.homeRuntimeId() ?? null;
  return useMemo(() => noticeable(raw, list, home), [raw, list, home]);
}

interface ChiefItemsStore {
  items: ReadonlyArray<ChiefItem> | null;
  readonly listeners: Set<() => void>;
  /** chief.board.updated heard so far: a list answer that left before one is older than it. */
  updates: number;
  connection: number;
  refs: number;
  stop: (() => void) | null;
}
const itemStores = new WeakMap<Client, ChiefItemsStore>();

function itemsStoreFor(client: Client): ChiefItemsStore {
  let s = itemStores.get(client);
  if (!s) itemStores.set(client, (s = { items: null, listeners: new Set(), updates: 0, connection: -1, refs: 0, stop: null }));
  return s;
}

function setItems(s: ChiefItemsStore, items: ReadonlyArray<ChiefItem>) {
  s.items = items;
  s.listeners.forEach((l) => l());
}

function retainItems(client: Client, s: ChiefItemsStore): () => void {
  if (s.refs++ === 0)
    s.stop = client.on("chief.board.updated", (b) => {
      s.updates++;
      setItems(s, b.items);
    });
  return () => {
    if (--s.refs > 0) return;
    s.stop?.();
    s.stop = null;
    // Updates go unheard until the next reader, which reads the board again.
    s.connection = -1;
  };
}

/** The board once per connection: an update heard while the answer was out is newer than it. */
function readItems(client: Client, s: ChiefItemsStore, connection: number) {
  if (s.connection === connection) return;
  s.connection = connection;
  const updates = s.updates;
  client.call("chief.items.list", {}).then(
    (r) => {
      if (s.updates === updates) setItems(s, r.items);
    },
    () => undefined,
  );
}

/**
 * Every Chief's items on this runtime, for what waits on the person: chief.items.list on each connection, then every
 * chief.board.updated. Only a read, so it never makes a Chief (chief.get would); null until read, and where no Chief is
 * read (chiefHere).
 */
function useChiefItems(): ReadonlyArray<ChiefItem> | null {
  const { client: runtimeClient, connection, chiefHere = true } = useRuntimeClient();
  const client = chiefHere ? runtimeClient : null;
  const store = useMemo(() => (client ? itemsStoreFor(client) : null), [client]);
  useEffect(() => (client && store ? retainItems(client, store) : undefined), [client, store]);
  useEffect(() => {
    if (client && store) readItems(client, store, connection);
  }, [client, store, connection]);
  return useSyncExternalStore(
    (l) => {
      if (!store) return () => undefined;
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
    () => store?.items ?? null,
    () => store?.items ?? null,
  );
}

/** How many wait on you, on every computer and every Chief's board: the title's count, and the dot on a phone's menu button. */
export function useNeedsYou(): number {
  return needsYouCount(useAllChats(), useChiefItems() ?? []);
}

/** Mounted once in the shell: keeps the title's count of what waits on you. */
export function useNeedsYouTitle(): void {
  const count = useNeedsYou();
  useEffect(() => {
    document.title = titleFor(count);
  }, [count]);
}

/** Coming back to the app clears what was posted. */
export function clearNotices(shown: Map<string, Notification>): void {
  for (const n of shown.values()) n.close();
  shown.clear();
  window.cavemanDesktop?.setBadge?.(0);
}

/**
 * What is known of each workspace after `incoming`: the 2 s poll's whole list (`whole`: workspaces missing from it are
 * gone) or one workspace.changed push. A record older than the one known (by updated_at, which every status change
 * bumps) never replaces it: a poll answer read before a push but delivered after it must not undo it.
 */
export function mergeNewer(known: ReadonlyMap<string, Workspace>, incoming: Iterable<Workspace>, whole: boolean): Map<string, Workspace> {
  const next = new Map(whole ? [] : known);
  for (const w of incoming) {
    const held = known.get(w.id);
    next.set(w.id, held && held.updated_at > w.updated_at ? held : w);
  }
  return next;
}

/** The Chiefs as their notices read them: chief.list's names, each one's last word (chiefs.ts), and the board. */
function useChiefsNow(): ChiefsNow {
  const { chiefs, latest, working } = useChiefs();
  const items = useChiefItems();
  return useMemo(
    () => ({
      chiefs: new Map(chiefs.map((c) => [c.id, { name: c.name, path: chiefPath(c), home: c.home, latest: latest.get(c.id), working: working.has(c.id) }])),
      items,
    }),
    [chiefs, latest, working, items],
  );
}

/** When the person last left a Chief's conversation in this browser (routes/Chief.tsx keeps it): what came before, they saw. */
function chiefReadAt(chiefId: string): string | null {
  try {
    return localStorage.getItem(`caveman.chief.read.${chiefId}`);
  } catch {
    return null;
  }
}

/** Before Settings arrive nothing is told, but what is there is heard, so it is not news later. */
const QUIET: Settings["notifications"] = { needs_input: false, turn_done: false, chief_messages: false };

/**
 * Mounted once in the shell: watches the workspaces and the Chiefs and posts notices while the app is away. The
 * runtime's workspace.changed pushes carry every status change, so a turn shorter than the poll still says it finished
 * or failed; the poll fills in the rest.
 */
export function useWorkspaceNotifications(): void {
  // Every computer's chats: a chat on a Cloud computer or another Mac that needs you says so here too (Cloud's list).
  const all = useAllChats();
  const hub = useSyncHub();
  const settings = useRuntimeSelector((v) => v.settings);
  const { client } = useRuntimeClient();
  const navigate = useNavigate();
  const chiefs = useChiefsNow();
  const known = useRef<Map<string, Workspace> | null>(null);
  const heard = useRef<ChiefsHeard | null>(null);
  const shown = useRef(new Map<string, Notification>());
  const latest = useRef({ settings, navigate });
  latest.current = { settings, navigate };
  const wanted = settings !== null && (settings.notifications.needs_input || settings.notifications.turn_done || settings.notifications.chief_messages !== false);

  useEffect(() => {
    const clear = () => clearNotices(shown.current);
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, []);

  // A browser asks once, on a click (prompts need a gesture). The desktop app's permission handler grants it.
  useEffect(() => {
    if (!wanted || typeof Notification === "undefined" || Notification.permission !== "default") return;
    const ask = () => void Notification.requestPermission().catch(() => undefined);
    document.addEventListener("pointerdown", ask, { once: true });
    return () => document.removeEventListener("pointerdown", ask);
  }, [wanted]);

  const step = (next: Map<string, Workspace>) => {
    const before = known.current;
    known.current = next;
    const { settings, navigate } = latest.current;
    if (before && settings) postNotices(before, next, settings.notifications, shown.current, navigate);
  };
  useEffect(() => step(mergeNewer(known.current ?? new Map(), all.values(), true)), [all]);
  // Nothing before the first poll: that is first sight, which says nothing. A push about a chat that now runs on another
  // computer is this runtime's parked record of it: Cloud's list speaks for that chat, once.
  useEffect(
    () => client?.on("workspace.changed", (w) => known.current && !hub?.elsewhere(w.session_id) && step(mergeNewer(known.current, [w], false))),
    [client, hub],
  );
  // The Chiefs: their replies (chiefs.ts, from workspace.changed) and their board (chief.board.updated).
  useEffect(() => {
    const { settings, navigate } = latest.current;
    const next = chiefNotices(heard.current, chiefs, settings?.notifications ?? QUIET, known.current ?? new Map(), chiefReadAt);
    heard.current = next.heard;
    post(next.notices, shown.current, navigate);
  }, [chiefs]);
}
