// A Recommended card's banner: a field of ASCII characters, ordered-dithered (Bayer 4x4) from a glow around the logo,
// a slow diagonal wave and soft noise. Seeded from the plugin's name, so each card has its own pattern and keeps it.
// Pure; Recommended.tsx sets it in a <pre> in the plugin's brand colour.

/** Dark to light: a cell's character by how lit it is. */
export const RAMP = " .:-=+*#%@";

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

/** A character is about 0.6 of a line wide: distances across are scaled by it so the glow is round. */
const ASPECT = 0.6;

/** FNV-1a, then a mulberry32 stream: the same name gives the same numbers. */
function stream(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `rows` lines of `cols` characters. The middle is left blank for the logo (`hole`, in lines); around it the glow is
 * brightest, and it fades towards the edges.
 */
export function ditherField(seed: string, cols: number, rows: number, hole = 6): string {
  const rand = stream(seed);
  // Value noise on a coarse lattice, eased between its points: soft blobs, not grain.
  const STEP = 6;
  const lw = Math.ceil(cols / STEP) + 2;
  const lh = Math.ceil(rows / (STEP * ASPECT)) + 2;
  const lattice = Array.from({ length: lw * lh }, rand);
  const at = (x: number, y: number) => lattice[Math.min(lh - 1, y) * lw + Math.min(lw - 1, x)]!;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const gx = x / STEP;
    const gy = y / (STEP * ASPECT);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = ease(gx - x0);
    const ty = ease(gy - y0);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return top + (bottom - top) * ty;
  };
  const angle = rand() * Math.PI;
  const freq = 0.28 + rand() * 0.22;
  const phase = rand() * Math.PI * 2;
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const far = Math.hypot(cx * ASPECT, cy);
  const top = RAMP.length - 1;
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      const dx = (x - cx) * ASPECT;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d < hole) {
        line += " ";
        continue;
      }
      const glow = Math.exp(-(((d - hole - 1) / 6) ** 2));
      const wave =
        0.5 + 0.5 * Math.sin((dx * Math.cos(angle) + dy * Math.sin(angle)) * freq + phase);
      const v = 0.72 * glow + 0.22 * wave + 0.3 * noise(x, y) - 0.55 * (d / far);
      const level = Math.floor(v * top + BAYER[y % 4]![x % 4]! / 16);
      line += RAMP[Math.max(0, Math.min(top, level))];
    }
    lines.push(line);
  }
  return lines.join("\n");
}
