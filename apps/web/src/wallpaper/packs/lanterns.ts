import type { Pack } from "../swarm.ts";

// A festival night from the riverbank: paper lanterns let go one after another, climbing slowly with the flame
// showing through, each lighting the ones beside it. A click is a breath of wind: they swing away from it and
// go on up.
const TOP = [".aaa.", "aaaaa"];
const FOOT = ["abbba", "abcba", "rrcrr"];

export default {
  id: "lanterns",
  name: "Lanterns",
  ground: "#0a0e1c",
  glyphs: "*+=~^oO0'",
  count: 34,
  spark: "#ffe8a0",
  kinds: [
    {
      speed: 1.5,
      beat: 3,
      wander: 0.5,
      home: -Math.PI / 2,
      flee: 4,
      lit: "bc",
      frames: [
        [...TOP, "aabaa", "abbba", ...FOOT],
        [...TOP, "aaaaa", "aabaa", ...FOOT],
        [...TOP, "aabaa", "abbba", ...FOOT],
        [...TOP, "abbba", "abbba", ...FOOT],
      ],
      coats: [
        { a: "#e8782c", b: "#f8b84c", c: "#fff0b0", r: "#7c4420" },
        { a: "#d8482c", b: "#f08a3c", c: "#ffe8a0", r: "#74301c" },
        { a: "#e89a2c", b: "#fcd060", c: "#fff8d0", r: "#7c5420" },
        { a: "#d8588c", b: "#f0989c", c: "#ffe8d8", r: "#74304c" },
      ],
    },
  ],
} satisfies Pack;
