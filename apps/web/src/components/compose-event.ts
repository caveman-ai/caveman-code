// Words for a box from elsewhere in the app (Composer.tsx listens): Edit on a sent message, the Changes tab's
// line comments, a Chief's things to try. Wire text, so thread references come back as pills; they go above
// anything already typed. A box is its chat's id, or its draft key when it has no chat (a Chief's).

import type { Drawn } from "./annotate/model.ts";

export const COMPOSE_EVENT = "caveman:compose";
export type ComposeDetail = { readonly box: string; readonly wire: string };
export const composeIn = (box: string, wire: string): void => {
  window.dispatchEvent(new CustomEvent<ComposeDetail>(COMPOSE_EVENT, { detail: { box, wire } }));
};

// A picture for a box from elsewhere: one from the chat, marked up in the viewer (annotate/Annotator.tsx). A box on
// screen says it takes them. The same chat in two panes is two boxes by one name: the one that said so last gets it,
// and when that one goes the other still does.
export interface FileBox {
  /**
   * Attaches it like a dropped file, with its way back when it has marks (what it was drawn on, and the marks);
   * why it couldn't (its engine takes no images, it is too large), or null.
   */
  readonly take: (file: File, drawn: Drawn | null) => Promise<string | null>;
  /** Puts the caret in the box, to say what to do about it. */
  readonly focus: () => void;
}
/** Every box on screen by each name, in the order they said so. */
const boxes = new Map<string, ReadonlyArray<FileBox>>();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((watcher) => watcher());

export function takeFilesIn(box: string, taker: FileBox): () => void {
  boxes.set(box, [...(boxes.get(box) ?? []), taker]);
  changed();
  return () => {
    const left = (boxes.get(box) ?? []).filter((other) => other !== taker);
    if (left.length) boxes.set(box, left);
    else boxes.delete(box);
    changed();
  };
}

/** The box by that name on screen (the latest of several), or null. With watchFileBoxes, a store for useSyncExternalStore. */
export const fileBox = (box: string | null): FileBox | null => (box === null ? null : (boxes.get(box)?.at(-1) ?? null));
export const watchFileBoxes = (watcher: () => void): (() => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
