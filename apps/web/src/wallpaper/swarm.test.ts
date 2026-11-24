import { describe, expect, it } from "vitest";
import { PAINTINGS } from "./paintings.ts";
import { GLYPHS, TILE, createSwarm, type Pack, type Swarm } from "./swarm.ts";

const PACKS = PAINTINGS.flatMap((painting) => (painting.life ? [painting.life] : []));
const pack = (id: string) => PACKS.find((p) => p.id === id)!;

/** A second of a page, in the frames it is drawn in. */
const run = (swarm: Swarm, seconds: number) => {
  for (let i = 0; i < seconds * 30; i++) swarm.step(1 / 30);
};
const far = (from: readonly [number, number], body: { x: number; y: number }) =>
  Math.hypot(body.x - from[0], body.y - from[1]);
const mean = (values: ReadonlyArray<number>) => values.reduce((a, b) => a + b, 0) / values.length;

/** One square creature that walks right and never meanders: what a click does to it is all that moves it off its line. */
const WALKERS: Pack = {
  id: "walkers",
  name: "Walkers",
  ground: "#101010",
  glyphs: "#",
  count: 40,
  kinds: [{ speed: 2, wander: 0, home: 0, frames: [["aa", "aa"]], coats: [{ a: "#ffffff" }] }],
};

describe("the characters a tile can wear", () => {
  it("are 63, each once: a tile's fourth byte names one in six bits, and keeps two for what kind of tile it is", () => {
    expect(GLYPHS).toHaveLength(63);
    expect(new Set(GLYPHS).size).toBe(63);
  });
});

describe("the packs that ship", () => {
  it("are a dozen, each a painting that moves", () => {
    expect(PACKS).toHaveLength(12);
    for (const painting of PAINTINGS.filter((p) => p.life)) {
      expect(painting.moves, painting.id).toBe(true);
      expect(painting.id, painting.id).toBe(painting.life!.id);
    }
  });

  it.each(PACKS.map((p) => [p.id, p] as const))(
    "%s is drawn whole and sits on a dark ground",
    (_id, p) => {
      // Art whose frames differ in size, a letter with no colour, a character no tile can wear: each throws here.
      const swarm = createSwarm(p);
      swarm.resize(1280, 800);
      run(swarm, 2);
      const tiles = swarm.tiles();
      expect(tiles.data).toHaveLength(tiles.width * tiles.height * 4);
      expect(tiles.layers.map((layer) => layer[0])).toEqual([...TILE]);
      expect(tiles.height).toBe(tiles.layers.reduce((rows, layer) => rows + layer[2], 0));
      let worn = 0;
      for (let i = 3; i < tiles.data.length; i += 4) {
        if (tiles.data[i] === 0) continue;
        worn++;
        expect(tiles.data[i]! & 63).toBeGreaterThan(0);
      }
      expect(worn).toBeGreaterThan(0);
      // Light words sit on every one of them (look.ts `inkFor`).
      expect(Math.max(...tiles.ground)).toBeLessThan(0.2);
    },
  );
});

describe("a swarm", () => {
  it("is the same page for the same seed, and another for another", () => {
    const [a, b, c] = [
      createSwarm(pack("koi"), 3),
      createSwarm(pack("koi"), 3),
      createSwarm(pack("koi"), 4),
    ];
    for (const swarm of [a, b, c]) {
      swarm.resize(1280, 800);
      run(swarm, 3);
    }
    expect(a.bodies()).toEqual(b.bodies());
    expect(a.bodies()).not.toEqual(c.bodies());
  });

  it("holds as many as its box has room for", () => {
    const swarm = createSwarm(pack("koi"));
    swarm.resize(1280, 800);
    expect(swarm.bodies()).toHaveLength(pack("koi").count);
    swarm.resize(640, 184);
    const small = swarm.bodies().length;
    expect(small).toBeLessThan(pack("koi").count);
    expect(small).toBeGreaterThanOrEqual(3);
    swarm.resize(2560, 1440);
    expect(swarm.bodies().length).toBeGreaterThan(pack("koi").count);
  });

  it("moves, keeps its number, and stays on or beside the page however long it runs", () => {
    for (const p of PACKS.filter((p) => !p.click)) {
      const swarm = createSwarm(p);
      swarm.resize(900, 600);
      const before = swarm.bodies();
      run(swarm, 120);
      const after = swarm.bodies();
      expect(after, p.id).toHaveLength(before.length);
      if (p.kinds.some((kind) => kind.speed > 0)) expect(after, p.id).not.toEqual(before);
      for (const body of after) {
        expect(body.x, p.id).toBeGreaterThan(-400);
        expect(body.x, p.id).toBeLessThan(1300);
        expect(body.y, p.id).toBeGreaterThan(-400);
        expect(body.y, p.id).toBeLessThan(1000);
      }
    }
  });

  it("scatters from a click: the near ones end further from it than they would have", () => {
    const at = [640, 400] as const;
    const [calm, startled] = [createSwarm(WALKERS, 5), createSwarm(WALKERS, 5)];
    for (const swarm of [calm, startled]) swarm.resize(1280, 800);
    const near = calm.bodies().flatMap((body, i) => (far(at, body) < 300 ? [i] : []));
    expect(near.length).toBeGreaterThan(3);
    startled.poke(...at);
    for (const swarm of [calm, startled]) run(swarm, 1);
    const gap = (swarm: Swarm) => mean(near.map((i) => far(at, swarm.bodies()[i]!)));
    expect(gap(startled)).toBeGreaterThan(gap(calm) + 20);
    // One far from the click never heard it.
    const distant = calm.bodies().findIndex((body) => far(at, body) > 600);
    expect(startled.bodies()[distant]).toEqual(calm.bodies()[distant]);
  });

  it("settles again: a while after a click the herd is walking its own way", () => {
    const swarm = createSwarm(WALKERS, 5);
    swarm.resize(1280, 800);
    swarm.poke(640, 400);
    run(swarm, 12);
    const before = swarm.bodies();
    run(swarm, 1);
    // East again, at its own pace: nothing is still running.
    const moved = swarm
      .bodies()
      .map((body, i) => body.x - before[i]!.x)
      .filter((dx) => Math.abs(dx) < 600);
    for (const dx of moved) {
      expect(dx).toBeGreaterThan(0);
      expect(dx).toBeLessThan(2 * 1.25 * TILE[2]);
    }
  });

  it("turns aside from the pointer", () => {
    const [calm, minded] = [createSwarm(WALKERS, 9), createSwarm(WALKERS, 9)];
    for (const swarm of [calm, minded]) swarm.resize(1280, 800);
    const one = calm.bodies().reduce((best, body, i, all) => (body.x < all[best]!.x ? i : best), 0);
    const start = calm.bodies()[one]!;
    // The pointer waits just ahead of it and a little to one side.
    minded.hover(start.x + 40, start.y + 6);
    for (const swarm of [calm, minded]) run(swarm, 1.5);
    // It passed above the pointer, where left alone it would have walked straight on.
    expect(minded.bodies()[one]!.y).toBeLessThan(calm.bodies()[one]!.y - 2);
    // Once the pointer has left it comes back to its own heading, and the two walk the same way again.
    minded.hover(null);
    for (const swarm of [calm, minded]) run(swarm, 6);
    const apart = minded.bodies()[one]!.y - calm.bodies()[one]!.y;
    for (const swarm of [calm, minded]) run(swarm, 3);
    expect(minded.bodies()[one]!.y - calm.bodies()[one]!.y).toBeCloseTo(apart, 0);
  });

  it("makes more where a click lands, in the packs that do, and lets them burn out", () => {
    const embers = pack("embers");
    const swarm = createSwarm(embers);
    swarm.resize(1280, 800);
    const usual = swarm.bodies().length;
    swarm.poke(300, 300);
    const lit = swarm.bodies();
    expect(lit).toHaveLength(usual + embers.click!.spawn);
    for (const spark of lit.slice(usual)) expect(far([300, 300], spark)).toBeLessThan(1);
    run(swarm, 30);
    expect(swarm.bodies()).toHaveLength(usual);
  });

  it("keeps its own number through a resize while a click's sparks are still in the air", () => {
    const embers = pack("embers");
    const [steady, resized] = [createSwarm(embers), createSwarm(embers)];
    for (const swarm of [steady, resized]) swarm.resize(1280, 800);
    resized.poke(300, 300);
    // The window is dragged a little wider, then to half its size: the sparks are no part of either count.
    for (const swarm of [steady, resized]) swarm.resize(1300, 800);
    expect(resized.bodies()).toHaveLength(steady.bodies().length + embers.click!.spawn);
    for (const swarm of [steady, resized]) swarm.resize(640, 400);
    expect(resized.bodies()).toHaveLength(steady.bodies().length + embers.click!.spawn);
    run(resized, 30);
    expect(resized.bodies()).toHaveLength(steady.bodies().length);
  });

  it("snows on the whole page for as long as it runs: a flake reaches the bottom and comes round again", () => {
    const mammoths = pack("mammoths");
    const snow = mammoths.kinds.findIndex((kind) => kind.bare);
    const swarm = createSwarm(mammoths);
    swarm.resize(1280, 800);
    run(swarm, 180);
    const flakes = swarm.bodies().filter((body) => body.kind === snow);
    const low = flakes.filter((body) => body.y > 600).length;
    expect(flakes.length).toBeGreaterThan(20);
    expect(low / flakes.length).toBeGreaterThan(0.12);
    expect(low / flakes.length).toBeLessThan(0.4);
  });

  it("leaves what stays where it is alone: a hand on the wall does not flinch", () => {
    const swarm = createSwarm(pack("hands"));
    swarm.resize(1280, 800);
    const before = swarm.bodies();
    swarm.poke(640, 400);
    const after = swarm.bodies();
    expect(after.slice(0, before.length)).toEqual(before);
    // The click left one more, where it landed, at the nearest depth.
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ depth: 2 });
    expect(far([640, 400], after.at(-1)!)).toBeLessThan(1);
  });

  it("works a thick body's shape into its colour: a dark outline, a lighter middle", () => {
    const slab: Pack = {
      ...WALKERS,
      count: 1,
      kinds: [
        {
          speed: 0,
          frames: [Array.from({ length: 11 }, () => "a".repeat(11))],
          coats: [{ a: "#8090a0" }],
        },
      ],
    };
    const swarm = createSwarm(slab);
    swarm.resize(400, 300);
    const { data, width, layers } = swarm.tiles();
    for (const body of swarm.bodies()) {
      const [size, , , top] = layers[body.depth]!;
      const [x, y] = [Math.round(body.x / size), Math.round(body.y / size)];
      if (x < 6 || y < 6 || x > 400 / size - 6 || y > 300 / size - 6) continue;
      const red = (dx: number, dy: number) => data[((top + y + dy) * width + x + dx) * 4]!;
      // Its own grain and sheen move a tile a little; its place in the picture moves it a lot.
      expect(red(0, 0)).toBeGreaterThan(red(-5, 0) * 1.25);
      expect(red(0, 0)).toBeGreaterThan(red(0, 5) * 1.25);
    }
  });

  it("marks the tiles that give light and the ones that are a character alone", () => {
    const torch: Pack = {
      ...WALKERS,
      count: 4,
      kinds: [
        {
          speed: 0,
          lit: "f",
          bare: { l: "'" },
          frames: [["f.", "a.", "al"]],
          coats: [{ f: "#ffb040", a: "#806040", l: "#806040" }],
        },
      ],
    };
    const swarm = createSwarm(torch);
    swarm.resize(400, 300);
    const kinds = new Set<number>();
    const { data } = swarm.tiles();
    for (let i = 3; i < data.length; i += 4) if (data[i]) kinds.add(data[i]! & 192);
    expect([...kinds].sort((a, b) => a - b)).toEqual([0, 64, 128]);
    // A bare letter is the character its kind gave it.
    for (let i = 3; i < data.length; i += 4)
      if (data[i]! & 64) expect(GLYPHS[(data[i]! & 63) - 1]).toBe("'");
  });

  it("brightens the tiles under the pointer's lamp, and the ones a click's ring is crossing", () => {
    const slab: Pack = {
      ...WALKERS,
      count: 30,
      kinds: [{ speed: 0, frames: [["aa", "aa"]], coats: [{ a: "#405060" }] }],
    };
    const total = (swarm: Swarm) =>
      swarm.tiles().data.reduce((sum, byte, i) => (i % 4 === 3 ? sum : sum + byte), 0);
    const [dark, lamped, rung] = [createSwarm(slab), createSwarm(slab), createSwarm(slab)];
    for (const swarm of [dark, lamped, rung]) swarm.resize(400, 300);
    lamped.hover(200, 150);
    expect(total(lamped)).toBeGreaterThan(total(dark) * 1.05);
    lamped.hover(null);
    expect(total(lamped)).toBe(total(dark));
    rung.poke(200, 150);
    rung.step(0.2);
    dark.step(0.2);
    expect(total(rung)).toBeGreaterThan(total(dark) * 1.02);
  });

  it("knocks: solid ones that meet throw sparks, and ones that are not pass through each other", () => {
    const crowd = (solid: boolean): Pack => ({
      ...WALKERS,
      count: 60,
      kinds: [
        {
          speed: 4,
          wander: 2,
          solid,
          frames: [Array.from({ length: 6 }, () => "a".repeat(6))],
          coats: [{ a: "#ffffff" }],
        },
      ],
    });
    const most = (swarm: Swarm) => {
      swarm.resize(600, 400);
      let seen = 0;
      for (let i = 0; i < 600; i++) {
        swarm.step(1 / 30);
        seen = Math.max(seen, swarm.sparks());
      }
      return seen;
    };
    expect(most(createSwarm(crowd(true)))).toBeGreaterThan(0);
    expect(most(createSwarm(crowd(false)))).toBe(0);
  });

  it("is knocked by the pointer when it walks into one, and never holds more sparks than a picture can take", () => {
    const one: Pack = {
      ...WALKERS,
      count: 3,
      kinds: [
        {
          speed: 1,
          wander: 0,
          home: 0,
          frames: [Array.from({ length: 6 }, () => "a".repeat(6))],
          coats: [{ a: "#ffffff" }],
        },
      ],
    };
    const [calm, struck] = [createSwarm(one, 2), createSwarm(one, 2)];
    for (const swarm of [calm, struck]) swarm.resize(900, 600);
    const start = calm.bodies()[0]!;
    // The pointer comes up from behind it, on its tail.
    struck.hover(start.x - 6, start.y);
    for (const swarm of [calm, struck]) swarm.step(1 / 30);
    expect(struck.sparks()).toBeGreaterThan(0);
    for (const swarm of [calm, struck]) run(swarm, 0.5);
    expect(struck.bodies()[0]!.x).toBeGreaterThan(calm.bodies()[0]!.x + 4);
    for (let i = 0; i < 400; i++) struck.poke(450, 300);
    expect(struck.sparks()).toBeLessThanOrEqual(260);
  });

  it("does nothing before it has a box", () => {
    const swarm = createSwarm(pack("bats"));
    swarm.step(1);
    swarm.poke(10, 10);
    expect(swarm.bodies()).toEqual([]);
  });
});
