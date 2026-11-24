// Where the app opens. A deep link or a notification wins (caveman://chat/<id>, caveman://chief/<id>); else the chat
// or Chief you left less than 30 minutes ago, if it is still there, as the main panel's root (a subagent over its
// parents), with its draft in its box; else a new chat. Nothing goes under it: its top left is the sidebar's button
// (shell/DrawerLayout.tsx), as when the sidebar opened it. The keyboard rises on the first tap, never on launch. The
// screen you are on is written to cc/v1/boot as you move (the shell calls `saveRoute`), and when you left it is noted
// as the app goes to the background.
import { CHIEFS } from "../board/model";
import { KEYS, onLeave, read, write } from "./persist";
import { store } from "./store";

/** A screen the app can open on: a new chat (Home), a chat or a Chief. */
export type LaunchRoute = { to: "home" } | { to: "chat"; id: string } | { to: "chief"; id: string };
/** Any screen the shell is on; only a chat or a Chief is ever reopened. */
export interface SavedRoute {
  to: string;
  id?: string;
}

export interface Boot {
  /** The screen you were on. */
  route: SavedRoute | null;
  /** When you went there. */
  at: number;
  /** When you left the app from it, if you did. */
  leftAt: number | null;
}

/** How long the last screen is worth going back to. */
export const RESTORE_MS = 30 * 60_000;
const HOME: LaunchRoute = { to: "home" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function bootFromDisk(data: unknown): Boot | null {
  if (!isObject(data) || typeof data.at !== "number") return null;
  const r = data.route;
  const route = isObject(r) && typeof r.to === "string" ? { to: r.to, id: typeof r.id === "string" ? r.id : undefined } : null;
  return { route, at: data.at, leftAt: typeof data.leftAt === "number" ? data.leftAt : null };
}

/** The boot record as this launch found it (before anything this launch saved). */
export const BOOT: Boot | null = read(KEYS.boot, bootFromDisk);
let boot: Boot = BOOT ?? { route: null, at: 0, leftAt: null };

/** The shell calls this on every navigation: the screen now on top. */
export function saveRoute(route: SavedRoute) {
  if (boot.route?.to === route.to && boot.route.id === route.id && boot.leftAt === null) return;
  boot = { route: { to: route.to, id: route.id }, at: Date.now(), leftAt: null };
  write(KEYS.boot, () => boot);
}

// Leaving the app notes when, so the next launch knows how long ago it was.
onLeave(() => {
  if (!boot.route) return;
  boot = { ...boot, leftAt: Date.now() };
  write(KEYS.boot, () => boot);
});

/** A chat (not archived) or a Chief that is there to open. */
function exists(route: LaunchRoute): boolean {
  if (route.to === "home") return true;
  if (route.to === "chief") return CHIEFS.some((c) => c.id === route.id);
  const s = store.get();
  return s.board.chats.some((c) => c.id === route.id) && !s.inbox.archived[route.id];
}

/** For a subagent, its parents and then itself, what Back walks up through; anything else alone, as the root. */
export function stackFor(route: LaunchRoute): LaunchRoute[] {
  if (route.to !== "chat") return [route];
  const chats = store.get().board.chats;
  const chain: LaunchRoute[] = [route];
  let parent = chats.find((c) => c.id === route.id)?.parent;
  // Bounded, in case a parent link ever loops.
  for (let depth = 0; parent && depth < 8; depth++) {
    chain.unshift({ to: "chat", id: parent });
    parent = chats.find((c) => c.id === parent)?.parent;
  }
  return chain;
}

/**
 * The chat or Chief a link names: caveman://chat/<id>, any URL with /chat/<id> or /chief/<id> in its path (Expo Go's
 * exp://…/--/chat/<id>, the web build's), or ?chat=<id> / ?chief=<id>.
 */
export function routeFromUrl(url: string): LaunchRoute | null {
  const path = url.match(/(?:^caveman:\/\/|\/)(chat|chief)\/([^/?#]+)/i);
  if (path) return { to: path[1]!.toLowerCase() as "chat" | "chief", id: decodeURIComponent(path[2]!) };
  const query = url.split("?")[1]?.split("#")[0];
  if (!query) return null;
  const params = new URLSearchParams(query);
  const chat = params.get("chat");
  if (chat) return { to: "chat", id: chat };
  const chief = params.get("chief");
  return chief ? { to: "chief", id: chief } : null;
}

/** The stack to open on: a link, else what you left under RESTORE_MS ago, else a new chat. Top of the stack is last. */
export function launchRoute(saved: Boot | null, now: number, url?: string | null, there: (route: LaunchRoute) => boolean = exists): LaunchRoute[] {
  const link = url ? routeFromUrl(url) : null;
  if (link && there(link)) return stackFor(link);
  const r = saved?.route;
  const left = saved?.leftAt ?? saved?.at ?? 0;
  if (r?.id && (r.to === "chat" || r.to === "chief") && now - left < RESTORE_MS) {
    const route: LaunchRoute = { to: r.to, id: r.id };
    if (there(route)) return stackFor(route);
  }
  return [HOME];
}

/** The web build's address, as a launch link. Native reads its link with Linking.getInitialURL and passes it in. */
export const webUrl = (): string | null => (typeof location !== "undefined" && typeof location.href === "string" ? location.href : null);

/** Takes ?chat= and ?chief= off the web build's address once read, so a reload later opens where you were instead. */
function followedWebLink() {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("chat") && !url.searchParams.has("chief")) return;
    url.searchParams.delete("chat");
    url.searchParams.delete("chief");
    history.replaceState(history.state, "", url.toString());
  } catch {}
}

/** This launch's stack: launchRoute over the boot record this launch found, now, and the web build's address. */
export function launchStack(url: string | null = webUrl()): LaunchRoute[] {
  const stack = launchRoute(BOOT, Date.now(), url);
  if (url === webUrl()) followedWebLink();
  return stack;
}
