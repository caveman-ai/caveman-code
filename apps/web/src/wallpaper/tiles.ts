// How a living painting is drawn: the one GLSL every pack shares, and the characters its tiles wear. swarm.ts says
// which tile is where and what colour; this turns each into a small lit key with its character printed on it and
// a glow just past its edge, over the pack's ruled ground, and the wallpaper's shader does the rest (the effect,
// the dials, the reading limit), as for any painting.

import { GLYPHS } from "./swarm.ts";

/** The atlas is this many characters a row, each in a square this many pixels a side. */
const ROW = 8;
const SQUARE = 32;

export const TILES = /* glsl */ `
uniform sampler2D uTiles;  // a texel a tile: its colour, and in alpha its character and what kind of tile it is
uniform sampler2D uGlyphs; // the characters, ${ROW} a row, white on black
uniform vec4 uLayers[3];   // far to near: a tile's side in CSS px, columns, rows, the layer's first row in uTiles
uniform vec3 uGround;      // the page behind them

// A key is a square a little short of its tile, its corners eased. Half its side, and its corner, in tiles.
const float HALF = 0.455;
const float CORNER = 0.07;
// How far a place is from a key's edge, in tiles: under 0 on the key. f is the place within the key's own tile.
float fromKey(vec2 f) {
  vec2 d = abs(f - 0.5) - (HALF - CORNER);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - CORNER;
}

vec3 paint(vec2 p, float t) {
  vec2 box = uSize / uScale;
  vec2 px = vec2(p.x * box.y + 0.5 * box.x, (0.5 - p.y) * box.y);
  // The ground is ruled as squared paper is, the near tiles on its lines, and falls away a little at the corners.
  vec2 rule = step(mod(px, uLayers[2].x), vec2(1.0));
  vec3 col = uGround + 0.03 * max(rule.x, rule.y);
  col *= 1.0 - 0.2 * smoothstep(0.4, 0.9, length(px / box - 0.5));
  for (int i = 0; i < 3; i++) {
    vec4 layer = uLayers[i];
    vec2 at = px / layer.x;
    ivec2 cell = ivec2(floor(at));
    ivec2 last = ivec2(layer.yz) - 1;
    vec2 f = fract(at);

    // Every key glows a little past its own edge: its colour, strongest at the edge and gone half a tile out. So
    // the gaps in a creature are lit by it, and it has a thin bright rim against the dark. A key that gives light
    // glows further. The far ones are too small for it to show.
    if (i > 0) {
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          ivec2 other = cell + ivec2(dx, dy);
          if (other.x < 0 || other.y < 0 || other.x > last.x || other.y > last.y) continue;
          vec4 near = texelFetch(uTiles, ivec2(other.x, other.y + int(layer.w)), 0);
          int kind = int(near.a * 255.0 + 0.5);
          if (kind == 0 || (kind / 64) % 2 == 1) continue;
          float lit = float(kind / 128);
          float out_ = max(fromKey(f - vec2(dx, dy)), 0.0);
          col += near.rgb * mix(0.5, 1.0, lit) * exp(-out_ * mix(7.5, 3.6, lit));
        }
      }
    }

    if (cell.x > last.x || cell.y > last.y) continue;
    vec4 tile = texelFetch(uTiles, ivec2(cell.x, cell.y + int(layer.w)), 0);
    int worn = int(tile.a * 255.0 + 0.5);
    if (worn == 0) continue;
    float lit = float(worn / 128);
    bool alone = (worn / 64) % 2 == 1;
    int glyph = worn % 64 - 1;
    vec2 uv = (vec2(glyph % ${ROW}, glyph / ${ROW}) + clamp(f, 0.03, 0.97)) / ${ROW}.0;
    // Too small to be a character, it is the key's grain.
    float mark = textureLod(uGlyphs, uv, max(0.0, log2(${SQUARE}.0 / (layer.x * uScale)))).r;
    if (alone) {
      // A character with no key under it: a leg, a ripple, a snowflake, a ring going out.
      col = mix(col, tile.rgb, mark);
      continue;
    }
    float edge = fromKey(f);
    float key = clamp(0.5 - edge * layer.x * uScale, 0.0, 1.0);
    // The key is brightest along its edge, as a lit key is, and its character is printed on it lighter than it
    // is, or darker on one already pale. One that gives light is brighter all over and its character faint.
    vec3 face = tile.rgb * (1.0 + 0.22 * smoothstep(-0.2, 0.0, edge) + 0.25 * lit);
    float pale = step(0.52, dot(face, vec3(0.3, 0.55, 0.15)));
    vec3 print = mix(mix(face, vec3(1.0), 0.36), mix(face, uGround, 0.6), pale);
    col = mix(col, mix(face, print, mark * (1.0 - 0.6 * lit)), key);
  }
  return col;
}
`;

let atlas: HTMLCanvasElement | null = null;
/** Every character of GLYPHS in the code font, drawn once: what a living painting's renderer is handed. */
export function glyphAtlas(): HTMLCanvasElement {
  if (atlas) return atlas;
  atlas = Object.assign(document.createElement("canvas"), {
    width: ROW * SQUARE,
    height: Math.ceil(GLYPHS.length / ROW) * SQUARE,
  });
  const ctx = atlas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, atlas.width, atlas.height);
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${SQUARE * 0.78}px "SF Mono", SFMono-Regular, ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  [...GLYPHS].forEach((glyph, i) =>
    ctx.fillText(glyph, ((i % ROW) + 0.5) * SQUARE, (Math.floor(i / ROW) + 0.54) * SQUARE),
  );
  return atlas;
}
