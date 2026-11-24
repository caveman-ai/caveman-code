// The arithmetic the page's edges share (ProgressiveEdge.tsx, EdgeBlur): one eased ramp, sampled into gradient stops.
// A ramp that starts or ends with a slope draws a line where it does (the eye finds the corner in a linear gradient),
// so every ramp here is a smoothstep, flat at both ends, and long enough that no line of text straddles a big step.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Smoothstep: 0 to 1 across [0, 1], flat at both ends. */
export const smooth = (u: number) => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};

/** How far a blur layer that hands in between `lo` and `hi` of the whole strength is on, for a strength `s`. */
export const windowed = (s: number, lo: number, hi: number) => smooth((s - lo) / Math.max(1e-6, hi - lo));

/** Points down a box `height` tall, every `step` pt and at both ends: where a gradient's stops go. */
export function samples(height: number, step = 4): number[] {
  const h = Math.max(1, height);
  const n = Math.max(2, Math.ceil(h / step));
  return Array.from({ length: n + 1 }, (_, i) => (i / n) * h);
}

/** A CSS mask down a box from `at(y)` (0 clear, 1 whole), as `linear-gradient` stops in px. */
export function cssMask(height: number, at: (y: number) => number, step = 4): string {
  const stops = samples(height, step).map((y) => `rgba(0,0,0,${clamp01(at(y)).toFixed(3)}) ${y.toFixed(1)}px`);
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}
