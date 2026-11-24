// Settings > Review, as numbers: where the short-change ruler puts a pull request and the limit. No React, so tests
// read it without a browser.

/** The ruler's right end in lines; a larger change sits at it. */
export const RULER_MAX = 1000;

/** The limits the ruler's handle stops at: numbers a person would pick, about evenly spaced on its log scale. */
export const RULER_STOPS: ReadonlyArray<number> = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

/** Where `lines` sits on the ruler, 0 to 1: log scale from 1 line to RULER_MAX, so 10, 100 and 1,000 are evenly spaced. */
export const rulerAt = (lines: number): number => Math.min(1, Math.max(0, Math.log10(Math.max(1, lines)) / Math.log10(RULER_MAX)));

/** The stop nearest a ruler position 0 to 1. */
export function stopAt(position: number): number {
  let best = RULER_STOPS[0]!;
  for (const stop of RULER_STOPS) if (Math.abs(rulerAt(stop) - position) < Math.abs(rulerAt(best) - position)) best = stop;
  return best;
}

/** The next stop up (1) or down (-1) from `lines`; a limit typed between stops moves to its neighbour that way. */
export function stepStop(lines: number, by: 1 | -1): number {
  if (by > 0) return RULER_STOPS.find((s) => s > lines) ?? RULER_STOPS.at(-1)!;
  return RULER_STOPS.findLast((s) => s < lines) ?? RULER_STOPS[0]!;
}

/**
 * A lane (0 up) for each mark at `positions` (0 to 1), so marks closer than `gap` stack instead of hiding each
 * other; past `max` lanes a mark shares the bottom one.
 */
export function rulerLanes(positions: ReadonlyArray<number>, gap: number, max = 3): number[] {
  const order = positions.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const ends: number[] = [];
  const lanes = new Array<number>(positions.length).fill(0);
  for (const { p, i } of order) {
    let lane = ends.findIndex((end) => p - end >= gap);
    if (lane < 0) lane = ends.length < max ? ends.length : 0;
    ends[lane] = p;
    lanes[i] = lane;
  }
  return lanes;
}

/** Settings > Review's Advanced values when the runtime reports none: the runtime's own defaults. */
export const ADVANCED_DEFAULTS = {
  review_step_up: true,
  review_single_pass_kb: 48,
  review_prewarm_daily: 20,
  review_prewarm_plan_percent: 70,
  review_prewarm_idle_minutes: 2,
} as const;

type Advanced = { -readonly [K in keyof typeof ADVANCED_DEFAULTS]?: ((typeof ADVANCED_DEFAULTS)[K] extends boolean ? boolean : number) | undefined };

/**
 * The folded Advanced section in one line: each value in words, `changed` where it is not the default, so a
 * changed value shows without opening it.
 */
export function advancedSummary(settings: Advanced): Array<{ text: string; changed: boolean }> {
  const v = { ...ADVANCED_DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, x]) => x !== undefined)) } as { [K in keyof typeof ADVANCED_DEFAULTS]: (typeof ADVANCED_DEFAULTS)[K] extends boolean ? boolean : number };
  const changed = (key: keyof typeof ADVANCED_DEFAULTS) => v[key] !== ADVANCED_DEFAULTS[key];
  return [
    { text: v.review_step_up ? "steps up once" : "never steps up", changed: changed("review_step_up") },
    { text: `${v.review_single_pass_kb} KB in one call`, changed: changed("review_single_pass_kb") },
    { text: `${v.review_prewarm_daily} ahead a day`, changed: changed("review_prewarm_daily") },
    { text: `under ${v.review_prewarm_plan_percent}% of a plan`, changed: changed("review_prewarm_plan_percent") },
    { text: `after ${v.review_prewarm_idle_minutes} min quiet`, changed: changed("review_prewarm_idle_minutes") },
  ];
}
