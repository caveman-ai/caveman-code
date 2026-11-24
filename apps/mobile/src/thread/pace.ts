// How an answer arrives on screen: two gears, as Codex paces its stream (docs/). The engine's
// words come in bursts; the screen lets them out on the display's own frames, one word every 33ms on the smooth gear,
// and when it falls behind (8 or more words waiting, or the oldest waiting 120ms) the catch-up gear closes the backlog
// over about 180ms, never slower than the smooth one. The gears have Codex's hysteresis: catch-up holds at least
// 250ms, lets go only once 2 words or fewer wait and none for longer than 40ms, and can't come back for 250ms after,
// so a stream on the edge doesn't lurch between them. Each word fades in over 150ms from the moment it was let out
// (packages/ui word-fade.ts), and the text counts as still arriving until the last fade is done, so nothing snaps to
// full ink when it settles. What had arrived when the chat opened is there at once: reopening a chat never replays it.
//
// The scripted board hands a text over whole, with when it began (`at`); its bursts are simulated here from that
// moment. On a runtime the arrivals are the provider's chunks and the same two gears pace them.
import { useEffect, useReducer, useRef } from "react";

/** The simulated provider: this many words land together, this often (about 44 words a second). */
const BURST = 4;
const BURST_MS = 90;
/** The smooth gear: one word this often. */
export const WORD_MS = 33;
/** The catch-up gear closes what waits over about this long. */
export const CATCH_SPAN_MS = 180;
/** Catch-up starts at this many words waiting, or the oldest waiting this long. */
export const ENTER_WORDS = 8;
export const ENTER_MS = 120;
/** It lets go at this few words waiting, the oldest no older than this. */
export const EXIT_WORDS = 2;
export const EXIT_MS = 40;
/** Catch-up holds at least this long, and can't start again for this long after it ends. */
export const HOLD_MS = 250;
export const REENTRY_MS = 250;
/** How long one word takes to fade in, from when it was let out. */
export const FADE_MS = 150;

/** A text cut into words, the space after each kept with it, so joining a prefix gives back the text as written. */
export function unitsOf(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/** Words that have arrived `ms` after the text began. */
const arrivedBy = (ms: number, total: number) => (ms < 0 ? 0 : Math.min(total, (Math.floor(ms / BURST_MS) + 1) * BURST));
/** When word `i` arrived, from the text's start. */
const arrivalOf = (i: number) => Math.floor(i / BURST) * BURST_MS;

/** Where the reveal stands: how far it has got (fractional between frames), and which gear it is in since when. */
export interface Gear {
  shown: number;
  catching: boolean;
  /** When the gear last changed (ms); -Infinity before it ever has. */
  since: number;
}

export const startGear = (shown: number): Gear => ({ shown, catching: false, since: Number.NEGATIVE_INFINITY });

/**
 * One frame of the two gears: `arrived` words are in, the oldest still hidden has waited `waitedMs`, it is `now`, and
 * `dt` ms passed since the last frame. Pure, so the hysteresis can be tested.
 */
export function stepGear(gear: Gear, arrived: number, waitedMs: number, now: number, dt: number): Gear {
  const backlog = Math.max(0, arrived - gear.shown);
  let { catching, since } = gear;
  if (!catching && (backlog >= ENTER_WORDS || waitedMs >= ENTER_MS) && now - since >= REENTRY_MS) {
    catching = true;
    since = now;
  } else if (catching && backlog <= EXIT_WORDS && waitedMs <= EXIT_MS && now - since >= HOLD_MS) {
    catching = false;
    since = now;
  }
  const rate = catching ? Math.max(1 / WORD_MS, backlog / CATCH_SPAN_MS) : 1 / WORD_MS;
  return { shown: Math.min(arrived, gear.shown + rate * dt), catching, since };
}

/** How far into its fade a word let out at `revealedAt` is at `now`: 0 just out, 1 at full ink. */
export const fadeOf = (revealedAt: number, now: number) => Math.max(0, Math.min(1, (now - revealedAt) / FADE_MS));

/** When a text will have fully arrived, been let out and faded in: a bound for what waits on it when nothing paced it. */
export function settledAt(text: string, at: number): number {
  const total = unitsOf(text).length;
  return at + arrivalOf(Math.max(0, total - 1)) + BURST_MS + CATCH_SPAN_MS + HOLD_MS + FADE_MS;
}

const clockNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The part of `text` on screen now, and whether it is still arriving (or fading). `fades` is the ink of the newest
 * words still fading, oldest first, each 0..1; empty once it settles. `still` (Reduce Motion) shows words as they
 * arrive, without the fade.
 */
export function usePaced(text: string, at: number, still = false): { shown: string; streaming: boolean; fades: readonly number[] } {
  const units = unitsOf(text);
  const total = units.length;
  const [, frame] = useReducer((n: number) => n + 1, 0);
  // What had arrived when it first drew is there at once, at full ink.
  const gear = useRef<Gear | null>(null);
  if (!gear.current) gear.current = startGear(arrivedBy(Date.now() - at, total));
  /** When each word was let out (performance clock); words there from the start have none, so they are at full ink. */
  const revealed = useRef<number[]>([]);
  const latest = useRef({ total, at, still });
  latest.current = { total, at, still };

  const count = Math.min(total, Math.floor(gear.current.shown));
  const fades: number[] = [];
  if (!still) {
    const t = clockNow();
    for (let i = count - 1; i >= 0; i--) {
      const out = revealed.current[i];
      if (out === undefined) break;
      const ink = fadeOf(out, t);
      if (ink >= 1) break;
      fades.unshift(ink);
    }
  }
  const streaming = count < total || fades.length > 0;

  useEffect(() => {
    if (!streaming) return;
    let raf = 0;
    let last = clockNow();
    const tick = () => {
      const g = gear.current!;
      const { total: all, at: began, still: calm } = latest.current;
      const clock = clockNow();
      const elapsed = Date.now() - began;
      const arrived = arrivedBy(elapsed, all);
      const before = Math.min(all, Math.floor(g.shown));
      if (calm) gear.current = { ...g, shown: arrived };
      else {
        const waited = before < arrived ? Math.max(0, elapsed - arrivalOf(before)) : 0;
        gear.current = stepGear(g, arrived, waited, clock, Math.min(64, clock - last));
      }
      last = clock;
      const after = Math.min(all, Math.floor(gear.current.shown));
      if (!calm) for (let i = before; i < after; i++) revealed.current[i] = clock;
      frame();
      const lastOut = revealed.current[after - 1];
      const fading = !calm && lastOut !== undefined && clock - lastOut < FADE_MS;
      if (after < all || fading) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [streaming, total]);

  return { shown: units.slice(0, count).join(""), streaming, fades };
}
