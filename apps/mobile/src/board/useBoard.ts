// The board as screens have always read it: every chat, each Chief's lines and thoughts, the toast and the moment,
// and the actions (start, send, tellChief, allow, deny, stop…). It used to hold the board in a reducer of its own;
// now the board lives in the app's store (store/board.ts), kept on disk and alive across screens, and the scripted
// engine runs once for the app (board/script.ts). This hook is the facade over both, the same shape as before, so
// screens that take a `Board` keep working. New screens read the store's slices instead (store/select.ts), which
// re-render only what changed; this hook re-renders on every board change, as it always did.
import * as launch from "../store/launch";
import * as select from "../store/select";
import * as sessions from "../store/sessions";
import { isLive } from "../live/seams";
import { store, useStore } from "../store/store";
import * as script from "./script";

// The script starts with the app, not with a screen: a chat at work keeps working whatever is open.
script.ensureScript();
// So does the person's own board, once someone has signed in to Caveman here (live/link.ts, loaded only then).
if (isLive()) void import("../live/link").then((link) => link.refresh());

const actions = {
  start: script.start,
  send: script.send,
  tellChief: script.tellChief,
  endCall: script.endCall,
  allow: script.allow,
  deny: script.deny,
  stop: script.stop,
  notify: script.notify,
  pin: script.pin,
  archive: script.archive,
  setModel: script.setModel,
  dismissMoment: script.dismissMoment,
  showMoment: script.showMoment,
};

export function useBoard() {
  const board = useStore((s) => s.board);
  const moment = board.chats.find((c) => c.id === board.momentId && c.phase === "ready") ?? null;
  return { ...board, moment, ...actions };
}

export type Board = ReturnType<typeof useBoard>;

// In development the store, its selectors, sessions, the launch rule and the script are on `globalThis.__cc`, to read
// or drive from a console: `__cc.select.tilesOf(__cc.store.get())`, `__cc.script.resetDemo()`.
if (__DEV__) Object.assign(globalThis, { __cc: { ...(globalThis as { __cc?: object }).__cc, store, select, sessions, launch, script } });
