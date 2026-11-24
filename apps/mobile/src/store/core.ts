// The app's one small store, with no state library: a reducer, a snapshot and two ways to listen. Screens listen
// through `useSelector`, which re-renders a component only when the slice it picked changes, and hears at most once an
// animation frame however many actions land in it (thirty chats streaming must not mean thirty renders a frame).
// Side effects that must not wait a frame (writing to disk, keeping a derived field) `watch` instead, synchronously.
// Reducers share structure: whatever an action didn't touch keeps its identity, so a picked row stays the same object.
import { useCallback, useRef, useSyncExternalStore } from "react";

export interface Store<S, A> {
  /** The state now, already holding every action dispatched so far (screens hear of it on the next frame). */
  get(): S;
  dispatch(action: A): void;
  /** Hears changes at most once an animation frame. For screens, through `useSelector`. */
  subscribe(listener: () => void): () => void;
  /** Hears every change at once, with the state before it and the action that made it (none for `replace`). */
  watch(listener: (next: S, prev: S, action: A | undefined) => void): () => void;
  /** Puts a whole state in place (a reset, a restore), as one change. */
  replace(next: S): void;
}

const nextFrame: (run: () => void) => void =
  typeof requestAnimationFrame === "function" ? (run) => void requestAnimationFrame(run) : (run) => void setTimeout(run, 16);

export function createStore<S, A>(initial: S, reduce: (state: S, action: A) => S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  const watchers = new Set<(next: S, prev: S, action: A | undefined) => void>();
  let scheduled = false;
  // A frame that never comes (a web tab in the background) still lets the screens catch up within a second.
  let fallback: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    if (!scheduled) return;
    scheduled = false;
    if (fallback) clearTimeout(fallback);
    fallback = null;
    for (const listener of [...listeners]) listener();
  };
  const set = (next: S, action?: A) => {
    if (Object.is(next, state)) return;
    const prev = state;
    state = next;
    for (const watcher of [...watchers]) watcher(next, prev, action);
    if (scheduled) return;
    scheduled = true;
    nextFrame(notify);
    fallback = setTimeout(notify, 1000);
  };

  return {
    get: () => state,
    dispatch: (action) => set(reduce(state, action), action),
    replace: (next) => set(next),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    watch(listener) {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
  };
}

/**
 * The slice of a store a component draws, re-rendered only when `equal` says it changed (identity by default; pass
 * `shallow` for a fresh array or object of the same members). `pick` may be an inline function: what it picked for
 * a given state is kept, so React never sees a new value for an unchanged store.
 */
export function useSelector<S, T>(store: Pick<Store<S, unknown>, "get" | "subscribe">, pick: (state: S) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const memo = useRef<{ state: S; pick: (state: S) => T; value: T } | null>(null);
  // The latest pick and equal: a new pick (an inline function, a new id) is read once against the state it sees, and
  // an equal answer keeps the value it had.
  const latest = useRef({ pick, equal });
  latest.current = { pick, equal };
  const snapshot = useCallback(() => {
    const state = store.get();
    const { pick: read, equal: same } = latest.current;
    const was = memo.current;
    if (was && Object.is(was.state, state) && was.pick === read) return was.value;
    const next = read(state);
    const value = was && same(was.value, next) ? was.value : next;
    memo.current = { state, pick: read, value };
    return value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** Same members in the same places: arrays item by item, objects key by key, one level deep. */
export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => Object.is(item, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * A function of one object argument, remembered for the last few inputs by identity: selectors over the store's
 * slices (which keep their identity while untouched) recompute only when one of them moved.
 */
export function memoLast<Args extends readonly unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
  let last: { args: Args; value: R } | null = null;
  return (...args: Args) => {
    if (last && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) return last.value;
    const value = fn(...args);
    last = { args, value };
    return value;
  };
}
