/**
 * Every pixel icon is a little toy (STYLE.md 8 "Toys"). Hover wakes it; a
 * click sets it off. Both are flipbooks: held frames drawn on the icon's own
 * grid, so nothing scales, blurs or lands between pixels, at any size.
 *
 * Calm toys ("far too aggressive, tone them down, i hate
 * the bouncing up and down"): one small gesture each, in place. Nothing hops,
 * flips or flies off; a part moves a pixel or two, lights up or is redrawn,
 * and every frame stays inside the 16x16 box.
 *
 * A toy is a rig and two timelines. The rig cuts the glyph into parts (a
 * crown, a letter, a knob); a beat holds for some milliseconds with each part
 * moved, swapped for another drawing or hidden, and a few pixels painted over
 * it (a spark, a ring, a drop). PixelIcon draws every frame once; pixel.css
 * shows each in turn.
 *
 * An icon without a toy of its own gets one made from its drawing: on hover
 * its top half leans a pixel, on a click it is pressed in a row. A glyph
 * drawn tomorrow plays on day one.
 */
import { GLYPHS, type GlyphPath } from "./glyphs";
import type { PixelIconName } from "./names";

/** A drawing as pixels: x, y and its palette char (glyphs.ts). */
export type Px = ReadonlyArray<readonly [x: number, y: number, ch: string]>;
export type Vec = readonly [x: number, y: number];
/** Where a part is in a beat: moved, redrawn (and moved), or gone. */
type Place = Vec | null | { draw?: Px; at?: Vec };
type Beat = { ms: number; parts: Readonly<Record<string, Place>>; fx: ReadonlyArray<readonly [Px, number, number]> };
type Rig = ReadonlyArray<readonly [name: string, part: Px]>;

/** The fx colour: glint on light, tunic orange on dark (`--px-shine`). */
export const SPARK = "*";

export type Flipbook = { ms: number; frames: ReadonlyArray<{ t: number; ms: number; paths: GlyphPath[] }> };
export type Toy = { hover: Flipbook; pop: Flipbook };

// ── Drawing ─────────────────────────────────────────────────────────────────

/** Pixels of a grid, or of a small sprite written on one line with `|` between rows. */
export function px(drawing: string | readonly string[]): Px {
  const rows = typeof drawing === "string" ? drawing.split("|") : drawing;
  return rows.flatMap((row, y) => [...row].flatMap((ch, x) => (ch === "." ? [] : [[x, y, ch] as const])));
}

export const shift = (p: Px, dx: number, dy: number): Px => p.map(([x, y, ch]) => [x + dx, y + dy, ch] as const);
/** Recoloured: every pixel in `ch` (a flash, a part lit up). */
export const tint = (p: Px, ch: string): Px => p.map(([x, y]) => [x, y, ch] as const);
/** Turned a quarter clockwise about the 16px box (the one rotation pixel art allows). */
export const turn = (p: Px): Px => p.map(([x, y, ch]) => [15 - y, x, ch] as const);
/** Only the pixels a test keeps. */
export const keep = (p: Px, test: (x: number, y: number, ch: string) => boolean): Px => p.filter(([x, y, ch]) => test(x, y, ch));

/** Squashed: `row` folds away and everything above it comes down one. Stacks: squash twice, two rows. */
export const squash = (p: Px, row: number): Px => p.flatMap(([x, y, ch]) => (y === row ? [] : y < row ? [[x, y + 1, ch] as const] : [[x, y, ch] as const]));
/** Stretched: `row` is drawn twice and everything above it goes up one. */
export const stretch = (p: Px, row: number): Px =>
  p.flatMap(([x, y, ch]) => (y === row ? [[x, y - 1, ch] as const, [x, y, ch] as const] : y < row ? [[x, y - 1, ch] as const] : [[x, y, ch] as const]));

/** The drawn box: [left, top, right, bottom], inclusive. */
export function bounds(p: Px): readonly [number, number, number, number] {
  let [l, t, r, b] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of p) [l, t, r, b] = [Math.min(l, x), Math.min(t, y), Math.max(r, x), Math.max(b, y)];
  return [l, t, r, b];
}

/**
 * Squeezed to `w` columns about its own centre, a cover seen at an angle:
 * each column is drawn wherever any of the columns it stands for has a pixel,
 * so the outline survives.
 */
export function narrow(p: Px, w: number): Px {
  const [l, , r] = bounds(p);
  const width = r - l + 1;
  const left = Math.round((l + r + 1) / 2 - w / 2);
  const out = new Map<string, readonly [number, number, string]>();
  for (const [x, y, ch] of p) {
    const X = left + Math.min(w - 1, Math.floor(((x - l) * w) / width));
    const key = `${X},${y}`;
    if (!out.has(key)) out.set(key, [X, y, ch]);
  }
  return [...out.values()];
}

// ── Rigging and timelines ──────────────────────────────────────────────────

type Test = (x: number, y: number, ch: string) => boolean;
export const rows = (top: number, bottom: number): Test => (_, y) => y >= top && y <= bottom;
export const box = (left: number, top: number, right: number, bottom: number): Test => (x, y) => x >= left && x <= right && y >= top && y <= bottom;
export const chars = (set: string): Test => (_, __, ch) => set.includes(ch);

/**
 * Cut a glyph into parts, painted in the order given: each drawn pixel goes to
 * the first part whose test takes it. The pixels no test takes are `body`,
 * painted first unless a key says "rest", which puts them there instead.
 */
export function cut(grid: readonly string[], tests: Readonly<Record<string, Test | "rest">>): Rig {
  const parts = new Map<string, Array<readonly [number, number, string]>>();
  const named = Object.entries(tests);
  const restName = named.find(([, t]) => t === "rest")?.[0] ?? "body";
  if (!named.some(([, t]) => t === "rest")) parts.set(restName, []);
  for (const [name] of named) parts.set(name, []);
  for (const [x, y, ch] of px(grid)) {
    const hit = named.find(([, t]) => t !== "rest" && t(x, y, ch))?.[0] ?? restName;
    parts.get(hit)!.push([x, y, ch]);
  }
  return [...parts];
}

/** One beat: hold `ms`; parts not named stay at rest; each fx is a drawing at [x, y], painted over the parts. */
export const beat = (ms: number, parts: Readonly<Record<string, Place>> = {}, ...fx: ReadonlyArray<readonly [Px, number, number]>): Beat => ({ ms, parts, fx });

const isVec = (p: Place): p is Vec => Array.isArray(p);

function paint(rig: Rig, b: Beat): GlyphPath[] {
  const canvas = new Map<number, Map<number, string>>();
  const put = (x: number, y: number, ch: string) => {
    let row = canvas.get(y);
    if (!row) canvas.set(y, (row = new Map()));
    row.set(x, ch);
  };
  for (const [name, part] of rig) {
    const place = name in b.parts ? b.parts[name]! : ([0, 0] as const);
    if (place === null) continue;
    const { draw = part, at = [0, 0] } = isVec(place) ? { at: place } : place;
    for (const [x, y, ch] of draw) put(x + at[0], y + at[1], ch);
  }
  for (const [drawing, dx, dy] of b.fx) for (const [x, y, ch] of drawing) put(x + dx, y + dy, ch);
  // One path per colour: horizontal runs, row by row (glyphs.ts glyphPaths).
  const byChar = new Map<string, string[]>();
  for (const y of [...canvas.keys()].sort((a, c) => a - c)) {
    const row = canvas.get(y)!;
    const xs = [...row.keys()].sort((a, c) => a - c);
    for (let i = 0; i < xs.length; ) {
      const ch = row.get(xs[i]!)!;
      let j = i + 1;
      while (j < xs.length && xs[j] === xs[j - 1]! + 1 && row.get(xs[j]!) === ch) j++;
      const runs = byChar.get(ch) ?? [];
      runs.push(`M${xs[i]} ${y}h${j - i}v1h-${j - i}z`);
      byChar.set(ch, runs);
      i = j;
    }
  }
  return [...byChar].map(([char, runs]) => ({ char, d: runs.join("") }));
}

function book(rig: Rig, beats: readonly Beat[]): Flipbook {
  let t = 0;
  const frames = beats.map((b) => {
    const frame = { t, ms: b.ms, paths: paint(rig, b) };
    t += b.ms;
    return frame;
  });
  return { ms: t, frames };
}

/** A toy from a rig and its two timelines, each a list of beats. */
export function toy(rig: Rig, hover: readonly Beat[], pop: readonly Beat[]): Toy {
  return { hover: book(rig, hover), pop: book(rig, pop) };
}

// ── The toy every icon gets ────────────────────────────────────────────────

/**
 * The lean and the press, made from any drawing. Hover: its top half leans a
 * pixel to the right, a nod. Click: it is pressed in a row and lets go.
 */
export function madeToy(grid: readonly string[]): Toy {
  const body = px(grid);
  const [, t, , b] = bounds(body);
  const mid = Math.floor((t + b + 1) / 2);
  const lean = body.map(([x, y, ch]) => [y < mid ? x + 1 : x, y, ch] as const);
  return toy([["body", body]], [beat(100, { body: { draw: lean } })], [beat(110, { body: { draw: squash(body, mid) } })]);
}

// ── Toys of their own ──────────────────────────────────────────────────────

type Fx = readonly [Px, number, number];
const ONE = px(SPARK);
/** A drawing at [x, y] in a beat. */
const fx = (p: Px, x: number, y: number): Fx => [p, x, y];
/** A four-point star. */
const STAR = px(".*.|*.*|.*.");
const STAR_LIT = px(".*.|***|.*.");
/** A row of `ch` from x0 to x1 at y. */
const line = (x0: number, x1: number, y: number, ch = "#"): Px => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, ch] as const);
const partOf = (rig: Rig, name: string): Px => rig.find(([n]) => n === name)![1];
/** A part redrawn where it stands in one colour: lit (the fx colour) or a state colour. */
const lit = (rig: Rig, name: string, ch = SPARK): Place => ({ draw: tint(partOf(rig, name), ch) });
const SMOKE = px(".:.|:::|.:.");

type Drawn = Exclude<PixelIconName, "engine-caveman">;

/** An engine tile: its monogram (in the sprite outline) nods inside the tile on hover; a click presses the tile in a row. */
function tileToy(grid: readonly string[]): Toy {
  const all = px(grid);
  const fill = all.find(([, , ch]) => ch !== "k")![2];
  const rig: Rig = [["tile", all.map(([x, y, ch]) => [x, y, ch === "k" ? fill : ch] as const)], ["mono", keep(all, (_, __, ch) => ch === "k")]];
  const mono = partOf(rig, "mono");
  return toy(rig, [beat(100, { mono: { draw: mono.map(([x, y, ch]) => [y < 8 ? x + 1 : x, y, ch] as const) } })], [beat(110, { tile: { draw: squash(partOf(rig, "tile"), 8) }, mono: { draw: squash(mono, 8) } })]);
}

const TOYS: Partial<Record<Drawn, () => Toy>> = {
  "engine-claude-agent": () => tileToy(GLYPHS["engine-claude-agent"]),
  "engine-codex": () => tileToy(GLYPHS["engine-codex"]),
  "engine-acp": () => tileToy(GLYPHS["engine-acp"]),

  /** New: a plus. Hover: its arms push out a pixel. Click: they push out two, the middle lit, and come back. */
  new: () => {
    const rig = cut(GLYPHS.new, { up: box(7, 3, 8, 6), down: box(7, 9, 8, 12), left: box(3, 7, 6, 8), right: box(9, 7, 12, 8) });
    const spread = (d: number) => ({ up: [0, -d] as Vec, down: [0, d] as Vec, left: [-d, 0] as Vec, right: [d, 0] as Vec });
    return toy(rig, [beat(100, spread(1))], [beat(50, spread(1)), beat(100, { ...spread(2), body: lit(rig, "body") }), beat(50, spread(1))]);
  },

  /** Search: a lens. Hover: a glint slides across the glass. Click: the lens swells a pixel all round and settles. */
  search: () => {
    const rig = cut(GLYPHS.search, { glint: box(4, 5, 5, 6), handle: (x, y) => x >= 9 && y >= 9 });
    const MID = shift(px(["...#####...", "..#.....#..", ".#.......#.", "#.........#", "#.........#", "#.........#", "#.........#", "#.........#", ".#.......#.", "..#.....#..", "...#####..."]), 1, 1);
    const glint = (d: number): Place => ({ draw: tint(partOf(rig, "glint"), SPARK), at: [d, d] });
    return toy(
      rig,
      [beat(60, { glint: glint(0) }), beat(60, { glint: glint(1) }), beat(60, { glint: glint(2) })],
      [beat(110, { body: { draw: MID }, handle: [1, 1], glint: glint(-1) }), beat(60, { glint: glint(0) })],
    );
  },

  /** Chief: the crown. Hover: a gleam runs across the crown and the Chief blinks. Click: the crown shines and he shuts his eyes, pleased. */
  chief: () => {
    const rig = cut(GLYPHS.chief, { crown: rows(0, 4), eyes: box(5, 7, 10, 8) });
    const crown = partOf(rig, "crown");
    const shut = { draw: keep(partOf(rig, "eyes"), (_, y) => y === 8) };
    const gleam = (from: number, to: number): Place => ({ draw: crown.map(([x, y, ch]) => [x, y, x >= from && x <= to ? SPARK : ch] as const) });
    return toy(
      rig,
      [beat(50, { crown: gleam(2, 5) }), beat(60, { crown: gleam(6, 9), eyes: shut }), beat(50, { crown: gleam(10, 13) })],
      [beat(140, { crown: lit(rig, "crown"), eyes: shut }), beat(60, { eyes: shut })],
    );
  },

  /** Settings: the gear. Hover: it turns three notches. Click: it turns five, quicker. */
  settings: () => {
    const rig = cut(GLYPHS.settings, { hub: box(5, 5, 10, 10) });
    // The gear a half tooth on (22.5 degrees): the same shape, its teeth between the drawn ones.
    const HALF = px([
      "................", ".....##..##.....", "....#.#..#.#....", "....#..##..#....", "..##.#....#.##..", ".#..#......#..#.", ".##..........##.", "...#........#...",
      "...#........#...", ".##..........##.", ".#..#......#..#.", "..##.#....#.##..", "....#..##..#....", "....#.#..#.#....", ".....##..##.....",
    ]);
    const HUB_X = px(["", "", "", "", "", ".....#....#.....", ".....##..##.....", "......####......", "......####......", ".....##..##.....", ".....#....#....."]);
    const half = { body: { draw: HALF }, hub: { draw: HUB_X } };
    return toy(rig, [beat(80, half), beat(70, {}), beat(80, half)], [beat(45, half), beat(45, {}), beat(45, half), beat(45, {}), beat(50, half)]);
  },

  /** Inbox: a letter in a tray. Hover: its lines light up, one then the other, as if read. Click: it is pushed a pixel down into the tray. */
  inbox: () => {
    const rig = cut(GLYPHS.inbox, { l1: box(6, 4, 9, 4), l2: box(6, 6, 8, 6), letter: box(4, 2, 11, 9), tray: "rest" });
    const down = (name: string, ch?: string): Place => ({ draw: ch ? tint(partOf(rig, name), ch) : partOf(rig, name), at: [0, 1] });
    return toy(
      rig,
      [beat(70, { l1: lit(rig, "l1") }), beat(70, { l2: lit(rig, "l2") })],
      [beat(120, { letter: down("letter"), l1: down("l1", SPARK), l2: down("l2", SPARK) })],
    );
  },

  /** Automations: the bolt. Hover: a charge runs down it, top half then bottom, and a spark jumps off its tip. Click: it flashes twice, sparks off its tip. */
  automations: () => {
    const rig = cut(GLYPHS.automations, { top: rows(0, 6) });
    const flash = { top: lit(rig, "top"), body: lit(rig, "body") };
    return toy(
      rig,
      [beat(60, { top: lit(rig, "top") }), beat(60, { body: lit(rig, "body") }), beat(50, {}, fx(ONE, 3, 13))],
      [beat(50, flash), beat(40, {}), beat(80, flash, fx(ONE, 3, 13)), beat(50, {}, fx(ONE, 2, 14), fx(ONE, 5, 13))],
    );
  },

  /** Getting started: the rocket. Hover: its flame flickers. Click: the flame roars and puffs smoke; the rocket stays on its pad. */
  rocket: () => {
    const rig = cut(GLYPHS.rocket, { exhaust: chars(":"), ship: "rest" });
    const FLAME = [px("..w|.wt|t.."), px("..ww|.wwt|wwt.|tt.."), px("...ww|..wwt|.wwt.|wwt..|tt...")];
    // The flame hangs off the ship's tail, down and to the left of it.
    const flame = (size: number): Fx => fx(FLAME[size]!, 6 - bounds(FLAME[size]!)[2], 10);
    const fired = { exhaust: null };
    return toy(
      rig,
      [beat(60, fired, flame(0)), beat(60, fired, flame(1)), beat(60, fired, flame(0))],
      [beat(50, fired, flame(1)), beat(100, fired, flame(2), fx(SMOKE, 0, 12)), beat(60, fired, flame(1))],
    );
  },

  /** Review: a pull request's three nodes on wires. Hover: the branch's node lights, then the base's. Click: a spark runs from the branch up and over the arrow into the base, which lights up. */
  review: () => {
    const rig = cut(GLYPHS.review, { tl: box(2, 1, 6, 5), bl: box(2, 10, 6, 14), br: box(9, 10, 13, 14), arrow: box(8, 1, 13, 9) });
    return toy(
      rig,
      [beat(80, { br: lit(rig, "br") }), beat(80, { tl: lit(rig, "tl") })],
      [
        beat(40, { br: lit(rig, "br") }),
        beat(40, {}, fx(px("*|*"), 12, 7)),
        beat(40, {}, fx(px("*|*"), 12, 4)),
        beat(40, {}, fx(px("**"), 10, 3)),
        beat(40, { arrow: lit(rig, "arrow") }, fx(px("**"), 7, 3)),
        beat(90, { tl: lit(rig, "tl") }),
      ],
    );
  },

  /** Plugins: four blocks. Hover: the odd block nudges in toward the others. Click: all four snap together a pixel and part again. */
  spaces: () => {
    const rig = cut(GLYPHS.spaces, { tl: box(0, 0, 7, 7), tr: box(8, 0, 15, 7), br: box(8, 8, 15, 15), bl: box(0, 8, 7, 15) });
    return toy(rig, [beat(100, { br: [-1, -1] })], [beat(110, { tl: [1, 1], tr: [-1, 1], br: [-1, -1], bl: [1, -1] }), beat(50, { br: [-1, -1] })]);
  },

  /** Customize: three sliders. Hover: the knobs slide two pixels and back. Click: they line up in one column and go home. */
  customize: () => {
    const rig = cut(GLYPHS.customize, { s1: rows(2, 4), s2: rows(6, 8), s3: rows(10, 12) });
    const slider = (y: number, k: number): Px => [
      ...line(1, 14, y).filter(([x]) => x < k - 1 || x > k + 2),
      ...[y - 1, y, y + 1].flatMap((ky) => [[k, ky, "t"] as const, [k + 1, ky, "t"] as const]),
    ];
    const knobs = (a: number, b: number, c: number) => ({ s1: { draw: slider(3, a) }, s2: { draw: slider(7, b) }, s3: { draw: slider(11, c) } });
    return toy(
      rig,
      [beat(60, knobs(5, 9, 7)), beat(80, knobs(6, 8, 8)), beat(60, knobs(5, 9, 7))],
      [beat(50, knobs(6, 8, 7)), beat(120, knobs(7, 7, 7)), beat(50, knobs(6, 8, 7))],
    );
  },

  /** Files and folders: the paperclip. Hover: it gives a little twist. Click: it is pinched a row shorter and lets go with a twist. */
  attach: () => {
    const rig = cut(GLYPHS.attach, {});
    const clip = partOf(rig, "body");
    const twist = { body: { draw: clip.map(([x, y, ch]) => [y < 8 ? x + 1 : x, y, ch] as const) } };
    return toy(rig, [beat(100, twist)], [beat(110, { body: { draw: squash(clip, 8) } }), beat(60, twist)]);
  },

  /** Goal: the target. Hover: the ring round the bullseye lights. Click: a dart flies the last two pixels in and the ring lights. */
  goal: () => {
    const rig = cut(GLYPHS.goal, { eye: chars("t"), inner: box(5, 5, 10, 10), outer: "rest" });
    // Tip at its bottom left (0, 4); amber fletching at the tail.
    const DART = px("...ww|...#w|..#..|.#...|#....");
    const dart = (x: number, y: number) => fx(DART, x, y - 4);
    return toy(
      rig,
      [beat(110, { inner: lit(rig, "inner") })],
      [beat(50, {}, dart(10, 6)), beat(110, { inner: lit(rig, "inner") }, dart(8, 8)), beat(60, {}, dart(8, 8))],
    );
  },

  /** Grill mode: the kettle grill. Hover: its flames flicker a row taller and back. Click: they duck, then flare up and throw an ember. */
  "grill-mode": () => {
    const rig = cut(GLYPHS["grill-mode"], { flames: chars("t") });
    const flames = partOf(rig, "flames");
    // The top pixel of each tongue burns hot.
    const hot = (p: Px): Place => ({ draw: p.map(([x, y, ch]) => [x, y, p.some(([a, b]) => a === x && b === y - 1) ? ch : "w"] as const) });
    const tall = stretch(flames, 4);
    return toy(
      rig,
      [beat(60, { flames: hot(flames) }), beat(70, { flames: hot(tall) }), beat(60, { flames: hot(flames) })],
      [beat(50, { flames: { draw: squash(flames, 3) } }), beat(100, { flames: hot(tall) }, fx(ONE, 3, 0)), beat(60, { flames: hot(flames) }, fx(ONE, 2, 0))],
    );
  },

  /** Record a skill: the record button. Hover: the dot shrinks and comes back red. Click: it blinks red. */
  "record-skill": () => {
    const rig = cut(GLYPHS["record-skill"], { dot: box(5, 5, 10, 10) });
    const dot = partOf(rig, "dot");
    const small = keep(dot, (x, y) => x > 5 && x < 10 && y > 5 && y < 10);
    const red = (p: Px) => ({ dot: { draw: tint(p, "x") } });
    return toy(rig, [beat(60, { dot: { draw: small } }), beat(100, red(dot))], [beat(70, red(dot)), beat(50, red(small)), beat(100, red(dot))]);
  },

  /** Plugin: a fire in its cave. Hover: the fire flickers. Click: it flares bright and settles. */
  space: () => {
    const rig = cut(GLYPHS.space, { fire: chars("tl") });
    const fire = partOf(rig, "fire");
    const flick = (extra: Px, hot = false): Place => ({ draw: [...(hot ? fire.map(([x, y]) => [x, y, y === 10 ? "w" : "t"] as const) : fire), ...extra] });
    const tip = (x: number, y: number, ch = "w"): Px => [[x, y, ch]];
    return toy(
      rig,
      [beat(60, { fire: flick(tip(8, 9)) }), beat(60, { fire: flick(tip(7, 9)) }), beat(60, { fire: flick([...tip(8, 9), ...tip(8, 8)]) })],
      [
        beat(50, { fire: flick([...tip(7, 9), ...tip(8, 9, "t")]) }),
        beat(100, { fire: flick([...line(7, 8, 9, "t"), ...tip(7, 8), ...tip(8, 8)], true) }),
        beat(60, { fire: flick([...tip(7, 9), ...tip(8, 8)]) }),
      ],
    );
  },

  /** Permissions: the shield. Hover: its check draws itself, stroke by stroke, and turns green. Click: the shield is pressed in a row, its check green. */
  approve: () => {
    const rig = cut(GLYPHS.approve, { check: box(4, 5, 11, 9) });
    const check = [...partOf(rig, "check")].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const upTo = (n: number) => ({ check: { draw: check.slice(0, n) } });
    const green = { draw: tint(check, "v") };
    return toy(
      rig,
      [beat(50, upTo(0)), beat(45, upTo(4)), beat(45, upTo(8)), beat(100, { check: green })],
      [beat(110, { body: { draw: squash(partOf(rig, "body"), 9) }, check: { ...green, at: [0, 1] } }), beat(70, { check: green })],
    );
  },

  /** Split view: a window and its divider. Hover: the divider slides two pixels over and back, the panel growing. Click: it slides out to give the panel most of the window, and back. */
  "split-view": () => {
    const rig = cut(GLYPHS["split-view"], {});
    const frame = keep(partOf(rig, "body"), (x, y) => y === 2 || y === 12 || x === 1 || x === 14);
    const split = (d: number): Place => ({
      draw: [...frame, ...[3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((y) => [[d, y, "#"] as const, [d + 1, y, "#"] as const]), ...[4, 5, 6, 7, 8, 9, 10].flatMap((y) => line(d + 3, 12, y, ":"))],
    });
    return toy(
      rig,
      [beat(60, { body: split(6) }), beat(80, { body: split(5) }), beat(60, { body: split(6) })],
      [beat(45, { body: split(5) }), beat(110, { body: split(3) }), beat(50, { body: split(5) })],
    );
  },

  /** Call the Chief: the handset. Hover: it rings, one ring coming off it and then another. Click: it turns green, ringing. */
  call: () => {
    const rig = cut(GLYPHS.call, {});
    const RING = px("*.|.*|*.");
    const green = { body: lit(rig, "body", "v") };
    return toy(
      rig,
      [beat(70, {}, fx(RING, 8, 1)), beat(80, {}, fx(RING, 8, 1), fx(RING, 11, 0))],
      [beat(60, green, fx(RING, 8, 1)), beat(110, green, fx(RING, 8, 1), fx(RING, 11, 0))],
    );
  },

  /** Hang up: the handset put down. Hover: it turns red. Click: it is pressed down on its cradle, red. */
  "call-end": () => {
    const rig = cut(GLYPHS["call-end"], {});
    const set = partOf(rig, "body");
    return toy(rig, [beat(100, { body: lit(rig, "body", "x") })], [beat(120, { body: { draw: tint(squash(set, 9), "x") } }), beat(60, { body: lit(rig, "body", "x") })]);
  },

  /** Mute: the microphone. Hover: a sound wave rolls off each side. Click: it is tapped, "testing", and a bigger wave goes out. */
  mic: () => {
    const rig = cut(GLYPHS.mic, { capsule: box(5, 1, 10, 8), stand: "rest" });
    const WAVE = px("*|*|*");
    return toy(
      rig,
      [beat(70, {}, fx(WAVE, 1, 3), fx(WAVE, 14, 3)), beat(70, {}, fx(WAVE, 0, 3), fx(WAVE, 15, 3))],
      [beat(60, { capsule: [0, 1] }), beat(110, {}, fx(px(".*|*.|*.|*.|.*"), 0, 2), fx(px("*.|.*|.*|.*|*."), 14, 2))],
    );
  },

  /** Unmute: the microphone, struck through. Hover: the slash turns red. Click: the slash is drawn across again, in red. */
  "mic-off": () => {
    const rig = cut(GLYPHS["mic-off"], { slash: (x, y) => x === y });
    const slash = partOf(rig, "slash");
    const red = (upTo = 16) => ({ slash: { draw: tint(keep(slash, (_, y) => y <= upTo), "x") } });
    return toy(rig, [beat(100, red())], [beat(40, { slash: null }), beat(40, red(5)), beat(40, red(10)), beat(100, red())]);
  },

  /** Secrets: the padlock. Hover: the keyhole glints and the shackle lifts a pixel, unlocked. Click: it opens two pixels and clicks shut. */
  secret: () => {
    const rig = cut(GLYPHS.secret, { shackle: rows(0, 5), hole: box(7, 8, 8, 10) });
    const glint = lit(rig, "hole");
    return toy(
      rig,
      [beat(60, { hole: glint }), beat(100, { hole: glint, shackle: [0, -1] })],
      [beat(50, { hole: glint, shackle: [0, -1] }), beat(110, { hole: glint, shackle: [0, -2] }), beat(40, { shackle: [0, -1] })],
    );
  },

  /** Usage: a pie with one slice. Hover: the slice goes once round, a clock hand. Click: round once more, quicker. */
  context: () => {
    const rig = cut(GLYPHS.context, {});
    const pie = partOf(rig, "body");
    const q = (k: number) => ({ body: { draw: Array.from({ length: k }).reduce<Px>((p) => turn(p), pie) } });
    return toy(rig, [beat(60, q(1)), beat(60, q(2)), beat(60, q(3))], [beat(40, q(1)), beat(40, q(2)), beat(40, q(3))]);
  },

  /** On Caveman Cloud: the cloud. Hover: a few drops of rain fall from it. Click: it flashes and lets go a little bolt. */
  "computer-cloud": () => {
    const rig = cut(GLYPHS["computer-cloud"], {});
    const DROP = px(":|:");
    const BOLT = px("..w|.ww|ww.|w..");
    return toy(
      rig,
      [beat(60, {}, fx(DROP, 5, 12)), beat(60, {}, fx(DROP, 5, 14), fx(DROP, 9, 12)), beat(60, {}, fx(DROP, 9, 14))],
      [beat(50, { body: lit(rig, "body") }), beat(110, {}, fx(BOLT, 6, 12)), beat(50, {}, fx(DROP, 4, 13), fx(DROP, 10, 13))],
    );
  },

  /** Keyboard: </>. Hover: the brackets draw a pixel apart. Click: they close in on the slash, which lights, and open again. */
  "artifact-code": () => {
    const rig = cut(GLYPHS["artifact-code"], { lb: box(2, 5, 5, 10), rb: box(10, 5, 13, 10) });
    const apart = (d: number) => ({ lb: [-d, 0] as Vec, rb: [d, 0] as Vec });
    return toy(rig, [beat(100, apart(1))], [beat(50, apart(-1)), beat(90, { ...apart(-1), body: lit(rig, "body") }), beat(50, apart(1))]);
  },

  /** Agents: a builder caveman. Hover: he waves. Click: he throws both arms up and stands wide. */
  "tool-subagent": () => {
    const rig = cut(GLYPHS["tool-subagent"], { la: box(2, 8, 3, 10), ra: box(12, 8, 13, 10), ll: box(4, 12, 7, 14), rl: box(8, 12, 11, 14) });
    return toy(
      rig,
      [beat(70, { ra: [1, -2] }), beat(60, { ra: [2, -2] }), beat(70, { ra: [1, -2] })],
      [beat(120, { la: [-1, -2], ra: [1, -2], ll: [-1, 0], rl: [1, 0] }), beat(60, { la: [-1, -1], ra: [1, -1] })],
    );
  },

  /** Projects: a book. Hover: its cover lifts a little off the pages. Click: the cover swings further open and shuts. */
  repo: () => {
    const rig = cut(GLYPHS.repo, { cover: box(5, 2, 12, 10) });
    const cover = partOf(rig, "cover");
    // The cover seen at an angle, hinged on the spine: squeezed to `w` columns from its left edge.
    const open = (w: number): Place => ({ draw: shift(narrow(cover, w), 5 - bounds(narrow(cover, w))[0], 0) });
    return toy(rig, [beat(60, { cover: open(7) }), beat(80, { cover: open(6) })], [beat(50, { cover: open(6) }), beat(100, { cover: open(4) }), beat(50, { cover: open(6) })]);
  },

  /** Archived chats: Zz. Hover: they dim, one then the other, breathing. Click: woken, the big z pops into a star and comes back. */
  "state-sleeping": () => {
    const rig = cut(GLYPHS["state-sleeping"], { big: box(8, 2, 13, 7), small: "rest" });
    return toy(
      rig,
      [beat(90, { big: lit(rig, "big", ":") }), beat(90, { small: lit(rig, "small", "'") })],
      [beat(60, { big: null }, fx(STAR_LIT, 9, 3)), beat(70, { big: null }, fx(STAR, 9, 3))],
    );
  },

  /** Memory: the bookmark. Hover: it fills in, kept. Click: it is pressed in a row, filled. */
  bookmark: () => {
    const rig = cut(GLYPHS.bookmark, {});
    const mark = partOf(rig, "body");
    const FILL = px(["", "", "", ...Array.from({ length: 7 }, () => ".....::::::"), ".....::..::", ".....:....:"]);
    return toy(rig, [beat(110, {}, fx(FILL, 0, 0))], [beat(110, { body: { draw: squash(mark, 6) } }, fx(squash(FILL, 6), 0, 0)), beat(60, {}, fx(FILL, 0, 0))]);
  },

  /** Computers: the laptop. Hover: its screen wakes, a cursor typing a line. Click: the lid dips two rows and opens again. */
  "computer-this-mac": () => {
    const rig = cut(GLYPHS["computer-this-mac"], { screen: rows(0, 9) });
    const screen = partOf(rig, "screen");
    // The lid shut `k` rows: rows fold away just above the hinge.
    const fold = (k: number): Place => ({ draw: Array.from({ length: k }).reduce<Px>((p) => squash(p, 8), screen) });
    const CURSOR = px("*|*");
    const typed = (n: number): Fx[] => [fx(line(5, 4 + n, 5, SPARK), 0, 0), fx(CURSOR, 5 + n, 5)];
    return toy(
      rig,
      [beat(70, {}, ...typed(0)), beat(70, {}, ...typed(2)), beat(70, {}, ...typed(4))],
      [beat(50, { screen: fold(1) }), beat(100, { screen: fold(2) }), beat(50, { screen: fold(1) })],
    );
  },

  /** Queued: the hourglass. Hover: a grain of sand falls through. Click: it is turned on its side and back, and a grain falls. */
  "state-queued": () => {
    const rig = cut(GLYPHS["state-queued"], {});
    const GRAIN = px(":");
    return toy(
      rig,
      [beat(60, {}, fx(GRAIN, 7, 6)), beat(60, {}, fx(GRAIN, 8, 8)), beat(60, {}, fx(GRAIN, 7, 9))],
      [beat(80, { body: { draw: turn(partOf(rig, "body")) } }), beat(50, {}, fx(GRAIN, 7, 6)), beat(50, {}, fx(GRAIN, 8, 8))],
    );
  },

  /** Account: three cards. Hover: each slides out a pixel in turn, as if flipped through. Click: the stack is dealt two pixels out and gathered back. */
  overview: () => {
    const rig = cut(GLYPHS.overview, { a: rows(0, 6), b: rows(7, 10), c: rows(11, 15) });
    return toy(
      rig,
      [beat(60, { a: [1, 0] }), beat(60, { b: [1, 0] }), beat(60, { c: [1, 0] })],
      [beat(45, { a: [2, 0], b: [1, 0] }), beat(100, { a: [2, 0], b: [2, 0], c: [2, 0] }), beat(50, { a: [1, 0], b: [1, 0], c: [1, 0] })],
    );
  },
};

/** The icons with a toy of their own; every other icon plays the one made from its drawing. */
export const OWN_TOYS = Object.keys(TOYS) as Drawn[];

const made = new Map<string, Toy>();
/** The toy for an icon: its own if it has one, else one made from its drawing. */
export function toyFor(name: Drawn): Toy {
  let t = made.get(name);
  if (!t) made.set(name, (t = TOYS[name]?.() ?? madeToy(GLYPHS[name])));
  return t;
}
