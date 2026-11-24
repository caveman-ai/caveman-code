// The keyboard as the box needs to know it beside its animated height: whether it is coming up and how tall it will
// stand (iOS says so as it starts to move; Android once it is up), whether it is all the way up, and how tall it stood
// last time, kept on disk so the `+` menu takes the keyboard's own height from the first time it opens after a launch
// (place.ts). A browser has no keyboard: there `__cc.keyboard.show(336)` and `__cc.keyboard.hide()` stand one in, its
// height on the UI thread and its events alike, to see a box and its chat over a phone's keyboard; with
// `__cc.keyboard.auto = true` (or `?keyboard` in the address) it comes and goes with the box's field, as a phone's does.
import { useSyncExternalStore } from "react";
import { Keyboard, Platform } from "react-native";
import { makeMutable, withTiming } from "react-native-reanimated";
import { read, write } from "../../store/persist";
import { PLACE_MS } from "./place";

const KEY = "cc/v1/keyboard";
const WEB = Platform.OS === "web";

export interface KeyboardState {
  /** Where it is going: its height from the screen's foot, or 0 going down. */
  target: number;
  /** All the way up. */
  up: boolean;
}

let state: KeyboardState = { target: 0, up: false };
let last = read(KEY, (d) => (typeof d === "number" && d > 120 && d < 1200 ? d : null)) ?? 0;
const listeners = new Set<() => void>();
const set = (next: KeyboardState) => {
  if (next.target === state.target && next.up === state.up) return;
  state = next;
  listeners.forEach((l) => l());
};
const remember = (height: number) => {
  if (height <= 120 || Math.abs(height - last) < 1) return;
  last = Math.round(height);
  write(KEY, () => last);
};

/** The keyboard's height the last time it stood up, or 0 if it never has (place.ts guesses then). */
export const lastKeyboard = () => last;

if (!WEB) {
  const ios = Platform.OS === "ios";
  Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
    remember(e.endCoordinates.height);
    set({ target: e.endCoordinates.height, up: !ios });
  });
  if (ios) Keyboard.addListener("keyboardDidShow", (e) => set({ target: e.endCoordinates.height, up: true }));
  Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => set({ target: 0, up: false }));
}

/**
 * The keyboard's height on the UI thread, on the web: a browser has none to rise over, so it stays at nothing unless
 * development stands one in (below). A phone reads Reanimated's `useAnimatedKeyboard` instead.
 */
export const WEB_KEYBOARD = WEB ? { height: makeMutable(0) } : null;

/** The stand-in follows the box's field (development, on the web). */
let auto = false;
let stand: { show: (to?: number) => void; hide: () => void } | null = null;

/** The box's field took the keyboard (true) or let it go: on the web, the stand-in keyboard follows, when it's on. */
export function fieldFocus(on: boolean) {
  if (!auto || !stand) return;
  if (on) stand.show();
  else stand.hide();
}

if (__DEV__ && WEB_KEYBOARD) {
  const height = WEB_KEYBOARD.height;
  auto = typeof location !== "undefined" && new URLSearchParams(location.search).has("keyboard");
  const handle = {
    // `__cc.keyboard.value = 336` still sets the height alone, as it did before the events were stood in too.
    get value() {
      return height.value;
    },
    set value(to: number) {
      height.value = to;
    },
    show(to = last || 336) {
      remember(to);
      set({ target: to, up: false });
      height.value = withTiming(to, { duration: PLACE_MS });
      // All the way up once it has risen, unless it was put away meanwhile.
      setTimeout(() => state.target === to && set({ target: to, up: true }), PLACE_MS);
    },
    hide() {
      set({ target: 0, up: false });
      height.value = withTiming(0, { duration: PLACE_MS });
    },
    get auto() {
      return auto;
    },
    set auto(on: boolean) {
      auto = on;
    },
  };
  stand = handle;
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, keyboard: handle };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Where the keyboard is going and whether it is up, re-rendering as either changes. */
export function useKeyboardState(): KeyboardState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
