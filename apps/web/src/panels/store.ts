// The side panel's state: per workspace, an ordered list of tabs and the
// active one. Modelled on upstream rightPanelStore (MIT,
// apps/web/src/rightPanelStore.ts @ ab3a3cd1), cut down: the store holds tab
// descriptors only; each surface owns its resource (a terminal's PTY, a
// browser session) and does its own cleanup. No side effects in here.
//
// A tab can also show as a pane of its own in the split view (panes/store.ts
// hosts it, `setTabHost`). It stays here, its workspace's, so what a surface
// owns and names keeps working; `getPanel` and `usePanel` give the panel as it
// shows, without the hosted tabs, and `getTabs`/`useTab` give every tab.
//
// Other modules open tabs with `openSurface(workspaceId, kind, params)` and
// add surface kinds by augmenting `SurfaceParams` and calling
// `defineSurface` (registry.ts):
//
//   declare module "../../panels/store.ts" {
//     interface SurfaceParams { artifact: { itemId: string } }
//   }

import { useRef, useSyncExternalStore } from "react";

/** Every surface kind and the params its tab carries. Augment to add a kind. */
export interface SurfaceParams {
  /** The pane's cards: Environment, Context, Connectors, Outputs, Changes, then the agent's live screens and agents. `agent`: open that agent's page over them, once (a native subagent's item id, a builder's workspace id). */
  overview: { agent?: string | undefined };
  /** The launcher a fresh tab shows: tools, local servers, recent pages. */
  new: {};
  /** `agent`: the runtime's browser, streamed; the agent drives, the user can take over. `local`: a page this client loads itself. */
  browser: { url?: string; backend?: "agent" | "local"; /** An HTML file on the workspace computer, not on this client. */ path?: string; source?: boolean; line?: number };
  /** A shell in the workspace, or one command (`command`) such as the Run button's. `terminalId` is the runtime's, once it exists. */
  terminal: { command?: string; terminalId?: string | undefined };
  /** The tree with no file open; `path` is a folder to show (expanded and scrolled to). */
  files: { path?: string };
  /** One file: code, or rendered markdown. `line` scrolls to a line. */
  file: { path: string; ref?: string; line?: number };
  /**
   * The workspace's changes; `path` selects one file. `turn`: one finished turn's, by the checkpoint it ended at.
   * `item`: one file-change step's own recorded diff (its tool row's item id), not the checkout's.
   */
  diff: { path?: string; turn?: string; item?: string };
  /** The lead's builders and what each is doing. `only`: just these (its result row's builders left out), by id, else title. */
  agents: { only?: { ids: string[]; titles: string[] } | undefined };
  /** The computer's screen, streamed; the agent drives, the user can take over. */
  computer: {};
  /** The project's commands one click away, each with its last run (docs/computer-config.md "Actions"). */
  actions: {};
}

export type SurfaceKind = keyof SurfaceParams;

export interface Tab<K extends SurfaceKind = SurfaceKind> {
  readonly id: string;
  readonly kind: K;
  readonly params: SurfaceParams[K];
  /** Set by the surface (page title, shell cwd); the registry's title is the fallback. */
  readonly title?: string;
  /**
   * Something changed in a tab the user isn't looking at. Cleared when it is activated. `pulse`: something put there
   * for them that they didn't open (a Chief's Smart View): the mark pulses blue until they look.
   */
  readonly attention?: boolean | "pulse";
  /** Bumped each time the tab is opened again, so a surface can re-reveal (scroll to `line`) the same params. */
  readonly reveal: number;
}

export interface PanelState {
  /** Hiding is not closing: tabs survive a closed panel. */
  readonly open: boolean;
  readonly maximized: boolean;
  readonly active: string | null;
  readonly tabs: ReadonlyArray<Tab>;
  /** Panel width in px, committed on resize end. Null: the default. */
  readonly width: number | null;
}

export const EMPTY_PANEL: PanelState = { open: false, maximized: false, active: null, tabs: [], width: null };

/** The split view, as the panels see it: which tabs it shows as panes, and how to bring one into view. */
export interface TabHost {
  hosts(workspaceId: string, tabId: string): boolean;
  /** Bring the pane showing this tab to the front and focus it. */
  reveal(workspaceId: string, tabId: string): void;
  /** A hosted tab gave its place to another (`openSurface` with `replace`): the pane shows that one now. */
  retarget(workspaceId: string, fromId: string, toId: string): void;
}

const NO_HOST: TabHost = { hosts: () => false, reveal: () => {}, retarget: () => {} };
let host: TabHost = NO_HOST;
let hostVersion = 0;

/** How a kind names its tabs. `one`: the kind itself. A function: a stable id from the params (a file's path). Else `kind:<n>`. */
export type TabIdentity<K extends SurfaceKind> = "one" | "many" | ((params: SurfaceParams[K]) => string);

const identities = new Map<SurfaceKind, TabIdentity<never>>();

/** Called by `defineSurface`; kept here so the store has no dependency on React components. */
export function setTabIdentity<K extends SurfaceKind>(kind: K, identity: TabIdentity<K>): void {
  identities.set(kind, identity as TabIdentity<never>);
}

// ------------------------------------------------------------------- store

const STORAGE_KEY = "caveman.panels.v1";
/** Workspaces kept in storage, most recently touched first. */
const MAX_STORED = 40;

let byWorkspace: Record<string, PanelState> = load();
const listeners = new Set<() => void>();
let counter = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Record<string, PanelState> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<PanelState>>;
    const out: Record<string, PanelState> = {};
    for (const [id, s] of Object.entries(parsed)) {
      const tabs = Array.isArray(s.tabs)
        ? s.tabs.filter((t): t is Tab => typeof t?.id === "string" && typeof t?.kind === "string" && typeof t.params === "object" && t.params !== null).map((t) => ({ ...t, attention: false, reveal: 0 }))
        : [];
      const active = tabs.some((t) => t.id === s.active) ? (s.active as string) : (tabs[0]?.id ?? null);
      out[id] = { open: Boolean(s.open) && tabs.length > 0, maximized: false, active, tabs, width: typeof s.width === "number" ? s.width : null };
    }
    return out;
  } catch {
    return {};
  }
}

function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const kept = Object.entries(byWorkspace).slice(-MAX_STORED);
  // Maximized and attention are session state; a reload opens the panel at its normal size.
  const out = Object.fromEntries(kept.map(([id, s]) => [id, { open: s.open, active: s.active, width: s.width, tabs: s.tabs.map(({ id: tid, kind, params, title }) => ({ id: tid, kind, params, title })) }]));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Storage full or blocked: the panel keeps working for this session.
  }
}

function save(): void {
  if (saveTimer || typeof localStorage === "undefined") return;
  saveTimer = setTimeout(flush, 250);
}

// A reload right after a change still finds it. ponytail: last writer wins between two windows; listen to `storage` if the app ever opens a second one.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => saveTimer && flush());

function get(workspaceId: string): PanelState {
  return byWorkspace[workspaceId] ?? EMPTY_PANEL;
}

const views = new WeakMap<PanelState, { version: number; view: PanelState }>();

/**
 * The panel as it shows: without the tabs the split view hosts. The active tab falls to the nearest one left (the
 * next, else the one before), and with none left the panel is closed. The same object until something changes.
 */
function shown(workspaceId: string): PanelState {
  const s = get(workspaceId);
  const cached = views.get(s);
  if (cached?.version === hostVersion) return cached.view;
  let view = s;
  if (s.tabs.some((t) => host.hosts(workspaceId, t.id))) {
    const tabs = s.tabs.filter((t) => !host.hosts(workspaceId, t.id));
    const at = s.tabs.findIndex((t) => t.id === s.active);
    const active = tabs.some((t) => t.id === s.active) ? s.active : ((s.tabs.slice(at + 1).find((t) => tabs.includes(t)) ?? s.tabs.slice(0, Math.max(at, 0)).reverse().find((t) => tabs.includes(t)))?.id ?? null);
    view = { ...s, tabs, active, open: s.open && tabs.length > 0, maximized: s.maximized && tabs.length > 0 };
  }
  views.set(s, { version: hostVersion, view });
  return view;
}

function set(workspaceId: string, next: PanelState): void {
  if (next === get(workspaceId)) return;
  // Re-insert so the most recently touched workspace sorts last; save keeps the last MAX_STORED.
  const { [workspaceId]: _, ...rest } = byWorkspace;
  byWorkspace = next.tabs.length === 0 && !next.open && next.width === null ? rest : { ...rest, [workspaceId]: next };
  save();
  for (const l of listeners) l();
}

function update(workspaceId: string, f: (s: PanelState) => PanelState): void {
  set(workspaceId, f(get(workspaceId)));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The panel of one workspace as it shows (no hosted tabs). Re-renders only when that workspace's panel changes. */
export function usePanel(workspaceId: string): PanelState {
  return useSyncExternalStore(subscribe, () => shown(workspaceId));
}

/** The panel as it shows: its strip leaves out the tabs the split view hosts. */
export function getPanel(workspaceId: string): PanelState {
  return shown(workspaceId);
}

/** Every tab of a workspace, the hosted ones included: what a surface looks itself up in. */
export function getTabs(workspaceId: string): ReadonlyArray<Tab> {
  return get(workspaceId).tabs;
}

/** One tab, wherever it shows; null once it is closed. */
export function useTab(workspaceId: string, tabId: string): Tab | null {
  return useSyncExternalStore(subscribe, () => get(workspaceId).tabs.find((t) => t.id === tabId) ?? null);
}

/** Several tabs, wherever they show (each null once closed): the window's tab strip names a tab of them by these. */
export function useTabsOf(refs: ReadonlyArray<{ readonly workspaceId: string; readonly id: string }>): ReadonlyArray<Tab | null> {
  const last = useRef<ReadonlyArray<Tab | null>>([]);
  return useSyncExternalStore(subscribe, () => {
    const next = refs.map((r) => get(r.workspaceId).tabs.find((t) => t.id === r.id) ?? null);
    if (next.length === last.current.length && next.every((t, i) => t === last.current[i])) return last.current;
    return (last.current = next);
  });
}

/** The split view tells the panels what it hosts (panes/store.ts), once, and `hostChanged` whenever that changes. */
export function setTabHost(next: TabHost): void {
  host = next;
  hostChanged();
}

export function hostChanged(): void {
  hostVersion++;
  for (const l of listeners) l();
}

export const isHosted = (workspaceId: string, tabId: string): boolean => host.hosts(workspaceId, tabId);

/**
 * Whether a tab can land in another workspace's panel (`moveTabTo`). Not when that workspace already shows the same
 * thing in a pane of its own: the drop would only bring that pane forward, and the panel would gain nothing.
 */
export function canMoveTabTo(fromWorkspaceId: string, tabId: string, toWorkspaceId: string): boolean {
  const tab = get(fromWorkspaceId).tabs.find((t) => t.id === tabId);
  if (!tab || fromWorkspaceId === toWorkspaceId) return false;
  const twin = idFor(tab.kind, tab.params as never);
  return twin === null || !get(toWorkspaceId).tabs.some((t) => t.id === twin) || !host.hosts(toWorkspaceId, twin);
}

// ----------------------------------------------------------------- actions

export interface OpenOptions {
  /** Make it the active tab and open the panel (default). False adds it quietly with an attention mark, for opens the user didn't ask for. */
  readonly focus?: boolean;
  /** Put the tab where this one is and close this one (a launcher tab becoming what it opened). */
  readonly replace?: string;
  /** With `focus: false`: its attention mark pulses (Tab.attention "pulse") until the user looks. */
  readonly pulse?: boolean;
  /** With `focus: false`: no attention mark either, for a tab that is always there (a Chief's Work). */
  readonly quiet?: boolean;
}

/**
 * Open a tab, or activate the one already showing the same thing. Returns its id. A tab the split view hosts is shown
 * in its pane instead; one that replaces a hosted tab takes its pane.
 */
export function openSurface<K extends SurfaceKind>(workspaceId: string, kind: K, params: SurfaceParams[K], options: OpenOptions = {}): string {
  const focus = options.focus ?? true;
  const id = idFor(kind, params) ?? `${kind}:${Date.now().toString(36)}${(counter++).toString(36)}`;
  // The pane moves to the new tab before the panel changes: it never shows the old one closed.
  const inPane = options.replace !== undefined && options.replace !== id && host.hosts(workspaceId, options.replace) && !host.hosts(workspaceId, id);
  if (inPane) host.retarget(workspaceId, options.replace!, id);
  const hosted = host.hosts(workspaceId, id);
  update(workspaceId, (s) => {
    const existing = s.tabs.find((t) => t.id === id);
    const seen = focus || (s.open && s.active === id) || hosted;
    // Params merge, so what a surface stored (a terminal's id) survives a re-open. A file's `line` is a one-shot
    // reveal: re-opening without one doesn't scroll back to the last.
    const merged: Record<string, unknown> = existing ? { ...existing.params, ...params } : params;
    if (existing && (kind === "file" || (kind === "browser" && "path" in params)) && !("line" in params)) delete merged.line;
    // Changes opened without a turn shows them all again; only the checkpoint row's Changes picks one turn.
    if (existing && kind === "diff" && !("turn" in params)) delete merged.turn;
    // Likewise one step's diff: Changes opened any other way shows the checkout's again.
    if (existing && kind === "diff" && !("item" in params)) delete merged.item;
    // And the file a turn's row revealed: Changes opened without one doesn't scroll back to it and expand it again.
    if (existing && kind === "diff" && !("path" in params)) delete merged.path;
    const mark = seen || options.quiet ? false : options.pulse ? "pulse" : true;
    const tab: Tab = existing ? ({ ...existing, params: merged, reveal: existing.reveal + 1, attention: mark } as Tab) : { id, kind, params, reveal: 0, ...(mark ? { attention: mark } : {}) };
    // Opening a file replaces the bare tree tab: the file view carries the tree. A tree in a pane of its own stays.
    let tabs = existing ? s.tabs.map((t) => (t.id === id ? tab : t)) : [...s.tabs.filter((t) => !(kind === "file" && t.kind === "files" && !host.hosts(workspaceId, t.id))), tab];
    if (options.replace && options.replace !== id && tabs.some((t) => t.id === options.replace)) {
      const rest = tabs.filter((t) => t.id !== id);
      tabs = rest.toSpliced(rest.findIndex((t) => t.id === options.replace), 1, tab);
    }
    if (hosted) return { ...s, tabs, active: tabs.some((t) => t.id === s.active) ? s.active : null };
    if (focus) return { ...s, tabs, open: true, active: id };
    return { ...s, tabs, active: tabs.some((t) => t.id === s.active) ? s.active : id };
  });
  if (hosted && focus && !inPane) host.reveal(workspaceId, id);
  return id;
}

/** The id a tab of this kind and params has in any panel; null for a kind whose every open is a tab of its own. */
export function idFor<K extends SurfaceKind>(kind: K, params: SurfaceParams[K]): string | null {
  const identity = (identities.get(kind) ?? "many") as TabIdentity<K>;
  return identity === "one" ? kind : identity === "many" ? null : `${kind}:${identity(params)}`;
}

/** Show a tab: in the panel, or in the pane that hosts it. */
export function activateTab(workspaceId: string, tabId: string): void {
  if (host.hosts(workspaceId, tabId)) return host.reveal(workspaceId, tabId);
  update(workspaceId, (s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab || (s.open && s.active === tabId && !tab.attention)) return s;
    return { ...s, open: true, active: tabId, tabs: tab.attention ? s.tabs.map((t) => (t === tab ? { ...t, attention: false } : t)) : s.tabs };
  });
}

/** Close tabs. The tab at the closed one's place becomes active (right neighbour, else left); no tabs left closes the panel. */
export function closeTabs(workspaceId: string, which: (tab: Tab, index: number, tabs: ReadonlyArray<Tab>) => boolean): void {
  update(workspaceId, (s) => {
    const tabs = s.tabs.filter((t, i) => !which(t, i, s.tabs));
    if (tabs.length === s.tabs.length) return s;
    let active = s.active;
    if (!tabs.some((t) => t.id === active)) {
      const at = s.tabs.findIndex((t) => t.id === s.active);
      const after = s.tabs.slice(at + 1).find((t) => tabs.includes(t));
      const before = s.tabs.slice(0, Math.max(at, 0)).reverse().find((t) => tabs.includes(t));
      active = (after ?? before ?? null)?.id ?? null;
    }
    return { ...s, tabs, active, open: tabs.length > 0 && s.open, maximized: tabs.length > 0 && s.maximized };
  });
}

export const closeTab = (workspaceId: string, tabId: string) => closeTabs(workspaceId, (t) => t.id === tabId);

export function moveTab(workspaceId: string, tabId: string, toIndex: number): void {
  update(workspaceId, (s) => {
    const from = s.tabs.findIndex((t) => t.id === tabId);
    if (from < 0 || from === toIndex) return s;
    const tabs = [...s.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab!);
    return { ...s, tabs };
  });
}

/** Let a surface name its tab, flag it, or remember what it owns (`params`, merged: a terminal's id). Unknown tabs are ignored (the tab closed meanwhile). */
export function updateTab(workspaceId: string, tabId: string, patch: { title?: string; attention?: boolean | "pulse"; params?: Record<string, unknown> }): void {
  update(workspaceId, (s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const attention = patch.attention && s.open && s.active === tabId ? false : (patch.attention ?? tab.attention ?? false);
    const params = patch.params && Object.entries(patch.params).some(([k, v]) => (tab.params as Record<string, unknown>)[k] !== v) ? { ...tab.params, ...patch.params } : tab.params;
    if ((patch.title ?? tab.title) === tab.title && attention === (tab.attention ?? false) && params === tab.params) return s;
    return { ...s, tabs: s.tabs.map((t) => (t.id === tabId ? ({ ...t, ...(patch.title !== undefined ? { title: patch.title } : {}), attention, params } as Tab) : t)) };
  });
}

/** Show or hide the panel. Showing an empty panel (every tab hosted counts) opens a launcher tab. */
export function setPanelOpen(workspaceId: string, open: boolean): void {
  if (open && shown(workspaceId).tabs.length === 0) return void openSurface(workspaceId, "new", {});
  update(workspaceId, (s) => {
    if (s.open === open) return s;
    // The tab that comes into view is seen.
    const tabs = open ? s.tabs.map((t) => (t.id === s.active && t.attention ? { ...t, attention: false } : t)) : s.tabs;
    return { ...s, open, maximized: open && s.maximized, tabs };
  });
}

/**
 * A kind's key or menu row (⌃` for Terminal, Files, Changes): show its last tab, or hide the panel when that tab is
 * already in front. Files counts its open files. With none in the strip, one in a pane of its own comes forward there;
 * with none at all, a new one opens.
 */
export function toggleSurface(workspaceId: string, kind: SurfaceKind): void {
  const match = (t: Tab) => t.kind === kind || (kind === "files" && t.kind === "file");
  const s = shown(workspaceId);
  const last = [...s.tabs].reverse().find(match) ?? [...get(workspaceId).tabs].reverse().find(match);
  if (last && s.open && s.active === last.id) setPanelOpen(workspaceId, false);
  else if (last) activateTab(workspaceId, last.id);
  else openSurface(workspaceId, kind, {} as never);
}

/**
 * A tab leaves the strip for a pane of its own: the panel goes on with the tab beside it, or hides when that was its
 * last. Call before the split view hosts it.
 */
export function stepAside(workspaceId: string, tabId: string): void {
  update(workspaceId, (s) => {
    if (s.active !== tabId) return s;
    const rest = s.tabs.filter((t) => t.id !== tabId && !host.hosts(workspaceId, t.id));
    const at = s.tabs.findIndex((t) => t.id === tabId);
    const next = s.tabs.slice(at + 1).find((t) => rest.includes(t)) ?? s.tabs.slice(0, at).reverse().find((t) => rest.includes(t));
    return { ...s, active: next?.id ?? null, open: s.open && next !== undefined, maximized: s.maximized && next !== undefined };
  });
}

/**
 * A tab goes to another workspace's panel, in front there (a pull request dragged from one chat's panel to another's).
 * Only for tabs that don't depend on their workspace (`portable`): it keeps its params and title; nothing it owns ends.
 * Returns its id there.
 */
export function moveTabTo(fromWorkspaceId: string, tabId: string, toWorkspaceId: string): string | null {
  const tab = get(fromWorkspaceId).tabs.find((t) => t.id === tabId);
  if (!tab || !canMoveTabTo(fromWorkspaceId, tabId, toWorkspaceId)) return null;
  const id = openSurface(toWorkspaceId, tab.kind, tab.params as never);
  if (tab.title) updateTab(toWorkspaceId, id, { title: tab.title });
  closeTabs(fromWorkspaceId, (t) => t.id === tabId);
  return id;
}

export function setMaximized(workspaceId: string, maximized: boolean): void {
  update(workspaceId, (s) => (s.maximized === maximized ? s : { ...s, maximized, open: s.open || maximized }));
}

/** Null puts it back to the default. */
export function setPanelWidth(workspaceId: string, width: number | null): void {
  const w = width === null ? null : Math.round(width);
  update(workspaceId, (s) => (s.width === w ? s : { ...s, width: w }));
}

/** Test hook: forget every panel (and the split view's hosting). */
export function resetPanels(): void {
  byWorkspace = {};
  host = NO_HOST;
  hostChanged();
}
