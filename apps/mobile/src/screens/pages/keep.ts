// What a page keeps while the app runs: the prototype's stand-in for the runtime's own record. A verdict given on
// Review, an automation paused or deleted, a plugin installed: each stays put when you leave the page and come back,
// and anything else reading it (the sidebar's Review count) sees the change at once.
import { useSyncExternalStore } from "react";

export interface Kept<T> {
  get: () => T;
  set: (next: T | ((was: T) => T)) => void;
  use: () => T;
}

/** A value made on first read by `start`, kept until the app quits. */
export function keep<T>(start: () => T): Kept<T> {
  let value: { now: T } | null = null;
  const listeners = new Set<() => void>();
  const get = () => (value ??= { now: start() }).now;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  return {
    get,
    set(next) {
      value = { now: typeof next === "function" ? (next as (was: T) => T)(get()) : next };
      listeners.forEach((listener) => listener());
    },
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}
