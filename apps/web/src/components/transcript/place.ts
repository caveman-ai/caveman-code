// Where the reader left a chat they had scrolled up in: the row at the top of the view and how far up it sat, kept past
// the chat's view (its pane keeps only the chats it showed lately rendered). Opened again, the chat shows there, not at
// its end; one they were following opens at its end (upstream rememberTimelinePosition, by row and offset).

export interface Place {
  /** The first row whose bottom is below the top of the view. */
  readonly row: string;
  /** Its top, from the top of the view (zero or less). */
  readonly offset: number;
}

const places = new Map<string, Place>();
const MAX_PLACES = 100;

/** The reader's place in chat `key`; null forgets it (they follow the end again). */
export function rememberPlace(key: string, place: Place | null): void {
  places.delete(key);
  if (!place) return;
  places.set(key, place);
  if (places.size > MAX_PLACES) places.delete(places.keys().next().value!);
}

/** Every chat follows its end again: a page that starts over (each browser test) forgets where it was read. */
export function forgetPlaces(): void {
  places.clear();
}

export function placeOf(key: string): Place | undefined {
  return places.get(key);
}

interface Box {
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}

/** The place in `view` of the first of `rows` (each with its row id) still in view; null when none is. */
export function readPlace(
  view: Box,
  rows: Iterable<{ readonly id: string; readonly el: Box }>,
): Place | null {
  const top = view.getBoundingClientRect().top;
  for (const { id, el } of rows) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return { row: id, offset: Math.round(r.top - top) };
  }
  return null;
}
