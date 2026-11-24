import type { Painting } from "../paintings.ts";

// A long exposure of the northern lights: one curtain high in the frame, its rays leaning toward a point far
// overhead, oxygen green along the hem and red-violet where it thins at altitude, stars through it, hazy ridges
// and spruce below. Painted as a watercolourist who winters above the Arctic Circle, working from a photograph.
export default {
  id: "aurora",
  name: "Aurora",
  light: 0.07,
  moves: true,
  glsl: /* glsl */ `
const float TURN = 6.2831853 / 3600.0;

// Value noise along a line that repeats every 'period' cells, so a steady drift can close its loop when t wraps.
float strand(float x, float period, float seed) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  // Wrapped half a cell off the seam, so the cell's number comes out whole whatever the division rounds to.
  float here = i - period * floor((i + 0.5) / period);
  float next = i + 1.0 - period * floor((i + 1.5) / period);
  return mix(hash21(vec2(here, seed)), hash21(vec2(next, seed)), u);
}

// The curtain's light, linear. Its lower edge is the sheet seen from below: where it runs toward or away from us
// we look through more of it, so those stretches are the bright ones.
vec3 curtain(vec2 p, float t) {
  float turn = t * TURN;
  // Rays follow the field lines, which meet far overhead, so every pattern is read along a line through that point.
  vec2 zenith = vec2(0.12 * uAspect, 3.0);
  float u = zenith.x + (p.x - zenith.x) * (zenith.y - 0.32) / (zenith.y - p.y);

  float a = 2.3 * u - 3.0 * turn + 0.9;
  float b = 5.3 * u + 5.0 * turn;
  float c = 10.1 * u - 8.0 * turn;
  float depth = 0.042 * sin(a) + 0.020 * sin(b) + 0.007 * sin(c);
  float slope = 0.097 * cos(a) + 0.106 * cos(b) + 0.071 * cos(c);
  float fold = sqrt(1.0 + 50.0 * slope * slope);

  // The sheet itself drifts four widths an hour, and every pattern on it repeats in a whole number of those.
  float along = u + t / 900.0;
  float lively = smoothstep(0.1, 0.7, strand(along * 1.5, 6.0, 0.0));
  float bands = strand(along * 6.0 + depth * 10.0, 24.0, 3.0);
  // Each finer set of rays is pushed about by the coarser one, so none of them stand in even rows.
  float fine = strand(along * 23.0 + depth * 30.0 + bands * 2.5, 92.0, 6.0);
  float hair = strand(along * 71.0 + depth * 60.0 + fine * 3.0, 284.0, 9.0);
  float rays = mix(0.3, 1.0, bands * bands) * mix(0.35, 1.0, fine) * mix(0.68, 1.0, hair);
  float power = mix(0.4, 1.0, lively) * fold;

  float d = p.y - (0.325 + 0.08 * u / uAspect + depth);
  float above = max(d, 0.0);
  // A quiet stretch has a diffuse hem; a lively one is sharp.
  float soft = mix(0.045, 0.012, lively);
  float edge = smoothstep(-0.4 * soft, soft, d);
  float hem = exp(-above / (0.018 + 0.020 * bands)) * mix(0.45, 1.0, bands) * mix(0.55, 1.0, hair);
  float tall = 0.7 * exp(-above / (0.07 + 0.08 * lively + 0.20 * bands * fine)) * rays;
  float thinning = 1.0 - 0.88 * smoothstep(0.08, 0.22, above);
  float green = (edge * (hem + tall) * thinning + 0.022 * exp(-abs(d) / 0.045)) * power;

  // Oxygen's red line glows higher up and for longer, so it is a blur over the rays, not rays of its own.
  float red = 0.6 * smoothstep(0.06, 0.20, above) * exp(-above / 0.30) * mix(0.45, 1.0, bands) * mix(0.7, 1.0, fine) * power;
  vec3 high = mix(vec3(0.72, 0.05, 0.36), vec3(0.42, 0.08, 0.80), smoothstep(0.08, 0.24, above));
  return vec3(0.10, 1.0, 0.30) * green + high * red;
}

// One row of spruce: a tree a cell, each its own height, width and place in the cell. 'least' is how tall the
// smallest stands, so a row can be a closed canopy or a few lone trees.
float spruce(float x, float count, float height, float least, float seed) {
  float cell = x * count;
  float i = floor(cell);
  float tall = hash21(vec2(i, seed));
  float at = 0.3 + 0.4 * hash21(vec2(i, seed + 1.0));
  float wide = 0.10 + 0.13 * hash21(vec2(i, seed + 2.0));
  float side = max(0.0, 1.0 - abs(fract(cell) - at) / wide);
  // Boughs: the cone's side steps in and out a little on the way up.
  float boughs = 1.0 + 0.22 * sin(side * 30.0 + tall * 20.0) * (1.0 - side);
  return height * mix(least, 1.0, tall * tall) * side * sqrt(side) * boughs;
}

// A row of spruce standing clear of the canopy, as a mask: spires whose width wanders with their boughs, most of
// them too small to show.
float spires(vec2 p, float ground, float count, float height, float seed) {
  float i = floor(p.x * count);
  float tall = hash21(vec2(i, seed));
  float h = height * tall * tall;
  float dx = p.x - (i + 0.3 + 0.4 * hash21(vec2(i, seed + 1.0))) / count;
  float rise = (p.y - ground) / max(h, 0.0001);
  float boughs = 0.6 + 0.8 * vnoise(vec2(rise * 10.0 + tall * 30.0 + step(0.0, dx) * 5.0, i));
  float halfWidth = h * 0.15 * (1.0 - rise) * boughs;
  return smoothstep(0.0012, -0.0006, abs(dx) - halfWidth);
}

// One layer of stars: at most one a cell, most of them faint. Returns its light and how warm it is.
vec2 starfield(vec2 p, float cell, float chance, float size, float seed) {
  vec2 grid = p / cell;
  vec2 id = floor(grid) + seed;
  float pick = hash21(id);
  if (pick > chance) return vec2(0.0);
  vec2 at = 0.15 + 0.7 * vec2(hash21(id + 3.1), hash21(id + 8.7));
  float mag = hash21(id + 12.3);
  float r = length(fract(grid) - at) * cell / (size * (0.8 + 0.5 * mag));
  float core = exp(-r * r);
  // The lens spreads a bright star a little; a faint one has no halo to speak of.
  float halo = 0.06 * mag * mag / (1.0 + 0.35 * r * r);
  float m2 = mag * mag;
  float m4 = m2 * m2;
  return vec2((0.006 + 0.994 * m4 * m4) * (core + halo), hash21(id + 21.9));
}

vec3 paint(vec2 p, float t) {
  float turn = t * TURN;
  float up = p.y + 0.5;

  vec3 c = mix(vec3(0.0040, 0.0072, 0.0100), vec3(0.0012, 0.0021, 0.0060), smoothstep(0.0, 0.75, up));
  // Airglow and a far arc below the horizon, seen through a lot of air.
  c += vec3(0.0035, 0.0130, 0.0080) * exp(-up / 0.085);

  vec3 lights = curtain(p, t);
  // The sky around the curtain scatters some of its light: an uneven green veil, thicker where the air is hazier.
  vec2 drift = 0.3 * vec2(sin(turn * 2.0), cos(turn * 2.0));
  float veil = fbm(vec2(p.x * 1.1, p.y * 2.6) + drift + 7.0);
  c += vec3(0.0008, 0.0056, 0.0026) * veil * veil * smoothstep(0.02, 0.44, p.y);
  c += lights * 0.34;

  vec2 mid = p * vec2(1.6, 4.0);
  float quiet = 1.0 - 0.85 * exp(-1.6 * dot(mid, mid));
  vec2 faint = starfield(p, 0.021, 0.5, 0.00085, 0.0);
  vec2 bright = starfield(p, 0.097, 0.3, 0.0012, 40.0);
  float breathe = 1.0 + 0.1 * sin(turn * floor(50.0 + 60.0 * bright.y) + bright.y * 50.0);
  float air = smoothstep(0.07, 0.34, up) * quiet;
  c += mix(vec3(1.0, 0.93, 0.85), vec3(0.78, 0.87, 1.0), faint.y) * faint.x * 0.22 * air;
  c += mix(vec3(1.0, 0.92, 0.82), vec3(0.76, 0.86, 1.0), bright.y) * bright.x * 0.6 * air * breathe;

  // A wooded ridge across a frozen lake, greyed by the air in front of it, with mist lying along its foot.
  float shore = -0.416 + 0.003 * sin(p.x * 2.6 + 1.0);
  float farRidge = shore + 0.012 + 0.075 * smoothstep(0.25, 0.8, fbm(vec2(p.x * 1.15 + 3.1, 0.7))) + 0.004 * vnoise(vec2(p.x * 70.0, 4.0));
  vec3 glow = c;
  float mist = exp(-max(p.y - shore, 0.0) / 0.010);
  vec3 ridge = mix(vec3(0.0016, 0.0036, 0.0036) + 0.18 * glow, vec3(0.0042, 0.0098, 0.0088), 0.7 * mist);
  c = mix(c, ridge, smoothstep(0.003, -0.002, p.y - farRidge));
  // Snow on the ice takes its colour from the sky and shows the wind in long low drifts.
  float drifts = fbm(vec2(p.x * 4.0 + 1.7, p.y * 90.0));
  vec3 snow = vec3(0.0046, 0.0112, 0.0092) * (0.55 + 0.9 * drifts) * (1.0 + 6.0 * (shore - p.y));
  c = mix(c, snow, smoothstep(0.0015, -0.0015, p.y - shore));
  // The near bank: black forest, a closed canopy with a few trees standing clear of it.
  float ground = -0.462 + 0.034 * (fbm(vec2(p.x * 1.9 + 9.4, 2.3)) - 0.5);
  float canopy = max(spruce(p.x, 140.0, 0.012, 0.45, 2.0), spruce(p.x, 61.0, 0.020, 0.25, 5.0));
  float forest = smoothstep(0.0015, -0.0015, p.y - ground - canopy);
  forest = max(forest, max(spires(p, ground, 27.0, 0.050, 9.0), spires(p, ground, 11.0, 0.066, 14.0)));
  c = mix(c, vec3(0.0007, 0.0010, 0.0012), forest);

  // The lens gathers less light toward its corners.
  vec2 off = p / vec2(uAspect, 1.0);
  c *= 1.0 - 0.45 * smoothstep(0.25, 0.75, dot(off, off) * 2.0);

  c = pow(1.0 - exp(-c), vec3(1.0 / 2.2));
  // Sensor noise, a grain a pixel, the same every frame so it never crawls.
  vec2 px = gl_FragCoord.xy * 0.7319;
  float grain = hash21(px + 0.123) + hash21(px * 1.37 + 19.7) - 1.0;
  return c + grain * (0.006 + 0.03 * c);
}
`,
} satisfies Painting;
