// The paintings that ship with the app: each a GLSL function the wallpaper's shader calls (shader.ts PRELUDE says
// what it may use). One file each under paintings/, found here by name, so adding one is adding its file. The
// living ones are packs of creatures instead (packs/, one file each): swarm.ts moves them and tiles.ts draws them.

import type { Pack } from "./swarm.ts";
import { TILES } from "./tiles.ts";

export interface Painting {
  readonly id: string;
  readonly name: string;
  /**
   * How light it is on average, 0 (black) to 1 (white): which ink reads on it (look.ts `inkFor`). "panel": it is
   * painted in the page's own colour (`uPanel`), so as light as the theme is.
   */
  readonly light: number | "panel";
  /** It moves, slowly. A still one is drawn once. */
  readonly moves: boolean;
  /** Frames a second it wants while it moves, when the usual few are too few (falling snow) or more than it needs. */
  readonly fps?: number;
  /**
   * Pixel art: drawn in pixels this many CSS px wide, shown enlarged with nothing smoothed, as the companion is. `p`
   * is then each pixel's middle, and `gl_FragCoord.xy` counts whole pixels.
   */
  readonly pixel?: number;
  /**
   * GLSL ES 3.00 defining `vec3 paint(vec2 p, float t)`: the colour to show (sRGB, 0 to 1) at `p`, where y runs
   * -0.5 (bottom) to 0.5 (top) and x runs -uAspect/2 to uAspect/2, at `t` seconds.
   */
  readonly glsl: string;
  /** A living painting: the creatures on it, which answer the pointer. Its `glsl` draws their tiles. */
  readonly life?: Pack;
}

const files = import.meta.glob<{ default: Painting }>("./paintings/*.ts", { eager: true });
const packs = import.meta.glob<{ default: Pack }>("./packs/*.ts", { eager: true });

/** A pack as a painting: as light as its ground, and quick enough on its feet to answer a click. */
const living = (pack: Pack): Painting => ({
  id: pack.id,
  name: pack.name,
  light:
    [1, 3, 5].reduce((sum, at) => sum + Number.parseInt(pack.ground.slice(at, at + 2), 16), 0) /
    765,
  moves: true,
  fps: 30,
  glsl: TILES,
  life: pack,
});

/** The order Settings shows them in; one not named here follows, by name. The living ones come after the still. */
const ORDER = [
  ...["mist", "flow", "horizon", "aurora", "silk", "snow", "dusk", "campfire", "cavewall"],
  ...["mammoths", "herd", "cavemen", "embers", "hands", "bats", "pterosaurs"],
  ...["koi", "murmuration", "bugs", "lanterns", "ducks"],
];
const place = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);

export const PAINTINGS: ReadonlyArray<Painting> = [
  ...Object.values(files).map((file) => file.default),
  ...Object.values(packs).map((file) => living(file.default)),
].sort((a, b) => place(a.id) - place(b.id) || a.name.localeCompare(b.name));

export const findPainting = (id: string): Painting | undefined =>
  PAINTINGS.find((p) => p.id === id);
