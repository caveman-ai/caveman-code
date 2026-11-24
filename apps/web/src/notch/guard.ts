// When the notch takes a click (docs/, "A click it did not earn"). It opens by itself, and its
// card changes by itself, and either may happen under a pointer that is at work in another app: the click on its way
// to that app must never answer an approval or ship a chat's work. So after either, the notch takes no click until
// the person has had time to see what changed and has moved the pointer since. A pointer that only rests never
// presses anything, however long it rests.

/**
 * Long enough to see what changed, and to hold back a click that was already on its way: a browser's permission
 * prompt waits 500 ms before its buttons work, Firefox's dialogs a whole second.
 */
export const ARM_MS = 800;
/** A pointer that went this far since the change was moved by the person: a press's own jitter is a few points. */
export const MOVE_PX = 16;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Guard {
  /** When the notch last opened by itself, or its card last changed. */
  readonly at: number;
  /**
   * Where the page believed the pointer was then (null: not over its window). A move reported at that very place is
   * no move: the page replays one whenever what is under the pointer changes.
   */
  readonly rest: Point | null;
  /**
   * Where the pointer was first seen to go since: its travel is measured from there, not from `rest`. The page can
   * be wrong about where the pointer is (it hears nothing while another app drags), and the first move it then hears
   * is the pointer being found, not the person moving it.
   */
  readonly from: Point | null;
  /** The pointer has gone MOVE_PX from there. */
  readonly moved: boolean;
}

/** Nothing has changed by itself: the notch is the person's to press. */
export const ARMED: Guard = {
  at: Number.NEGATIVE_INFINITY,
  rest: null,
  from: null,
  moved: true,
};

/** It opened by itself, or its card changed, at `now`, with the pointer believed at `rest`. */
export const disarmed = (now: number, rest: Point | null): Guard => ({
  at: now,
  rest,
  from: null,
  moved: false,
});

/** A move of the pointer was reported, to `to`. The same guard when that changes nothing. */
export function pointed(guard: Guard, to: Point): Guard {
  if (guard.moved) return guard;
  if (!guard.from)
    return guard.rest && guard.rest.x === to.x && guard.rest.y === to.y
      ? guard
      : { ...guard, from: to };
  return Math.hypot(to.x - guard.from.x, to.y - guard.from.y) >= MOVE_PX
    ? { ...guard, moved: true }
    : guard;
}

/** Has what changed been there long enough to be seen, and a click already on its way to have landed? */
export const settled = (guard: Guard, now: number): boolean => now - guard.at >= ARM_MS;

/**
 * Does it take a press at `now`? A mouse press only once the pointer has been moved since the change. A press that
 * does not come from a resting pointer (the keyboard, an assistive technology, a finger or a pen) is meant where it
 * lands: it counts once what changed has been there long enough to be seen.
 */
export const armed = (guard: Guard, now: number, deliberate = false): boolean =>
  settled(guard, now) && (guard.moved || deliberate);
