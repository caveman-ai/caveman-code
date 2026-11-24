import type { Painting } from "../paintings.ts";

// A small campfire at night, seen from inside the mouth of a cave: near-black rock around the edges, a violet
// night with a few stars and far hills through the opening, and one low flame whose light falls off fast.
// Painted as a film lighting artist who lights the whole scene from that single flame and shows no more of it.
export default {
  id: "campfire",
  name: "Campfire",
  light: 0.08,
  moves: true,
  glsl: /* glsl */ `
// The palette, in linear light.
const vec3 NIGHT = vec3(0.0040, 0.0027, 0.0070);
const vec3 EMBER = vec3(0.2590, 0.0440, 0.0160);
const vec3 ORANGE = vec3(0.8370, 0.3490, 0.0470);
const vec3 PALE = vec3(0.9910, 0.7160, 0.4840);
const vec3 VIOLET = vec3(0.0950, 0.0560, 0.2960);
// The flame's heart. Pale flame itself comes out grey under the app's reading limit; this keeps its warmth.
const vec3 GOLD = vec3(1.0, 0.5, 0.1);

const float TAU = 6.2831853;
const float HORIZON = -0.135;
const float FLAME = 0.085; // the flame's height, in p

// A sine that comes round whole when t wraps at 3600: 'turns' is how many times it does in the hour.
float slow(float t, float turns, float phase) {
  return sin(TAU * (turns * t / 3600.0 + phase));
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  return length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
}

// Straight faces of rock between corners, 'count' of them round the mouth ('turn' is 0 to 1 round it): x how far
// the rock stands out there, 0 to 1, y its slope a radian.
vec2 faces(float turn, float count, float seed) {
  float x = (turn + 0.014 * sin(TAU * (turn * 4.0 + seed))) * count;
  float i = floor(x);
  float a = hash21(vec2(mod(i, count), seed));
  float b = hash21(vec2(mod(i + 1.0, count), seed));
  return vec2(mix(a, b, x - i), (b - a) * count / TAU);
}

// How far p is into a wall of rock whose edge lies 'edge' from the mouth's centre, less its crags (x), and how
// much of the fire's light that edge turns to face (y).
vec2 wall(vec2 from, float edge, float crags, float seed, vec2 toFire) {
  float rho = length(from);
  vec2 dir = from / max(rho, 1e-4);
  vec2 along = vec2(-dir.y, dir.x);
  float turn = atan(dir.y, dir.x) / TAU + 0.5;
  vec2 rag = 0.5 * faces(turn, 9.0, seed) + 0.32 * faces(turn, 23.0, seed + 1.0) + 0.18 * faces(turn, 61.0, seed + 2.0);
  float lip = edge - crags * rag.x;
  vec2 normal = normalize(-dir * lip - along * crags * rag.y);
  return vec2(rho - lip, clamp(dot(normal, toFire) * 0.85 + 0.15, 0.0, 1.0));
}

// How deep p is in one tongue of flame: 1 on its centre line, 0 at its edge, less outside. q is from its foot, in
// flame heights. Its bend climbs it as a slow wave.
float tongue(vec2 q, float height, float width, float lean, float phase, float t) {
  float u = q.y / height;
  if (u <= 0.0 || u >= 1.0) return -1.0;
  float bend = (lean + 0.07 * sin(u * 3.4 - t * 0.9 + phase)) * u * u + (vnoise(vec2(phase, u * 2.2 - t * 0.45)) - 0.5) * 0.16 * u;
  float half_ = width * 3.25 * sqrt(u) * pow(1.0 - u, 1.7);
  return max(1.0 - abs(q.x - bend) / max(half_, 1e-4), -1.0);
}

vec3 stars(vec2 p, float t, float spacing, float shine) {
  vec2 grid = p / spacing;
  vec2 cell = floor(grid);
  float pick = hash21(cell + 3.1);
  if (pick > 0.3) return vec3(0.0);
  vec2 at = 0.2 + 0.6 * vec2(hash21(cell + 9.7), hash21(cell + 21.3));
  float d = length(fract(grid) - at) * spacing / (0.0012 + 0.0013 * hash21(cell + 5.5));
  shine *= pow(hash21(cell + 14.9), 2.0) * (0.82 + 0.18 * slow(t, 300.0 + floor(pick * 900.0), pick * 7.0));
  return mix(vec3(0.75, 0.78, 1.0), PALE, hash21(cell + 2.2) * 0.5) * shine * exp(-d * d);
}

// Noise for the last bit of each channel, so the sky's long gradient never shows as bands.
float speck(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 scene(vec2 p, float t) {
  vec2 fire = vec2(min(0.15, 0.1 * uAspect), -0.315);
  float breath = 0.8 + 0.11 * slow(t, 520.0, 0.0) + 0.06 * slow(t, 937.0, 0.31) + 0.03 * slow(t, 1610.0, 0.7);
  vec2 heart = fire + vec2(0.0, 0.3 * FLAME);
  vec3 warm = mix(EMBER, ORANGE, 0.45);

  // The cave: a leaning, rounded mouth measured across the whole box, and a nearer wall of rock in the corners.
  vec2 from = p - vec2(0.01 * uAspect, -0.175);
  float lean = atan(from.y, from.x);
  vec2 n = from / vec2(0.45 * uAspect, 0.6);
  float mouth = length(from) / max(pow(pow(abs(n.x), 2.3) + pow(abs(n.y), 2.3), 1.0 / 2.3), 1e-4);
  mouth *= 1.0 + 0.06 * sin(2.0 * lean + 0.6) + 0.045 * sin(3.0 * lean + 2.1);
  vec2 m = from / vec2(0.5 * uAspect, 0.66);
  float corners = length(from) / max(pow(pow(abs(m.x), 3.2) + pow(abs(m.y), 3.2), 1.0 / 3.2), 1e-4);
  float size = clamp(uAspect / 1.5, 0.55, 1.0);
  vec2 toFire = normalize(heart - p);
  vec2 far_ = wall(from, mouth, 0.15 * size, 7.0, toFire);
  vec2 near_ = wall(from, corners, 0.15 * size, 23.0, toFire);
  float rock = max(smoothstep(-0.001, 0.001, far_.x), smoothstep(-0.003, 0.003, near_.x));

  vec3 col = vec3(0.0);
  if (rock < 1.0) {
    // Night sky, hills.
    float up = clamp((p.y - HORIZON) / (0.5 - HORIZON), 0.0, 1.0);
    col = mix(NIGHT * 1.5 + VIOLET * 0.22, NIGHT * 0.9 + VIOLET * 0.012, pow(up, 0.5));
    col += (stars(p, t, 0.075, 0.5) + stars(p + 3.7, t, 0.043, 0.14)) * smoothstep(0.05, 0.16, up);
    float far = HORIZON + 0.004 + 0.055 * vnoise(vec2(p.x * 1.5 + 4.2, 0.5)) + 0.012 * vnoise(vec2(p.x * 6.0, 7.5));
    col = mix(col, NIGHT * 1.3 + VIOLET * 0.085, smoothstep(0.0015, -0.0015, p.y - far));
    float near = HORIZON - 0.008 + 0.034 * vnoise(vec2(p.x * 2.4 + 11.0, 3.5)) + 0.007 * vnoise(vec2(p.x * 11.0, 1.5));
    col = mix(col, NIGHT * 1.1 + VIOLET * 0.035, smoothstep(0.0015, -0.0015, p.y - near));

    // The ground, lit by the fire alone. Distance is taken on the ground so the pool lies flat, from a
    // vanishing line above the hills so it does not lie too flat to see.
    if (p.y < HORIZON) {
      float line = HORIZON + 0.1;
      float depth = 1.0 / (line - p.y);
      vec2 g = vec2((p.x - fire.x) * depth, depth - 1.0 / (line - fire.y));
      float d2 = dot(g, g);
      float grain = fbm(g * vec2(4.0, 7.0) + 31.0);
      float lit = breath / (1.0 + d2 / 0.07) * exp(-sqrt(d2) * 0.7);
      vec3 earth = warm * (0.5 + 0.9 * grain * grain);
      vec3 ground = NIGHT * 0.9 + VIOLET * 0.008 + earth * lit * 0.8;
      col = mix(col, ground, smoothstep(0.0, 0.012, HORIZON - p.y));
    }

    // The fire: a bed of embers between dark logs that glow where they meet it, one flame with a lick at each
    // side, and the air glowing around it.
    vec2 q = p - fire;
    float hot = exp(-length(q * vec2(1.0, 2.0)) * 50.0);
    float coal = vnoise(p * vec2(210.0, 340.0)) * (0.5 + 0.5 * vnoise(p * 46.0 + vec2(0.0, t * 0.16)));
    vec3 embers = mix(EMBER * 0.5, ORANGE, smoothstep(0.1, 0.55, coal)) * (0.2 + 1.6 * coal) * breath;

    float back = min(segment(q, vec2(-0.047, -0.003), vec2(0.02, 0.022)), segment(q, vec2(0.05, -0.004), vec2(-0.017, 0.02)));
    col = mix(col, EMBER * (0.02 + 0.9 * hot * breath), smoothstep(0.0046, 0.0034, back));

    float bed = smoothstep(1.0, 0.25, length((q - vec2(0.0, -0.003)) / vec2(0.043, 0.0105)));
    col = mix(col, embers, bed);

    vec2 f = (q - vec2(0.0, -0.004)) / FLAME;
    float a = max(tongue(f, 0.95 + 0.1 * slow(t, 610.0, 0.1), 0.25, 0.07 * slow(t, 450.0, 0.2), 1.7, t), 0.0);
    float b = max(tongue(f - vec2(-0.1, 0.0), 0.55 + 0.09 * slow(t, 790.0, 0.6), 0.15, -0.05 + 0.05 * slow(t, 530.0, 0.5), 5.3, t), 0.0);
    float c = max(tongue(f - vec2(0.09, 0.0), 0.42 + 0.09 * slow(t, 880.0, 0.35), 0.13, 0.04 + 0.05 * slow(t, 670.0, 0.8), 9.1, t), 0.0);
    float heat = min(a + 0.8 * (b + c), 1.0);
    float rise = clamp(f.y, 0.0, 1.0);
    vec3 flame = mix(EMBER * 0.7, ORANGE * 0.5, smoothstep(0.1, 0.7, heat));
    flame = mix(flame, ORANGE * 1.1, smoothstep(0.6, 0.95, heat));
    flame = mix(flame, GOLD, smoothstep(0.55, 1.0, a) * (1.0 - smoothstep(0.15, 0.65, rise)));
    flame *= 1.0 - 0.5 * smoothstep(0.5, 1.0, rise);
    col = mix(col, flame, smoothstep(0.0, 0.3, heat) * (1.0 - 0.35 * smoothstep(0.6, 1.0, rise)));

    vec2 la = vec2(-0.037, -0.0125);
    vec2 lb = vec2(0.04, -0.0105);
    float front = segment(q, la, lb);
    float crown = clamp((front - segment(q - vec2(0.0, 0.0012), la, lb)) / 0.0012, 0.0, 1.0);
    col = mix(col, EMBER * 0.02 + ORANGE * 0.3 * crown * exp(-abs(q.x) * 34.0) * breath, smoothstep(0.0044, 0.0032, front));

    float away = length((p - heart) * vec2(1.0, 1.25));
    col += ORANGE * breath * (0.26 * exp(-away * 30.0) + 0.04 * exp(-away * 8.0));

    // Sparks: each rises on its own loop, wandering, and goes out on the way.
    for (int i = 0; i < 7; i++) {
      float k = float(i);
      float turn = t / (9.0 + 1.7 * k) + k * 0.37;
      float life = fract(turn);
      float seed = floor(turn) + k * 13.0;
      float reach = 0.1 + 0.12 * hash21(vec2(seed, 1.0));
      vec2 at = fire + vec2((hash21(vec2(seed, 2.0)) - 0.5) * 0.03, 0.05 + reach * life);
      at.x += (0.012 + 0.03 * life) * sin(life * (3.0 + 4.0 * hash21(vec2(seed, 3.0))) + seed) * life;
      float glow = smoothstep(0.0, 0.08, life) * pow(1.0 - life, 1.6);
      float d = length(p - at);
      col += mix(ORANGE, PALE, 0.3) * glow * (exp(-d * d / 1.5e-6) + 0.12 * exp(-d * 420.0));
    }

    // Now and then one does not go out: it climbs all the way up and is a star for a couple of minutes.
    float turn = t / 180.0;
    float life = fract(turn);
    float seed = floor(turn) + 41.0;
    vec2 home = vec2(0.01 * uAspect + (hash21(vec2(seed, 7.0)) - 0.5) * 0.4 * uAspect, 0.17 + 0.09 * hash21(vec2(seed, 8.0)));
    float climb = clamp(life / 0.25, 0.0, 1.0);
    float eased = 1.0 - (1.0 - climb) * (1.0 - climb);
    vec2 at = mix(fire + vec2(0.0, 0.06), home, eased);
    at.x += 0.035 * sin(climb * 7.0 + seed) * eased * (1.0 - eased);
    float d = length(p - at);
    float glow = smoothstep(0.0, 0.01, life) * smoothstep(1.0, 0.85, life) * mix(0.9, 0.3, eased);
    col += mix(mix(ORANGE, PALE, 0.3), vec3(0.85, 0.8, 0.9), eased) * glow * exp(-d * d / 1.5e-6);
  }

  if (rock > 0.0) {
    // Almost black. The fire catches the faces of the mouth's lip that turn toward it, and barely the nearer wall.
    float reach = breath / (1.0 + dot(p - heart, p - heart) * 9.0);
    float in_ = max(far_.x, 0.0);
    float grain = fbm(p * vec2(7.0, 11.0) + 3.0);
    vec3 stone = NIGHT * 0.5 + warm * reach * far_.y * (0.55 * exp(-in_ / 0.005) + (0.16 * exp(-in_ / 0.035) + 0.012) * grain * grain * 2.2);
    in_ = max(near_.x, 0.0);
    vec3 nearer = NIGHT * 0.3 + warm * reach * near_.y * 0.14 * exp(-in_ / 0.007);
    stone = mix(stone, nearer, smoothstep(-0.003, 0.003, near_.x));
    col = mix(col, stone, rock);
  }
  return col;
}

vec3 paint(vec2 p, float t) {
  vec3 col = scene(p, t);
  // The hour's last seconds fade into its first, so the wrap of t never shows.
  if (t > 3592.0) col = mix(col, scene(p, t - 3600.0), smoothstep(3592.0, 3600.0, t));
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  return col + (speck(p * 2400.0 + 900.0) + speck(p * 2400.0 + 1700.0) - 1.0) / 255.0;
}
`,
} satisfies Painting;
