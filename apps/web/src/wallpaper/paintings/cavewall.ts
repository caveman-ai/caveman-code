import type { Painting } from "../paintings.ts";

// A museum photograph of a painted limestone wall under one raking lamp: hand stencils, a bison, a row of dots and
// a running stag, the pigment worn into the rock's grain and most of the wall left bare. Painted as an
// archaeological illustrator who has copied Lascaux and Chauvet by lamplight. Only the lamp moves.
export default {
  id: "cavewall",
  name: "Cave wall",
  light: 0.12,
  moves: true,
  glsl: /* glsl */ `
const vec3 LAMP = vec3(1.0, 0.55, 0.19);
const vec3 LIMESTONE = vec3(0.4, 0.35, 0.28);
const vec3 RUST = vec3(0.4, 0.24, 0.12);
const vec3 CALCITE = vec3(0.6, 0.57, 0.5);
const vec3 OCHRE = vec3(0.46, 0.085, 0.022);
const vec3 CHARCOAL = vec3(0.014, 0.012, 0.011);
const mat2 SKEW = mat2(0.8, 0.6, -0.6, 0.8);

mat2 turn(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Value noise on a quintic curve with its slope, (value, d/dx, d/dy): the wall is lit by its slope, so the slope
// is worked out exactly instead of from neighbours.
vec3 swell(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}

// The wall's long folds, running down to the right as flowstone lies, as (height, slope) in p's own units.
// "boss" is a low bulge (centre, radius) the bison is painted over, as the old painters chose their rock.
vec3 folds(vec2 p, vec2 bend, vec3 boss) {
  mat2 lay = turn(0.5);
  vec2 stretch = vec2(0.75, 1.7);
  vec2 q = (lay * p + vec2(4.7, 9.2) + bend) * stretch;
  mat2 J = mat2(stretch * lay[0], stretch * lay[1]);
  vec3 n = swell(q);
  vec3 h = 0.16 * vec3(n.x, n.yz * J);
  q = SKEW * q * 2.1 + 3.1;
  J = 2.1 * SKEW * J;
  n = swell(q);
  h += 0.065 * vec3(n.x, n.yz * J);
  vec2 b = (p - boss.xy) / boss.z;
  float lump = 0.022 * exp(-dot(b, b));
  return h + lump * vec3(1.0, -2.0 * b / boss.z);
}

// The two coarsest octaves of the rock's surface: what the lamp's small shadows fall from.
float bumps(vec2 p) {
  vec2 q = p * 6.5 + vec2(1.7, 5.3);
  float h = 0.011 * swell(q).x;
  q = SKEW * q * 2.07 + 4.1;
  return h + 0.0045 * swell(q).x;
}

// The rock's surface from knuckle-sized bumps down to its grain, as (height, slope): limestone is broad shapes
// and a fine tooth with less between, so the middle octaves are the weakest. "low" is bumps() here; "tooth" is
// the grain alone, about -1 in a pit to 1 on a high point.
const float OCTAVES[6] = float[6](0.011, 0.0045, 0.0016, 0.0008, 0.00045, 0.00026);
vec3 surface(vec2 p, out float low, out float tooth) {
  vec2 q = p * 6.5 + vec2(1.7, 5.3);
  mat2 J = mat2(6.5, 0.0, 0.0, 6.5);
  vec3 sum = vec3(0.0);
  low = 0.0;
  tooth = 0.0;
  for (int i = 0; i < 6; i++) {
    vec3 n = swell(q);
    float a = OCTAVES[i];
    sum += a * vec3(n.x, n.yz * J);
    if (i < 2) low += a * n.x;
    else tooth += a * (n.x - 0.5);
    q = SKEW * q * 2.07 + 4.1;
    J = 2.07 * SKEW * J;
  }
  tooth /= 0.001;
  return sum;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float ellipse(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 < 0.001 ? -min(r.x, r.y) : k0 * (k0 - 1.0) / k1;
}

float taper(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float u = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * u) - mix(ra, rb, u);
}

// A brush stroke along a quadratic curve, wa wide where it starts and wb where it lifts off.
float stroke(vec2 pos, vec2 A, vec2 B, vec2 C, float wa, float wb) {
  vec2 a = B - A;
  vec2 b = A - 2.0 * B + C;
  vec2 c = a * 2.0;
  vec2 d = A - pos;
  float kk = 1.0 / dot(b, b);
  float kx = kk * dot(a, b);
  float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  float kz = kk * dot(d, a);
  float p = ky - kx * kx;
  float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float h = q * q + 4.0 * p * p * p;
  float u;
  if (h >= 0.0) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - q) / 2.0;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    u = clamp(uv.x + uv.y - kx, 0.0, 1.0);
  } else {
    float z = sqrt(-p);
    float v = acos(q / (p * z * 2.0)) / 3.0;
    float m = cos(v);
    float n = sin(v) * 1.732050808;
    vec2 us = clamp(vec2(m + m, -n - m) * z - kx, 0.0, 1.0);
    vec2 d0 = d + (c + b * us.x) * us.x;
    vec2 d1 = d + (c + b * us.y) * us.y;
    u = dot(d0, d0) < dot(d1, d1) ? us.x : us.y;
  }
  vec2 off = d + (c + b * u) * u;
  return length(off) - mix(wa, wb, u);
}

float triangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// An open hand, palm at the origin, a unit about the wrist crease to the middle fingertip.
float hand(vec2 q) {
  float d = length(max(abs(q) - vec2(0.1, 0.115), 0.0)) - 0.08;
  d = smin(d, taper(q, vec2(-0.12, 0.14), vec2(-0.225, 0.52), 0.046, 0.036), 0.03);
  d = smin(d, taper(q, vec2(-0.04, 0.17), vec2(-0.055, 0.63), 0.048, 0.038), 0.03);
  d = smin(d, taper(q, vec2(0.05, 0.16), vec2(0.1, 0.58), 0.046, 0.036), 0.03);
  d = smin(d, taper(q, vec2(0.13, 0.11), vec2(0.25, 0.42), 0.04, 0.031), 0.03);
  d = smin(d, taper(q, vec2(-0.13, -0.09), vec2(-0.39, 0.13), 0.056, 0.042), 0.04);
  return smin(d, taper(q, vec2(0.0, -0.17), vec2(0.03, -0.7), 0.14, 0.12), 0.04);
}

// A bison facing right, a unit long. x: its whole outline, legs and beard in; y: the horns and tail, drawn as lines.
vec2 bison(vec2 q) {
  float body = ellipse(q - vec2(-0.28, 0.02), vec2(0.19, 0.17));
  body = smin(body, ellipse(q - vec2(-0.03, 0.0), vec2(0.28, 0.15)), 0.08);
  body = smin(body, ellipse(q - vec2(0.14, 0.09), vec2(0.2, 0.2)), 0.07);
  body = smin(body, taper(q, vec2(0.33, 0.02), vec2(0.47, -0.1), 0.1, 0.04), 0.05);
  body = smin(body, taper(q, vec2(0.4, -0.13), vec2(0.385, -0.22), 0.028, 0.004), 0.03);
  body = smin(body, taper(q, vec2(0.12, -0.08), vec2(0.15, -0.37), 0.046, 0.011), 0.03);
  body = smin(body, taper(q, vec2(0.22, -0.08), vec2(0.265, -0.32), 0.038, 0.01), 0.03);
  body = smin(body, taper(q, vec2(-0.3, -0.04), vec2(-0.385, -0.21), 0.075, 0.028), 0.03);
  body = smin(body, taper(q, vec2(-0.385, -0.21), vec2(-0.34, -0.39), 0.028, 0.01), 0.015);
  body = smin(body, taper(q, vec2(-0.19, -0.08), vec2(-0.255, -0.2), 0.05, 0.023), 0.03);
  body = smin(body, taper(q, vec2(-0.255, -0.2), vec2(-0.22, -0.34), 0.023, 0.009), 0.015);

  float line = stroke(q, vec2(0.33, 0.09), vec2(0.32, 0.22), vec2(0.42, 0.24), 0.017, 0.003);
  line = min(line, stroke(q, vec2(0.42, 0.06), vec2(0.46, 0.16), vec2(0.54, 0.18), 0.015, 0.003));
  line = min(line, stroke(q, vec2(-0.46, 0.09), vec2(-0.58, 0.14), vec2(-0.57, -0.08), 0.008, 0.013));
  return vec2(body, line);
}

// A stag at full stretch, running right, a unit long.
float stag(vec2 q) {
  float d = ellipse(turn(-0.12) * q, vec2(0.3, 0.1));
  d = smin(d, taper(q, vec2(0.22, 0.05), vec2(0.4, 0.27), 0.07, 0.038), 0.05);
  d = min(d, taper(q, vec2(0.4, 0.28), vec2(0.55, 0.23), 0.043, 0.017));
  d = min(d, taper(q, vec2(0.39, 0.3), vec2(0.33, 0.37), 0.016, 0.005));
  d = min(d, taper(q, vec2(-0.29, 0.04), vec2(-0.36, 0.1), 0.02, 0.006));
  d = min(d, stroke(q, vec2(0.22, -0.03), vec2(0.38, -0.08), vec2(0.58, -0.13), 0.028, 0.006));
  d = min(d, stroke(q, vec2(0.17, -0.07), vec2(0.3, -0.2), vec2(0.47, -0.25), 0.026, 0.006));
  d = min(d, stroke(q, vec2(-0.22, -0.01), vec2(-0.4, -0.05), vec2(-0.61, -0.16), 0.034, 0.006));
  d = min(d, stroke(q, vec2(-0.2, -0.06), vec2(-0.34, -0.2), vec2(-0.51, -0.28), 0.028, 0.006));
  d = min(d, stroke(q, vec2(0.42, 0.31), vec2(0.38, 0.53), vec2(0.2, 0.6), 0.017, 0.007));
  d = min(d, stroke(q, vec2(0.44, 0.31), vec2(0.5, 0.5), vec2(0.37, 0.69), 0.017, 0.007));
  d = min(d, taper(q, vec2(0.43, 0.33), vec2(0.53, 0.4), 0.012, 0.005));
  d = min(d, taper(q, vec2(0.37, 0.47), vec2(0.44, 0.56), 0.012, 0.005));
  d = min(d, taper(q, vec2(0.3, 0.56), vec2(0.33, 0.67), 0.012, 0.005));
  return d;
}

// What is left of a wet wash: it holds in the rock's pits and has worn off its high points.
float held(float tooth) {
  return mix(0.5, 1.0, smoothstep(0.35, -0.3, tooth));
}

// A dry charcoal stick marks the high points and skips the pits.
float caught(float tooth) {
  return mix(0.5, 1.0, smoothstep(-0.45, 0.1, tooth));
}

// A mark's edge: it frays on the grain, a few pixels soft.
float mark(float d, float tooth) {
  return smoothstep(0.0035, -0.0035, d - tooth * 0.004);
}

// Ochre blown round a hand held to the wall: thickest at the skin, thinning to a mist, the hand left bare.
float stencil(vec2 p, vec2 at, float size, float lean, float side, float tooth) {
  vec2 q = turn(lean) * (p - at) / size;
  q.x *= side;
  if (dot(q, q) > 3.2) return 0.0;
  float d = hand(q);
  float ragged = swell(q * 2.4 + at * 31.0).x - 0.5;
  float cloud = 1.0 - smoothstep(0.15, 1.3, length(q - vec2(0.0, 0.2)) + ragged * 0.5);
  cloud *= 0.5 + 0.7 * exp(-max(d, 0.0) * 5.0);
  cloud *= smoothstep(-0.015, 0.05, d - tooth * 0.02);
  return clamp(cloud * 1.25 - 0.12 + 0.14 * tooth, 0.0, 1.0);
}

vec3 paint(vec2 p, float t) {
  float edge = 0.5 * uAspect;
  float wide = smoothstep(1.05, 1.6, uAspect);
  // Whole turns in the hour t wraps at, so the lamp has no seam.
  float w = 6.2831853 / 3600.0;
  float breath = 1.0 + 0.045 * sin(t * w * 211.0) + 0.018 * sin(t * w * 379.0 + 1.3);
  // Held low to the wall so its light rakes. A narrow pane has less wall to fall dark across, so it stands further off.
  vec3 lamp = vec3(-edge - mix(0.42, 0.34, wide) + 0.02 * sin(t * w * 191.0), mix(-0.36, -0.3, wide) + 0.03 * sin(t * w * 257.0 + 0.7), 0.3);

  vec2 bisonAt = mix(vec2(-edge + 0.2, -0.34), vec2(-edge + 0.36, -0.27), wide);
  float bisonSize = mix(0.31, 0.44, wide);
  vec3 boss = vec3(bisonAt + vec2(0.02, 0.03) * bisonSize, 0.42 * bisonSize);

  vec2 bend = 0.3 * vec2(swell(p * 0.7 + 13.0).x, swell(p * 0.7 + 31.0).x);
  float rough = mix(0.3, 1.3, smoothstep(0.2, 0.8, swell(p * 1.3 + 21.0).x));
  float rust = swell(p * 0.9 + 57.0).x;
  // Calcite has run down the wall in sheets: smoother, paler, and it shines.
  float calcite = smoothstep(0.5, 0.82, swell(vec2(p.x * 2.4, p.y * 0.5) + bend * 2.0 + 40.0).x);
  rough *= 1.0 - 0.45 * calcite;

  float low, tooth;
  vec3 fold = folds(p, bend, boss);
  vec3 skin = surface(p, low, tooth) * rough;
  low *= rough;
  vec2 slope = fold.yz + skin.yz;

  // A fissure: a narrow groove along one contour of a slow noise, open only in places.
  vec3 seam = swell(p * 2.1 + bend * 3.0 + 70.0);
  float across = 2.0 * seam.x - 1.0;
  float groove = smoothstep(0.5, 0.78, swell(p * 0.9 + 83.0).x) * exp(-across * across / 0.0004);
  slope += 0.002 * groove * (2.0 * across / 0.0004) * 4.2 * seam.yz;

  vec3 normal = normalize(vec3(-slope, 1.0));
  vec3 toLamp = lamp - vec3(p, 0.0);
  float reach = dot(toLamp, toLamp);
  vec3 ray = toLamp / sqrt(reach);
  float facing = max(dot(normal, ray), 0.0);

  // The bumps' shadows: a few steps toward the lamp, the folds taken as a plane over that short way.
  vec2 along = normalize(toLamp.xy);
  float rise = toLamp.z / length(toLamp.xy);
  float tilt = dot(fold.yz, along);
  float shade = 1.0;
  float s = 0.008;
  for (int i = 0; i < 5; i++) {
    float clear = low + s * (rise - tilt) - bumps(p + along * s) * rough;
    shade = min(shade, clamp(clear / (0.6 * s * rise + 0.0005) + 0.3, 0.0, 1.0));
    s *= 1.9;
  }

  vec3 rock = mix(LIMESTONE, RUST, smoothstep(0.35, 0.8, rust) * 0.7);
  rock = mix(rock, CALCITE, calcite * 0.55);
  rock *= mix(0.72, 1.06, smoothstep(-0.6, 0.6, tooth)) * (1.0 - 0.75 * groove);
  float gloss = mix(0.03, 0.3, calcite);

  // Paint is thinner under the calcite that has grown over it since.
  float veil = 1.0 - 0.45 * calcite;
  float wash = held(tooth) * veil;
  float stick = caught(tooth) * veil;

  float handSize = mix(0.085, 0.1, wide);
  float cloud = stencil(p, mix(vec2(-edge + 0.09, -0.135), vec2(-edge + 0.13, -0.03), wide), handSize, 0.22, 1.0, tooth);
  cloud = max(cloud, 0.85 * stencil(p, mix(vec2(-edge + 0.21, -0.12), vec2(-edge + 0.255, 0.06), wide), handSize * 0.92, -0.16, -1.0, tooth));
  cloud = max(cloud, 0.8 * stencil(p, mix(vec2(edge - 0.1, 0.36), vec2(-edge + 0.1, 0.19), wide), handSize * 0.95, 0.05, 1.0, tooth));
  rock = mix(rock, OCHRE, cloud * 0.85 * mix(0.8, 1.0, wash));

  vec2 q = (p - bisonAt) / bisonSize;
  if (abs(q.x) < 0.75 && abs(q.y) < 0.55) {
    vec2 b = bison(q);
    float pressure = 0.5 + swell(q * 3.4 + 5.0).x;
    float within = mark(b.x * bisonSize, tooth);
    // Red for the flank; charcoal for the back's line, the mane, the head and the legs, as at Altamira.
    float back = max(smoothstep(-0.1, 0.06, q.y + 0.02 - 0.1 * q.x), smoothstep(0.24, 0.34, q.x));
    float dark = max(smoothstep(0.1, 0.34, q.x + 0.3 * q.y), smoothstep(-0.08, -0.19, q.y));
    float line = min(abs(b.x + 0.012) - mix(-0.012, 0.016, back) * pressure, b.y) * bisonSize;
    // The stick's line, and the dust of it rubbed out from the line with a thumb.
    float drawn = max(mark(line, tooth), 0.4 * exp(-max(line, 0.0) / 0.012) * mix(within, 1.0, 0.35));
    rock = mix(rock, OCHRE, within * wash * mix(0.65, 0.95, pressure - 0.5));
    rock = mix(rock, CHARCOAL, max(drawn, within * dark * 0.95) * stick * 0.94);
  }

  vec2 dotsAt = mix(vec2(edge - 0.29, -0.375), vec2(-edge + 0.68, -0.35), wide);
  float dots = 1.0;
  for (int i = 0; i < 6; i++) {
    float k = float(i);
    vec2 at = dotsAt + mix(0.8, 1.0, wide) * vec2(0.036 * k + 0.006 * sin(k * 4.1), 0.011 * sin(k * 1.3) + 0.004 * k);
    dots = min(dots, length(p - at) - mix(0.0075, 0.009, wide) - 0.002 * sin(k * 2.7));
  }
  rock = mix(rock, OCHRE, mark(dots, tooth) * wash * 0.8);

  vec2 stagAt = mix(vec2(edge - 0.14, -0.21), vec2(edge - 0.34, -0.26), wide);
  float stagSize = mix(0.155, 0.24, wide);
  q = (p - stagAt) / stagSize;
  if (abs(q.x) < 0.75 && abs(q.y) < 0.8) rock = mix(rock, OCHRE, mark(stag(q) * stagSize, tooth) * wash * 0.85);

  // The one mark a caveman should not know: a pointer, small, in the dark corner.
  q = (p - mix(vec2(edge - 0.05, -0.45), vec2(edge - 0.09, -0.4), wide)) / 0.036;
  if (dot(q, q) < 1.0) {
    float arrow = min(triangle(q, vec2(-0.25, 0.5), vec2(-0.25, -0.3), vec2(0.3, -0.06)), taper(q, vec2(-0.03, -0.15), vec2(0.13, -0.5), 0.07, 0.06));
    rock = mix(rock, OCHRE, smoothstep(0.002, -0.002, arrow * 0.036 - tooth * 0.0015) * wash * 0.85);
  }

  float power = 5.2 * breath * pow(lamp.z * lamp.z / reach, 0.9);
  // Lamp, a little of it bounced back into its own shadows, the cave's dim air, and a cool fill from the camera's side.
  vec3 light = LAMP * power * (facing * shade + 0.05);
  light += vec3(0.03, 0.03, 0.031) * (0.5 + 0.5 * normal.z);
  light += vec3(0.012, 0.014, 0.018) * max(dot(normal, normalize(vec3(0.55, 0.35, 0.75))), 0.0);
  vec3 colour = rock * light;
  float glint = pow(max(dot(normal, normalize(ray + vec3(0.0, 0.0, 1.0))), 0.0), 16.0);
  colour += LAMP * power * shade * gloss * glint;
  // Dust in the air between lens and wall, lit where the lamp is near.
  colour += LAMP * 0.005 * breath * pow(lamp.z * lamp.z / reach, 0.5);
  colour *= 1.0 - 0.35 * smoothstep(0.1, 0.6, p.y);
  colour *= 1.0 - 0.3 * smoothstep(0.55, 1.25, length(p / vec2(edge, 0.5)));
  float grainy = hash21(p * 1531.0 + 7.0) + hash21(p * 977.0 + 3.0) - 1.0;
  return pow(colour, vec3(1.0 / 2.2)) + grainy * 0.014;
}
`,
} satisfies Painting;
