// A yes or a no on one of the Chief's asks or ready changes, from wherever you gave it (the deck, the Ready card, a row
// in the agents sheet, a peek). An ask's answer is the one every screen gives (src/asks/decide.ts): it happens on the
// board at once, so the card leaves the deck in the same moment, and its Undo is the shell's toast for 4 seconds. A
// ready change's Ship it and Later wait those 4 seconds before they happen; from the deck and the Ready card the card
// goes at once and the toast holds the Undo too; from a sheet's
// row or a peek, the Undo is drawn in place of the buttons you pressed, as before. Each decision owns its Undo: a later
// one never lets an earlier one go early. They live here, outside the screen, so leaving the Chief inside those seconds
// loses neither a decision nor its Undo. Ship goes to the chat; Later puts a ready change off in the inbox
// (store/inbox.ts snooze), so it stays put off across screens and a relaunch, and comes back by the inbox's rules.
import * as script from "../board/script";
import { act, gist } from "../asks/decide";
import { notice } from "../shell/ui";
import { createStore, useSelector } from "../store/core";
import { dispatch, store as appStore } from "../store/store";

const storeNow = () => appStore.get();
import type { Card } from "./cards";

export { gist };

/** How long a decision waits before it happens, so you can take it back (docs/, "The Chief"). */
export const UNDO_MS = 4000;
/** How long Later puts a ready change off: it comes back sooner if the chat moves. */
const LATER_MS = 3 * 3_600_000;

/**
 * Where a decision was made, so its Undo is drawn there: a sheet's row, a peek; or the shell's toast (`toast`), for one
 * made on the deck or the Ready card, which leave at once.
 */
export type Slot = "ask" | "ready" | "sheet" | "peek" | "toast";

export interface Pending {
  card: Card;
  yes: boolean;
  from: Slot;
  /** When it was made: the newest in a slot is the one its bar shows. */
  at: number;
}

/** What waits behind Undo, by the chat the answer goes to (the asker, or the ready chat). */
export type Pendings = Readonly<Record<string, Pending>>;

type Action = { type: "add"; pending: Pending } | { type: "drop"; id: string };

const store = createStore<Pendings, Action>({}, (state, action) => {
  if (action.type === "add") return { ...state, [action.pending.card.chat.id]: action.pending };
  if (!state[action.id]) return state;
  const { [action.id]: _, ...rest } = state;
  return rest;
});
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Every decision waiting behind its Undo. */
export const usePending = () => useSelector(store, (p) => p);

/** What a waiting decision's bar says: the verb, then what it's about (a command in mono, or words). */
export function pendingWords(p: Pending): { verb: string; what: string; code: boolean } {
  if (p.card.kind === "ask") return { verb: p.yes ? "Allowing" : "Denying", what: gist(p.card.chat.ask), code: true };
  return p.yes ? { verb: "Shipping", what: p.card.row.title, code: false } : { verb: "Putting off", what: "for 3 hours", code: false };
}

/** A decision whose 4 seconds are up happens now. */
function land(id: string) {
  const was = store.get()[id];
  timers.delete(id);
  if (!was) return;
  store.dispatch({ type: "drop", id });
  const { card, yes } = was;
  if (card.kind === "ask") act(card.chat.id, yes ? { kind: "allow" } : { kind: "deny" });
  // An answer given since (shipped from the chat, a new turn, archived) wins: a ship it that waited never runs over it,
  // and never lands as steering on a chat that is at work again.
  else if (yes) {
    const now = storeNow().board.chats.find((c) => c.id === card.chat.id);
    if (now?.phase === "ready" && !storeNow().inbox.archived[now.id]) script.send(now.id, "Looks great, ship it");
  }
  else dispatch({ type: "inbox/snooze", id: card.chat.id, phase: card.chat.phase, until: Date.now() + LATER_MS });
}

/** Takes a waiting decision back: the ask or the change is in front of you again, as it was. */
export function undo(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  store.dispatch({ type: "drop", id });
}

/**
 * A yes or a no. An ask's is answered at once, Undo in the toast (`card.reply` says which option or words, when the
 * card picked more than a yes or a no). A ready change's waits 4 seconds behind its own Undo. A second answer to the
 * same chat inside them does nothing.
 */
export function decide(card: Card, yes: boolean, from: Slot = "ask") {
  const id = card.chat.id;
  if (card.kind === "ask") {
    act(id, card.reply ?? (yes ? { kind: "allow" } : { kind: "deny" }));
    return;
  }
  if (store.get()[id]) return;
  // On the deck and the Ready card the change leaves at once and the toast holds its Undo; in a sheet or a peek the
  // Undo stands where its buttons were.
  const away = from === "ask" || from === "ready" || from === "toast";
  store.dispatch({ type: "add", pending: { card, yes, from: away ? "toast" : from, at: Date.now() } });
  timers.set(
    id,
    setTimeout(() => land(id), UNDO_MS),
  );
  if (away) {
    notice({
      id: `decide-${id}-${Date.now()}`,
      text: yes ? "Shipping" : "Later",
      detail: card.row.title,
      tone: "info",
      icon: yes ? "merge" : "snooze",
      ms: UNDO_MS,
      action: { label: "Undo", onPress: () => undo(id) },
    });
  }
}
