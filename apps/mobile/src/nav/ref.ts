// The stack from outside a screen: the sidebar, Search, the toast's Open, Settings' Chiefs, archive's Undo. Screens use
// their own `navigation` (routes.ts `useNav`) for the rest. Two ways into a chat or a Chief: a jump from anywhere (the
// sidebar, Search, the toast, a link) makes it the main panel's root (`showChat`, `showChief`, `showNewChat` below),
// and a link inside a chat or a Chief (a subagent, a chat a Chief names) pushes it over what's showing (`openChat`,
// `openChief`), where the one rule of nav/moves.ts decides where it lands.
import { CommonActions, createNavigationContainerRef, StackActions } from "@react-navigation/native";
import { Platform } from "react-native";
import type { LaunchRoute } from "../store/launch";
import { closeSidebar, setInspector } from "../shell/drawer";
import { askerOf } from "../store/select";
import { store } from "../store/store";
import { chatMove, chiefMove, type Move } from "./moves";
import type { RootStackParamList, RouteName } from "./routes";

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** The screen on top: its name and, for a chat or a Chief, its id. */
export interface Focused {
  name: RouteName;
  id?: string;
}

export function focusedRoute(): Focused | null {
  if (!navigationRef.isReady()) return null;
  const route = navigationRef.getCurrentRoute();
  if (!route) return null;
  const params = route.params as { id?: unknown } | undefined;
  return { name: route.name as RouteName, id: typeof params?.id === "string" ? params.id : undefined };
}

/** What the launch rule keeps of a screen (store/launch.ts): a chat or a Chief by id, anything else by name. */
export function savedOf(route: Focused): { to: string; id?: string } {
  if (route.name === "Thread") return { to: "chat", id: route.id };
  if (route.name === "Chief") return { to: "chief", id: route.id };
  return { to: route.name.toLowerCase() };
}

/**
 * The stack the launch rule chose, as the navigator's first state: the chat or Chief at the root (a subagent over its
 * parents), or a new chat. Nothing goes under it: the root's top left is the sidebar's button, not Back.
 */
export function stateOf(stack: readonly LaunchRoute[]) {
  const routes = stack.map((r) =>
    r.to === "chat" ? { name: "Thread" as const, params: { id: r.id } } : r.to === "chief" ? { name: "Chief" as const, params: { id: r.id } } : { name: "Home" as const },
  );
  if (!routes.length) routes.push({ name: "Home" });
  return { index: routes.length - 1, routes };
}

/** The chats from the top of a subagent's family down to it: its parents first. */
function familyOf(id: string): string[] {
  const chats = store.get().board.chats;
  const chain = [id];
  let parent = chats.find((c) => c.id === id)?.parent;
  for (let depth = 0; parent && depth < 8; depth++) {
    chain.unshift(parent);
    parent = chats.find((c) => c.id === parent)?.parent;
  }
  return chain;
}

/** Carries out a move to a chat or a Chief (nav/moves.ts). `route` is what a replace puts in the top's place. */
function apply(move: Move, route: { name: "Thread"; params: { id: string } } | { name: "Chief"; params: { id: string; call?: number } }) {
  switch (move.kind) {
    case "stay":
      return;
    case "back":
      navigationRef.dispatch(StackActions.pop(move.count));
      return;
    case "replace":
      navigationRef.dispatch(StackActions.replace(route.name, route.params));
      return;
    case "push":
      if (route.name === "Chief") navigationRef.dispatch(StackActions.push("Chief", route.params));
      else pushChats(move.ids, route.params.id);
  }
}

/**
 * Pushes a chat and the parents going in under it. On a phone they land as one move, only the chat sliding in. The
 * web's history takes one entry per change of the stack (React Navigation's linking), so there each parent goes in as
 * a move of its own and the browser's Back walks up the family too; the rest follows once the linking has written the
 * parent's address (a microtask after the stack's state event, and this one is queued behind it, so nothing paints
 * between).
 */
function pushChats(ids: readonly string[], id: string) {
  const [first] = ids;
  if (!first) return;
  if (Platform.OS === "web" && ids.length > 1) {
    const off = navigationRef.addListener("state", () => {
      off();
      void Promise.resolve().then(() => {
        const top = focusedRoute();
        if (top?.name === "Thread" && top.id === first) openChat(id);
      });
    });
    navigationRef.dispatch(StackActions.push("Thread", { id: first }));
    return;
  }
  for (const chat of ids) navigationRef.dispatch(StackActions.push("Thread", { id: chat }));
}

/**
 * Opens a chat over whatever is showing (nav/moves.ts chatMove): nothing if it is on top already (a second tap in the
 * same frame), back to it if it is right under the top, and a subagent over its parent, as if you had come through it.
 * `inPlace`: it takes the top screen's place instead (the sibling strip, the up arrow, Next).
 */
export function openChat(id: string, how?: { inPlace?: boolean }) {
  const state = navigationRef.isReady() ? navigationRef.getRootState() : undefined;
  if (!state) return;
  apply(chatMove(state, familyOf(id), how?.inPlace ? "inPlace" : "push"), { name: "Thread", params: { id } });
}

/**
 * A row's chat, as a row opens it (a list, a workspace, Search): the subagent that asks when one does, its parent
 * going in under it, so the tap lands on the ask's dock and Back is the parent; else the chat itself.
 */
export function openRow(id: string) {
  openChat(rowTarget(id));
}

/** What a row opens: its subagent that asks, when one does, else the chat itself. */
function rowTarget(id: string): string {
  const chats = store.get().board.chats;
  const chat = chats.find((c) => c.id === id);
  const asker = chat ? askerOf(chat, chats) : null;
  return asker && asker.id !== id && asker.phase === "needs" ? asker.id : id;
}

/**
 * Opens a Chief (nav/moves.ts chiefMove): back to it when it is on the stack already, matched by its id, else pushed
 * over what's showing, or in the top screen's place with `inPlace` (its menu's other Chiefs, Next). `call` starts a
 * call as it shows.
 */
export function openChief(id: string, how?: { call?: number; inPlace?: boolean }) {
  const state = navigationRef.isReady() ? navigationRef.getRootState() : undefined;
  if (!state) return;
  const call = how?.call;
  const move = chiefMove(state, id, how?.inPlace ? "inPlace" : "push");
  apply(move, { name: "Chief", params: call ? { id, call } : { id } });
  // The Chief that was already there takes the call as a param of its own (screens/Chief.tsx starts it when it changes).
  if (call && (move.kind === "stay" || move.kind === "back") && move.key) navigationRef.dispatch({ ...CommonActions.setParams({ call }), source: move.key });
}

/**
 * Opens a pull request (pulls/PullScreen.tsx) over whatever is showing, by its repository on GitHub (owner/name) and
 * its number; the one already on top stays.
 */
export function openPull(repo: string, number: number) {
  const [owner, name] = repo.split("/");
  if (!navigationRef.isReady() || !owner || !name) return;
  const here = navigationRef.getCurrentRoute();
  const at = here?.params as { owner?: string; name?: string; number?: number } | undefined;
  if (here?.name === "Pull" && at?.owner === owner && at.name === name && at.number === number) return;
  navigationRef.dispatch(StackActions.push("Pull", { owner, name, number }));
}

// ---------------------------------------------------------------- the sidebar's ways into the main panel

type Root = { name: "Home" } | { name: "Review" } | { name: "Automations" } | { name: "Thread"; params: { id: string } } | { name: "Chief"; params: { id: string } };

/**
 * The routes that arrive without sliding in (nav/Navigator.tsx reads them for each screen's `animation`): a new root
 * swaps in place under the panel, which is itself sliding back over the sidebar, so a push from the right on top of
 * that would be two motions for one move. Let go once the swap has been drawn, so Back from a subagent the sidebar
 * opened still slides.
 */
const cuts = new Set<string>();
const cutHearers = new Set<() => void>();
let cutVersion = 0;
let cutSeq = 0;
let cutTimer: ReturnType<typeof setTimeout> | null = null;
const cutChanged = () => {
  cutVersion++;
  for (const hear of [...cutHearers]) hear();
};
export const isCut = (key: string) => cuts.has(key);
/** For the navigator: changes whenever the routes that arrive without sliding do. */
export const cutStore = {
  subscribe(hear: () => void) {
    cutHearers.add(hear);
    return () => void cutHearers.delete(hear);
  },
  version: () => cutVersion,
};

/**
 * What the sidebar opens becomes the main panel's root, so its top left is the sidebar's button and a swipe from the
 * left shows the sidebar again; only what you open from there (a subagent, a guide) is pushed over it. A subagent's
 * parents go in under it, so Back walks up the family. Each closes the sidebar; showing what is already showing just
 * closes it. Screens already in place keep theirs (and where they were scrolled); the rest swap in without sliding.
 */
function showRoots(routes: readonly Root[]) {
  closeSidebar();
  // Beside a sidebar that stays, the inspector belongs to the screen it was opened over: a new root starts without it,
  // so picking a chat in the sidebar never sends the sidebar away for the last chat's details.
  setInspector(false);
  if (!navigationRef.isReady() || !routes.length) return;
  const state = navigationRef.getRootState();
  const idOf = (params: unknown) => (params as { id?: string } | undefined)?.id;
  const matches = (i: number, r: Root) => state?.routes[i]?.name === r.name && idOf(state?.routes[i]?.params) === ("params" in r ? r.params.id : undefined);
  const same = !!state && state.routes.length === routes.length && routes.every((r, i) => matches(i, r));
  if (same) return;
  const seq = ++cutSeq;
  let kept = true;
  const next = routes.map((r, i) => {
    kept = kept && matches(i, r);
    const key = kept ? state!.routes[i]!.key : `${r.name}-root-${seq}-${i}`;
    return { ...r, key };
  });
  const top = state?.routes[state.index]?.key;
  for (const r of next) cuts.add(r.key);
  if (top) cuts.add(top);
  cutChanged();
  navigationRef.dispatch(CommonActions.reset({ index: next.length - 1, routes: next }));
  if (cutTimer) clearTimeout(cutTimer);
  cutTimer = setTimeout(() => {
    cutTimer = null;
    cuts.clear();
    cutChanged();
  }, 600);
}

/** The main panel shows a new chat. */
export const showNewChat = () => showRoots([{ name: "Home" }]);
/** The main panel shows a chat, a subagent over its parents. */
export const showChat = (id: string) => showRoots(familyOf(id).map((chat) => ({ name: "Thread" as const, params: { id: chat } })));
/**
 * The main panel shows one of the sidebar's places (Pull requests, Automations) as its root, like a chat or a Chief:
 * a swipe from the left there brings the sidebar back ("if im in a chat and then i click on pull
 * requests and then i swipe out of it, it takes me to the chat not the sidebar").
 */
export const showPlace = (name: "Review" | "Automations") => showRoots([{ name }]);
/** The main panel shows a Chief. */
export const showChief = (id: string) => showRoots([{ name: "Chief", params: { id } }]);
/** A row's chat as the main panel's root (a search result): the subagent that asks when one does, as `openRow` picks. */
export const showRow = (id: string) => showChat(rowTarget(id));
