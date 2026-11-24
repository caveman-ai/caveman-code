// The keyboard's place at the foot of the screen, and what takes it there ("opening the chat
// menu should push the text up so you can see it"). The box's `+` menu isn't a sheet over the chat: it rises where the
// keyboard stands, at the keyboard's own height, the box rides on it as it rides on the keyboard, and the chat under the
// box rides up with it, so the draft and the last message stay in view. Swapping the keyboard for the menu, or back,
// moves nothing: the one takes the other's place at the same height. Sheets about something else (Details, Agents,
// Search) still cover the chat.
//
// The chat and the box are one motion ("the chat really should smoothly move with the user
// when typing messages"). The box on the focused screen works out, on the UI thread, every frame, how far its top
// stands over where it rests (its lift): the keyboard or the menu under it, and the card growing as it opens and as you
// write a new line, but never the card pulled tall by its grabber, which covers the chat instead. It hands that to its
// own chat by its draft scope (`claimLift`), and the chat moves up by as much, less the empty room it already has over
// the box's resting top, as a transform on its list: no room is added at its foot and nothing waits on the JS thread,
// and since the chat derives its ride from the box's own value the two are worked out in the same frame. What the box
// tells its screen (Composer `onHeight`, `onEdge`) is where it rests, and that only changes for what stays (a queued
// follow-up's row, what rides on the box).
//
// What lives here is plain arithmetic, which box's lift each chat hears, the hook a chat rides it with, and one tiny
// store of the same lift as React last committed it (iOS lets a raised chat scroll its first lines into view with it),
// so a test can pin the arithmetic: how tall the menu stands for a keyboard of a given height, how far the box then
// stands over its rest, how far a chat with room under its last line rides, and which box's lift a chat hears.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { type DerivedValue, Easing, useDerivedValue, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { BOX } from "./state";

/** A phone's keyboard before it has ever shown, from the screen's foot: an iPhone's, with its suggestions bar. */
export const KEYBOARD_GUESS = 336;
/** The menu is never shorter than this (a keyboard without its suggestions bar, a short phone), nor over half the screen. */
const LEAST = 280;
const MOST = 0.5;
/** The menu rises and falls as the keyboard does: its duration, for what moves with it. */
export const PLACE_MS = 250;

/** How tall the menu stands, from the screen's foot: the keyboard's last height, within reason for this screen. */
export function menuHeight(keyboard: number, screen: number): number {
  const most = Math.round(screen * MOST);
  const want = keyboard > 0 ? keyboard : KEYBOARD_GUESS;
  return Math.max(Math.min(LEAST, most), Math.min(most, Math.round(want)));
}

/**
 * How far the box stands over its resting place while something `place` tall holds the foot (the keyboard or the
 * menu): it rests `BOX.lift` over the safe edge (`base`) and rides `BOX.overKeyboard` over whatever is there.
 */
export function riseOf(place: number, base: number): number {
  if (place <= 0) return 0;
  return Math.max(0, Math.round(place + BOX.overKeyboard - (base + BOX.lift)));
}

/**
 * How far the box's top stands over where it rests, live (a worklet: the box works it out every frame). `foot` is
 * what holds the screen's foot, the keyboard or the menu, whichever stands higher (0: neither); `height` is the box as
 * tall as it stands now, the grabber's pull left out, and `rest` as tall as its screen keeps room for (the capsule, and
 * a queued follow-up's row). `slack` is the room opening it frees over it (a chat's floating row stepping away), which
 * the card grows into first. Below its rest it counts as at rest: a card shorter than the capsule and its row never
 * drops the chat.
 */
export function liftOf(foot: number, base: number, height: number, rest: number, slack = 0): number {
  "worklet";
  const bottom = Math.max(base + BOX.lift, foot + BOX.overKeyboard);
  return bottom - (base + BOX.lift) + Math.max(0, height - rest - slack);
}

/** How far a chat rides up with its box: as far as the box rose, less the empty room it had under its last line. */
export function rideOf(lift: number, blank: number): number {
  "worklet";
  return Math.max(0, lift - blank);
}

/**
 * The empty room between a chat's last row and the box's resting top, with the chat at its end: the room a sent turn
 * keeps under itself (`anchored`), and whatever a chat shorter than its screen leaves under it.
 */
export const blankOf = (anchored: number, viewport: number, content: number) => Math.max(0, anchored) + Math.max(0, viewport - content);

// ---------------------------------------------------------------- the box's lift, live, on the UI thread

/**
 * The focused box's lift, by its draft scope (a chat's id, "chief:<id>", "new"): a value the box derives every frame on
 * the UI thread. A chat derives its own ride from it rather than hearing it through a value the box writes, so the UI
 * thread works them out in order, in the same frame: the box and its chat never stand a frame apart.
 */
const lifts = new Map<string, DerivedValue<number>>();
const liftListeners = new Set<() => void>();
const tellLifts = () => liftListeners.forEach((l) => l());
const subscribeLifts = (listener: () => void) => {
  liftListeners.add(listener);
  return () => void liftListeners.delete(listener);
};

/** The box on the focused screen: its own chat rides `lift` from now on. */
export function claimLift(owner: string, lift: DerivedValue<number>) {
  if (lifts.get(owner) === lift) return;
  lifts.set(owner, lift);
  tellLifts();
}

/** A box going out of sight, or away, takes its lift with it, if it is still the one heard. */
export function releaseLift(owner: string, lift: DerivedValue<number>) {
  if (lifts.get(owner) !== lift) return;
  lifts.delete(owner);
  tellLifts();
}

/** Which box's lift a chat hears: the focused box with its draft scope, or none. */
export const heardLift = (owner: string) => lifts.get(owner) ?? null;

/**
 * A chat eases onto a lift it didn't follow a frame ago (its box went out of focus, or came back), and over a change in
 * the room under its last line, in this long. One time and one curve for both, so when they come together (the box
 * giving way to a docked ask, whose room is taller) the ride only ever goes one way.
 */
export const RIDE_MS = 200;
const EASE = { duration: RIDE_MS, easing: Easing.out(Easing.quad) };

export interface ChatLift {
  /** How far this chat's box stands over its rest, as the chat rides it. */
  lift: DerivedValue<number>;
  /** A hand has the chat: it stays where it is while the box moves (the keyboard following the finger down). */
  hold: () => void;
  /** The hand let go: it eases back onto the box. */
  release: () => void;
}

/**
 * The lift a chat rides with, on the UI thread: its own box's lift while that box is the focused one, frame for frame.
 * When the box gives it up (a screen pushed over the chat, the box giving way to a docked ask), the chat eases down
 * from where it stood rather than dropping, and eases onto it again when the box takes it back. While a hand drags the
 * chat it holds still, so the content moves with the finger alone and never at the box's rate too; let go, it eases
 * back onto the box.
 */
export function useChatLift(owner: string | undefined): ChatLift {
  const source = useSyncExternalStore(
    subscribeLifts,
    () => (owner ? heardLift(owner) : null),
    () => null,
  );
  // The last box heard stays in the ride's worklet after it has gone, weighed out (`on`), so its going is one step on
  // the UI thread, in the frame that hears it, rather than a new worklet a frame later.
  const kept = useRef(source);
  if (source) kept.current = source;
  const box = kept.current;
  const on = useSharedValue(source ? 1 : 0);
  const ease = useSharedValue(0);
  const held = useSharedValue(-1);
  const lift = useDerivedValue(() => (held.value >= 0 ? held.value : (box ? box.value * on.value : 0) + ease.value), [box]);
  // The box came or went: from where the chat stood to where the box is, eased (`lift` still holds where it stood). In
  // the commit that hears it, so it starts with whatever took the box's place (a docked ask's room).
  const heard = useRef(source);
  useLayoutEffect(() => {
    if (heard.current === source) return;
    heard.current = source;
    const now = source ? 1 : 0;
    scheduleOnUI(() => {
      "worklet";
      const from = lift.value;
      on.value = now;
      ease.value = from - (box ? box.value * now : 0);
      ease.value = withTiming(0, EASE);
    });
  }, [source, box, on, ease, lift]);
  const hold = useCallback(() => {
    scheduleOnUI(() => {
      "worklet";
      if (held.value < 0) held.value = lift.value;
    });
  }, [held, lift]);
  const release = useCallback(() => {
    scheduleOnUI(() => {
      "worklet";
      if (held.value < 0) return;
      ease.value = held.value - (box ? box.value * on.value : 0);
      held.value = -1;
      ease.value = withTiming(0, EASE);
    });
  }, [box, on, ease, held]);
  return { lift, hold, release };
}

// ---------------------------------------------------------------- the box's lift, as React last committed it

interface Rise {
  /** The box's draft scope: the chat that rides it. */
  owner: string | null;
  rise: number;
}

let current: Rise = { owner: null, rise: 0 };
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

/** The focused box stands this far over its rest once it has got where it is going (0: at rest). */
export function setRise(owner: string, rise: number) {
  if (current.owner === owner && current.rise === rise) return;
  if (rise <= 0 && current.owner !== owner) return;
  current = rise > 0 ? { owner, rise } : { owner: null, rise: 0 };
  tell();
}

/** A box going away (or out of sight) takes its rise with it, if it is still the one told. */
export function clearRise(owner: string) {
  if (current.owner !== owner) return;
  current = { owner: null, rise: 0 };
  tell();
}

export const riseNow = (owner: string) => (current.owner === owner ? current.rise : 0);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * How far the box over this chat will stand over its rest, as React knows it: what a raised chat on iOS keeps as room
 * over its top (contentInset), so its first lines can still be scrolled into view under the bar, and what a turn sent
 * from the box shares out with the list as it goes up under the bar (screens/Thread.tsx).
 */
export function useRise(owner: string | undefined): number {
  return useSyncExternalStore(
    subscribe,
    () => (owner ? riseNow(owner) : 0),
    () => 0,
  );
}

// ---------------------------------------------------------------- a hand on the chat puts the menu away

const putAways = new Set<() => void>();

/** The box with its menu up hears this: a drag on the chat puts the menu away, as it takes the keyboard down. */
export function onPutMenuAway(listener: () => void): () => void {
  putAways.add(listener);
  return () => void putAways.delete(listener);
}

export function putMenuAway() {
  putAways.forEach((l) => l());
}
