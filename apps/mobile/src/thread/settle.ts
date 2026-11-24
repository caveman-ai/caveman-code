// When a turn is over on screen, not just on the wire (DECISIONS.md O4). The engine marks a turn finished the moment
// its last words are sent, but they are still pacing in (thread/pace.ts): until the answer has settled the chat still
// reads as working, so the capsule keeps its clock, the box says "Steer the work…", the fold stays open and the Changes
// pill and action row wait. Each paced text says here when it starts and stops arriving; an answer nobody is drawing
// (the chat scrolled far up, or not open) settles when its pace says it would have.
import { useEffect, useReducer, useSyncExternalStore } from "react";
import type { Chat } from "../board/model";
import { answerOf, turnsOf } from "./fold";
import { settledAt } from "./pace";

const arriving = new Set<string>();
const settled = new Set<string>();
/** When each paced text settled on screen. */
const settledTimes = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  for (const listener of listeners) listener();
};

/** A paced text with this id is arriving (true), or has settled (false). */
export function reportArriving(id: string, on: boolean) {
  if (on) {
    if (arriving.has(id) || settled.has(id)) return;
    arriving.add(id);
    emit();
    return;
  }
  const was = arriving.delete(id);
  if (settled.has(id)) return;
  settled.add(id);
  settledTimes.set(id, Date.now());
  if (was) emit();
}

/** A paced text left the screen before it settled: what it still owes is judged by its pace from here on. */
export function leaveArriving(id: string) {
  if (arriving.delete(id)) emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The answer that ends a chat's latest turn, if that turn has finished on the wire. */
function endingAnswer(chat: Pick<Chat, "items" | "phase">) {
  if (chat.phase === "working" || chat.phase === "needs") return null;
  const turn = turnsOf(chat.items).at(-1);
  if (!turn || turn.items.some((i) => i.kind === "stop")) return null;
  return answerOf(turn.items);
}

/**
 * When a chat's latest answer settled on screen, or by its pace if nobody drew it (Date.now() time); null while it is
 * still arriving, or while the engine hasn't finished the turn. What comes after it (the next queued follow-up) waits
 * on this, so the answer you were reading folds and closes before anything new arrives under it.
 */
export function settledSince(chat: Pick<Chat, "items" | "phase">, now = Date.now()): number | null {
  const answer = endingAnswer(chat);
  // Nothing paced to wait on: a turn that ended without words (or was stopped) has settled already.
  if (!answer) return chat.phase === "working" || chat.phase === "needs" ? null : 0;
  const bound = settledAt(answer.text, answer.at);
  if (settled.has(answer.id)) return settledTimes.get(answer.id) ?? bound;
  if (arriving.has(answer.id) || now < bound) return null;
  return bound;
}

/** Whether a chat's latest answer has settled at least `after` ms ago. */
export const settledNow = (chat: Pick<Chat, "items" | "phase">, after = 0, now = Date.now()) => {
  const since = settledSince(chat, now);
  return since !== null && now - since >= after;
};

/** Whether a chat's latest answer is still arriving on screen, though the engine has finished the turn. */
export function useSettling(chat: Pick<Chat, "items" | "phase"> | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const answer = chat ? endingAnswer(chat) : null;
  const bound = answer ? settledAt(answer.text, answer.at) : 0;
  const pending = !!answer && !settled.has(answer.id) && (arriving.has(answer.id) || Date.now() < bound);
  // Nobody drew it: it settles when its pace says it would have.
  useEffect(() => {
    if (!pending || !answer || arriving.has(answer.id)) return;
    const timer = setTimeout(wake, Math.max(0, bound - Date.now()) + 16);
    return () => clearTimeout(timer);
  }, [pending, answer, bound]);
  return pending;
}
