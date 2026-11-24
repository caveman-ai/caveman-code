// How a sheet moves when it leads somewhere: its timings in one place, and a slow-motion factor for development that
// every one of them is multiplied by, so a frame in the middle of a push can be caught on a screenshot
// (`__cc.ui.slow(8)`, ui.ts; `__cc.ui.slow(1)` puts it back). It never touches the app's other motion.
import { makeMutable, ReduceMotion, withDelay } from "react-native-reanimated";

/** A sheet arriving and going (Sheet.tsx), and a frame changing size between two sheets of different heights. */
export const ARRIVE_MS = 380;
export const LEAVE_MS = 240;
/** A page pushed in a sheet's body, or popped: the page under it moves a third of the way left and back. */
export const PUSH_MS = 350;
/** With Reduce Motion on, a page cross-fades in this long instead. */
export const FADE_MS = 220;
/** The head's left glyph changing in its circle (X to a back chevron and back): a cross-fade with a slight scale. */
export const GLYPH_MS = 160;
/**
 * The head's title changing: the new one arrives over TITLE_MS, starting TITLE_IN_DELAY after the old one has begun to
 * leave, and the old one is gone in TITLE_OUT_MS (an exit about two thirds of its entrance). Where they cross, the two
 * together are less than one title's ink, so they never read as one word ("PSrettiengs").
 */
export const TITLE_MS = 220;
export const TITLE_OUT_MS = 140;
export const TITLE_IN_DELAY = 50;
/** How far a title drifts as it changes. */
export const DRIFT = 12;

let factor = 1;
/** The factor on the UI thread, for timings a gesture starts there. */
export const slowness = makeMutable(1);

/** Development only: every timing in a sheet's transitions runs `k` times slower (1 is real time). */
export function setSlow(k = 1) {
  factor = Number.isFinite(k) && k > 0 ? k : 1;
  slowness.value = factor;
  return factor;
}

/** A duration at the current speed. */
export const slow = (ms: number) => ms * factor;

/**
 * An animation that starts its clock on the next frame, not when it is set. A timing set as a page is pushed would
 * count the time the new page takes to lay out, and its first visible frame would be a third of the way through; this
 * one shows all of it, and the head and the body, set in the same moment, start on the same frame.
 */
export function nextFrame<T>(animation: T, after = 1): T {
  return withDelay(Math.max(1, after), animation as never, ReduceMotion.Never) as T;
}
