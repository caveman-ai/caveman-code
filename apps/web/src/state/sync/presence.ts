// Whether the person is at this device now (S14, F-7): a visible window with input in the last five minutes. Cloud
// keeps a person's computers awake longer only while one of their devices says so on its chat stream, so a desktop app
// left open or a background tab never holds every computer up; and a device wakes Cloud computers on connect only
// once someone is there.

export interface Presence {
  /** The window is visible and had input in the last IDLE_MS. */
  active(): boolean;
  /** Called on every change of `active()`. */
  subscribe(listener: () => void): () => void;
}

/** Input older than this is nobody at the device. */
export const IDLE_MS = 5 * 60_000;

/** Tests and places with no window: always someone there. */
export const alwaysPresent: Presence = { active: () => true, subscribe: () => () => undefined };

const INPUT = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;

/** Presence from a browser window's visibility and its input. */
export function windowPresence(win: Window = window, doc: Document = document, now: () => number = Date.now, idleMs = IDLE_MS): Presence {
  const listeners = new Set<() => void>();
  let lastInput = Number.NEGATIVE_INFINITY;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const active = () => doc.visibilityState === "visible" && now() - lastInput < idleMs;
  let was = active();
  const check = () => {
    const is = active();
    if (is === was) return;
    was = is;
    for (const listener of listeners) listener();
  };
  // A timer may fire a little before the clock says the input is idleMs old: look again until it is.
  const whenIdle = () => {
    clearTimeout(idle);
    const left = lastInput + idleMs - now();
    if (left > 0) idle = setTimeout(whenIdle, left);
    else check();
  };
  const onInput = () => {
    lastInput = now();
    whenIdle();
    check();
  };
  for (const name of INPUT) win.addEventListener(name, onInput, { passive: true, capture: true });
  doc.addEventListener("visibilitychange", check);
  return {
    active,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
