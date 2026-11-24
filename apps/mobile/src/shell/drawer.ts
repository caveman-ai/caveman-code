// The sidebar that lives behind the main panel ("a simple depthful sidebar like this that lives
// behind the main panel and the main panel has some shadow", for clean mobile navigation). The main panel slides aside to
// show it; whether it is showing, and how it sorts its chats, is this small store. Opening a chat, a Chief or a new
// chat from it goes through nav/ref.ts (showChat, showChief, showNewChat), which also closes it.
//
// Two ways to read the chats: by project (folders, for clean mobile navigation) or as the queue (the hourglass), where the
// chats are sorted by their state in shelves, as upstream own sidebar sorts its threads.
//
// The app opens the sidebar the way you left it ("make sure loading the app also saves last sidebar state"): open or
// shut, projects or queue, and which sections were folded, read from disk before the first frame (expo-sqlite's
// localStorage on a phone, the browser's own on the web), like the rest of the snapshot (store/persist.ts).
//
// Where two columns fit (the iPhone Duo unfolded, shell/layout.tsx) the sidebar stands beside the panel instead of
// behind it: `docked` says whether it is standing there or tucked away for a wider panel, and `inspector` whether the
// screen's third column (a chat's details) is open. They are kept apart from `open`, which is the phone's slide, so
// folding the Duo shut never opens the phone on its sidebar.
import { createStore, useSelector } from "../store/core";

export type SidebarMode = "projects" | "queue";

/** How much of the main panel stays in view at the right while the sidebar shows (the compact layout, with its button). */
export const SIDEBAR_SLIVER = 52;

export interface DrawerState {
  open: boolean;
  mode: SidebarMode;
  /** Sections folded shut, by key ("chiefs", "pinned", "recent", "project:<repo>", "shelf:settled", a parent's subagents "agents:<id>"). */
  folded: readonly string[];
  /** Sections opened past their cut-off ("chiefs" shows a few until you ask for the rest). */
  expanded: readonly string[];
  /** Where two columns fit: the sidebar stands beside the panel (else it is tucked away). */
  docked: boolean;
  /** Where two columns fit: the inspector beside the panel is open. */
  inspector: boolean;
}

const KEY = "cc/v1/sidebar";

const FIRST: DrawerState = { open: false, mode: "projects", folded: ["shelf:settled", "shelf:snoozed"], expanded: [], docked: true, inspector: false };

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);

function saved(): DrawerState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return FIRST;
    const v = JSON.parse(raw) as Partial<Record<keyof DrawerState, unknown>>;
    return {
      open: v.open === true,
      mode: v.mode === "queue" ? "queue" : "projects",
      folded: strings(v.folded) ?? FIRST.folded,
      expanded: strings(v.expanded) ?? FIRST.expanded,
      docked: v.docked !== false,
      inspector: v.inspector === true,
    };
  } catch {
    return FIRST;
  }
}

export const drawer = createStore<DrawerState, (s: DrawerState) => DrawerState>(saved(), (s, change) => change(s));

// Every change is written at once: it is a few bytes, and a phone can be swiped away a moment after the sidebar moved.
drawer.subscribe(() => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(drawer.get()));
  } catch {
    // Private browsing and full disks: the sidebar just isn't remembered.
  }
});

const set = (patch: Partial<DrawerState>) => drawer.dispatch((s) => ({ ...s, ...patch }));

/** A slice of the sidebar's state; re-renders only when it changes. */
export const useDrawer = <T>(pick: (s: DrawerState) => T, equal?: (a: T, b: T) => boolean) => useSelector(drawer, pick, equal);

export const openSidebar = () => set({ open: true });
export const closeSidebar = () => set({ open: false });
export const setSidebarMode = (mode: SidebarMode) => set({ mode });
/** Where two columns fit: stand the sidebar beside the panel, or tuck it away. */
export const setDocked = (docked: boolean) => set({ docked });
/** Where two columns fit: open or close the inspector beside the panel. */
export const setInspector = (inspector: boolean) => set({ inspector });

/** Shows a section past its cut-off, or back to it. */
export const toggleExpanded = (key: string) => drawer.dispatch((s) => ({ ...s, expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key] }));
