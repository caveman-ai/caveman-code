import type { Painting } from "../paintings.ts";

// The brand's own scene as a telephoto photograph at blue hour: ridges stacked by haze, mist pooled in the valleys,
// a volcano beyond them with a thin plume, the last afterglow low to one side. First painted as a woodblock print
// in the line of Hokusai and Hasui; the composition is still that printmaker's, the light is a camera's.
export default {
  id: "dusk",
  name: "Dusk",
  light: 0.1,
  moves: true,
  glsl: /* glsl */ `
// Linear light; the picture is encoded once, at the end.
const vec3 ZENITH = vec3(0.0035, 0.0028, 0.0075);
const vec3 BLUE = vec3(0.035, 0.034, 0.115);
const vec3 MAUVE = vec3(0.22, 0.085, 0.14);
const vec3 AMBER = vec3(0.95, 0.38, 0.06);
const vec3 GROUND = vec3(0.0022, 0.002, 0.004);

// Every speed is a whole number of turns an hour, so the hour's wrap shows no seam.
const float TURN = 6.2831853 / 3600.0;
const float HORIZON = -0.255;

float wisp(vec2 p) {
  return 0.57 * vnoise(p) + 0.29 * vnoise(p * 2.03 + 7.1) + 0.14 * vnoise(p * 4.1 + 3.3);
}

float stroke(vec2 p, vec2 a, vec2 b) {
  vec2 along = b - a;
  return length(p - a - along * clamp(dot(p - a, along) / dot(along, along), 0.0, 1.0));
}

// A skyline, 0 to about 1.5: the first octave folded about its middle, which gives summits and round saddles.
float ridgeLine(float x, float seed) {
  float fold = 2.0 * vnoise(vec2(x, seed)) - 1.0;
  float h = 0.6 * (1.0 - sqrt(fold * fold + 0.012));
  h += 0.5 * vnoise(vec2(x * 0.37 + 3.1, seed + 9.0));
  h += 0.22 * vnoise(vec2(x * 2.3 + 1.7, seed + 17.0));
  h += 0.1 * vnoise(vec2(x * 5.1 + 4.2, seed + 31.0));
  h += 0.045 * vnoise(vec2(x * 11.7, seed + 47.0));
  return h;
}

float treeLine(float x) {
  float u = x / 0.0042;
  float a = hash21(vec2(floor(u), 2.7)) * (1.0 - abs(2.0 * fract(u) - 1.0));
  u = u * 0.77 + 0.5;
  float b = hash21(vec2(floor(u), 8.1)) * (1.0 - abs(2.0 * fract(u) - 1.0));
  return max(a, b);
}

vec3 paint(vec2 p, float t) {
  float glowAt = -0.27 * uAspect;
  float coneAt = 0.17 * uAspect;
  float side = exp(-pow((p.x - glowAt) / (0.26 + 0.16 * uAspect), 2.0));
  // What the haze between here and there adds: the low sky's own light, warmer toward where the sun went down.
  vec3 air = BLUE * 0.55 + MAUVE * 0.35 * side + AMBER * 0.1 * side * side;

  vec3 col = vec3(0.0);
  float open = 1.0;

  // Four times an hour something small and leathery glides home across the afterglow.
  float trip = fract(t / 900.0 + 0.5) / 0.09;
  if (trip < 1.0) {
    vec2 q = (p - vec2(glowAt + mix(0.34, -0.3, trip), HORIZON + 0.07 - 0.012 * trip + 0.006 * sin(trip * 5.0))) / 0.011;
    float beat = sin(t * 1.1);
    vec2 arm = vec2(abs(q.x), q.y);
    vec2 wrist = vec2(0.45, 0.3 + 0.12 * beat);
    float flier = min(stroke(arm, vec2(0.0), wrist), stroke(arm, wrist, vec2(1.0, 0.16 + 0.4 * beat))) - mix(0.1, 0.02, min(arm.x, 1.0));
    flier = min(flier, stroke(q, vec2(0.3, 0.14), vec2(-0.6, -0.1)) - 0.045);
    float seen = 0.8 * (1.0 - smoothstep(-0.02, 0.14, flier)) * smoothstep(0.0, 0.1, trip) * (1.0 - smoothstep(0.9, 1.0, trip));
    col += GROUND * seen;
    open *= 1.0 - seen;
  }

  if (p.y < HORIZON + 0.06) {
    for (int i = 4; i >= 0; i--) {
      float k = float(i);
      float near = k / 4.0;
      float low = -0.262 - 0.04 * k - 0.004 * k * k;
      float rise = 0.022 + 0.008 * k;
      float crest = low + rise * ridgeLine(p.x * (3.4 - 0.45 * k) + 19.0 * k, 5.0 * k + 1.0);
      if (i >= 3) crest += (i == 4 ? 0.007 : 0.003) * treeLine(p.x * (i == 4 ? 1.0 : 1.9) + k);
      float soft = mix(0.0026, 0.0014, near);
      float cover = smoothstep(-soft, soft, crest - p.y);
      if (cover > 0.0) {
        float drift = t * TURN * (2.0 + mod(k, 2.0)) + 1.7 * k;
        float x = p.x + (0.5 + 0.12 * k) * sin(drift);
        float level = low + rise * (0.45 + 0.55 * vnoise(vec2(x * 1.3 + 4.0 * k, 3.0 * k + 0.7 * cos(drift))));
        float fray = wisp(vec2(x * 5.0 + 9.0 * k, p.y * 34.0 - 5.0 * k + 0.5 * cos(drift)));
        float pool = smoothstep(-0.012, 0.03, level - p.y + 0.03 * (fray - 0.5));
        float lay = vnoise(vec2(p.x * 17.0 + 3.0 * k, (crest - p.y) * 55.0 + 11.0 * k));
        float fog = mix(0.84, 0.07, pow(near, 0.75)) + 0.07 * (lay - 0.5);
        fog = 1.0 - (1.0 - clamp(fog, 0.0, 1.0)) * (1.0 - 0.9 * pool);
        col += open * cover * mix(GROUND, air * (1.0 + 0.3 * pool), fog);
        open *= 1.0 - cover;
        if (open < 0.002) break;
      }
    }
  }

  if (open > 0.002) {
    float dx = p.x - coneAt;
    float flank = max(abs(dx) - 0.012, 0.0);
    float top = HORIZON + 0.158 * exp(-flank / (dx < 0.0 ? 0.115 : 0.15))
      + 0.012 * (wisp(vec2(dx * 16.0 + 40.0, 2.0)) - 0.5) * (1.0 - exp(-flank / 0.05))
      + 0.003 * (vnoise(vec2(dx * 90.0, 7.0)) - 0.5)
      - 0.0045 * (1.0 - smoothstep(0.003, 0.012, abs(dx)));
    vec2 mouth = vec2(coneAt + 0.001, HORIZON + 0.153);

    // The plume: up out of the mouth, then over with the wind, widening and thinning as it goes.
    vec2 wind = normalize(vec2(0.86, 0.5));
    float u = dot(p - mouth, wind);
    float v = dot(p - mouth, vec2(-wind.y, wind.x));
    if (u > -0.004 && u < 0.3) {
      float reach = max(u, 0.0);
      float cycle = t / 120.0;
      float first = 1.0 - abs(2.0 * fract(cycle) - 1.0);
      float width = 0.0026 + 0.1 * reach;
      float bend = 0.011 * (1.0 - exp(-reach / 0.01)) - 0.7 * reach * reach
        + 0.1 * reach * (vnoise(vec2(reach * 16.0 - 0.6 * sin(t * TURN * 30.0), 3.0)) - 0.5);
      float across = (v - bend) / width;
      // Two copies of the billows, each sliding along the plume and swapped while it is faded out: the flow never
      // has to run backwards to loop.
      float billow = first * wisp(vec2(reach * 46.0 - 5.0 * fract(cycle), across * 1.1 + 2.0))
        + (1.0 - first) * wisp(vec2(reach * 46.0 - 5.0 * fract(cycle + 0.5), across * 1.1 + 39.0));
      billow = (billow - 0.5) / sqrt(first * first + (1.0 - first) * (1.0 - first)) + 0.5;
      float smoke = exp(-1.4 * across * across) * smoothstep(-0.003, 0.004, u) * exp(-reach / 0.065) * (0.35 + 1.1 * billow);
      smoke = clamp(0.75 * smoke, 0.0, 0.85);
      float ember = 0.8 + 0.2 * sin(t * TURN * 45.0);
      vec3 lit = air * 1.5 + BLUE * 0.25 + MAUVE * 0.12 * side * (0.5 - 0.5 * clamp(across, -1.0, 1.0)) + AMBER * 0.5 * ember * exp(-reach / 0.01);
      col += open * smoke * lit;
      open *= 1.0 - smoke;
    }

    float cover = smoothstep(-0.0018, 0.0018, top - p.y);
    if (cover > 0.0) {
      float lift = clamp((p.y - HORIZON) / 0.158, 0.0, 1.0);
      float gully = vnoise(vec2(dx / (0.03 + HORIZON + 0.16 - p.y) * 7.0, 1.0));
      float fog = mix(0.93, 0.4, smoothstep(0.0, 1.0, lift)) + 0.09 * (gully - 0.5) * lift;
      vec3 rock = mix(GROUND, air, fog) + (MAUVE * 0.035 + AMBER * 0.006) * (1.0 - fog) * (1.0 - smoothstep(-0.2, 0.02, dx));
      col += open * cover * rock;
      open *= 1.0 - cover;
    }

    float h = max(p.y - HORIZON, 0.0);
    vec3 sky = ZENITH + BLUE * exp(-h / 0.26) * (0.55 + 0.45 * side)
      + MAUVE * 0.9 * side * exp(-h / 0.085)
      + AMBER * pow(side, 1.5) * exp(-h / 0.032)
      + vec3(1.0, 0.62, 0.2) * 0.6 * side * side * side * exp(-h / 0.012);

    float bank = wisp(vec2(p.x * 1.1 + 0.25 * sin(t * TURN * 2.0) + 3.0, h * 30.0 + 0.2 * p.x));
    float cloud = smoothstep(0.52, 0.74, bank) * smoothstep(0.012, 0.03, h) * (1.0 - smoothstep(0.05, 0.1, h));
    sky = mix(sky, sky * 0.35 + air * 0.25, 0.75 * cloud);

    vec2 grid = p / 0.03;
    vec2 cell = floor(grid);
    if (hash21(cell + 0.5) > 0.86) {
      vec2 at = cell + 0.2 + 0.6 * vec2(hash21(cell + 1.7), hash21(cell + 5.3));
      float d = length(grid - at) * 0.03;
      float twinkle = 0.85 + 0.15 * sin(t * TURN * 300.0 + 40.0 * hash21(cell + 3.1));
      sky += vec3(0.8, 0.85, 1.0) * (0.012 + 0.3 * pow(hash21(cell + 9.1), 6.0)) * twinkle * exp(-d * d / 0.0000008) * smoothstep(0.22, 0.6, h);
    }
    col += open * sky;
  }

  // The lens: a little of the afterglow spilt over what stands in front of it, and darker corners.
  float spill = exp(-pow((p.x - glowAt) / (0.2 + 0.1 * uAspect), 2.0)) * exp(-pow((p.y - HORIZON - 0.03) / 0.07, 2.0));
  col += AMBER * 0.03 * spill;
  vec2 corner = p / vec2(0.5 * uAspect, 0.5);
  col *= 1.0 - 0.11 * dot(corner, corner);

  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  return col + (hash21(p * 917.0) + hash21(p * 613.0 + 4.7) - 1.0) * 0.012;
}
`,
} satisfies Painting;
