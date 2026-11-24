// H1: whether this computer slept (or was stopped) since the clock was last looked at. The moves pass's watch looks
// every second and the pass at each of its turns; a gap past 6 s between two looks is a sleep, never a long pass (the
// watch keeps looking while one runs). Woken, either may run first: the first to look counts the wake, and the other
// then sees no gap, so each sleep counts once. Before, only the watch looked: a pass that ran first after a sleep of
// more than a minute cleared the lid's mark by its minute rule, did not see the wake, and asked for the lid's chats
// back at once instead of 30 s after it (lidCycle (i), s-sync real stack).

/** How long without a look reads as a sleep. */
export const WAKE_GAP_MS = 6_000;

export function wakeWatch(now: () => number = Date.now, gapMs = WAKE_GAP_MS) {
  let looked = now();
  let wakes = 0;
  let lastGapMs = 0;
  return {
    /** Looks at the clock: whether it slept since the last look (counted once, whoever looks first). */
    look(): boolean {
      const at = now();
      const slept = at - looked > gapMs;
      if (slept) lastGapMs = at - looked;
      looked = at;
      if (slept) wakes++;
      return slept;
    },
    /** How long the last sleep seen lasted between two looks (0: none seen), for the log line that says so. */
    get lastGapMs() {
      return lastGapMs;
    },
    /** How many sleeps were seen. */
    get wakes() {
      return wakes;
    },
  };
}
