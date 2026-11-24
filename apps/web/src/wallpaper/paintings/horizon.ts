import type { Painting } from "../paintings.ts";

// Orbital sunrise over the limb of a planet, as a station photograph: air lit edge-on (ember red against the
// ground, a pale core, Rayleigh blue thinning out), a green airglow shell above it, the star blooming on the sensor.
// Painted as an astrophotographer who prints these large: thin atmosphere, real black, a little grain.
export default {
  id: "horizon",
  name: "Horizon",
  light: 0.05,
  moves: true,
  glsl: /* glsl */ `
const float TAU = 6.2831853;

// The prelude's hash shows stripes at grain scale; this one does not.
float grainHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// exp(-x), held where a GPU's fast exp stays exact: far tails otherwise come back as a faint grey step.
float fall(float x) {
  return exp(-min(x, 30.0));
}

// A few steady points: nothing twinkles above the air.
float starfield(vec2 p) {
  vec2 g = p / 0.13;
  vec2 cell = floor(g);
  vec2 at = 0.12 + 0.76 * vec2(grainHash(cell + 9.7), grainHash(cell + 21.3));
  float d = length(g - cell - at) * 0.13;
  float mag = pow(grainHash(cell + 40.9), 3.0);
  return step(0.4, grainHash(cell + 3.1)) * (0.012 + 0.4 * mag) * fall(d * d / (0.001 * 0.001));
}

vec3 paint(vec2 p, float t) {
  // A wider window sees more of the limb, so the planet grows with it and the curve stays a low orbit's.
  float radius = 1.6 + 0.9 * uAspect;
  vec2 centre = vec2(0.2 * uAspect, -0.21 - radius);
  vec2 q = p - centre;
  float above = length(q) - radius;
  float arc = atan(q.x, q.y) * radius;

  float sunX = uAspect * (-1.0 / 6.0 + 0.07 * sin(TAU * t / 3600.0));
  float sunTurn = asin((sunX - centre.x) / radius);
  vec2 sun = centre + (radius + 0.004) * vec2(sin(sunTurn), cos(sunTurn));
  vec2 v = p - sun;
  float d = length(v);

  float span = abs(arc - sunTurn * radius);
  float lit = fall(span / (0.2 + 0.3 * uAspect));

  // Cloud tops stand in silhouette against the lowest air: in a photograph the limb is never a clean curve.
  float tops = 0.0024 * smoothstep(0.3, 0.9, fbm(vec2(arc * 30.0, 3.0)));
  float sky = smoothstep(-0.0007, 0.0007, above - tops);
  float up = max(above, 0.0);

  // Air seen edge-on, one scale height of it being 0.0042 here: each colour scatters by its Rayleigh share and
  // is spent by the same share on the way, so the thick low air comes out ember red, the middle pale, the thin
  // top blue. Thin sheets of haze lie through it.
  float sheets = 0.8 + 0.4 * vnoise(vec2(arc * 4.0, up * 170.0));
  float density = fall(up / 0.0042) * sheets;
  vec3 rayleigh = vec3(0.19, 0.44, 1.0);
  vec3 thickness = 22.0 * density * rayleigh;
  // Away from the star the light arrives lower and has crossed more air: the low layers go out first.
  float spent = 0.3 + 1.5 * (1.0 - lit);
  vec3 scatter = (1.0 - exp(-thickness)) * exp(-thickness * spent);
  vec3 air = scatter * 0.42 * (0.07 + 0.93 * pow(lit, 1.2))
    + vec3(0.12, 0.20, 1.0) * 0.09 * lit * fall(up / 0.045);

  // Airglow: a thin shell of green far above the blue, brightest at its own height and faint below it.
  float lift = (up - 0.05) / 0.003;
  float shell = lift > 0.0 ? fall(lift * lift) : 1.0 / (1.0 - 0.8 * lift);
  air += vec3(0.30, 1.0, 0.36) * 0.008 * shell * (1.0 - 0.85 * lit) * (0.7 + 0.6 * vnoise(vec2(arc * 2.5, 9.0)));

  // The night side beside the terminator: a cloud deck, foreshortened to streaks, catching the last of the light.
  float under = max(-above, 0.0);
  float inward = sqrt(2.0 * under * radius);
  float deck = smoothstep(0.42, 0.85, fbm(vec2(arc * 11.0, inward * 11.0 + 5.0)));
  vec3 dusk = mix(vec3(1.0, 0.40, 0.18), vec3(0.28, 0.36, 0.60), smoothstep(0.0, 0.16, inward));
  vec3 night = dusk * deck * 0.03 * pow(lit, 1.5) * fall(inward / 0.11);

  float breath = 1.0 + 0.12 * sin(TAU * t / 60.0);
  float swell = 1.0 + 0.05 * sin(TAU * t / 90.0 + 1.0);

  // Seven aperture blades make fourteen points; a fainter fourteen sit between them. Opposite points match,
  // and red light diffracts further than blue, so the tips run warm.
  float turn = atan(v.y, v.x);
  float sharp = 14.0 + 260.0 * d;
  float uneven = 0.72 + 0.28 * cos(2.0 * turn + 0.8) * cos(4.0 * turn + 2.1);
  float points = pow(abs(cos(7.0 * turn + 0.4)), sharp) * uneven
    + 0.34 * pow(abs(sin(7.0 * turn + 0.4)), sharp * 2.5);
  vec3 rays = 0.22 * points * exp(-min(d / (0.038 * breath * vec3(1.25, 1.0, 0.78)), vec3(30.0)));

  float disc = 0.7 * fall(d * d / (0.006 * 0.006));
  float glow = swell * 0.6 / (1.0 + pow(d / 0.016, 1.6)) * fall(d / 0.12);

  // The glare is made in the lens and on the sensor, so it lies over the ground as well as the sky.
  float spill = 0.3 + 0.7 * fall(under / 0.02);
  float heat = (disc + glow + rays.g) * spill;
  vec3 cream = vec3(1.0, 0.90, 0.74);
  vec3 gold = vec3(1.0, 0.64, 0.32);
  vec3 glare = mix(gold, cream, smoothstep(0.03, 0.4, heat)) * (disc + glow + rays) * spill;
  float washed = 1.0 - 0.9 * smoothstep(0.0, 0.25, heat);

  float clear = sky * smoothstep(0.0, 0.05, up) * (1.0 - smoothstep(0.0, 0.004, heat));
  vec3 stars = vec3(0.82, 0.88, 1.0) * starfield(p) * clear;

  // Once an hour something small and man-made crosses the frame, as it does in every long exposure.
  float pass = (t - 1400.0) / 400.0;
  vec2 craft = p - vec2((pass - 0.5) * (uAspect + 0.2), 0.30 - 0.06 * pass);
  float crossing = 0.1 * fall(dot(craft, craft) / (0.001 * 0.001)) * smoothstep(0.0, 0.1, pass) * (1.0 - smoothstep(0.9, 1.0, pass));

  vec3 col = (air * sky + night * (1.0 - sky)) * washed + glare + stars + vec3(0.9, 0.92, 1.0) * crossing;
  vec3 shown = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));

  // Grain at two sizes, a little of it in colour, heavier where there is light to carry it.
  vec2 fine = floor(p * 1400.0);
  vec2 coarse = floor(p * 610.0);
  vec3 speck = vec3(grainHash(fine), grainHash(fine + 57.0), grainHash(fine + 113.0)) - 0.5;
  float clump = grainHash(coarse + 7.0) - 0.5;
  vec3 grain = mix(vec3(speck.x + speck.y + speck.z) * 0.6, speck, 0.35) + 0.35 * clump;
  return clamp(shown + grain * (0.012 + 0.03 * sqrt(max(shown.g, 0.0))), 0.0, 1.0);
}
`,
} satisfies Painting;
