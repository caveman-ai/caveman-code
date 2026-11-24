import type { Pack } from "../swarm.ts";

// Dusk at the cave mouth: the colony leaving, hundreds of wingbeats with no plan between them. A click is a
// dropped stone: they break away from it in every direction.
const UP = [
  "a.............a",
  "aa...........aa",
  "aaa..b...b..aaa",
  ".aaaabbbbbaaaa.",
  "..aaaabbbaaaa..",
  "...a..bbb..a...",
  "......b.b......",
  "...............",
];
const LEVEL = [
  "...............",
  "...............",
  ".....b...b.....",
  "aaaaabbebeaaaaa",
  "aaaaaabbbaaaaaa",
  "a..a..bbb..a..a",
  "......b.b......",
  "...............",
];
const DOWN = [
  "...............",
  "...............",
  ".....b...b.....",
  "..aaabbbbbaaa..",
  ".aaaaabbbaaaaa.",
  "aaa.a.bbb.a.aaa",
  "aa....b.b....aa",
  "a.............a",
];

export default {
  id: "bats",
  name: "Bats",
  ground: "#0e0b15",
  glyphs: "^vVwWmM<>/\\",
  count: 30,
  spark: "#c8b0e8",
  kinds: [
    {
      speed: 9,
      beat: 11,
      wander: 2.4,
      flock: 0.2,
      flee: 3,
      lit: "e",
      frames: [UP, LEVEL, DOWN, LEVEL],
      coats: [
        { a: "#7a5c8c", b: "#4c3a5c", e: "#e8c060" },
        { a: "#8c6a78", b: "#5a4250", e: "#e8c060" },
        { a: "#66608c", b: "#3e3a5c", e: "#e8c060" },
      ],
    },
  ],
} satisfies Pack;
