// The window's tabs and each tab's split-view layout, persisted in localStorage under the window's own key, and the
// screen-reader announcer (pins live on the runtime: Workspace.inbox). Components read them with useLayout() and
// useTabs(); nothing here renders. `panes` acts on the tab in front, so the split view never needs to know about tabs.

import { useSyncExternalStore } from "react";
import { activateTab as showPanelTab, canMoveTabTo, hostChanged, moveTabTo, setTabHost, stepAside } from "../panels/store.ts";
import { cloudHosted } from "../state/cloud.ts";
import * as tree from "./tree.ts";
import type { Layout, Pane, TabRef, Zone } from "./tree.ts";

/**
 * A tab: what fills the panel, kept as it was while another tab is in front. A page (the Chief, New chat,
 * Automations) or the split view: one chat, or up to nine side by side, side-panel tabs among them. `path` is the
 * route it shows; `layout` its split view, kept behind a page too, so a page opened over chats goes back to them.
 */
export interface Tab {
  readonly id: string;
  readonly path: string;
  readonly layout: Layout;
  /**
   * Its own Back and Forward, as a browser tab's: the routes it showed before `path`, oldest first, and the ones Back
   * stepped back from, nearest last. Absent: none yet.
   */
  readonly back?: ReadonlyArray<string>;
  readonly forward?: ReadonlyArray<string>;
}

export interface Tabs {
  readonly list: ReadonlyArray<Tab>;
  readonly active: string;
  /** Tab ids, the one in front first, then the ones in front before it. */
  readonly recent: ReadonlyArray<string>;
}

/** Tabs kept rendered, hidden: switching back to one of them only shows it again (PaneHost). */
export const KEEP_TABS = 5;
/** Closed tabs ⌘⇧T brings back, newest last. */
const CLOSED_MAX = 20;
/** Routes a tab's Back (and its Forward) keeps; older ones drop off. */
const HISTORY_MAX = 50;

const TABS_PREFIX = "caveman.tabs.";
const STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * window.name survives reloads of this window and differs per window. A new window (the app launched again) takes
 * over the tabs of the window closed last, so they come back as they were: one marked `closedAt` on its way out, or,
 * in the desktop app, one that ended without the mark (a shutdown, a force quit, a crash). The desktop app runs one
 * window, so at its launch no other is live; a browser's other tabs may be, each on its own unmarked tabs.
 */
function windowId(): string {
  if (window.name.startsWith("caveman-")) return window.name.slice("caveman-".length);
  const alone = window.cavemanDesktop !== undefined;
  let id = crypto.randomUUID().slice(0, 8);
  let newest = 0;
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(TABS_PREFIX)) continue;
    let stored: { closedAt?: unknown; savedAt?: unknown } | null;
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "null") as { closedAt?: unknown; savedAt?: unknown } | null;
    } catch {
      continue;
    }
    const closedAt = typeof stored?.closedAt === "number" ? stored.closedAt : null;
    // Unmarked: when its window last wrote it, which a live window does at least daily. A key from before windows
    // recorded that is of unknown age: a browser tab may still be live on it; the desktop app's window is gone.
    const at = closedAt ?? (typeof stored?.savedAt === "number" ? stored.savedAt : alone ? 0 : null);
    if (at === null) continue;
    // A window gone a month that no window took over: its tabs are not coming back.
    if (Date.now() - at > STALE_WINDOW_MS) stale.push(key);
    else if ((closedAt !== null || alone) && at > newest) [newest, id] = [at, key.slice(TABS_PREFIX.length)];
  }
  for (const key of stale) localStorage.removeItem(key);
  window.name = `caveman-${id}`;
  return id;
}

const WINDOW = windowId();
const KEY = `${TABS_PREFIX}${WINDOW}`;
/** One split view per window, from before tabs: read once into the first tab. */
const LEGACY_KEY = `caveman.panes.${WINDOW}`;
/** The route the window opened on: none ("#/") brings the tab in front back as it was (AppShell). */
const LAUNCH_HASH = location.hash;

/** The chat a `/w/:workspaceId` route shows, or null for a page. */
export function chatOf(path: string): string | null {
  const m = /^\/w\/([^/?#]+)/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

export const chatPath = (workspaceId: string) => `/w/${encodeURIComponent(workspaceId)}`;

/**
 * The split view naming no chat: a side-panel tab's pane is in focus (a pull request in a tab of its own, a terminal
 * clicked beside its chat). A chat's route would focus that chat (PaneHost), so it can't stand for a focused tab.
 */
export const PANES_PATH = "/panes";

/** Whether a route shows the split view. */
export const isSplitPath = (path: string): boolean => chatOf(path) !== null || path === PANES_PATH;

/** The route a split view shows: its focused chat; the panes for a focused tab; else its first chat, else the panes. */
export function splitPath(layout: Layout): string {
  const focused = tree.findPane(layout, layout.focused);
  if (focused?.tab) return PANES_PATH;
  const ws = focused?.workspaceId ?? tree.openWorkspaceIds(layout)[0];
  return ws ? chatPath(ws) : layout.root ? PANES_PATH : "/new";
}

/**
 * The chat the person last had on screen, behind the tab in front: the most recent tab other than the active one that
 * shows a chat, or null. Typing a note in the Chief (its own tab) attaches this as the note's "showing" chat, the
 * typed-note answer to a call's showing: line. A split whose side-panel tab was in focus (`/panes`) shows the chat
 * focused there last.
 */
export function recentChat(tabs: Tabs): string | null {
  for (const id of tabs.recent) {
    if (id === tabs.active) continue;
    const tab = tabs.list.find((t) => t.id === id);
    const ws = !tab ? null : tab.path === PANES_PATH ? lastChat(tab.layout) : chatOf(tab.path);
    if (ws) return ws;
  }
  return null;
}

/** The chat a split had in focus last: its focused pane's, else the most recently focused chat pane's, else its first. */
function lastChat(layout: Layout): string | null {
  const ids = [layout.focused, ...(layout.recent ?? [])];
  for (const id of ids) {
    const ws = tree.findPane(layout, id)?.workspaceId;
    if (ws) return ws;
  }
  return tree.openWorkspaceIds(layout)[0] ?? null;
}

/** Routes a tab can show: everything in the shell but Settings, which takes the whole window over every tab. */
export const tabbable = (path: string) => path.startsWith("/") && path !== "/" && !/^\/settings(\/|\?|$)/.test(path) && path.length < 2048;

/**
 * A chat tab whose chat left it (moved, closed) shows the one now focused there; with none, its side-panel tabs, and
 * with nothing at all a new chat. A tab of side-panel tabs that a chat joined names the chat.
 */
function withPath(tab: Tab): Tab {
  const ws = chatOf(tab.path);
  if (!isSplitPath(tab.path) || (ws !== null && tree.paneOf(tab.layout, ws))) return tab;
  const path = splitPath(tab.layout);
  return path === tab.path ? tab : { ...tab, path };
}

/** A stored tab's Back and Forward: the routes a tab can show, the newest HISTORY_MAX of each. */
function storedHistory(t: Record<string, unknown>): Pick<Tab, "back" | "forward"> {
  const routes = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && tabbable(p)).slice(-HISTORY_MAX) : []);
  return { back: routes(t.back), forward: routes(t.forward) };
}

/** Reads stored tabs; malformed ones drop out, and none left is null. */
export function parseTabs(json: string | null): Tabs | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as { tabs?: unknown; active?: unknown };
    if (!Array.isArray(o.tabs)) return null;
    const seen = new Set<string>();
    const held = new Set<string>();
    const list: Tab[] = [];
    for (const t of o.tabs as Array<Record<string, unknown> | null>) {
      if (!t || typeof t.id !== "string" || !/^t\d+$/.test(t.id) || seen.has(t.id) || typeof t.path !== "string" || !tabbable(t.path)) continue;
      seen.add(t.id);
      // One home per chat and per side-panel tab: one a damaged copy left in two tabs stays in the first.
      let layout = tree.fromJSON(t.layout);
      for (const p of tree.leaves(layout.root)) if (held.has(tree.paneKey(p) ?? "")) layout = tree.close(layout, p.id);
      for (const p of tree.leaves(layout.root)) if (tree.paneKey(p)) held.add(tree.paneKey(p)!);
      list.push(withPath({ id: t.id, path: t.path, layout, ...storedHistory(t) }));
    }
    if (list.length === 0) return null;
    const active = typeof o.active === "string" && seen.has(o.active) ? o.active : list[0]!.id;
    return { list, active, recent: [active] };
  } catch {
    return null;
  }
}

/** A closed tab ⌘⇧T can bring back, and where it stood in the strip. */
interface Closed {
  readonly tab: Tab;
  readonly index: number;
}

/** The closed tabs stored with the window's tabs; malformed ones drop out. */
function loadClosed(): Closed[] {
  let v: unknown;
  try {
    v = (JSON.parse(localStorage.getItem(KEY) ?? "null") as { closed?: unknown } | null)?.closed;
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.flatMap((c: { tab?: Record<string, unknown>; index?: unknown } | null) => {
    const t = c?.tab;
    if (!t || typeof t.id !== "string" || !/^t\d+$/.test(t.id) || typeof t.path !== "string" || !tabbable(t.path) || typeof c.index !== "number") return [];
    return [{ tab: { id: t.id, path: t.path, layout: tree.fromJSON(t.layout), ...storedHistory(t) }, index: c.index }];
  }).slice(-CLOSED_MAX);
}

/**
 * Where a window with nothing kept opens: the Chief, or New chat in a browser window Caveman Cloud serves, which has no
 * computer of its own (the Chief lives on a Mac, and a first visit there has no chat yet).
 */
export const homePath = (hosted: boolean): string => (hosted ? "/new" : "/chief");
const HOME_PATH = homePath(typeof window !== "undefined" && typeof window.location !== "undefined" && cloudHosted(window.location, (window as { cavemanDesktop?: unknown }).cavemanDesktop));

function load(): Tabs {
  const stored = parseTabs(localStorage.getItem(KEY));
  if (stored) return stored;
  const layout = tree.parse(localStorage.getItem(LEGACY_KEY));
  const ws = tree.findPane(layout, layout.focused)?.workspaceId;
  return { list: [{ id: "t1", path: ws ? chatPath(ws) : HOME_PATH, layout }], active: "t1", recent: ["t1"] };
}

let tabs: Tabs = load();
let current: Tab = tabs.list.find((t) => t.id === tabs.active)!;
/** The pane that just landed, so it can flash its outline once. */
let landed: { id: string; n: number } | null = null;
let closed: Closed[] = loadClosed();
const listeners = new Set<() => void>();

function homesOf(list: ReadonlyArray<Tab>): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  list.forEach((t, i) => {
    for (const p of tree.leaves(t.layout.root)) if (p.workspaceId) map.set(p.workspaceId, i);
  });
  return map;
}

/** Every side-panel tab shown as a pane, by tree.tabKey: the tab (its index) it is in. */
function hostedOf(list: ReadonlyArray<Tab>): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  list.forEach((t, i) => {
    for (const p of tree.leaves(t.layout.root)) if (p.tab) map.set(tree.tabKey(p.tab), i);
  });
  return map;
}

/** The open workspaces, one array per distinct set so a layout change that opens nothing re-renders no row. */
let openIds: ReadonlyArray<string> = tree.openWorkspaceIds(current.layout);
/** Every open chat's tab (its index), by workspace id: where the sidebar marks it, and one home per chat. */
let homes: ReadonlyMap<string, number> = homesOf(tabs.list);
/** Every hosted side-panel tab's tab (its index): their panels' strips leave them out (panels/store.ts). */
let hosted: ReadonlyMap<string, number> = hostedOf(tabs.list);

// The panels ask here which of their tabs show as panes, and hand over the ones to show.
setTabHost({
  hosts: (workspaceId, id) => hosted.has(tree.tabKey({ workspaceId, id })),
  reveal: (workspaceId, id) => revealTab({ workspaceId, id }),
  retarget: (workspaceId, fromId, toId) => {
    const home = hostOf({ workspaceId, id: fromId });
    const pane = home && tree.tabPaneOf(home.layout, { workspaceId, id: fromId });
    if (home && pane) setTabs({ ...tabs, list: patchTab(tabs.list, home.id, (t) => ({ ...t, layout: tree.updatePane(t.layout, pane.id, { tab: { workspaceId, id: toId } }) })) });
  },
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

let saving = false;
function save() {
  if (saving) return;
  saving = true;
  // One write for a burst of changes (a tab switch moves focus and route in one go).
  queueMicrotask(() => {
    saving = false;
    localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.list, active: tabs.active, closed, savedAt: Date.now() }));
  });
}

// Leaving (quit, window closed, reload): marked so the next new window takes these tabs over (windowId). A reload
// keeps its window.name, and its first save clears the mark.
window.addEventListener("pagehide", () => localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.list, active: tabs.active, closed, closedAt: Date.now() })));
// Taken over: unmarked at once, so a second new window opening now does not take the same tabs.
save();
// Written at least daily while the window lives, so a month-old savedAt means a window that is gone (windowId).
setInterval(save, 24 * 60 * 60 * 1000);

function setTabs(next: Tabs, land?: string) {
  if (next === tabs && !land) return;
  const listChanged = next.list !== tabs.list;
  tabs = next;
  current = tabs.list.find((t) => t.id === tabs.active)!;
  if (land) landed = { id: land, n: (landed?.n ?? 0) + 1 };
  const open = tree.openWorkspaceIds(current.layout);
  if (open.length !== openIds.length || open.some((id, i) => id !== openIds[i])) openIds = open;
  let hostMoved = false;
  if (listChanged) {
    homes = homesOf(tabs.list);
    const now = hostedOf(tabs.list);
    hostMoved = now.size !== hosted.size || [...now.keys()].some((k) => !hosted.has(k));
    hosted = now;
  }
  save();
  listeners.forEach((l) => l());
  if (hostMoved) hostChanged();
}

function patchTab(list: ReadonlyArray<Tab>, id: string, patch: (t: Tab) => Tab): ReadonlyArray<Tab> {
  let changed = false;
  const next = list.map((t) => {
    if (t.id !== id) return t;
    const u = patch(t);
    if (u !== t) changed = true;
    return u;
  });
  return changed ? next : list;
}

const toFront = (id: string, recent: ReadonlyArray<string>) => (recent[0] === id ? recent : [id, ...recent.filter((r) => r !== id)]);
const nextTabId = () => `t${Math.max(0, ...tabs.list.map((t) => Number(t.id.slice(1)))) + 1}`;

/** The tab in front's layout becomes `next`. */
function commit(next: Layout, land?: string) {
  if (next === current.layout && !land) return;
  setTabs({ ...tabs, list: patchTab(tabs.list, current.id, (t) => ({ ...t, layout: tree.settle(t.layout, next) })) }, land);
}

/**
 * Opens a chat without taking another chat's place: focus it where it is open (another tab comes to the front), else
 * tree.place (an empty pane, or the one pane on screen). A split with every pane in use keeps it: the chat gets a tab of
 * its own, and the split's tab goes back to the chat focused in it.
 */
function open(workspaceId: string, flash: boolean) {
  const home = holding(workspaceId);
  if (home && home.id !== current.id) {
    const pane = tree.paneOf(home.layout, workspaceId)!;
    const list = patchTab(tabs.list, home.id, (t) => ({ ...t, layout: tree.settle(t.layout, tree.focus(t.layout, pane.id)), path: chatPath(workspaceId) }));
    return setTabs({ ...tabs, list, active: home.id, recent: toFront(home.id, tabs.recent) });
  }
  const next = tree.place(current.layout, workspaceId);
  if (next) return commit(next, flash && tree.leaves(next.root).length > 1 ? (next.focused ?? undefined) : undefined);
  // The split's tab goes back to the chat focused in it; a page it showed over the split is a step Back returns to.
  const back = tree.findPane(current.layout, current.layout.focused)?.workspaceId;
  const list = back ? patchTab(tabs.list, current.id, (t) => stepTo(t, chatPath(back))) : tabs.list;
  const id = nextTabId();
  setTabs({ ...tabs, list: [...list, { id, path: chatPath(workspaceId), layout: tree.show(tree.EMPTY, workspaceId) }], active: id, recent: toFront(id, tabs.recent) });
}

/** The split view's box in px (PaneHost marks it); null off the w/ route. */
function hostSize(): { w: number; h: number } | null {
  const box = document.querySelector("[data-pane-host]")?.getBoundingClientRect();
  return box ? { w: box.width, h: box.height } : null;
}

function holding(workspaceId: string): Tab | undefined {
  const i = homes.get(workspaceId);
  return i === undefined ? undefined : tabs.list[i];
}

/** The tab whose split view shows this side-panel tab. */
function hostOf(ref: TabRef): Tab | undefined {
  const i = hosted.get(tree.tabKey(ref));
  return i === undefined ? undefined : tabs.list[i];
}

/** `tab` goes to `path`, as a browser tab does: where it was is a step Back returns to, and Forward clears. */
function stepTo(tab: Tab, path: string): Tab {
  return path === tab.path ? tab : { ...tab, path, back: [...(tab.back ?? []), tab.path].slice(-HISTORY_MAX), forward: [] };
}

/**
 * A route Back or Forward can take `tab` to: not the one on screen, nor a chat that would not open in this tab as it is
 * now: one that lives in another tab, or one a split with every pane in use has no room for (tree.place), which would
 * get a tab of its own. The panes' route names no side-panel tab, so it shows only while the split still focuses one
 * (splitPath); else PaneHost would trade it for the focused chat's at once and the step would show nothing.
 */
function reachable(tab: Tab, path: string): boolean {
  if (path === tab.path) return false;
  if (path === PANES_PATH) return splitPath(tab.layout) === PANES_PATH;
  const ws = chatOf(path);
  if (ws === null) return true;
  const home = holding(ws);
  return (!home || home.id === tab.id) && tree.place(tab.layout, ws) !== null;
}

/**
 * Takes a chat out of the tab behind that holds it, so it can open in `keep` (a drop, an empty pane's pick): one home
 * per chat. That tab closes when the chat was all it showed.
 */
function detach(workspaceId: string, keep: string = current.id): void {
  const home = holding(workspaceId);
  if (home && home.id !== keep) leave(home, tree.paneOf(home.layout, workspaceId)!.id);
}

/** `detach` for a side-panel tab shown as a pane in a tab behind. */
function detachTab(ref: TabRef): void {
  const home = hostOf(ref);
  if (home && home.id !== current.id) leave(home, tree.tabPaneOf(home.layout, ref)!.id);
}

/** A pane leaves a tab behind; the tab closes when that pane was all its split view showed. */
function leave(home: Tab, paneId: string): void {
  const layout = tree.close(home.layout, paneId);
  const list = layout.root === null && isSplitPath(home.path) ? tabs.list.filter((t) => t.id !== home.id) : patchTab(tabs.list, home.id, (t) => withPath({ ...t, layout }));
  setTabs({ ...tabs, list, recent: tabs.recent.filter((id) => list.some((t) => t.id === id)) });
}

/**
 * Whether the window shows its tabs: the desktop app does (TabStrip). A browser has its own tabs and shows none of
 * these, so a tab of the window's made there could never be reached again.
 */
const tabsShown = (): boolean => typeof window !== "undefined" && window.cavemanDesktop !== undefined;

/**
 * Where "Open in split view" puts a tab: a pane beside its chat (else the focused pane), right if that fits, else
 * below. Null: no room in the split in front.
 */
function placeTab(ref: TabRef): { readonly layout: Layout; readonly paneId: string } | null {
  const layout = current.layout;
  const pane = tree.newTabPane(layout, ref);
  if (!layout.root) return { layout: { root: pane, focused: pane.id }, paneId: pane.id };
  const anchor = tree.paneOf(layout, ref.workspaceId)?.id ?? layout.focused ?? tree.leaves(layout.root)[0]!.id;
  const size = hostSize();
  let next: Layout;
  // The split view behind a page has no size on screen: it takes the pane, and squeezes if it must (PaneHost).
  if (size && size.w > 0 && size.h > 0) {
    next = tree.splitAt(layout, anchor, "right", pane, size.w, size.h);
    if (next === layout) next = tree.splitAt(layout, anchor, "bottom", pane, size.w, size.h);
  } else next = tree.insert(layout, anchor, "right", pane);
  return next === layout ? null : { layout: next, paneId: pane.id };
}

/** Where the window is: the hash router's route. */
const here = () => location.hash.replace(/^#/, "") || "/";

/**
 * Brings a hosted side-panel tab into view: its tab to the front, its pane focused (and flashed), the split view on
 * screen. Navigates itself (replacing the entry, as useTabNav does): the panels call it from anywhere.
 */
function revealTab(ref: TabRef): void {
  const home = hostOf(ref);
  const pane = home && tree.tabPaneOf(home.layout, ref);
  if (!home || !pane) return;
  const layout = tree.settle(home.layout, tree.focus(home.layout, pane.id));
  const path = splitPath(layout);
  setTabs({ ...tabs, list: patchTab(tabs.list, home.id, (t) => ({ ...t, layout, path })), active: home.id, recent: toFront(home.id, tabs.recent) }, pane.id);
  if (here() !== path) location.replace(`#${path}`);
}

/**
 * The chat the pointer rests on in the sidebar, once its history is in: the focused pane renders it hidden (PaneFrame),
 * so opening it only shows it.
 */
let warm: string | null = null;
const warmListeners = new Set<() => void>();
export const warmChat = {
  set: (workspaceId: string | null) => {
    if (workspaceId === warm) return;
    warm = workspaceId;
    warmListeners.forEach((l) => l());
  },
};
const subscribeWarm = (l: () => void) => {
  warmListeners.add(l);
  return () => warmListeners.delete(l);
};
export const useWarmChat = (): string | null => useSyncExternalStore(subscribeWarm, () => warm);

/** The split view of the tab in front. */
export const panes = {
  get: (): Layout => current.layout,
  landed: () => landed,
  open: () => openIds,
  subscribe,
  set: (next: Layout) => commit(next),
  /** The route asked for a workspace (a sidebar click, a link, Back): `open`. */
  show: (workspaceId: string) => open(workspaceId, false),
  /** A chat the user just started (New chat): `open`, flashing the pane it landed in. */
  place: (workspaceId: string) => open(workspaceId, true),
  focus: (id: string) => commit(tree.focus(current.layout, id)),
  update: (id: string, patch: Partial<Omit<Pane, "kind" | "id">>) => commit(tree.updatePane(current.layout, id, patch)),
  /**
   * Closes a pane. The last one closes its tab, kept as it was so ⌘⇧T brings the chat back: answers the route to show.
   * The window's only tab empties instead (PaneHost shows the Chief).
   */
  close: (id: string): string | null => {
    if (tree.leaves(current.layout.root).length === 1 && tabs.list.length > 1 && tree.findPane(current.layout, id)) return windowTabs.close((t) => t.id === current.id);
    commit(tree.close(current.layout, id));
    return null;
  },
  /** Zoom: the focused pane fills the tab, or the split comes back. */
  toggleZoom: () => commit(tree.toggleZoom(current.layout)),
  /** Every pane of the split in equal shares, or only one split's (a divider's double-click). */
  equalize: (splitId?: string) => commit(tree.equalize(current.layout, splitId)),
  /** Focus the pane beside the focused one (⌥⌘ and an arrow): its id, or null at the edge. */
  focusToward: (dir: tree.Direction): string | null => {
    const id = tree.neighbor(current.layout, dir);
    if (id) commit(tree.focus(current.layout, id));
    return id;
  },
  /**
   * An empty pane gets a workspace (the picker, or the chat its New chat made): it lands like a drop, in the pane's own
   * tab, in front or not. `tab` is that tab as the person chose: New chat waits for its chat, they may go to another tab
   * meanwhile, and pane ids repeat across tabs. False, and nothing changes, when the pane is gone or holds a chat now, or
   * the chat is on screen in the tab in front: the caller opens it as any chat.
   */
  fill: (id: string, workspaceId: string, tab: string = current.id): boolean => {
    const into = tabs.list.find((t) => t.id === tab);
    if (!into || tree.findPane(into.layout, id)?.workspaceId !== null) return false;
    if (into.id !== current.id && holding(workspaceId)?.id === current.id) return false;
    detach(workspaceId, into.id);
    const filled = (layout: Layout): Layout => ({ ...tree.updatePane(layout, id, { workspaceId }), focused: id });
    if (into.id === current.id) commit(filled(current.layout), id);
    // Behind, the tab's route names the chat it now focuses, as the one in front's follows its focus (PaneHost).
    else setTabs({ ...tabs, list: patchTab(tabs.list, into.id, (t) => ({ ...t, layout: tree.settle(t.layout, filled(t.layout)), path: chatOf(t.path) === null ? t.path : chatPath(workspaceId) })) });
    return true;
  },
  /** ⌘D and ⌘⇧D: an empty pane (a new chat) beside the focused one, if every pane it shrinks stays above the minimum. */
  split: (zone: "right" | "bottom"): boolean => {
    const at = current.layout.focused;
    const size = hostSize();
    if (!at || !size) return false;
    const pane = tree.newPane(current.layout, null);
    const next = tree.splitAt(current.layout, at, zone, pane, size.w, size.h);
    if (next === current.layout) return false;
    commit(next, pane.id);
    return true;
  },
  /**
   * A workspace dropped on a pane. Already open here: focus it (or move that pane there when the drag came from a
   * pane header). Open in another tab: it moves here. Otherwise split or replace.
   */
  drop: (workspaceId: string, fromPaneId: string | null, targetId: string, zone: Zone) => {
    if (fromPaneId) return commit(tree.move(current.layout, fromPaneId, targetId, zone), fromPaneId);
    detach(workspaceId);
    const open = tree.paneOf(current.layout, workspaceId);
    if (open) return commit(tree.focus(current.layout, open.id), open.id);
    if (zone === "center" && !tree.findPane(current.layout, targetId)?.tab) {
      return commit({ ...tree.updatePane(current.layout, targetId, { workspaceId }), focused: targetId }, targetId);
    }
    // An edge, or a tab's pane (it goes back to its panel): a new pane.
    const pane = tree.newPane(current.layout, workspaceId);
    commit(tree.insert(current.layout, targetId, zone, pane), pane.id);
  },
  /**
   * A side-panel tab dropped on a pane: beside it, or in its place. From a pane's header, that pane moves. A tab
   * shown in a tab behind moves here.
   */
  dropTab: (ref: TabRef, fromPaneId: string | null, targetId: string, zone: Zone) => {
    if (fromPaneId) return commit(tree.move(current.layout, fromPaneId, targetId, zone), fromPaneId);
    detachTab(ref);
    const shown = tree.tabPaneOf(current.layout, ref);
    if (shown) return commit(tree.move(current.layout, shown.id, targetId, zone), shown.id);
    stepAside(ref.workspaceId, ref.id);
    const pane = tree.newTabPane(current.layout, ref);
    commit(tree.insert(current.layout, targetId, zone, pane), pane.id);
  },
  /**
   * "Open in split view": the tab leaves its panel for a pane (placeTab). Without room, the desktop gives it a tab of
   * its own; a browser, which shows no window tabs, leaves it in its panel and says so. Answers the route to show
   * (null: stay put).
   */
  hostTab: (ref: TabRef): string | null => {
    if (hostOf(ref)) {
      revealTab(ref);
      return null;
    }
    const place = placeTab(ref);
    if (!place) {
      if (tabsShown()) return windowTabs.openTab(ref);
      announce("No room in the split view. Close or zoom a pane first.");
      return null;
    }
    stepAside(ref.workspaceId, ref.id);
    commit(place.layout, place.paneId);
    return isSplitPath(current.path) ? null : splitPath(current.layout);
  },
  /** Whether `hostTab` would show the tab: it is in a pane already, there is room, or the window can give it a tab. */
  canHostTab: (ref: TabRef): boolean => hostOf(ref) !== undefined || tabsShown() || placeTab(ref) !== null,
  /** A tab's pane goes back into its own panel, in front there. Answers the route to show, as `close` does. */
  dock: (paneId: string): string | null => {
    const ref = tree.findPane(current.layout, paneId)?.tab;
    if (!ref) return null;
    const to = panes.close(paneId);
    showPanelTab(ref.workspaceId, ref.id);
    return to;
  },
  /**
   * A tab (in a pane, `paneId`, or in its panel's strip) goes to another workspace's panel: only tabs that don't
   * depend on their workspace (SurfaceDef.portable). Answers the route to show, as `close` does.
   */
  moveToPanel: (ref: TabRef, paneId: string | null, workspaceId: string): string | null => {
    if (!canMoveTabTo(ref.workspaceId, ref.id, workspaceId)) return null;
    const to = paneId && tree.findPane(current.layout, paneId)?.tab ? panes.close(paneId) : null;
    moveTabTo(ref.workspaceId, ref.id, workspaceId);
    return to;
  },
};

/**
 * The window's tabs. A change that brings another tab to the front answers the route to show (null: stay put), and
 * the caller goes there (useTabNav), replacing the history entry so Back never walks into another tab.
 */
export const windowTabs = {
  get: (): Tabs => tabs,
  /** The route of the tab in front: where Settings' "Back to app" goes. */
  frontPath: (): string => current.path,
  subscribe,
  /** The route the window comes back on at launch, when it opened on none. */
  launchPath: (): string | null => (LAUNCH_HASH === "" || LAUNCH_HASH === "#" || LAUNCH_HASH === "#/" ? current.path : null),
  /**
   * The route on screen is the tab in front's (AppShell). A chat open in another tab brings that tab to the front.
   * Going somewhere ("push": a link, a row, ⌘K) is a step Back returns from, and clears Forward, as in a browser; a
   * redirect, a pane's focus or the window opening ("replace") only renames the step the tab is on. A push that will
   * not land in this tab (reachable) leaves it as it is: a chat a full split has no room for gets a tab of its own
   * (open), whichever of the two hears of it first.
   */
  follow: (path: string, how: "push" | "replace" = "push") => {
    if (!tabbable(path)) return;
    const ws = chatOf(path);
    const home = ws === null ? undefined : holding(ws);
    if (ws !== null && home && home.id !== current.id) return panes.show(ws);
    if (current.path === path) return;
    if (how === "replace") return setTabs({ ...tabs, list: patchTab(tabs.list, current.id, (t) => ({ ...t, path })) });
    if (reachable(current, path)) setTabs({ ...tabs, list: patchTab(tabs.list, current.id, (t) => stepTo(t, path)) });
  },
  /**
   * Back (-1) or Forward (1) in the tab in front: answers the route to show (useTabNav), or null with nowhere to go. A
   * chat that would not open in this tab as it is now (reachable) is stepped over: Back never pulls a chat out of
   * another tab or spills one out of a full split. It stays in the history, as the pages a browser passes going several
   * steps at once.
   */
  go: (by: -1 | 1): string | null => {
    const ahead = (by < 0 ? current.back : current.forward) ?? [];
    const behind = (by < 0 ? current.forward : current.back) ?? [];
    const at = ahead.findLastIndex((p) => reachable(current, p));
    if (at < 0) return null;
    const path = ahead[at]!;
    const left = ahead.slice(0, at);
    const passed = [...behind, current.path, ...ahead.slice(at + 1).reverse()].slice(-HISTORY_MAX);
    const history = by < 0 ? { back: left, forward: passed } : { back: passed, forward: left };
    setTabs({ ...tabs, list: patchTab(tabs.list, current.id, (t) => ({ ...t, path, ...history })) });
    return path;
  },
  canGo: (by: -1 | 1): boolean => ((by < 0 ? current.back : current.forward) ?? []).some((p) => reachable(current, p)),
  activate: (id: string): string | null => {
    if (id === tabs.active) return null;
    const tab = tabs.list.find((t) => t.id === id);
    if (!tab) return null;
    setTabs({ ...tabs, active: id, recent: toFront(id, tabs.recent) });
    return tab.path;
  },
  /** ⌘1..⌘8 the tab at that place, ⌘9 the last one. */
  activateAt: (n: number): string | null => {
    const tab = n === 9 ? tabs.list.at(-1) : tabs.list[n - 1];
    return tab ? windowTabs.activate(tab.id) : null;
  },
  step: (by: 1 | -1): string | null => {
    const n = tabs.list.length;
    const at = tabs.list.findIndex((t) => t.id === tabs.active);
    return n < 2 ? null : windowTabs.activate(tabs.list[(at + by + n) % n]!.id);
  },
  /** A new tab, last in the strip, in front. */
  open: (path: string, layout: Layout = tree.EMPTY): string => {
    const id = nextTabId();
    setTabs({ list: [...tabs.list, { id, path, layout }], active: id, recent: toFront(id, tabs.recent) });
    return path;
  },
  /** ⌘T and +: New chat in a new tab. A New chat tab nobody has used yet comes to the front instead of a second one. */
  openNewChat: (): string => {
    const blank = tabs.list.find((t) => t.path === "/new" && t.layout.root === null);
    return blank ? (windowTabs.activate(blank.id) ?? blank.path) : windowTabs.open("/new");
  },
  /** A chat in a tab of its own (⌘-click, Open in new tab, a drop on the strip); one already open brings its tab forward. */
  openChat: (workspaceId: string): string => {
    if (holding(workspaceId)) {
      panes.show(workspaceId);
      return chatPath(workspaceId);
    }
    return windowTabs.open(chatPath(workspaceId), tree.show(tree.EMPTY, workspaceId));
  },
  /** A page in a tab of its own; a tab already showing it comes to the front. */
  openPage: (path: string): string => {
    const there = tabs.list.find((t) => t.path === path);
    return there ? (windowTabs.activate(there.id) ?? path) : windowTabs.open(path);
  },
  /** A pane of the split in front, dragged onto the strip: it leaves the split for a tab of its own. */
  splitOff: (paneId: string): string | null => {
    const pane = tree.findPane(current.layout, paneId);
    if (!pane || (!pane.workspaceId && !pane.tab) || tree.leaves(current.layout.root).length < 2) return null;
    setTabs({ ...tabs, list: patchTab(tabs.list, current.id, (t) => withPath({ ...t, layout: tree.close(t.layout, paneId) })) });
    if (pane.tab) return windowTabs.open(PANES_PATH, alone(pane.tab));
    return windowTabs.open(chatPath(pane.workspaceId!), tree.show(tree.EMPTY, pane.workspaceId!));
  },
  /** A side-panel tab in a tab of its own (its menu's Open in new tab, a drop on the strip). One shown already moves. */
  openTab: (ref: TabRef): string => {
    const shown = tree.tabPaneOf(current.layout, ref);
    if (shown) return windowTabs.splitOff(shown.id) ?? current.path;
    detachTab(ref);
    stepAside(ref.workspaceId, ref.id);
    return windowTabs.open(PANES_PATH, alone(ref));
  },
  /** A drag in the strip: the tab moves to `index`. */
  move: (id: string, index: number) => {
    const from = tabs.list.findIndex((t) => t.id === id);
    const to = Math.max(0, Math.min(tabs.list.length - 1, index));
    if (from < 0 || from === to) return;
    const list = [...tabs.list];
    list.splice(to, 0, list.splice(from, 1)[0]!);
    setTabs({ ...tabs, list });
  },
  /**
   * Closes tabs; their chats run on, and the sidebar keeps them. The last tab never closes here (⌘W then closes the
   * window). Closing the tab in front brings the one that takes its place, else the one before it.
   */
  close: (which: (tab: Tab, index: number) => boolean): string | null => {
    const shut = tabs.list.filter((t, i) => which(t, i));
    if (shut.length === 0 || shut.length >= tabs.list.length) return null;
    closed = [...closed, ...shut.map((tab) => ({ tab, index: tabs.list.indexOf(tab) }))].slice(-CLOSED_MAX);
    const list = tabs.list.filter((t) => !shut.includes(t));
    let active = tabs.active;
    if (!list.some((t) => t.id === active)) {
      const at = tabs.list.findIndex((t) => t.id === active);
      active = (tabs.list.slice(at + 1).find((t) => list.includes(t)) ?? tabs.list.slice(0, at).reverse().find((t) => list.includes(t)))!.id;
    }
    const moved = active !== tabs.active;
    setTabs({ list, active, recent: toFront(active, tabs.recent.filter((id) => list.some((t) => t.id === id))) });
    return moved ? current.path : null;
  },
  canReopen: () => closed.length > 0,
  /** ⌘⇧T: the last closed tab, back where it was. A chat opened elsewhere since stays there. */
  reopen: (): string | null => {
    const last = closed.at(-1);
    if (!last) return null;
    closed = closed.slice(0, -1);
    let layout = last.tab.layout;
    for (const p of tree.leaves(layout.root)) if ((p.workspaceId && homes.has(p.workspaceId)) || (p.tab && hosted.has(tree.tabKey(p.tab)))) layout = tree.close(layout, p.id);
    const id = tabs.list.some((t) => t.id === last.tab.id) ? nextTabId() : last.tab.id;
    const tab = withPath({ ...last.tab, id, layout });
    const list = [...tabs.list];
    list.splice(Math.min(last.index, list.length), 0, tab);
    setTabs({ list, active: id, recent: toFront(id, tabs.recent) });
    return tab.path;
  },
};

/** A split view of one side-panel tab. */
function alone(ref: TabRef): Layout {
  const pane = tree.newTabPane(tree.EMPTY, ref);
  return { root: pane, focused: pane.id };
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, panes.get);
}

export function useLanded(): { id: string; n: number } | null {
  return useSyncExternalStore(subscribe, panes.landed);
}

/** The workspaces open in the panes of the tab in front, in pane order; follows every open, close and swap live. */
export function useOpenWorkspaces(): ReadonlyArray<string> {
  return useSyncExternalStore(subscribe, panes.open);
}

export function useTabs(): Tabs {
  return useSyncExternalStore(subscribe, windowTabs.get);
}

/** Whether Back (-1) or Forward (1) has somewhere to go in the tab in front; follows every step and tab switch. */
export function useCanGo(by: -1 | 1): boolean {
  return useSyncExternalStore(subscribe, () => windowTabs.canGo(by));
}

/**
 * The place (1-based) of the tab a chat is open in, while the window has two tabs or more; else 0. A number, so a
 * sidebar row re-renders only when its own changes.
 */
export function useChatTab(workspaceId: string): number {
  return useSyncExternalStore(subscribe, () => (tabs.list.length < 2 ? 0 : (homes.get(workspaceId) ?? -1) + 1));
}

/**
 * The tab a chat is open in, with any number of tabs, and whether that tab is in front; null for a chat open nowhere.
 * The tab's own object, so a sidebar row re-renders only when that tab changes or comes and goes from the front.
 */
export function useChatHome(workspaceId: string): { tab: Tab; front: boolean } | null {
  const tab = useSyncExternalStore(subscribe, () => holding(workspaceId) ?? null);
  const front = useSyncExternalStore(subscribe, () => tabs.active === holding(workspaceId)?.id);
  return tab ? { tab, front } : null;
}

// -------------------------------------------------------------- announcer

let live: HTMLElement | null = null;

/**
 * Closes a pane and says so; answers the route to show when it was its tab's last (the tab closed with it). Here, not
 * with the pane's view: the tab strip closes panes too, and the shell must not load a chat's code to paint itself.
 */
export function closePane(id: string, title: string | null): string | null {
  const to = panes.close(id);
  const left = tree.leaves(panes.get().root).length;
  announce(`Closed ${title ?? "the empty pane"}${to !== null ? " and its tab." : `. ${left === 0 ? "No panes left." : `${left} ${left === 1 ? "pane" : "panes"} left.`}`}`);
  return to;
}

/** Says a split-view change to screen readers (one polite live region per window). */
export function announce(text: string): void {
  if (!live) {
    live = document.createElement("div");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.className = "sr-only";
    document.body.append(live);
  }
  // Clear first so the same sentence twice is read twice.
  live.textContent = "";
  requestAnimationFrame(() => {
    if (live) live.textContent = text;
  });
}
