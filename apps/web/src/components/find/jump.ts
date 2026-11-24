// Opening a chat at a place ⌘K found: the chat's find (useChatFind) takes the jump once its transcript holds the
// item, so a chat that is still loading, or not yet open, lands on the passage instead of its newest line.

export interface Jump {
  /** The transcript item to land on. */
  readonly item: string;
  /** The words that matched there, for the find bar to show and step through; "" for a match by meaning. */
  readonly query: string;
}

const EVENT = "caveman:chat-jump";
/** A jump not taken by then is stale: the chat never showed that item (a restored turn, another session). */
const STALE_MS = 15_000;
const pending = new Map<string, Jump & { readonly at: number }>();

/** Asks the chat of `sessionId` to land on `jump` as soon as it can. */
export function jumpTo(sessionId: string, jump: Jump): void {
  pending.set(sessionId, { ...jump, at: Date.now() });
  window.dispatchEvent(new CustomEvent(EVENT, { detail: sessionId }));
}

/** The jump waiting for `sessionId`, if its item is there (`has`); taken, so it happens once. */
export function takeJump(sessionId: string, has: (item: string) => boolean): Jump | undefined {
  const jump = pending.get(sessionId);
  if (!jump) return undefined;
  if (Date.now() - jump.at > STALE_MS) {
    pending.delete(sessionId);
    return undefined;
  }
  if (!has(jump.item)) return undefined;
  pending.delete(sessionId);
  return jump;
}

/** Calls `onJump` when a jump is asked for `sessionId` (the chat is already open). */
export function onJump(sessionId: string, onJump: () => void): () => void {
  const listener = (e: Event) => (e as CustomEvent<string>).detail === sessionId && onJump();
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
