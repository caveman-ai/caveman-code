import type { Painting } from "../paintings.ts";

// Wet indigo silk hung to dry: a few broad folds sweeping from the lower left to the upper right, lit along their
// crests, the middle left in a trough of shadow, one thread of peach light on a single crest. Painted as a Kyoto
// dyer who photographs one deep colour and the way a fold catches light, and nothing else.
export default {
  id: "silk",
  name: "Silk",
  light: 0.1,
  moves: true,
  glsl: /* glsl */ `
const float TAU = 6.2831853;
// How tall a fold stands, in the picture's own units, where the height below says 1.
const float DEEP = 0.32;
// One soft box, up and to the left, near enough that its light falls off across the frame.
const vec3 LAMP = vec3(-1.1, 2.0, 0.7);

// centre, width, height, turns an hour
const vec4 FOLD[6] = vec4[6](
  vec4(0.38, 0.100, 1.00, 9.0),
  vec4(-0.37, 0.095, 0.95, 13.0),
  vec4(0.82, 0.120, 0.85, 8.0),
  vec4(-0.64, 0.100, 0.90, 10.0),
  vec4(0.62, 0.090, 0.16, 15.0),
  vec4(-0.22, 0.060, 0.10, 12.0)
);

// Each fold where the pixel is: its centre, how much wider than usual, its height. Worked out once a pixel.
vec3 folds[6];
vec2 wander;

// Whole turns an hour, so the hour's wrap shows no seam.
float turn(float t, float turns) { return TAU * turns * t / 3600.0; }

// The prelude's hash repeats every fifty whole steps, which shows as streaks in the dark; this one does not.
float grain(vec2 cell) {
  vec3 q = fract(cell.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Two octaves, -1 to 1: fbm's finer ones would crumple the cloth.
float swell(vec2 q) { return vnoise(q) * 1.3 + vnoise(q * 2.03 + 11.7) * 0.7 - 1.0; }

// Where p lies on the cloth: x across the folds, y along them. The folds run nearly level through the middle,
// where the chat box is, sweep up only to its sides, and gather toward the lower left as cloth does at its peg.
vec2 cloth(vec2 p, float t) {
  float rise = 0.14 * p.x + 0.32 * p.x * p.x * p.x / (0.5 + p.x * p.x);
  float along = p.x + 0.3 * p.y;
  float across = (p.y - rise) / (1.0 + 0.2 * p.x / (1.0 + abs(p.x)));
  across += 0.030 * sin(along * 2.3 + turn(t, 7.0));
  across += 0.050 * (vnoise(vec2(along * 1.6, across * 1.2) + wander) - 0.5);
  return vec2(across, along);
}

void settle(float along, float t) {
  for (int i = 0; i < 6; i++) {
    vec4 f = FOLD[i];
    float k = float(i);
    folds[i] = vec3(
      f.x + 0.035 * sin(along * 1.7 + k * 2.3 + turn(t, f.w)),
      1.0 + 0.2 * sin(along * 1.1 - k * 1.9 - turn(t, f.w - 4.0)),
      f.z * (0.72 + 0.28 * sin(along * 1.3 + k * 3.1 + turn(t, f.w - 2.0)))
    );
  }
}

// The cloth's height at p. fine: how much of its small creasing to add (none where it is out of focus).
float surface(vec2 p, float t, float fine) {
  vec2 c = cloth(p, t);
  float h = 0.0;
  for (int i = 0; i < 6; i++) {
    float d = c.x - folds[i].x;
    float w = FOLD[i].y;
    // Each broad fold leans: a long slope up its lit side, a short drop on the other. The two slight ones do not.
    float lean = i < 4 ? 0.55 : 0.15;
    float x = d / (w * folds[i].y * (1.45 + lean * d * inversesqrt(d * d + 0.36 * w * w)));
    h += folds[i].z * exp(-x * x);
  }
  if (fine > 0.0) h += fine * (0.012 * swell(vec2(c.y * 2.4, c.x * 8.0) + wander.yx) + 0.003 * swell(vec2(c.y * 9.0, c.x * 31.0)));
  return h;
}

vec3 paint(vec2 p, float t) {
  wander = vec2(3.0, 7.0) + 0.3 * vec2(sin(turn(t, 3.0)), cos(turn(t, 2.0)));
  vec2 c = cloth(p, t);
  settle(c.y, t);

  // The lens is focused on the fold that carries the thread; the cloth softens away from it.
  float blur = smoothstep(0.10, 0.80, abs(c.x + 0.34));
  float sharp = (1.0 - blur) * (1.0 - blur);
  float e = mix(0.003, 0.030, blur);
  float h = surface(p, t, sharp);
  vec2 slope = DEEP * vec2(surface(p + vec2(e, 0.0), t, sharp) - h, surface(p + vec2(0.0, e), t, sharp) - h) / e;
  vec3 n = normalize(vec3(-slope, 1.0));

  vec3 lamp = LAMP - vec3(p, DEEP * h);
  float reach = dot(lamp, lamp);
  vec3 l = lamp * inversesqrt(reach);
  float power = 5.0 / reach;

  // What the folds between here and the lamp hide of it: five looks toward it, the penumbra widening with distance.
  vec2 toward = normalize(l.xy);
  float climb = l.z / length(l.xy);
  float open = 1.0;
  const float LOOK[5] = float[5](0.05, 0.13, 0.25, 0.40, 0.58);
  for (int i = 0; i < 5; i++) {
    float s = LOOK[i];
    float over = DEEP * (surface(p + toward * s, t, 0.0) - h) - s * climb;
    float soft = 0.012 + 0.10 * s + 0.03 * blur;
    open = min(open, 1.0 - smoothstep(-soft, soft, over));
  }

  // Satin's floats run across the folds; each thread shines where it lies square to the half vector, so the sheen
  // is a band along the fold that breaks where the cloth turns over its crest.
  float x2 = p.x * p.x;
  vec2 acrossDir = normalize(vec2(-(0.14 + 0.32 * x2 * (1.5 + x2) / ((0.5 + x2) * (0.5 + x2))), 1.0));
  vec3 thread = normalize(vec3(acrossDir, dot(slope, acrossDir)));
  float streak = vnoise(vec2(c.y * 240.0, c.x * 4.0)) * 0.6 + vnoise(vec2(c.y * 75.0, c.x * 2.0 + 5.0)) * 0.4 - 0.5;
  float along = dot(thread, normalize(l + vec3(0.0, 0.0, 1.0))) + streak * 0.02 * sharp;
  float sheen = sqrt(max(1.0 - along * along, 0.0));

  float facing = dot(n, l);
  float lit = smoothstep(-0.10, 0.35, facing) * open * power;
  float hollow = mix(0.3, 1.0, smoothstep(0.0, 1.0, h));

  vec3 indigo = vec3(0.012, 0.009, 0.090);
  vec3 plum = vec3(0.150, 0.020, 0.160);
  vec3 pale = vec3(0.550, 0.400, 0.800);
  vec3 col = indigo * (0.035 * hollow + 0.9 * lit * max(facing, 0.0));
  col += plum * lit * pow(sheen, 40.0) * 0.6;
  col += pale * lit * pow(sheen, 220.0) * 0.4 * (1.0 + 0.5 * streak * sharp);

  // The one warm light: a low slit from the other side, which only the top of this one fold stands tall enough to
  // catch, and the little bloom around it.
  float x = (c.x - folds[1].x) / 0.07;
  float caught = exp(-x * x) * smoothstep(0.5, 0.9, h) * (0.45 + 0.55 * smoothstep(-0.6, 0.8, sin(c.y * 1.9 + turn(t, 6.0))));
  float warmAlong = dot(thread, normalize(vec3(0.3, -0.9, 0.25) + vec3(0.0, 0.0, 1.0))) + streak * 0.02;
  float warm = sqrt(max(1.0 - warmAlong * warmAlong, 0.0));
  col += vec3(1.00, 0.45, 0.24) * caught * (pow(warm, 240.0) * 0.8 + pow(warm, 12.0) * 0.03);

  vec2 q = p / vec2(0.5 * uAspect, 0.5);
  col *= 1.0 - 0.18 * dot(q, q);
  col = pow(1.0 - exp(-col * 1.2), vec3(1.0 / 2.2));

  // Film grain, fixed in place so it never flickers; it also keeps the long dark slopes from showing 8-bit steps.
  col += (grain(floor(p * 2400.0)) - 0.5) * (0.008 + 0.035 * col.b);
  return clamp(col, 0.0, 1.0);
}
`,
} satisfies Painting;
