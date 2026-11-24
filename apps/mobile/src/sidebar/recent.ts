// When you last opened each Chief, so the sidebar lists the ones you use first (Chiefs "sorted by
// recently accessed"). Opening one is heard from the shell's focused screen (shell/ui.ts `focused`), however you got
// there: the sidebar, a toast, a link, Back. It is kept on disk like the sidebar's own state (shell/drawer.ts):
// expo-sqlite's localStorage on a phone, the browser's on the web, read before the first frame so the order doesn't
// jump as the app opens.
import { createStore, useSelector } from "../store/core";
import { ui } from "../shell/ui";

type Opened = Readonly<Record<string, number>>;

const KEY = "cc/v1/sidebar-chiefs";

function saved(): Opened {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, at]) => typeof at === "number"));
  } catch {
    return {};
  }
}

export const opened = createStore<Opened, (s: Opened) => Opened>(saved(), (s, change) => change(s));

opened.subscribe(() => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(opened.get()));
  } catch {
    // Private browsing and full disks: the order just isn't remembered.
  }
});

/** A Chief was opened just now. */
export function noteChief(id: string, at = Date.now()) {
  opened.dispatch((s) => (s[id] === at ? s : { ...s, [id]: at }));
}

// The Chief on top, as last heard: arriving at one counts once, however long it stays on top.
let onTop: string | null = null;
function hear() {
  const focused = ui.get().focused;
  const id = focused?.name === "Chief" ? (focused.id ?? null) : null;
  if (id && id !== onTop) noteChief(id);
  onTop = id;
}
// A hot reload in development runs this file again: the listener it left behind goes first, so each opening counts once.
const g = globalThis as { __ccSidebarRecent?: () => void };
g.__ccSidebarRecent?.();
g.__ccSidebarRecent = ui.watch(hear);
hear();

/** When each Chief was last opened, by id. */
export const useOpened = () => useSelector(opened, (s) => s);
