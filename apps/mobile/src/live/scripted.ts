// The script's runtime for the agent's screens: what a runtime connection would send about a chat's browser and
// computer, made from the scripted world (Chat.screens and Chat.using, board/world.ts) and behind the LiveSource a
// client's would be (live/protocol.ts). Its states say who drives and whether the agent is at it (`active`). While a
// view holds the screencast and the agent has the screen, the agent's cursor goes round the drawing's path, clicking as
// it goes (`*.pointer` move, then click, then a new frame). Your input lands only once you have taken the screen
// (`*.control` "user"), and never on a Mac's computer, as the runtime refuses it; a pointer released on a control
// presses it.
import { type Chat, deviceById } from "../board/model";
import { store } from "../store/store";
import type { Controller, InputEvent, LiveFrame, LivePointer, LiveSource, Screen, ScreenState } from "./protocol";
import { FIRST_PAGE, PAGES, type PageState, press, spotAt } from "./pages";

/** How long the agent's cursor takes between stops, settling before it clicks. */
const MOVE_MS = 650;

const chatOf = (id: string) => store.get().board.chats.find((c) => c.id === id);

/**
 * The agent is using `screen` right now. A client hears it as `active` states, every few seconds while the agent keeps
 * at it, and holds it for 15 s after the last or until the turn ends (the desktop's panels/live/float.ts); the
 * script knows it from the turn it plays.
 */
export const inUse = (chat: Chat, screen: Screen) => chat.phase === "working" && chat.using === screen;

/**
 * The screens the agent has opened in a chat, as the floating row lists them: the one in use first, then the ones it
 * used and left. A client lists the screens it has had a state for.
 */
export function screensOf(chat: Chat): { screen: Screen; live: boolean }[] {
  return (["browser", "computer"] as const)
    .filter((screen) => !!chat.screens?.[screen])
    .map((screen) => ({ screen, live: inUse(chat, screen) }))
    .sort((a, b) => Number(b.live) - Number(a.live));
}

/**
 * A screen streams once the agent has opened it: its browser on any computer; a Cloud computer's desktop; on a Mac the
 * window of the app it used (agent-desktop). A runtime answers `unsupported` before that, or where a Mac can't.
 */
export const canStream = (chat: Chat, screen: Screen) => !!chat.screens?.[screen];

/**
 * Whether the person's touches can drive the screen: the browser and a Cloud desktop take `*.input`; a Mac's computer
 * doesn't (Take over pauses the agent and brings its app forward there, for that Mac's own mouse).
 */
export const takesInput = (chat: Chat, screen: Screen) => screen === "browser" || deviceById(chat.device).kind === "cloud";

const same = (a: ScreenState | null, b: ScreenState | null) => JSON.stringify(a) === JSON.stringify(b);

const sources = new Map<string, LiveSource>();

/** The source for one chat's screen, one per chat and screen, so every view of it shares its state. */
export function sourceFor(chatId: string, screen: Screen): LiveSource {
  const key = `${screen}:${chatId}`;
  let source = sources.get(key);
  if (!source) sources.set(key, (source = create(chatId, screen)));
  return source;
}

function create(chatId: string, screen: Screen): LiveSource {
  const frames = new Set<(f: LiveFrame) => void>();
  const states = new Set<(s: ScreenState) => void>();
  const pointers = new Set<(p: LivePointer) => void>();
  /** Who wants frames. */
  const holders = new Map<object, number>();
  let page: PageState = FIRST_PAGE;
  /** A person holds the screen. */
  let held = false;
  let seq = 0;
  let stop = 0;
  let last: ScreenState | null = null;
  let frame: LiveFrame | null = null;
  let hand: ReturnType<typeof setTimeout> | null = null;
  let unwatch: (() => void) | null = null;

  const shows = () => chatOf(chatId)?.screens?.[screen];
  const controllerOf = (chat: Chat): Controller => (held ? "user" : inUse(chat, screen) ? "agent" : "none");

  const stateOf = (): ScreenState | null => {
    const chat = chatOf(chatId);
    const what = chat?.screens?.[screen];
    if (!chat || !what) return null;
    const common = { workspace_id: chatId, controller: controllerOf(chat), ...(inUse(chat, screen) ? { active: true as const } : null) };
    if ("url" in what) return { ...common, url: what.url, title: what.title, loading: false, can_go_back: false, can_go_forward: false };
    const view = PAGES[what.view];
    return { ...common, width: view.width, height: view.height, ...(what.app ? { app: what.app } : null) };
  };

  const draw = () => {
    const what = shows();
    if (!what) return;
    const view = PAGES[what.view];
    const next: LiveFrame = { workspace_id: chatId, drawn: what.view, page, width: view.width, height: view.height };
    frame = next;
    frames.forEach((l) => l(next));
  };

  const point = (x: number, y: number, phase: LivePointer["phase"]) => {
    const p: LivePointer = { workspace_id: chatId, x, y, phase, seq: ++seq };
    pointers.forEach((l) => l(p));
  };

  /** The agent's hand: round the path while someone watches and the agent has the screen. */
  const drive = () => {
    const acting = holders.size > 0 && last?.controller === "agent";
    if (!acting) {
      if (hand) clearTimeout(hand);
      hand = null;
      return;
    }
    if (hand) return;
    const next = () => {
      const what = shows();
      const path = what ? PAGES[what.view].path : [];
      const at = path[stop++ % Math.max(1, path.length)];
      if (!at) return;
      point(at.x, at.y, "move");
      hand = setTimeout(() => {
        if (at.click) {
          point(at.x, at.y, "click");
          page = press(page, at.click);
          draw();
        }
        hand = setTimeout(next, at.wait ?? 900);
      }, MOVE_MS);
    };
    hand = setTimeout(next, 300);
  };

  /** A new state when something changed: the chat moved on, or someone took or handed back the screen. */
  const publish = () => {
    const next = stateOf();
    if (!next || same(last, next)) return;
    last = next;
    states.forEach((l) => l(next));
    drive();
  };

  // The store is read only while someone listens or watches, as each change lands (not on the next frame), so the
  // state is never behind the chat, as a runtime's notification is applied when it arrives.
  const watch = () => {
    if (!unwatch) unwatch = store.watch(() => publish());
  };
  const settle = () => {
    if (unwatch && states.size + frames.size + pointers.size + holders.size === 0) {
      unwatch();
      unwatch = null;
    }
  };
  const listen = <T>(set: Set<(v: T) => void>, listener: (v: T) => void) => {
    watch();
    set.add(listener);
    return () => {
      set.delete(listener);
      settle();
    };
  };

  return {
    screen,
    get state() {
      // Read fresh when nobody watches; either way the same object until something in it changes, as a view's
      // snapshot must be.
      if (!unwatch) {
        const next = stateOf();
        if (!same(last, next)) last = next;
      }
      return last;
    },
    get frame() {
      return frame;
    },
    start: (holder, maxFps) => {
      const chat = chatOf(chatId);
      if (!chat || !canStream(chat, screen)) return Promise.resolve("unavailable");
      holders.set(holder, maxFps);
      watch();
      publish();
      if (!frame) draw();
      drive();
      return Promise.resolve("live");
    },
    stop: (holder) => {
      holders.delete(holder);
      drive();
      settle();
    },
    onFrame: (l) => listen(frames, l),
    onState: (l) => listen(states, l),
    onPointer: (l) => listen(pointers, l),
    control: (controller) => {
      held = controller === "user";
      publish();
      return Promise.resolve(last?.controller ?? "none");
    },
    input: (...events: InputEvent[]) => {
      const chat = chatOf(chatId);
      // Refused, as the runtime refuses it: from someone who hasn't taken the screen, or on a Mac's computer at all.
      if (!held || !chat || !takesInput(chat, screen)) return;
      const what = shows();
      if (!what) return;
      for (const e of events) {
        if (e.type !== "pointer" || e.action !== "up") continue;
        const spot = spotAt(PAGES[what.view], e.x, e.y);
        if (!spot) continue;
        page = press(page, spot);
        draw();
      }
    },
  };
}
