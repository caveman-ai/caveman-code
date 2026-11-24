// A living painting's creatures: a pack of small pictures set in tiles, each tile a keyboard character, that roam the
// page at three depths. Their colour is worked out a tile at a time, and that is where their shape and their life
// are: a dark outline, a lighter middle, pale tips, a sheen that runs down a body as it moves, a glint here and
// there. They answer the pointer: its lamp brightens the tiles it passes over, they turn aside from it, and it
// knocks into the ones it reaches. A click sends a ring out that lights each tile it crosses, and everything near
// runs from it, pale and trailing. They knock into each other too, with a shake and a burst of sparks. Pure: the
// box's size, the seconds that pass and where the pointer is go in; the tiles to draw come out (tiles.ts draws them,
// shader.ts uploads them). A pack is one file under packs/ (paintings.ts lists them); this file is everything they
// share.

import type { Rgb } from "./look.ts";

/** The characters a tile may wear, in the order the atlas holds them (tiles.ts): 63, eight a row. */
export const GLYPHS = "#@%&$*+=~^<>/\\|(){}[]!?;:.,'\"`_-0123456789oOxXvVwWmMzZsSnNuUiIl";
/** What an outline wears, heavy characters, and what a pale tile wears, round ones: the weight follows the shade. */
const HEAVY = "#%@&";
const ROUND = "oO0";

/** One frame of a creature: rows of one character a tile. "." is no tile; a letter names a colour of its coat. */
export type Art = ReadonlyArray<string>;

export interface Kind {
  /**
   * Its walk, wingbeat or pulse, every frame the same size. Seen from the side it faces right; seen from above
   * (`turns`) it points right.
   */
  readonly frames: ReadonlyArray<Art>;
  /** Its colourways: for each, the hex colour of every letter the frames use. One is picked a creature. */
  readonly coats: ReadonlyArray<Readonly<Record<string, string>>>;
  /** How many of the pack are this kind, against the other kinds' shares. 1 when left out. */
  readonly share?: number;
  /** Tiles a second at ease. 0: it stays where it is. */
  readonly speed: number;
  /** Frames a second at ease. Left out: it holds its first frame. */
  readonly beat?: number;
  /**
   * Seen from above: it turns to where it is going. "square": by quarter turns only, and it walks the way it is
   * drawn, along the lines of the paper, which keeps small art with thin legs whole. Left out, it is seen from the
   * side and only faces left or right.
   */
  readonly turns?: boolean | "square";
  /** How far it meanders, in radians a second. 0.6 when left out. */
  readonly wander?: number;
  /** The heading it keeps coming back to, in radians: 0 right, half a turn left, -π/2 up. Left out, it goes anywhere. */
  readonly home?: number;
  /** 0 to 1: how closely it keeps with the others of its kind. */
  readonly flock?: number;
  /** How many times faster it goes from a click. 4 when left out. */
  readonly flee?: number;
  /** It lasts between these seconds, fading in and out, and another is born. Left out, it lives on and wraps round the page. */
  readonly life?: readonly [number, number];
  /** Where a new one is born: anywhere on the page, or off its bottom or top edge. "anywhere" when left out. */
  readonly born?: "anywhere" | "below" | "above";
  /** The depths it is found at, 0 far to 2 near. All three when left out. */
  readonly depths?: ReadonlyArray<number>;
  /**
   * The letters of its art that give light: a flame, a lantern's paper, an eye. Their tiles keep their own colour,
   * with no outline or shade worked into it, and glow further past their edges than the rest.
   */
  readonly lit?: string;
  /**
   * Its colours are the artist's, tile for tile: no outline or middle is worked into them. For a small figure in
   * several colours (a caveman's hair, face and pelt), where a worked-in outline would only muddy them.
   */
  readonly drawn?: boolean;
  /**
   * The letters drawn as a character alone, with no tile under it, and for each the characters it may be: a leg, a
   * feeler, a ripple, a snowflake.
   */
  readonly bare?: Readonly<Record<string, string>>;
  /**
   * It knocks into the others and the pointer. Left out: it does if it moves and is five tiles across both ways, so
   * a snowflake or a starling passes through.
   */
  readonly solid?: boolean;
}

export interface Pack {
  readonly id: string;
  readonly name: string;
  /** The page behind them, a hex colour. Dark: light words sit on it. */
  readonly ground: string;
  /** The keyboard characters its tiles wear, each one of GLYPHS. */
  readonly glyphs: string;
  /** How many creatures a 1280 by 800 page holds. */
  readonly count: number;
  readonly kinds: ReadonlyArray<Kind>;
  /**
   * What a click does besides sending the near ones off: it makes this many more of one kind (the last when left
   * out) where it landed. They last half as long as the others and are not born again.
   */
  readonly click?: { readonly spawn: number; readonly kind?: number };
  /** The colour of what flies off a knock or a click, hex: sparks, dust, spray. White when left out. */
  readonly spark?: string;
}

/** A tile's side in CSS px at each depth, far to near: the same creatures, smaller and fainter further off. */
export const TILE = [5, 7, 10] as const;
/** How much of its own colour a tile keeps over the ground at each depth. */
const INK = [0.46, 0.72, 1] as const;
/** The share of a pack at each depth. */
const SHARE = [0.42, 0.33, 0.25] as const;
/** A click reaches this far, and the pointer this far, in CSS px. */
const REACH = 380;
const NEAR = 96;
/** A click's ring: how long it lasts, and how fast it grows in near tiles a second. */
const RING_LIFE = 0.75;
const RING_SPEED = 30;
/** A top-down creature is drawn at one of this many headings. */
const HEADINGS = 16;
const TURN = Math.PI * 2;
/** How far the pointer's lamp reaches, in CSS px, and how wide the band of a ring that lights a tile is. */
const LAMP = 210;
const BAND = 28;
/** After a knock: how long a creature shakes, and how long before it can knock again. */
const JOLT = 0.3;
const PARTING = 0.9;
/** No more sparks than this in the air: a crowd knocking about stays a picture. */
const SPARKS = 260;
/** In a tile's fourth byte, over its character: this tile gives light; this one is its character alone. */
const SELF_LIT = 128;
const BARE = 64;
/** A tile's place in its picture, which sets its shade: outline, next to it, the middle, deep in, a thin part. */
const [OUTLINE, INNER, MIDDLE, DEEP, THIN] = [0, 1, 2, 3, 4];
/** What an outline's colour is taken toward: the blue-black a shadow has. */
const SHADOW = [34, 28, 92] as const;

export interface Tiles {
  /**
   * A tile four bytes: red, green, blue, and its character's place in GLYPHS plus one (0: no tile there), with 128
   * added when the tile gives light of its own and 64 when it is its character alone. The three depths are stacked,
   * the far one first, each `width` wide.
   */
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Far to near: a tile's side in CSS px, its columns, its rows, and its first row in `data`. */
  readonly layers: ReadonlyArray<readonly [number, number, number, number]>;
  /** The page behind them, 0 to 1. */
  readonly ground: Rgb;
}

export interface Swarm {
  /** The box, in CSS px. The pack is as many as the box holds; a first call fills it. */
  resize(width: number, height: number): void;
  step(seconds: number): void;
  /** A click at a place in the box, in CSS px. */
  poke(x: number, y: number): void;
  /** Where the pointer is in the box, in CSS px; null when it has left. */
  hover(x: number | null, y?: number): void;
  /** The tiles as they stand now. The same object until the box changes size, its buffer written again each call. */
  tiles(): Tiles;
  /** Where every creature is, in CSS px, and which of the pack's kinds it is, for whoever wants to know (the tests). */
  bodies(): ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly depth: number;
    readonly kind: number;
  }>;
  /** How many sparks are in the air. */
  sparks(): number;
}

const hex = (colour: string): readonly [number, number, number] => {
  const n = Number.parseInt(colour.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A small seeded generator (mulberry32): the same pack and seed is the same page of creatures. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0 to 1 from two whole numbers: a tile's own shade and character, the same every frame. */
function hash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The short way round from one heading to another, -π to π. */
const toward = (to: number, from: number) => {
  const d = (to - from) % TURN;
  return d > Math.PI ? d - TURN : d < -Math.PI ? d + TURN : d;
};
const clamp = (v: number, by: number) => Math.max(-by, Math.min(by, v));
/** The heading a top-down kind is drawn at: the nearest of the few it has. */
const drawn = (kind: Kind, heading: number) => {
  const steps = kind.turns === "square" ? 4 : HEADINGS;
  return (Math.round((heading / TURN) * steps) * TURN) / steps;
};

/** Characters as their places in GLYPHS plus one: what a tile's fourth byte holds. */
function worn(characters: string): Uint8Array {
  if (characters.length === 0) throw new Error("A tile needs a character.");
  return Uint8Array.from(characters, (glyph) => {
    const at = GLYPHS.indexOf(glyph);
    if (at < 0) throw new Error(`"${glyph}" is not a character a tile can wear.`);
    return at + 1;
  });
}

/** A kind as the loop wants it: its frames as numbers, each tile's place in the picture, its coats shade by shade. */
interface Cast {
  readonly kind: Kind;
  readonly w: number;
  readonly h: number;
  /** Half its longest side, half its diagonal, and the round it knocks with: how far it reaches from its middle. */
  readonly span: number;
  readonly reach: number;
  readonly round: number;
  readonly solid: boolean;
  /** A frame: for every tile, its letter's place plus one, 0 for none. */
  readonly frames: ReadonlyArray<Uint8Array>;
  /** A frame again: for every tile, its place (OUTLINE to THIN), with 8 added where it is a tip that catches the light. */
  readonly places: ReadonlyArray<Uint8Array>;
  /** A coat: for each letter, its colour at each of the five places and then as a tip, three bytes each. */
  readonly coats: ReadonlyArray<Uint8Array>;
  readonly depths: ReadonlyArray<number>;
  /** For every letter: whether it gives light, and the characters it is drawn as alone (none: it is a tile). */
  readonly lit: ReadonlyArray<boolean>;
  readonly bare: ReadonlyArray<Uint8Array | null>;
}

function cast(kind: Kind): Cast {
  const first = kind.frames[0];
  if (!first?.length) throw new Error("A kind needs a frame.");
  const [w, h] = [first[0]!.length, first.length];
  const letters: string[] = [];
  const frames = kind.frames.map((art) => {
    if (art.length !== h || art.some((row) => row.length !== w))
      throw new Error(`Every frame of a kind is ${w} by ${h}.`);
    const out = new Uint8Array(w * h);
    art.forEach((row, y) => {
      for (let x = 0; x < w; x++) {
        const letter = row[x]!;
        if (letter === ".") continue;
        if (!letters.includes(letter)) letters.push(letter);
        out[y * w + x] = letters.indexOf(letter) + 1;
      }
    });
    return out;
  });
  for (const letter of (kind.lit ?? "") + Object.keys(kind.bare ?? {}).join(""))
    if (!letters.includes(letter)) throw new Error(`No frame has the letter "${letter}".`);
  const lit = letters.map((letter) => (kind.lit ?? "").includes(letter));
  const bare = letters.map((letter) => (kind.bare?.[letter] ? worn(kind.bare[letter]) : null));
  /** A tile that keeps its own colour whatever is round it: light, or a character alone. */
  const plain = (letter: number) => lit[letter - 1]! || bare[letter - 1] !== null;

  // Each tile's place in its picture: how many tiles in from the edge it is, and how thick the picture is there. A
  // thick part has a dark outline and a light middle; a thin one (a fish three tiles through) only shades toward
  // its edge; a part one tile wide (a leg, a horn, a finger) keeps its colour. A tile drawn as light or alone is
  // not body, and stands for nothing here.
  const FOUR = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const places = frames.map((frame) => {
    const body = (x: number, y: number) =>
      x >= 0 && x < w && y >= 0 && y < h && frame[y * w + x] !== 0 && !plain(frame[y * w + x]!);
    // 0: not body. 1: on the edge. 2, 3: that many in. 4: further.
    const depth = new Uint8Array(w * h);
    const each = (visit: (x: number, y: number, at: number) => void) => {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) if (body(x, y)) visit(x, y, y * w + x);
    };
    each((x, y, at) => (depth[at] = FOUR.some(([dx, dy]) => !body(x + dx, y + dy)) ? 1 : 4));
    for (const d of [2, 3]) {
      const next: number[] = [];
      each((x, y, at) => {
        if (depth[at] === 4 && FOUR.some(([dx, dy]) => depth[(y + dy) * w + x + dx] === d - 1))
          next.push(at);
      });
      for (const at of next) depth[at] = d;
    }
    const out = new Uint8Array(w * h).fill(THIN);
    each((x, y, at) => {
      let thick = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (body(x + dx, y + dy)) thick = Math.max(thick, depth[(y + dy) * w + x + dx]!);
      const d = depth[at]!;
      if (thick === 1 || kind.drawn) return;
      if (d === 1) {
        const open = FOUR.filter(([dx, dy]) => !body(x + dx, y + dy)).length;
        // Where a thick part sticks out, and here and there along its edge, it catches the light.
        const tip = thick >= 3 && (open >= 3 || hash(x * 31 + y * 17, w) < 0.05);
        out[at] = (thick >= 3 ? OUTLINE : INNER) + (tip ? 8 : 0);
      } else out[at] = thick < 3 ? DEEP : d === 2 ? INNER : d === 3 ? MIDDLE : DEEP;
    });
    return out;
  });

  const coats = kind.coats.map((coat) => {
    const out = new Uint8Array(letters.length * 18);
    letters.forEach((letter, i) => {
      const colour = coat[letter];
      if (!colour || !/^#[0-9a-f]{6}$/i.test(colour))
        throw new Error(`A coat has no colour for "${letter}".`);
      hex(colour).forEach((c, channel) => {
        const at = i * 18 + channel;
        out[at + OUTLINE * 3] = c * 0.56 * 0.86 + SHADOW[channel]! * 0.14;
        out[at + INNER * 3] = c * 0.86;
        out[at + MIDDLE * 3] = c;
        out[at + DEEP * 3] = Math.min(255, c * 1.12 + 6);
        out[at + THIN * 3] = c;
        out[at + 15] = c + (255 - c) * 0.6;
      });
    });
    return out;
  });
  if (coats.length === 0) throw new Error("A kind needs a coat.");
  return {
    kind,
    w,
    h,
    span: Math.max(w, h) / 2,
    reach: Math.ceil(Math.hypot(w, h) / 2),
    round: (w + h) * 0.2,
    solid: kind.solid ?? (kind.speed > 0 && Math.min(w, h) >= 5),
    frames,
    places,
    coats,
    depths: kind.depths ?? [0, 1, 2],
    lit,
    bare,
  };
}

interface Body {
  cast: number;
  coat: number;
  depth: number;
  /** Its middle, in its depth's tiles. */
  x: number;
  y: number;
  heading: number;
  /** Seen from the side: 1 facing right, -1 left. */
  facing: number;
  phase: number;
  /** 1 just clicked at, easing to 0. */
  fear: number;
  age: number;
  /** Seconds it lasts; Infinity for one that lives on. */
  life: number;
  /** Made by a click: it is not born again. */
  extra: boolean;
  /** Seconds left of the shake a knock gave it, and before it can knock again. */
  jolt: number;
  parting: number;
  /** Its own pace, 0 to 1, its own meander, and which tiles of it are which shade. */
  pace: number;
  sway: number;
  bias: number;
  seed: number;
}

/** What flies off a knock: a tile on its own, going out and dying. Places and speeds in CSS px. */
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  depth: number;
}

/** Light where something happened, gone in a moment: the tiles near it are brighter for it. */
interface Flash {
  x: number;
  y: number;
  age: number;
  life: number;
  reach: number;
  power: number;
}

export function createSwarm(pack: Pack, seed = 1): Swarm {
  const rng = random(seed);
  const casts = pack.kinds.map(cast);
  const shares = pack.kinds.map((kind) => kind.share ?? 1);
  const allShares = shares.reduce((a, b) => a + b, 0);
  const ground = hex(pack.ground);
  const sparkle = hex(pack.spark ?? "#ffffff");
  const glyphs = worn(pack.glyphs);
  const [heavy, round] = [worn(HEAVY), worn(ROUND)];

  let width = 0;
  let height = 0;
  let layers: Array<readonly [number, number, number, number]> = [];
  let across = 0;
  let data = new Uint8Array(0);
  // What tiles() hands back: one object a box size, its buffer written again each call.
  let page: Tiles = { data, width: 0, height: 0, layers, ground: [0, 0, 0] };
  let clock = 0;
  let pointer: readonly [number, number] | null = null;
  const bodies: Body[] = [];
  const rings: Array<{ x: number; y: number; age: number }> = [];
  const sparks: Spark[] = [];
  const flashes: Flash[] = [];

  /** A new creature: anywhere on the page, or `at` a place in CSS px (a click's). */
  const make = (which?: number, at?: readonly [number, number]): Body => {
    let chosen = which ?? 0;
    if (which === undefined) {
      let roll = rng() * allShares;
      chosen = shares.findIndex((share) => (roll -= share) < 0);
      if (chosen < 0) chosen = 0;
    }
    const c = casts[chosen]!;
    const { kind } = c;
    // A click's own are the nearest there are: it happened at the glass.
    let depth = c.depths[c.depths.length - 1]!;
    if (!at) {
      const total = c.depths.reduce((sum, d) => sum + SHARE[d]!, 0);
      let roll = rng() * total;
      depth = c.depths.find((d) => (roll -= SHARE[d]!) < 0) ?? depth;
    }
    const [size, cols, rows] = layers[depth]!;
    const heading = kind.home === undefined || at ? rng() * TURN : kind.home + (rng() - 0.5) * 0.5;
    const life = kind.life ? kind.life[0] + rng() * (kind.life[1] - kind.life[0]) : Infinity;
    return {
      cast: chosen,
      coat: Math.floor(rng() * c.coats.length),
      depth,
      x: at ? at[0] / size : rng() * cols,
      y: at ? at[1] / size : rng() * rows,
      heading,
      facing: Math.cos(heading) < 0 ? -1 : 1,
      phase: rng() * kind.frames.length,
      fear: at ? 1 : 0,
      // The first of a page are met mid-life, so they do not all fade together.
      age: at || life === Infinity ? 0 : rng() * life * 0.7,
      life: at && life !== Infinity ? life * 0.5 : life,
      extra: at !== undefined,
      jolt: 0,
      parting: 0,
      pace: rng(),
      sway: rng() * TURN,
      bias: 0,
      seed: Math.floor(rng() * 65536),
    };
  };

  /** One that has lived its time starts again, where its kind is born. */
  const reborn = (b: Body) => {
    const c = casts[b.cast]!;
    const [, cols, rows] = layers[b.depth]!;
    const { kind } = c;
    b.x = rng() * cols;
    b.y = kind.born === "below" ? rows + c.reach : kind.born === "above" ? -c.reach : rng() * rows;
    b.heading = kind.home === undefined ? rng() * TURN : kind.home + (rng() - 0.5) * 0.5;
    b.age = 0;
    b.fear = 0;
    b.life = kind.life![0] + rng() * (kind.life![1] - kind.life![0]);
    b.coat = Math.floor(rng() * c.coats.length);
  };

  const wanted = () => {
    const share = (width * height) / (1280 * 800);
    // A small box (a preview) keeps more than its share, so it is not empty; a wide screen is not crowded.
    return Math.max(3, Math.round(pack.count * Math.min(share ** 0.7, 2.6)));
  };

  /** How much of a creature there is now: one that lasts fades in and out. */
  const presence = (b: Body) =>
    b.life === Infinity
      ? 1
      : Math.max(
          0,
          Math.min(1, b.age / Math.min(0.8, b.life * 0.15), (b.life - b.age) / (b.life * 0.45)),
        );

  /** Sparks from a place, in CSS px, going every way. */
  const burst = (x: number, y: number, depth: number, count: number, speed: number) => {
    for (let i = 0; i < count && sparks.length < SPARKS; i++) {
      const a = rng() * TURN;
      const v = speed * (0.35 + 0.65 * rng());
      sparks.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        age: 0,
        life: 0.35 + 0.5 * rng(),
        depth,
      });
    }
  };

  /** A knock: it is thrown the way `nx, ny` points, shaken, and for a moment afraid. */
  const knock = (b: Body, nx: number, ny: number, fright: number) => {
    b.heading = Math.atan2(ny + 0.4 * Math.sin(b.heading), nx + 0.4 * Math.cos(b.heading));
    if (Math.abs(Math.cos(b.heading)) > 0.25) b.facing = Math.cos(b.heading) < 0 ? -1 : 1;
    b.fear = Math.max(b.fear, fright);
    b.jolt = JOLT;
    b.parting = PARTING;
  };

  // ---------------------------------------------------------------- drawing

  /**
   * How much light falls on a place, in CSS px, 0 for none: the pointer's lamp, a ring going by, a flash. A tile
   * there is that much brighter and paler; nothing is drawn of the light itself.
   */
  const lightAt = (x: number, y: number) => {
    let k = 0;
    if (pointer) {
      const d = Math.hypot(x - pointer[0], y - pointer[1]);
      if (d < LAMP) k += (1 - d / LAMP) ** 2;
    }
    for (const ring of rings) {
      const d = Math.abs(
        Math.hypot(x - ring.x, y - ring.y) - (1 + ring.age * RING_SPEED) * TILE[2],
      );
      if (d < BAND) k += 1.3 * (1 - d / BAND) * (1 - ring.age / RING_LIFE);
    }
    for (const f of flashes) {
      const d = Math.hypot(x - f.x, y - f.y);
      if (d < f.reach) k += f.power * (1 - d / f.reach) ** 2 * (1 - f.age / f.life);
    }
    return Math.min(1, k);
  };

  const put = (
    layer: readonly [number, number, number, number],
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    ink: number,
    glyph: number,
  ) => {
    const at = ((layer[3] + y) * across + x) * 4;
    data[at] = ground[0] + (Math.min(255, r) - ground[0]) * ink;
    data[at + 1] = ground[1] + (Math.min(255, g) - ground[1]) * ink;
    data[at + 2] = ground[2] + (Math.min(255, b) - ground[2]) * ink;
    data[at + 3] = glyph;
  };

  /** A creature, its middle on a tile of its depth, as much of it as `ink`. */
  const stamp = (b: Body, cx: number, cy: number, ink: number) => {
    const c = casts[b.cast]!;
    const { kind, w, h } = c;
    const layer = layers[b.depth]!;
    const [size, cols, rows] = layer;
    const at = Math.floor(b.phase) % c.frames.length;
    const frame = c.frames[at]!;
    const places = c.places[at]!;
    const coat = c.coats[b.coat]!;
    // The sheen runs down it as it goes, faster when it runs; and now and then a tile glints.
    const run = b.phase * 1.7 + clock * 1.3 + b.sway;
    const blink = Math.floor(clock * 4 + b.sway);
    const tile = (X: number, Y: number, sx: number, sy: number) => {
      const letter = frame[sy * w + sx]!;
      if (letter === 0) return;
      const own = sy * w + sx + b.seed * 131;
      const alone = c.bare[letter - 1];
      if (alone) {
        const from = (letter - 1) * 18 + THIN * 3;
        const glyph = alone[Math.floor(hash(own, 3) * alone.length)]! | BARE;
        return put(layer, X, Y, coat[from]!, coat[from + 1]!, coat[from + 2]!, ink, glyph);
      }
      const lit = c.lit[letter - 1]!;
      const place = lit ? THIN : places[sy * w + sx]!;
      const glint = !lit && place < 8 && hash(own, blink) < 0.014;
      const pale = place >= 8 || glint;
      const from = (letter - 1) * 18 + (pale ? 15 : place * 3);
      // Its own grain; the top of one seen from the side a little lighter than its belly; the sheen.
      let shade = 0.9 + 0.2 * hash(own, b.cast);
      if (!lit) {
        if (!kind.turns) shade *= 1.1 - (0.2 * (sy + 0.5)) / h;
        shade *= 1 + (0.09 + 0.1 * b.fear) * Math.sin(sx * 0.8 + sy * 0.3 - run);
      }
      // Light on it makes it brighter, and a little paler; fright in it takes it toward white.
      const light = lightAt((X + 0.5) * size, (Y + 0.5) * size);
      shade *= 1 + 0.6 * light;
      const white = Math.min(1, 0.1 * light + 0.3 * b.fear);
      const [r, g, bl] = [coat[from]! * shade, coat[from + 1]! * shade, coat[from + 2]! * shade];
      const set = pale ? round : place === OUTLINE ? heavy : glyphs;
      put(
        layer,
        X,
        Y,
        r + (255 - r) * white,
        g + (255 - g) * white,
        bl + (255 - bl) * white,
        ink,
        set[Math.floor(hash(own, letter + 7) * set.length)]! | (lit ? SELF_LIT : 0),
      );
    };
    if (kind.turns) {
      // Turned by asking, for each tile of the page it might cover, which tile of the art lands there: no holes.
      const q = drawn(kind, b.heading);
      const [cos, sin] = [Math.cos(q), Math.sin(q)];
      const r = c.reach;
      for (let dy = -r; dy <= r; dy++) {
        const Y = cy + dy;
        if (Y < 0 || Y >= rows) continue;
        for (let dx = -r; dx <= r; dx++) {
          const X = cx + dx;
          if (X < 0 || X >= cols) continue;
          const sx = Math.round(dx * cos + dy * sin + (w - 1) / 2);
          const sy = Math.round(dy * cos - dx * sin + (h - 1) / 2);
          if (sx >= 0 && sx < w && sy >= 0 && sy < h) tile(X, Y, sx, sy);
        }
      }
      return;
    }
    const x0 = cx - Math.floor(w / 2);
    const y0 = cy - Math.floor(h / 2);
    for (let sy = 0; sy < h; sy++) {
      const Y = y0 + sy;
      if (Y < 0 || Y >= rows) continue;
      for (let sx = 0; sx < w; sx++) {
        const X = x0 + sx;
        if (X >= 0 && X < cols) tile(X, Y, b.facing < 0 ? w - 1 - sx : sx, sy);
      }
    }
  };

  const draw = (b: Body) => {
    const c = casts[b.cast]!;
    const ink = INK[b.depth]! * presence(b);
    if (ink < 0.03) return;
    // One that is running leaves itself behind for a moment: two fainter copies back along its way.
    if (b.fear > 0.22 && c.kind.speed > 0) {
      const back = 0.9 + c.span * 0.5 * b.fear;
      for (const [far, faint] of [
        [2, 0.14],
        [1, 0.3],
      ] as const)
        stamp(
          b,
          Math.round(b.x - Math.cos(b.heading) * back * far),
          Math.round(b.y - Math.sin(b.heading) * back * far),
          ink * faint * b.fear,
        );
    }
    // Knocked, it shakes a tile from side to side.
    stamp(
      b,
      Math.round(b.x) + (b.jolt > 0 ? Math.round(Math.sin(b.jolt * 64)) : 0),
      Math.round(b.y),
      ink,
    );
  };

  /** A click's ring, in the near tiles: the characters themselves going out from where it landed. */
  const ring = (at: { x: number; y: number; age: number }) => {
    const layer = layers[2]!;
    const [size, cols, rows] = layer;
    const r = 1 + at.age * RING_SPEED;
    const ink = 0.5 * (1 - at.age / RING_LIFE) ** 1.5;
    const steps = Math.ceil(TURN * r);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TURN;
      const X = Math.round(at.x / size + Math.cos(a) * r);
      const Y = Math.round(at.y / size + Math.sin(a) * r);
      if (X < 0 || X >= cols || Y < 0 || Y >= rows) continue;
      put(layer, X, Y, ...sparkle, ink, glyphs[(X * 7 + Y * 13) % glyphs.length]! | BARE);
    }
  };

  const fleck = (s: Spark) => {
    const layer = layers[s.depth]!;
    const [size, cols, rows] = layer;
    const [X, Y] = [Math.floor(s.x / size), Math.floor(s.y / size)];
    if (X < 0 || X >= cols || Y < 0 || Y >= rows) return;
    const ink = INK[s.depth]! * (1 - s.age / s.life);
    put(layer, X, Y, ...sparkle, ink, glyphs[(X * 5 + Y * 11) % glyphs.length]! | SELF_LIT);
  };

  return {
    resize(w, h) {
      if (w === width && h === height) return;
      [width, height] = [w, h];
      let top = 0;
      layers = TILE.map((size) => {
        const layer = [size, Math.ceil(w / size), Math.ceil(h / size), top] as const;
        top += layer[2];
        return layer;
      });
      across = layers[0]![1];
      data = new Uint8Array(across * top * 4);
      page = {
        data,
        width: across,
        height: top,
        layers,
        ground: [ground[0] / 255, ground[1] / 255, ground[2] / 255],
      };
      // The pack is counted without what a click made: those go of themselves, and must not cost it one of its own.
      const want = wanted();
      let own = bodies.reduce((n, b) => n + (b.extra ? 0 : 1), 0);
      for (; own < want; own++) bodies.push(make());
      for (let i = bodies.length - 1; i >= 0 && own > want; i--) {
        if (bodies[i]!.extra) continue;
        bodies.splice(i, 1);
        own--;
      }
    },

    step(dt) {
      if (width === 0) return;
      clock += dt;
      for (let i = rings.length - 1; i >= 0; i--)
        if ((rings[i]!.age += dt) >= RING_LIFE) rings.splice(i, 1);
      for (let i = flashes.length - 1; i >= 0; i--)
        if ((flashes[i]!.age += dt) >= flashes[i]!.life) flashes.splice(i, 1);
      const drag = Math.exp(-3.2 * dt);
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]!;
        if ((s.age += dt) >= s.life) {
          sparks.splice(i, 1);
          continue;
        }
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vx *= drag;
        s.vy *= drag;
      }

      for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i]!;
        const c = casts[b.cast]!;
        const { kind } = c;
        const [size, cols, rows] = layers[b.depth]!;
        const mortal = b.life !== Infinity;
        if (mortal && (b.age += dt) >= b.life) {
          if (b.extra) {
            bodies.splice(i, 1);
            continue;
          }
          reborn(b);
        }
        b.fear *= Math.exp(-dt / 0.9);
        b.jolt = Math.max(0, b.jolt - dt);
        b.parting = Math.max(0, b.parting - dt);
        const calm = 1 - b.fear;
        b.phase += dt * (kind.beat ?? 0) * (0.9 + 0.2 * b.pace) * (1 + 1.6 * b.fear);
        if (kind.speed === 0) continue;

        let h = b.heading;
        // Its meander: two slow swings of its own, and a lean that comes and goes.
        b.bias += (rng() - 0.5) * 2.4 * dt - b.bias * 0.4 * dt;
        h +=
          (kind.wander ?? 0.6) *
          calm *
          dt *
          (0.8 * Math.sin(clock * 0.6 + b.sway) +
            0.5 * Math.sin(clock * 1.7 + b.sway * 2.3) +
            b.bias);
        if (kind.home !== undefined) {
          // Seen from the side, one walking the wrong way turns round by facing about, as the picture does.
          const sideways = !kind.turns && Math.abs(Math.cos(kind.home)) > 0.5;
          if (sideways && b.fear < 0.15 && Math.cos(h) * Math.cos(kind.home) < 0) h = Math.PI - h;
          h += toward(kind.home, h) * Math.min(1, 1.4 * dt) * calm;
        }
        if (kind.flock) {
          let [ax, ay, mx, my, sx, sy, n] = [0, 0, 0, 0, 0, 0, 0];
          const far = c.span * 6.4;
          const close = c.span * 2;
          for (const o of bodies) {
            if (o === b || o.depth !== b.depth || o.cast !== b.cast) continue;
            const [dx, dy] = [o.x - b.x, o.y - b.y];
            const d = Math.hypot(dx, dy);
            if (d > far || d === 0) continue;
            n++;
            ax += Math.cos(o.heading);
            ay += Math.sin(o.heading);
            mx += dx;
            my += dy;
            if (d < close) {
              sx -= (dx / d) * (1 - d / close);
              sy -= (dy / d) * (1 - d / close);
            }
          }
          if (n > 0) {
            const vx =
              Math.cos(h) + kind.flock * ((0.9 * ax) / n + (0.6 * mx) / (n * far) + 1.6 * sx);
            const vy =
              Math.sin(h) + kind.flock * ((0.9 * ay) / n + (0.6 * my) / (n * far) + 1.6 * sy);
            h += clamp(toward(Math.atan2(vy, vx), h), 2.4 * dt) * calm;
          }
        }
        let hurry = 1;
        if (pointer) {
          const [dx, dy] = [b.x * size - pointer[0], b.y * size - pointer[1]];
          const d = Math.hypot(dx, dy);
          if (c.solid && b.parting === 0 && d < c.round * size) {
            // The pointer has walked into it.
            const [nx, ny] = d < 0.5 ? [Math.cos(h), Math.sin(h)] : [dx / d, dy / d];
            b.heading = h;
            knock(b, nx, ny, 0.75);
            h = b.heading;
            burst(pointer[0], pointer[1], b.depth, 7, 190);
            flashes.push({ x: pointer[0], y: pointer[1], age: 0, life: 0.3, reach: 160, power: 1 });
          } else if (d < NEAR) {
            const push = 1 - d / NEAR;
            h += clamp(toward(Math.atan2(dy, dx), h), 5 * dt) * push;
            hurry += 0.6 * push;
          }
        }
        b.heading = h;
        if (Math.abs(Math.cos(h)) > 0.25) b.facing = Math.cos(h) < 0 ? -1 : 1;
        const speed =
          kind.speed * (0.8 + 0.4 * b.pace) * hurry * (1 + ((kind.flee ?? 4) - 1) * b.fear);
        const way = kind.turns === "square" ? drawn(kind, h) : h;
        b.x += Math.cos(way) * speed * dt;
        b.y += Math.sin(way) * speed * dt;

        // Off one side: one that lives on comes back in at the other; one that does not is born again.
        const m = c.reach + 1;
        const out = b.x < -m || b.x > cols + m || b.y < -m || b.y > rows + m;
        if (!out) continue;
        if (b.extra) bodies.splice(i, 1);
        else if (mortal) reborn(b);
        else {
          b.x = b.x < -m ? cols + m : b.x > cols + m ? -m : b.x;
          b.y = b.y < -m ? rows + m : b.y > rows + m ? -m : b.y;
        }
      }

      // Two at one depth that meet: each is put back off the other, and if they came together they knock.
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i]!;
        const ca = casts[a.cast]!;
        if (!ca.solid) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j]!;
          const cb = casts[b.cast]!;
          if (!cb.solid || b.depth !== a.depth) continue;
          const [dx, dy] = [b.x - a.x, b.y - a.y];
          const reach = ca.round + cb.round;
          const d = Math.hypot(dx, dy);
          if (d >= reach || d === 0) continue;
          const [nx, ny] = [dx / d, dy / d];
          const part = (reach - d) * 0.3;
          a.x -= nx * part;
          a.y -= ny * part;
          b.x += nx * part;
          b.y += ny * part;
          if (a.parting > 0 || b.parting > 0) continue;
          knock(a, -nx, -ny, 0.3);
          knock(b, nx, ny, 0.3);
          const size = layers[a.depth]![0];
          const [x, y] = [(a.x + nx * ca.round) * size, (a.y + ny * ca.round) * size];
          burst(x, y, a.depth, 6, 15 * size);
          flashes.push({ x, y, age: 0, life: 0.28, reach: 14 * size, power: 0.9 * INK[a.depth]! });
        }
      }
    },

    poke(x, y) {
      if (width === 0) return;
      rings.push({ x, y, age: 0 });
      flashes.push({ x, y, age: 0, life: 0.5, reach: 340, power: 1.6 });
      burst(x, y, 2, 12, 300);
      for (const b of bodies) {
        const size = layers[b.depth]![0];
        const [dx, dy] = [b.x * size - x, b.y * size - y];
        const d = Math.hypot(dx, dy);
        // One that stays where it is has nowhere to go.
        if (d >= REACH || casts[b.cast]!.kind.speed === 0) continue;
        b.fear = Math.max(b.fear, 0.35 + 0.65 * (1 - d / REACH));
        b.heading = (d < 1 ? rng() * TURN : Math.atan2(dy, dx)) + (rng() - 0.5) * 0.9;
        if (Math.abs(Math.cos(b.heading)) > 0.25) b.facing = Math.cos(b.heading) < 0 ? -1 : 1;
        // The nearest feel it land.
        if (d < 150) b.jolt = JOLT;
      }
      if (pack.click)
        for (let i = 0; i < pack.click.spawn; i++)
          bodies.push(make(pack.click.kind ?? casts.length - 1, [x, y]));
    },

    hover(x, y = 0) {
      pointer = x === null ? null : [x, y];
    },

    tiles() {
      data.fill(0);
      for (const at of rings) ring(at);
      // Far first; within a depth, the later drawn lies over the earlier.
      for (const b of bodies) draw(b);
      for (const s of sparks) fleck(s);
      return page;
    },

    bodies() {
      return bodies.map((b) => {
        const size = layers[b.depth]![0];
        return { x: b.x * size, y: b.y * size, depth: b.depth, kind: b.cast };
      });
    },

    sparks() {
      return sparks.length;
    },
  };
}
