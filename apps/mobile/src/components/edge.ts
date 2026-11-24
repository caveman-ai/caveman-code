// The left edge is Back's. On a pushed screen a swipe that starts in the strip along the left edge always goes back: the stack's
// own back swipe takes it there (nav/Navigator.tsx), and every horizontal swipe of ours inside the content (a row's
// actions, a card's Allow and Deny, the thread's dock) lets a touch that starts in the strip go at once instead of
// racing the stack for it. Out of the strip they keep their swipes, as Mail's rows do.
//
// A horizontal scroller (a chip row, a code block) needs nothing here: react-native-screens makes a scroll view wait
// for the edge swipe to fail. Only the pans we draw ourselves have to step aside, and they all do it through
// `yieldToBack`, so the strip is one number in one place.
import { GestureStateManager } from "react-native-gesture-handler";
import { makeMutable } from "react-native-reanimated";

/** The strip along the screen's left edge, in points, where a swipe means Back. */
export const BACK_EDGE = 24;

/**
 * Where the main panel's left edge stands in the window: 0 on a phone, past the sidebar where it stands beside the
 * panel (shell/DrawerLayout.tsx). Back's strip runs along the panel's edge, not the screen's.
 */
export const panelLeft = makeMutable(0);

/** Whether a touch this far from the screen's left edge starts in Back's strip. */
export function inBackEdge(x: number): boolean {
  "worklet";
  const from = x - panelLeft.value;
  return from >= 0 && from < BACK_EDGE;
}

/**
 * For a pan's `onBegin`: a touch that starts in Back's strip fails the pan there and then, so the stack's back swipe
 * has it. Says whether it did, for a pan with more to do as it begins.
 */
export function yieldToBack(e: { handlerTag: number; absoluteX: number }): boolean {
  "worklet";
  if (!inBackEdge(e.absoluteX)) return false;
  GestureStateManager.fail(e.handlerTag);
  return true;
}
