import type { Painting } from "../paintings.ts";

// The default: the page's own colour, and pecked into it here and there, so faint that only someone who looks sees
// them, small ancient glyphs: a spiral, rings, a sun, a figure with its arms up, water, a bighorn, a bird's track,
// tallies. Pixel art in the companion's pixels, one pixel wide, worn in places, a shade of the panel toward warm
// ochre, and none behind the question or the box. Two lights with no colour of their own drift over the wall on
// slow loops, one low on one side and one high on the other, and a glyph they pass shows a little more.
export default {
  id: "mist",
  name: "Mist",
  light: "panel",
  moves: true,
  // The lights move a few pixels a second over a soft wall: more frames would look the same and cost more.
  fps: 5,
  pixel: 2,
  glsl: /* glsl */ `
// Toward this, a little: on a dark panel a glyph lifts it, on a pale one it shades it, warm either way.
const vec3 OCHRE = vec3(0.62, 0.46, 0.36);
// The wall is plots this many pixels square; a glyph stays inside its own.
const float PLOT = 52.0;

float segment(vec2 g, vec2 a, vec2 b) {
  vec2 ga = g - a;
  vec2 ba = b - a;
  return length(ga - ba * clamp(dot(ga, ba) / dot(ba, ba), 0.0, 1.0));
}

// How far a pixel is from the lines of glyph k, in pixels, counted in whole pixels from its middle with y up. A
// line is the pixels within half a pixel of it. Each glyph keeps within 7 pixels of its middle.
float glyph(int k, vec2 g) {
  float r = length(g);
  float a = atan(g.y, g.x);
  float d = 99.0;
  if (k == 0) {
    // A spiral, two turns out from its middle.
    if (r < 5.6) d = 2.6 * abs(fract(r / 2.6 - a / 6.2831853 + 0.5) - 0.5);
  } else if (k == 1) {
    // Rings round a point.
    d = min(min(abs(r - 5.0), abs(r - 2.5)), r);
  } else if (k == 2) {
    // A sun.
    d = abs(r - 3.0);
    if (r > 4.2 && r < 7.1) d = min(d, r * abs(sin(a - round(a / 0.7853982) * 0.7853982)));
  } else if (k == 3) {
    // A figure with its arms up.
    d = abs(length(g - vec2(0.0, 5.0)) - 1.0);
    d = min(d, segment(g, vec2(0.0, 3.0), vec2(0.0, -2.0)));
    d = min(d, segment(g, vec2(-3.0, 2.0), vec2(3.0, 2.0)));
    d = min(d, segment(g, vec2(-3.0, 2.0), vec2(-3.0, 4.0)));
    d = min(d, segment(g, vec2(3.0, 2.0), vec2(3.0, 4.0)));
    d = min(d, segment(g, vec2(-2.0, -2.0), vec2(2.0, -2.0)));
    d = min(d, segment(g, vec2(-2.0, -2.0), vec2(-2.0, -5.0)));
    d = min(d, segment(g, vec2(2.0, -2.0), vec2(2.0, -5.0)));
  } else if (k == 4) {
    // Water: two zigzags.
    float zig = abs(mod(g.x, 4.0) - 2.0) - 1.0;
    if (abs(g.x) <= 6.0) d = min(abs(g.y - 3.0 - zig), abs(g.y + 3.0 - zig));
  } else if (k == 5) {
    // A bighorn: a box of a body on four legs, its horn curled back.
    d = segment(g, vec2(-4.0, 1.0), vec2(3.0, 1.0));
    d = min(d, segment(g, vec2(-4.0, -1.0), vec2(3.0, -1.0)));
    d = min(d, segment(g, vec2(-4.0, -1.0), vec2(-4.0, 1.0)));
    d = min(d, segment(g, vec2(3.0, -1.0), vec2(3.0, 1.0)));
    d = min(d, segment(g, vec2(-4.0, -1.0), vec2(-4.0, -4.0)));
    d = min(d, segment(g, vec2(-2.0, -1.0), vec2(-2.0, -4.0)));
    d = min(d, segment(g, vec2(1.0, -1.0), vec2(1.0, -4.0)));
    d = min(d, segment(g, vec2(3.0, -1.0), vec2(3.0, -4.0)));
    d = min(d, segment(g, vec2(3.0, 1.0), vec2(5.0, 3.0)));
    d = min(d, segment(g, vec2(-4.0, 1.0), vec2(-5.0, 2.0)));
    if (g.x <= 4.0 && g.y >= 3.0) d = min(d, abs(length(g - vec2(4.0, 4.0)) - 2.0));
  } else if (k == 6) {
    // A circle quartered.
    d = abs(r - 5.0);
    if (r < 5.0) d = min(d, min(abs(g.x), abs(g.y)));
  } else if (k == 7) {
    // A bird's track.
    d = segment(g, vec2(0.0, -1.0), vec2(-3.0, 4.0));
    d = min(d, segment(g, vec2(0.0, -1.0), vec2(0.0, 5.0)));
    d = min(d, segment(g, vec2(0.0, -1.0), vec2(3.0, 4.0)));
    d = min(d, segment(g, vec2(0.0, -1.0), vec2(0.0, -4.0)));
  } else if (k == 8) {
    // A snake, its head to the right.
    float slope = 1.6 * cos(g.x * 0.8);
    if (g.x >= -6.0 && g.x <= 5.0) d = abs(g.y - 2.0 * sin(g.x * 0.8)) / sqrt(1.0 + slope * slope);
    d = min(d, length(g - vec2(6.0, -2.0)) - 0.6);
  } else if (k == 9) {
    // Tallies, two rows of five.
    if (abs(g.x) <= 4.0 && mod(g.x, 2.0) == 0.0 && abs(abs(g.y) - 2.5) <= 1.5) d = 0.0;
  } else if (k == 10) {
    // A ladder.
    if (abs(g.y) <= 5.0) d = abs(abs(g.x) - 2.0);
    if (abs(g.x) <= 2.0 && abs(g.y) <= 4.0 && mod(g.y, 2.0) == 0.0) d = 0.0;
  } else {
    // Rain falling from a cloud.
    d = segment(g, vec2(-5.0, 3.0), vec2(5.0, 3.0));
    if (abs(g.x) <= 5.0 && mod(g.x + 1.0, 2.0) == 0.0 && g.y < 3.0 && g.y >= -3.0 + mod(g.x + 5.0, 4.0)) d = 0.0;
  }
  return d;
}

vec3 paint(vec2 p, float t) {
  float s = t * 0.04;
  vec2 low = vec2(-0.5 * uAspect + 0.1 * uAspect * (1.0 + sin(s * 0.7)), -0.6 + 0.05 * sin(s * 1.1));
  vec2 high = vec2(0.5 * uAspect - 0.08 * uAspect * (1.0 + cos(s * 0.5)), 0.64 + 0.04 * cos(s * 0.9));
  float wall = 0.6 + 0.8 * fbm(p * 0.9 + vec2(s * 0.15, -s * 0.1));
  // Each light ends: past its reach the page is the panel's colour and the glyphs alone.
  float a = smoothstep(0.08, 1.0, exp(-pow(length((p - low) * vec2(0.75, 1.0)) / 0.56, 2.0)) * wall);
  float b = smoothstep(0.1, 1.0, exp(-pow(length((p - high) * vec2(0.75, 1.0)) / 0.44, 2.0)) * wall);

  // One glyph in about a quarter of the plots, at a spot of its own in it, and none round the question and the box.
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 plot = floor(cell / PLOT);
  vec2 g = cell - plot * PLOT - 8.0 - floor(vec2(hash21(plot + 11.3), hash21(plot + 27.9)) * (PLOT - 15.0));
  float clear = smoothstep(0.75, 1.15, length(p / vec2(0.55, 0.3)));
  float carved = 0.0;
  if (hash21(plot + 3.7) < 0.25 * clear && max(abs(g.x), abs(g.y)) <= 7.0) {
    // Pecked into the rock: a pixel here and there never took, and some glyphs have worn more than others.
    float worn = step(0.18, hash21(cell + 0.5)) * mix(0.7, 1.0, hash21(plot + 59.0));
    carved = glyph(int(hash21(plot + 41.0) * 12.0), g) < 0.5 ? worn : 0.0;
  }

  // Toward a middle grey: on a dark panel that lights it, on a pale one it shades it.
  vec3 c = mix(uPanel, vec3(0.6), 0.05 * a + 0.035 * b);
  c = mix(c, OCHRE, carved * (0.038 + 0.03 * max(a, b)));
  // Under one step of the screen's, so shades this faint do not band.
  return c + (hash21(cell + 0.37) - 0.5) / 255.0;
}
`,
} satisfies Painting;
