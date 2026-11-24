// A chat's session, as screens use it: the draft in its box, the follow-ups queued behind its running turn, the folds
// you opened or shut, where you were scrolled and when you last read it. All of it outlives the screen and a relaunch
// (store.ts writes it to cc/v1/sessions). Scopes: a chat's id, NEW_CHAT for the new chat's box, and chiefScope(id)
// for a Chief's. The pure slice is session-state.ts.
import { type SetStateAction, useCallback, useRef, useState } from "react";
import { itemId, type SentImage } from "../board/model";
import { shallow } from "./core";
import type { Queued, Session } from "./session-state";
import { dispatch, store, useStore } from "./store";

export type { Queued, Session } from "./session-state";

/** The new chat's box. */
export const NEW_CHAT = "new";
/** A Chief's box. */
export const chiefScope = (id: string) => `chief:${id}`;

const NO_QUEUE: readonly Queued[] = [];
const NO_FOLDS: Readonly<Record<string, boolean>> = {};

// ---------------------------------------------------------------- reading and writing, outside React

export const sessionOf = (scope: string): Session | undefined => store.get().sessions[scope];
export const getDraft = (scope: string): string => sessionOf(scope)?.draft ?? "";
export const setDraft = (scope: string, text: string) => dispatch({ type: "session/draft", scope, text });
export const queueOf = (scope: string): readonly Queued[] => sessionOf(scope)?.queue ?? NO_QUEUE;

/** Puts a follow-up, and the pictures that go with it, at the end of a chat's queue. Returns its id. */
export function enqueue(scope: string, text: string, images?: readonly SentImage[]): string {
  const id = itemId();
  dispatch({ type: "session/queue", scope, queue: [...queueOf(scope), { id, text, at: Date.now(), ...(images?.length ? { images } : null) }] });
  return id;
}
export const unqueue = (scope: string, id: string) => dispatch({ type: "session/queue", scope, queue: queueOf(scope).filter((q) => q.id !== id) });
export const editQueued = (scope: string, id: string, text: string) => dispatch({ type: "session/queue", scope, queue: queueOf(scope).map((q) => (q.id === id ? { ...q, text } : q)) });
export const clearQueue = (scope: string) => dispatch({ type: "session/queue", scope, queue: [] });
/** Takes the first follow-up off the queue, to send it. */
export function shiftQueue(scope: string): Queued | undefined {
  const [first, ...rest] = queueOf(scope);
  if (first) dispatch({ type: "session/queue", scope, queue: rest });
  return first;
}

/** A box's Permissions pick (session-state.ts Session.access); null puts it back to what it starts with. */
export const setBoxAccess = (scope: string, access: Session["access"] | null) => dispatch({ type: "session/access", scope, access: access ?? null });

/** A fold opened (true) or shut (false) by hand; null puts it back to its default. */
export const setFold = (scope: string, row: string, open: boolean | null) => dispatch({ type: "session/fold", scope, row, open });
export const setAnchor = (scope: string, anchor: Session["anchor"]) => dispatch({ type: "session/anchor", scope, anchor });
/** You read it up to `at` (now by default). */
export const markRead = (scope: string, at = Date.now()) => dispatch({ type: "session/read", scope, at });

// ---------------------------------------------------------------- hooks

/**
 * The draft in a box, and its setter, for a controlled field: `const [text, setText] = useDraft(chat.id)`. The field
 * reads a copy kept in the component, so a keystroke shows at once (the store tells screens a frame later, and a field
 * handed an older value would drop what was typed since); every change is written through to the store. A change made
 * elsewhere (a reset, the queue's Edit in another box) is taken in when it lands.
 */
export function useDraft(scope: string): [string, (next: SetStateAction<string>) => void] {
  const stored = useStore((s) => s.sessions[scope]?.draft ?? "");
  const [text, setText] = useState(stored);
  const wrote = useRef({ scope, text: stored });
  if (wrote.current.scope !== scope || wrote.current.text !== stored) {
    wrote.current = { scope, text: stored };
    if (text !== stored) setText(stored);
  }
  const latest = useRef(text);
  latest.current = text;
  const set = useCallback(
    (next: SetStateAction<string>) => {
      const value = typeof next === "function" ? next(latest.current) : next;
      latest.current = value;
      wrote.current = { scope, text: value };
      setText(value);
      setDraft(scope, value);
    },
    [scope],
  );
  return [text, set];
}

/** A chat's queued follow-ups, and what you can do with them. The script sends the first when the turn ends. */
export function useQueue(scope: string) {
  const queued = useStore((s) => s.sessions[scope]?.queue ?? NO_QUEUE);
  return {
    queued,
    add: useCallback((text: string, images?: readonly SentImage[]) => enqueue(scope, text, images), [scope]),
    remove: useCallback((id: string) => unqueue(scope, id), [scope]),
    edit: useCallback((id: string, text: string) => editQueued(scope, id, text), [scope]),
    clear: useCallback(() => clearQueue(scope), [scope]),
  };
}

/** Every fold choice in a chat at once, for a transcript that draws many. */
export function useFolds(scope: string): Readonly<Record<string, boolean>> {
  return useStore((s) => s.sessions[scope]?.folds ?? NO_FOLDS, shallow);
}

export function useAnchor(scope: string): Session["anchor"] {
  return useStore((s) => s.sessions[scope]?.anchor ?? null, (a, b) => a?.row === b?.row && a?.offset === b?.offset);
}
