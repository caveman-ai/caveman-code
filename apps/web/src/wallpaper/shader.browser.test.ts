// The wallpaper's shader on a real WebGL2 canvas in Chromium: what it draws is read back pixel by pixel. The promise
// under test is the one a person relies on: whatever the picture and wherever the dials stand, the words on a
// wallpaper read.
import { expect, test } from "vitest";
import {
  INKS,
  READING_CONTRAST,
  effectUniforms,
  luminance,
  readingLimit,
  type EffectId,
} from "./look.ts";
import { PAINTINGS } from "./paintings.ts";
import { NO_PAINTING, createRenderer, type Frame } from "./shader.ts";
import { TILE, createSwarm, type Pack } from "./swarm.ts";
import { TILES, glyphAtlas } from "./tiles.ts";
import { onTheWall } from "./wall.ts";

const PANEL = [0.07, 0.07, 0.075] as const;
// A pixel is stored in 256 steps a channel, so the limit is met to within a step.
const READS = READING_CONTRAST - 0.12;

const frameFor = (ink: "light" | "dark", over: Partial<Frame> = {}): Frame => ({
  time: 40,
  effect: 0,
  grain: 1,
  amount: 0,
  brightness: 1,
  blur: 0,
  dim: 0,
  fade: 0,
  panel: PANEL,
  limit: readingLimit(ink),
  inkLight: ink === "light",
  ...over,
});

function easel(glsl: string) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 96, height: 60 });
  const renderer = createRenderer(canvas, glsl);
  if ("error" in renderer) throw new Error(renderer.error);
  return { canvas, renderer };
}

/** A flat image of one grey, as a person's picture. */
function flat(grey: number) {
  const image = Object.assign(document.createElement("canvas"), { width: 8, height: 8 });
  const ctx = image.getContext("2d")!;
  ctx.fillStyle = `rgb(${grey} ${grey} ${grey})`;
  ctx.fillRect(0, 0, 8, 8);
  return image;
}

/** Every pixel just drawn, as colours from 0 to 1. */
function pixels(canvas: HTMLCanvasElement): Array<readonly [number, number, number]> {
  const gl = canvas.getContext("webgl2")!;
  const bytes = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  return Array.from(
    { length: bytes.length / 4 },
    (_, i) => [bytes[i * 4]! / 255, bytes[i * 4 + 1]! / 255, bytes[i * 4 + 2]! / 255] as const,
  );
}

/** The least contrast any pixel leaves the ink. */
function leastContrast(canvas: HTMLCanvasElement, ink: "light" | "dark"): number {
  const of = luminance(INKS[ink]);
  return Math.min(
    ...pixels(canvas).map(
      (px) => (Math.max(of, luminance(px)) + 0.05) / (Math.min(of, luminance(px)) + 0.05),
    ),
  );
}

test("a white image turned all the way up still leaves light words readable", () => {
  const { canvas, renderer } = easel(NO_PAINTING);
  renderer.setImage(flat(255), 8, 8);
  renderer.draw(frameFor("light", { brightness: 1.4 }), 1);
  expect(leastContrast(canvas, "light")).toBeGreaterThanOrEqual(READS);
});

test("a black image leaves dark words readable", () => {
  const { canvas, renderer } = easel(NO_PAINTING);
  renderer.setImage(flat(0), 8, 8);
  renderer.draw(frameFor("dark", { panel: [1, 1, 1] }), 1);
  expect(leastContrast(canvas, "dark")).toBeGreaterThanOrEqual(READS);
});

test("no effect at any strength takes the words away", () => {
  const { canvas, renderer } = easel(NO_PAINTING);
  renderer.setImage(flat(255), 8, 8);
  for (const effect of ["dither", "grain", "glass", "dots"] satisfies EffectId[]) {
    for (const amount of [0, 50, 100]) {
      renderer.draw(
        frameFor("light", { ...effectUniforms({ effect, amount, size: 50 }), brightness: 1.4 }),
        1,
      );
      expect(leastContrast(canvas, "light"), `${effect} at ${amount}`).toBeGreaterThanOrEqual(
        READS,
      );
    }
  }
});

test("a picture keeps its lights in order under the limit: brighter in is brighter out", () => {
  const { canvas, renderer } = easel(NO_PAINTING);
  const shown = [40, 120, 200, 255].map((grey) => {
    renderer.setImage(flat(grey), 8, 8);
    renderer.draw(frameFor("light"), 1);
    return luminance(pixels(canvas)[0]!);
  });
  expect(shown).toEqual([...shown].sort((a, b) => a - b));
  expect(new Set(shown).size).toBe(shown.length);
});

test("a dither leaves a page that is the panel's colour flat", () => {
  const { canvas, renderer } = easel("vec3 paint(vec2 p, float t) { return uPanel; }");
  renderer.setImage(null);
  renderer.draw(frameFor("light", effectUniforms({ effect: "dither", amount: 60, size: 25 })), 1);
  expect(new Set(pixels(canvas).map((px) => px.join())).size).toBe(1);
});

test.each(PAINTINGS.map((p) => [p.id, p] as const))(
  "the painting %s compiles, is a picture, and leaves light words readable",
  (_id, painting) => {
    const { canvas, renderer } = easel(painting.glsl);
    renderer.setImage(null);
    // A living one is seen from far enough back that this small canvas holds a page of its creatures.
    const scale = painting.life ? 0.2 : 1;
    const swarm = painting.life ? createSwarm(painting.life) : null;
    swarm?.resize(canvas.width / scale, canvas.height / scale);
    if (swarm) renderer.setGlyphs(glyphAtlas());
    for (const time of [5, 40, 1700, 3599]) {
      for (let i = 0; swarm && i < 90; i++) swarm.step(1 / 30);
      if (swarm) renderer.setTiles(swarm.tiles());
      renderer.draw(frameFor("light", { time }), scale);
      expect(leastContrast(canvas, "light"), `at ${time}s`).toBeGreaterThanOrEqual(READS);
      // More than one colour: a painting that returns nothing, or not a number, is a flat field.
      expect(new Set(pixels(canvas).map((px) => px.join())).size, `at ${time}s`).toBeGreaterThan(1);
    }
  },
);

test("a living painting shows its creatures where the swarm has them, and its ground everywhere else", () => {
  // Grey squares that stay put on a black ground.
  const blocks: Pack = {
    id: "blocks",
    name: "Blocks",
    ground: "#000000",
    glyphs: "#",
    count: 6,
    kinds: [
      {
        speed: 0,
        frames: [Array.from({ length: 8 }, () => "a".repeat(8))],
        coats: [{ a: "#9a9a9a" }],
      },
    ],
  };
  const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 400 });
  const renderer = createRenderer(canvas, TILES);
  if ("error" in renderer) throw new Error(renderer.error);
  const swarm = createSwarm(blocks);
  swarm.resize(640, 400);
  renderer.setImage(null);
  renderer.setGlyphs(glyphAtlas());
  renderer.setTiles(swarm.tiles());
  renderer.draw(frameFor("light"), 1);
  const shown = pixels(canvas);
  // readPixels counts rows from the bottom; the swarm counts them from the top.
  const at = (x: number, y: number) =>
    luminance(shown[(399 - Math.floor(y)) * 640 + Math.floor(x)]!);
  const inside = (x: number, y: number) =>
    swarm
      .bodies()
      .some(
        (b) => Math.abs(x - b.x) < 5 * TILE[b.depth]! && Math.abs(y - b.y) < 5 * TILE[b.depth]!,
      );
  // The middle of every tile of every block that is wholly on the page is lit: its key, or the character cut in it.
  let tiles = 0;
  for (const body of swarm.bodies()) {
    const size = TILE[body.depth]!;
    const [left, top] = [Math.round(body.x / size) - 4, Math.round(body.y / size) - 4];
    for (let row = 0; row < 8; row++)
      for (let column = 0; column < 8; column++) {
        const [x, y] = [(left + column + 0.5) * size, (top + row + 0.5) * size];
        if (x < 0 || x >= 640 || y < 0 || y >= 400) continue;
        tiles++;
        expect(at(x, y), `a tile at ${x}, ${y}`).toBeGreaterThan(0.005);
      }
  }
  expect(tiles).toBeGreaterThan(64);
  // Away from them there is the ground and the faint rule on it, and nothing else.
  for (let y = 5; y < 400; y += 13)
    for (let x = 5; x < 640; x += 13)
      if (!inside(x, y)) expect(at(x, y), `the ground at ${x}, ${y}`).toBeLessThan(0.004);
});

test("a click is the wallpaper's on its bare wall and nowhere else, whatever the wallpaper itself stands in", () => {
  // As a new chat is laid out: the wallpaper's box inside a pane that has a role of its own.
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section role="region" id="pane"><div id="box">
      <h1 id="question">What should we build?</h1>
      <div id="bare"><span id="words">plain words</span></div>
      <button id="button"><span id="icon">+</span></button>
      <div class="glass"><textarea id="field"></textarea><div id="padding"></div></div>
      <span role="status" id="status">Loading</span>
    </div><p id="outside">not on it</p></section>`,
  );
  const pane = document.getElementById("pane")!;
  const box = document.getElementById("box")!;
  const at = (id: string) => onTheWall(document.getElementById(id), box);
  try {
    expect(onTheWall(box, box)).toBe(true);
    expect(["question", "bare", "words"].map(at)).toEqual([true, true, true]);
    expect(["button", "icon", "field", "padding", "status"].map(at)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(at("outside")).toBe(false);
    expect(onTheWall(null, box)).toBe(false);
  } finally {
    pane.remove();
  }
});
