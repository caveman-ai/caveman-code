// One motion vocabulary for the whole app, the desktop's (STYLE.md 8, packages/ui/src/styles/motion.json): answer at
// once and settle slowly, exits about two thirds of their entrance, nothing overshoots, nothing replays. Two kinds:
// springs for what a finger moves (a press, a sheet, a card under the thumb), so a gesture hands its speed on and a
// new one retargets mid-flight; and the deck's curves and durations for what simply arrives or leaves. The springs
// are critically damped: they come to rest without a bounce. Reanimated
// jumps to the end when the system's Reduce Motion is on (ReduceMotion.System, its default), so nothing here checks
// it again. The Chief's character keeps its own hops: it is pixel art, which moves in held frames of its own.
//
// Reduce Motion is followed while the app runs, not only read at launch (the foot of this file): `useReducedMotion`
// here is the setting as it is now, and `FollowReduceMotion` hands a change on to Reanimated.
import { duration as deckDuration, easeCurve } from "@caveman-app/ui/motion";
import * as Haptics from "expo-haptics";
import { createElement, useEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, Platform } from "react-native";
import { Easing, FadeIn, FadeOut, Keyframe, LinearTransition, ReducedMotionConfig, ReduceMotion, useReducedMotion as reducedMotionAtLaunch, useSharedValue, type WithSpringConfig, withRepeat, withTiming } from "react-native-reanimated";

/** The deck's duration scale, in ms: instant (colour), fast (a press, a row), base (popovers, data arriving), slow (a view, layout), scene (opening the app). */
export const duration = deckDuration;

const curve = (name: keyof typeof easeCurve) => {
  const [a, b, c, d] = easeCurve[name];
  return Easing.bezier(a, b, c, d);
};

/** The deck's curves. `snap`: arrivals and exits. `swift`: something on screen moving elsewhere. `drawer`: sheets and long travel. */
export const ease = { snap: curve("snap"), swift: curve("swift"), drawer: curve("drawer"), fade: curve("fade") };

/** A finger going down: fast, and still at once. */
export const press: WithSpringConfig = { damping: 44, stiffness: 900, mass: 0.5 };
/** Letting go: back to size, no bounce past it. */
export const release: WithSpringConfig = { damping: 32, stiffness: 420, mass: 0.6, overshootClamping: true };
/** Something arriving under its own power (the moment card, a card on the deck): quick, then a long settle. */
export const pop: WithSpringConfig = { damping: 28, stiffness: 210, mass: 0.9 };
/** Something reshaping or travelling (a sheet, the drawer, card into sheet): the same, a touch firmer. */
export const morph: WithSpringConfig = { damping: 30, stiffness: 240, mass: 0.85 };

/**
 * Entrances and exits for Reanimated's `entering` / `exiting` / `layout`, by what is moving:
 * - `fade`: what enters a chat or a view (a message, a card, a page). It only fades (STYLE.md: "no scale, no slide").
 * - `float`: chrome that floats over the page (a menu, a toast): a hair of scale from 0.94, never from nothing, with
 *   the fade. It is a keyframe, and on the web Reanimated pins a keyframe's element where it first stood, so give it
 *   only to absolutely placed chrome, inside a plain view that does the placing, and never with `layout`; in the flow
 *   (a chip in a row, a row in a list) use `fade`.
 * - `gone`: every exit, faster than it came.
 * - `layout`: rows making room for a row, on the snap curve; no spring.
 */
export const enter = {
  fade: FadeIn.duration(duration.fast).easing(ease.snap),
  float: new Keyframe({
    0: { opacity: 0, transform: [{ scale: 0.94 }] },
    100: { opacity: 1, transform: [{ scale: 1 }], easing: ease.snap },
  }).duration(duration.base),
};
export const exit = {
  gone: FadeOut.duration(120).easing(ease.snap),
  float: new Keyframe({
    0: { opacity: 1, transform: [{ scale: 1 }] },
    100: { opacity: 0, transform: [{ scale: 0.97 }], easing: ease.snap },
  }).duration(120),
};
export const layout = LinearTransition.duration(duration.base).easing(ease.snap);

/** A clock from 0 to 1, over and over, for anything that should look alive; held at 0 while `running` is false. */
export function useLoop(ms: number, running = true) {
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.value = 0;
    if (running) clock.value = withRepeat(withTiming(1, { duration: ms, easing: Easing.linear }), -1, false);
  }, [clock, ms, running]);
  return clock;
}

const native = Platform.OS === "ios" || Platform.OS === "android";
const ignore = () => {};

/** Haptics are seasoning: a device without them (or the web) just doesn't buzz. */
export const haptic = {
  tap: () => native && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore),
  soft: () => native && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(ignore),
  thud: () => native && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(ignore),
  tick: () => native && Haptics.selectionAsync().catch(ignore),
  done: () => native && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore),
};

// ---------------------------------------------------------------- Reduce Motion, as it is now

/**
 * What the setting was when the app started. Reanimated reads it once, then: its own `useReducedMotion` only ever
 * says this, and so does its default for every animation that doesn't say otherwise.
 */
const atLaunch = reducedMotionAtLaunch();

let still = atLaunch;
const watchers = new Set<() => void>();
const settle = (next: boolean) => {
  if (next === still) return;
  still = next;
  for (const watcher of watchers) watcher();
};

if (Platform.OS === "web") {
  // A browser says so through the media query, and tells of a change on the query itself.
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  if (query) {
    still = query.matches;
    query.addEventListener("change", (event) => settle(event.matches));
  }
} else {
  // A phone tells of a change as it is made. The switch is flipped in the system's Settings with the app behind it,
  // so the setting is also read again each time the app comes back to the front.
  const read = () => void AccessibilityInfo.isReduceMotionEnabled().then(settle).catch(ignore);
  AccessibilityInfo.addEventListener("reduceMotionChanged", settle);
  AppState.addEventListener("change", (state) => {
    if (state === "active") read();
  });
  read();
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
const current = () => still;

/**
 * Whether the system asks for less motion, now. Use this one, not Reanimated's hook of the same name, which says what
 * the setting was at launch: a view that reads this draws again the moment the setting changes, with no relaunch.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(watch, current, current);
}

/**
 * Hands a change of the setting on to Reanimated, so the animations that leave the choice to it (a plain `withTiming`,
 * an `entering`) follow too. Mounted once, at the app's root. It draws nothing, and while the setting is what it was
 * at launch it does nothing either: Reanimated already has that.
 */
export function FollowReduceMotion() {
  const on = useReducedMotion();
  return on === atLaunch ? null : createElement(ReducedMotionConfig, { mode: on ? ReduceMotion.Always : ReduceMotion.Never });
}
