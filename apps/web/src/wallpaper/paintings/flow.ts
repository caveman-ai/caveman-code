import type { Painting } from "../paintings.ts";

// The default: six lights in the dusk's colours (the sprite palette's glint, tunic, pink, dino shade, night and
// slate) drifting through each other, each on its own slow loop. No two frames a minute apart look different
// enough to notice; an hour apart they are another picture.
export default {
  id: "flow",
  name: "Flow",
  light: 0.42,
  moves: true,
  glsl: /* glsl */ `
const vec3 FLOW[6] = vec3[6](
  vec3(0.996, 0.859, 0.718),
  vec3(0.922, 0.620, 0.239),
  vec3(0.855, 0.545, 0.545),
  vec3(0.341, 0.263, 0.580),
  vec3(0.051, 0.035, 0.078),
  vec3(0.596, 0.635, 0.741)
);

vec3 paint(vec2 p, float t) {
  float s = t * 0.03;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    float k = float(i);
    vec2 at = vec2(0.6 * uAspect * sin(s * (0.7 + 0.13 * k) + k * 2.4), 0.52 * cos(s * (0.9 - 0.11 * k) + k * 1.7));
    float d = length(p - at);
    // The night weighs double: more of the picture is dark than lit.
    float w = (i == 4 ? 2.0 : 1.0) / pow(d * d + 0.03, 1.5);
    sum += pow(FLOW[i], vec3(2.2)) * w;
    total += w;
  }
  return pow(sum / total, vec3(1.0 / 2.2));
}
`,
} satisfies Painting;
