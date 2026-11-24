// A voice as a line: what the call's stage and the dictating mic draw (VoiceWave.tsx). A few sine partials summed
// under a bell, so the line rises out of nothing at both ends. How tall it stands follows how loud the sound is, and a
// sound starts in the middle and travels out to the ends over a third of a second, so each syllable is a swell that
// spreads. Which partials lead follows the spectrum (a vowel rolls in long waves, an "s" ripples), and the partials
// travel at their own speeds in opposite directions, so the line flows instead of scrolling. Everything eases on time
// constants, never per frame, so 60 and 120 Hz trace the same curve. Numbers only here; the canvas is VoiceWave's.

/** Bands of a sound's spectrum a source reports, low to high. */
export const BANDS = 8;

/** What a wave is drawn from, read once a frame: how loud the sound is now and its spectrum, both 0..1. */
export interface WaveSource {
  level(): number;
  bands(into: Float32Array): void;
}

/** Nothing sounding. */
export const SILENT: WaveSource = { level: () => 0, bands: (into) => void into.fill(0) };

/** What the line does while nothing sounds: drifts (it is listening), carries a ripple across (it is thinking), or lies flat. */
export type WaveRest = "drift" | "think" | "flat";

const PARTIALS = 4;
/** Cycles across the line, per partial. */
const CYCLES = [1.3, 2.2, 3.4, 5.1] as const;
/** How fast each partial travels at rest, in radians a second; neighbours run opposite ways. */
const SPEED = [2.1, -2.9, 3.8, -5.2] as const;
/** Each partial's share when the spectrum says nothing. */
const BASE = [0.34, 0.3, 0.22, 0.14] as const;
/** How long a sound takes from the middle of the line to its ends, in seconds, and how finely its way there is kept. */
const SPREAD_S = 0.34;
const HOP_S = 1 / 100;
const HISTORY = Math.ceil(SPREAD_S / HOP_S) + 2;
/** How far from the middle the way out is rounded off. */
const CREASE = 0.14;
/**
 * The line and its echoes: how tall each stands beside the line (negative: mirrored) and how far its partials trail.
 * The last is the line's own reflection, so the two close a body between them that pinches wherever the line crosses.
 */
const ECHO = [
  { gain: 1, lag: 0 },
  { gain: 0.66, lag: 0.55 },
  { gain: -0.5, lag: 1.2 },
  { gain: -0.8, lag: 0 },
] as const;
export const LAYERS = ECHO.length;

export interface WaveState {
  /** How loud, eased: quick to rise, slower to fall. */
  level: number;
  /** The level eased once more, so a sudden sound (a knock) starts with no corner: what the line stands to. */
  swell: number;
  /** The swell as it was, a ring of one value every HOP_S with the newest at `head`, `since` seconds old. */
  readonly history: Float32Array;
  head: number;
  since: number;
  /** Each partial's share of the height; they sum to 1. */
  readonly share: Float32Array;
  readonly phase: Float32Array;
  /** How much of the drift and of the thinking ripple shows, 0..1. */
  drift: number;
  think: number;
  /** Seconds the line has run. */
  time: number;
}

export const newWave = (): WaveState => ({
  level: 0,
  swell: 0,
  history: new Float32Array(HISTORY),
  head: 0,
  since: 0,
  share: Float32Array.from(BASE),
  phase: new Float32Array(PARTIALS),
  drift: 0,
  think: 0,
  time: 0,
});

/** `from` on its way to `to` after `dt` seconds, closing the gap with time constant `tau`: the same path at any frame rate. */
const ease = (from: number, to: number, dt: number, tau: number): number =>
  to + (from - to) * Math.exp(-dt / tau);

/** Moves the line on by `dt` seconds toward the sound it is given. */
export function stepWave(
  s: WaveState,
  dt: number,
  level: number,
  bands: Float32Array,
  rest: WaveRest,
): void {
  // Quick to rise, slower to fall: a word is one swell, not a flicker.
  s.level = ease(s.level, Math.min(1, Math.max(0, level)), dt, level > s.level ? 0.04 : 0.26);
  const before = s.swell;
  s.swell = ease(before, s.level, dt, 0.03);
  // Kept at its own fixed rate, each value taken from where in the frame it fell, whatever the screen's rate.
  s.since += dt;
  while (s.since >= HOP_S) {
    s.since -= HOP_S;
    s.head = (s.head + 1) % HISTORY;
    s.history[s.head] = before + (s.swell - before) * (1 - s.since / dt);
  }
  let sum = 0;
  for (let b = 0; b < BANDS; b++) sum += bands[b] ?? 0;
  for (let k = 0; k < PARTIALS; k++) {
    // The spectrum leans the mix; it never hands the line to one partial.
    const lean = sum > 0.01 ? ((bands[k * 2] ?? 0) + (bands[k * 2 + 1] ?? 0)) / sum : BASE[k]!;
    s.share[k] = ease(s.share[k]!, BASE[k]! * 0.6 + lean * 0.4, dt, 0.09);
    // Louder flows faster. Kept inside one turn, so a long call loses no precision.
    s.phase[k] = (s.phase[k]! + SPEED[k]! * (0.5 + 1.4 * s.swell) * dt) % (Math.PI * 2);
  }
  s.drift = ease(s.drift, rest === "drift" ? 1 : 0, dt, 0.25);
  s.think = ease(s.think, rest === "think" ? 1 : 0, dt, 0.25);
  s.time += dt;
}

/**
 * What the line keeps when what it draws changes (VoiceWave's source or rest): everything, so a new sound picks up
 * where the last one was and the hang-up's sound plays out; but with no sound and nothing to do in a silence (muted),
 * it lies flat at once instead of easing out of the last word.
 */
export function retargetWave(s: WaveState, source: boolean, rest: WaveRest): void {
  if (source || rest !== "flat") return;
  s.level = 0;
  s.swell = 0;
  s.since = 0;
  s.drift = 0;
  s.think = 0;
  s.history.fill(0);
}

/** How loud the line was `age` seconds ago, between the values it kept. */
function heard(s: WaveState, age: number): number {
  if (age <= s.since)
    return s.since > 0 ? s.swell + (s.history[s.head]! - s.swell) * (age / s.since) : s.swell;
  const back = (age - s.since) / HOP_S;
  const whole = Math.min(HISTORY - 2, Math.floor(back));
  const at = (hops: number) => s.history[(s.head - hops + HISTORY) % HISTORY]!;
  return at(whole) + (at(whole + 1) - at(whole)) * Math.min(1, back - whole);
}

/**
 * The line's height at `x` (-1 its left end, 1 its right), as a share of half the box: -1..1, and 0 at both ends.
 * `layer`: 0 the line, then its echoes. `rest`: how tall the drift stands, as that same share. `detail`: how much of
 * the partials' cycles a line this long has room for (1: all of them; a short line takes fewer, so it never scribbles).
 */
export function waveAt(s: WaveState, x: number, layer: number, rest: number, detail = 1): number {
  const echo = ECHO[layer] ?? ECHO[0];
  const bell = (1 - x * x) ** 1.4;
  let voice = 0;
  for (let k = 0; k < PARTIALS; k++)
    voice +=
      s.share[k]! *
      Math.sin(Math.PI * CYCLES[k]! * detail * x + s.phase[k]! + echo.lag * (k + 1) * 0.6);
  // What sounds now stands in the middle; what sounded a moment ago has travelled out toward the ends. The distance
  // is rounded off at the middle, so a swell on its way out has no crease there.
  const out = Math.hypot(x, CREASE) - CREASE;
  const loud = Math.min(1, heard(s, out * SPREAD_S) ** 0.75 * 1.15);
  // The ripple crosses left to right every 1.7 s, each echo a little behind, so it wears a tail.
  const at = ((s.time / 1.7) % 1) * 2.5 - 1.25 - layer * 0.13;
  const ripple = Math.exp(-(((x - at) / 0.46) ** 2)) * Math.sin(Math.PI * 2.6 * (x - at));
  const drift =
    Math.sin(Math.PI * 1.1 * detail * x + s.time * 1.4 - echo.lag * 1.3) *
    (0.75 + 0.25 * Math.sin(s.time * 0.9));
  // What moves at rest gives way to the voice, so the whole never leaves the box.
  const quiet = (1 - loud) * rest * ((s.drift + s.think * 0.5) * drift + s.think * 7 * ripple);
  // The partials seldom peak together, so the sum is lifted, and bent back under 1 where they do.
  return bell * echo.gain * Math.tanh(1.9 * loud * voice + quiet);
}

/** Too quiet to lift the line by a tenth of a pixel. */
const QUIET = 0.0001;

/** Nothing left to move: silent all the way out to the ends, with no drift or ripple showing. */
export const waveSettled = (s: WaveState): boolean =>
  s.swell < QUIET && s.drift < 0.002 && s.think < 0.002 && s.history.every((v) => v < QUIET);
