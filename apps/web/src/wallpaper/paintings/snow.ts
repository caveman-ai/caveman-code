import type { Painting } from "../paintings.ts";

// The Ice Age at blue hour, as a long exposure of a glacier valley in falling snow: ridgelines going off into
// haze, a moon blooming through thin cloud, one far fire. Painted as a Nordic blue-hour landscape painter in
// the line of Harald Sohlberg, working from a photograph: two blues, one small warm light.
export default {
  id: "snow",
  name: "Snow",
  light: 0.13,
  moves: true,
  glsl: /* glsl */ `
const float TURN = 6.2831853;
const float BEAST = 0.0095;

// Colours are worked in linear light, so glows add as light does, and encoded once at the end.
const vec3 ZENITH = vec3(0.0012, 0.0016, 0.0050);
const vec3 DEEP_SKY = vec3(0.0045, 0.0075, 0.0260);
const vec3 HAZE = vec3(0.0200, 0.0300, 0.0680);
const vec3 SNOW_SHADOW = vec3(0.0080, 0.0150, 0.0520);
const vec3 SNOW_MOONLIT = vec3(0.2000, 0.2500, 0.4000);
const vec3 ROCK = vec3(0.0015, 0.0020, 0.0050);
const vec3 MOONLIGHT = vec3(0.6200, 0.7200, 1.0000);
const vec3 EMBER = vec3(0.8300, 0.3400, 0.0470);

// A ridgeline, 0 to 1: one broad swell, creased at two scales where it stands tall, and rough at two more.
float crags(float x, float seed) {
  float swell = vnoise(vec2(x + seed, seed));
  float crease = 1.0 - abs(2.0 * vnoise(vec2(x * 2.3 + seed, seed + 3.0)) - 1.0);
  float notch = 1.0 - abs(2.0 * vnoise(vec2(x * 5.7 + seed, seed + 6.0)) - 1.0);
  float rough = 0.6 * vnoise(vec2(x * 13.0 + seed, seed + 9.0)) + 0.4 * vnoise(vec2(x * 31.0 + seed, seed + 12.0));
  return 0.5 * swell + 0.27 * crease * (0.4 + 0.6 * swell) + 0.13 * notch + 0.1 * rough;
}

// The four ridgelines, far to near: the massif at the head of the valley (low behind the chat box, tall at the
// sides), a spur coming down from the right, a nearer one from the left, and the snowfield underfoot.
float massifTop(float x) {
  return -0.218 + (0.03 + 0.115 * smoothstep(0.05, 0.5, abs(x) / uAspect)) * crags(x * 1.6, 3.0);
}
float rightSpurTop(float x) {
  return -0.305 + 0.085 * smoothstep(-0.2, 0.55, x / uAspect) + 0.045 * (crags(x * 1.25, 17.0) - 0.5);
}
float leftSpurTop(float x) {
  return -0.35 + 0.1 * smoothstep(0.15, -0.55, x / uAspect) + 0.045 * (crags(x * 1.05, 29.0) - 0.5);
}
float fieldTop(float x) {
  return -0.45 + 0.03 * x / uAspect + 0.03 * (vnoise(vec2(x * 1.1 + 41.0, 2.0)) + 0.4 * vnoise(vec2(x * 3.1, 7.0)) - 0.7);
}

// Snow on a slope under the moon, in linear light. q is the place on the slope in its own grain (across, down).
// look: the light it stands in before its own relief, how strongly the relief shows, and how much bare rock.
vec3 slope(vec2 q, vec3 look, float moonward) {
  float here = fbm(q);
  float relief = (here - fbm(q + vec2(0.13, -0.1))) * look.y;
  vec3 snow = mix(SNOW_SHADOW, SNOW_MOONLIT, clamp(look.x + relief, 0.0, 1.0) * moonward);
  float bare = mix(0.78, 0.5, look.z);
  return mix(snow, ROCK, smoothstep(bare, bare + mix(0.04, 0.16, look.z), here + 0.05 * abs(relief)) * step(0.001, look.z));
}

float capsule(vec2 q, vec2 a, vec2 b, float r) {
  vec2 qa = q - a;
  vec2 ba = b - a;
  return length(qa - ba * clamp(dot(qa, ba) / dot(ba, ba), 0.0, 1.0)) - r;
}

// A mammoth side on, looking left, its feet at the origin and about three units long: negative inside.
float mammoth(vec2 q) {
  float d = (length((q - vec2(0.2, 0.8)) / vec2(0.98, 0.5)) - 1.0) * 0.5;
  d = min(d, length(q - vec2(-0.38, 1.08)) - 0.56);
  d = min(d, length(q - vec2(-1.0, 1.3)) - 0.37);
  d = min(d, capsule(q, vec2(-1.26, 1.1), vec2(-1.42, 0.3), 0.1));
  d = min(d, capsule(q, vec2(-1.42, 0.3), vec2(-1.28, 0.12), 0.08));
  d = min(d, capsule(q, vec2(-0.5, 0.6), vec2(-0.52, 0.0), 0.17));
  d = min(d, capsule(q, vec2(0.72, 0.6), vec2(0.78, 0.0), 0.17));
  d = min(d, capsule(q, vec2(-0.12, 0.6), vec2(-0.1, 0.05), 0.15));
  d = min(d, capsule(q, vec2(0.38, 0.6), vec2(0.42, 0.05), 0.15));
  return min(d, capsule(q, vec2(1.1, 0.95), vec2(1.2, 0.55), 0.04));
}

// One flake a cell, falling down a slanted column. Every column's fall is a whole number of ROWS an hour, so the
// picture at t = 3600 is the picture at t = 0. soft is how far out of focus it is: 1 a wide dim disc, 0 a point.
const float ROWS = 40.0;
float flakes(vec2 p, float t, float cells, float fall, float radius, float soft, float share, float seed) {
  vec2 q = vec2(p.x + 0.24 * p.y, p.y) * cells;
  float column = floor(q.x);
  float c = hash21(vec2(column * 0.731 + seed, seed * 1.37));
  float y = q.y + t * (fall + floor(c * 5.0) - 2.0) * ROWS / 3600.0 + c * ROWS;
  vec2 id = vec2(column * 0.731, mod(floor(y), ROWS) * 0.413) + seed;
  float there = step(1.0 - share, hash21(id + 0.5));
  vec2 at = 0.25 + 0.5 * vec2(hash21(id + 3.7), hash21(id + 8.3));
  float sway = 0.07 * sin(t * TURN * (200.0 + floor(hash21(id + 5.1) * 240.0)) / 3600.0 + c * TURN);
  float size = radius * (0.7 + 0.6 * hash21(id + 1.9));
  // A flake further off is sharp, and drawn out down its fall by the long exposure.
  float d = length((vec2(fract(q.x), fract(y)) - at - vec2(sway, 0.0)) * vec2(1.0, mix(0.4, 1.0, soft))) / cells;
  return there * smoothstep(size, size * mix(0.1, 0.3, soft), d);
}

vec3 paint(vec2 p, float t) {
  vec2 moon = vec2(0.31 * uAspect, 0.365);
  float toMoon = length(p - moon);
  float moonward = smoothstep(-0.6, 0.45, p.x / uAspect);

  float up = clamp((p.y + 0.24) / 0.74, 0.0, 1.0);
  vec3 col = mix(HAZE, DEEP_SKY, smoothstep(0.0, 0.42, up));
  col = mix(col, ZENITH, smoothstep(0.3, 1.0, up));

  // Thin cloud: it shows by the moonlight it scatters, most of all around the moon.
  float cloud = smoothstep(0.3, 0.8, fbm(vec2(p.x * 1.3 + 4.0, p.y * 3.6 - p.x * 0.5 + 9.0)));
  col += MOONLIGHT * cloud * (0.0022 + 0.03 * exp(-toMoon * 5.5));
  col += MOONLIGHT * (0.5 * exp(-toMoon * 150.0) + 0.05 * exp(-toMoon * 30.0) + 0.012 * exp(-toMoon * 7.0));
  col = mix(col, MOONLIGHT, smoothstep(0.0105, 0.0055, toMoon));

  float fireX = -0.27 * uAspect;
  vec2 fire = vec2(fireX, leftSpurTop(fireX) + 0.001);
  float breath = 0.86 + 0.09 * sin(t * TURN * 420.0 / 3600.0) + 0.05 * sin(t * TURN * 1010.0 / 3600.0 + 1.3);

  if (p.y < -0.06) {
    float massif = massifTop(p.x) - p.y;
    float rightSpur = rightSpurTop(p.x) - p.y;
    float leftSpur = leftSpurTop(p.x) - p.y;
    float field = fieldTop(p.x) - p.y;
    float onRightSpur = smoothstep(-0.0022, 0.0022, rightSpur);
    float onLeftSpur = smoothstep(-0.0016, 0.0016, leftSpur);
    // The snow underfoot is nearer than the lens is focused: its edge is soft.
    float onField = smoothstep(-0.006, 0.006, field);

    if (massif > -0.003 && max(onRightSpur, max(onLeftSpur, onField)) < 1.0) {
      vec3 face = slope(vec2(p.x * 8.0 + 3.0, massif * 6.5), vec3(0.4, 6.0, 0.85), 0.45 + 0.55 * moonward);
      face = mix(face, HAZE, 0.74 + 0.2 * smoothstep(0.0, 0.1, massif));
      col = mix(col, face, smoothstep(-0.003, 0.003, massif));
    }

    // One mammoth stands on the right spur, small enough to be found late.
    float herdX = 0.24 * uAspect;
    vec2 beast = (p - vec2(herdX, rightSpurTop(herdX) - 0.0015)) / BEAST;
    if (abs(beast.x) < 2.2 && beast.y > -0.5 && beast.y < 2.0) {
      vec2 ring = beast - vec2(-1.5, 0.98);
      float tusk = abs(length(ring) - 0.42) - mix(0.02, 0.065, smoothstep(-0.42, 0.42, ring.x));
      col = mix(col, mix(ROCK, HAZE, 0.3), smoothstep(0.12, -0.1, mammoth(beast)));
      col = mix(col, HAZE * 2.2, 0.7 * smoothstep(0.1, -0.05, tusk) * smoothstep(0.05, -0.05, ring.y));
    }

    if (onRightSpur > 0.0 && max(onLeftSpur, onField) < 1.0) {
      float facing = smoothstep(0.25, -0.25, (rightSpurTop(p.x + 0.03) - rightSpurTop(p.x - 0.03)) / 0.06);
      vec3 look = vec3(0.14 + 0.3 * facing * exp(-rightSpur * 14.0), 2.6, 0.45 * exp(-rightSpur * 16.0));
      vec3 face = slope(vec2(p.x * 9.0 + 11.0, rightSpur * 4.5), look, 0.4 + 0.6 * moonward);
      face = mix(face, HAZE, 0.46 + 0.22 * smoothstep(0.0, 0.12, rightSpur));
      col = mix(col, face, onRightSpur);
    }

    if (onLeftSpur > 0.0 && onField < 1.0) {
      float facing = smoothstep(0.25, -0.25, (leftSpurTop(p.x + 0.03) - leftSpurTop(p.x - 0.03)) / 0.06);
      vec3 look = vec3(0.14 + 0.3 * facing * exp(-leftSpur * 11.0), 2.4, 0.4 * exp(-leftSpur * 18.0));
      vec3 face = slope(vec2(p.x * 7.0 + 23.0, leftSpur * 4.0), look, 0.4 + 0.6 * moonward);
      // The fire lights the snow around it; the slope is seen at a low angle, so the pool of light is wide and thin.
      vec2 fromFire = (p - fire) * vec2(1.0, 3.2);
      face += EMBER * breath * 0.05 / (1.0 + dot(fromFire, fromFire) * 9000.0) * step(p.y, fire.y);
      face = mix(face, HAZE, 0.24 + 0.14 * smoothstep(0.0, 0.14, leftSpur));
      col = mix(col, face, onLeftSpur);
    }

    float toFire = length(p - fire);
    col += EMBER * breath * (0.5 * exp(-toFire * 260.0) + 0.045 * exp(-toFire * 55.0) + 0.006 * exp(-toFire * 12.0));
    col = mix(col, vec3(1.0, 0.62, 0.22) * breath, smoothstep(0.0026, 0.0008, toFire));

    if (onField > 0.0) {
      vec3 face = slope(vec2(p.x * 2.2 + 37.0, field * 16.0), vec3(0.18, 1.6, 0.0), 0.3 + 0.3 * moonward);
      col = mix(col, mix(face, HAZE, 0.05), onField);
    }
  }

  vec3 flake = vec3(0.30, 0.35, 0.47);
  float fall = 0.4 * flakes(p, t, 23.0, 17.0, 0.0010, 0.0, 0.34, 53.0)
    + 0.5 * flakes(p, t, 14.0, 17.0, 0.0017, 0.2, 0.32, 31.0)
    + 0.34 * flakes(p, t, 8.0, 16.0, 0.0045, 0.6, 0.34, 17.0)
    + 0.13 * flakes(p, t, 3.4, 13.0, 0.016, 1.0, 0.3, 5.0);
  col = mix(col, flake, min(fall, 1.0));

  col *= 1.0 - 0.35 * smoothstep(0.3, 1.0, length(vec2(p.x / uAspect, p.y)));
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  float grain = hash21(p * 7919.0) + hash21(p * 4253.0 + 17.0) - 1.0;
  return col + grain * (0.006 + 0.03 * sqrt(col.g));
}
`,
} satisfies Painting;
