// Which of a chat's items the reader has already seen: what the chat held when it opened (its history) and
// whatever has rendered since. Only an item that arrives while the chat is open is new: its reply plays in
// word by word, its tool step enters. An item mounting again (a run folded when its turn ended, a fold opened,
// a pane shown again) was seen, so it sits still.
import { createContext } from "react";
import type { TranscriptItem } from "../../state/transcript-model.ts";

export interface Seen {
  /** Not in the chat's history and not rendered yet: it arrived while the reader watched. */
  isNew(id: string): boolean;
  /** Rendered: from now on it is history (called from an effect, so a strict-mode double render agrees). */
  add(id: string): void;
}

/** Every id in `items`, a subagent's steps included. */
function ids(items: ReadonlyArray<TranscriptItem>, into: Set<string>): Set<string> {
  for (const item of items) {
    into.add(item.id);
    if (item.kind === "subagent") ids(item.items, into);
  }
  return into;
}

/**
 * A chat's register, taken from the first list that holds anything (a chat opening empty takes the first one
 * it gets: the person's own message, or the history arriving whole).
 */
export function seenItems(): Seen & { open(items: ReadonlyArray<TranscriptItem>): void; catchUp(items: ReadonlyArray<TranscriptItem>): void } {
  let known: Set<string> | null = null;
  return {
    open(items) {
      if (known === null && items.length > 0) known = ids(items, new Set());
    },
    catchUp(items) {
      known = ids(items, known ?? new Set());
    },
    isNew: (id) => known !== null && !known.has(id),
    add(id) {
      known?.add(id);
    },
  };
}

/** Outside a chat (a preview, a reader) nothing is new: everything shows still. */
export const SeenItems = createContext<Seen>({ isNew: () => false, add: () => {} });
