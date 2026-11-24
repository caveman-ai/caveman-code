import type { Pack } from "../swarm.ts";

// A pond at night from the bridge: koi in the coats a keeper breeds for, schooling loosely under the surface, each
// with its tail going. A click is a pebble.
const LEFT = [
  "tt.................",
  "ttt......ff........",
  ".ttt......faaaa....",
  "..tttaabbbaaaaccc..",
  "....aabbbbbaaacaae.",
  ".....aaabbaaaaaaa..",
  "..........faaaa....",
  ".........ff........",
  "...................",
];
const MIDDLE = [
  "...................",
  ".........ff........",
  "t.........faaaa....",
  "tt...aabbbaaaaccc..",
  ".tttaabbbbbaaacaae.",
  "tt...aaabbaaaaaaa..",
  "t.........faaaa....",
  ".........ff........",
  "...................",
];
const RIGHT = [
  "...................",
  ".........ff........",
  "..........faaaa....",
  ".....aabbbaaaaccc..",
  "....aabbbbbaaacaae.",
  "..tttaaabbaaaaaaa..",
  ".ttt......faaaa....",
  "ttt......ff........",
  "tt.................",
];

export default {
  id: "koi",
  name: "Koi",
  ground: "#0a1320",
  glyphs: "~()<>{}oO0=",
  count: 15,
  spark: "#a8dcff",
  kinds: [
    {
      turns: true,
      speed: 4.5,
      beat: 4,
      wander: 0.7,
      flock: 0.45,
      flee: 5,
      frames: [LEFT, MIDDLE, RIGHT, MIDDLE],
      coats: [
        { a: "#f2ede2", b: "#e5482c", c: "#e5482c", f: "#c9c4ba", t: "#f2ede2", e: "#f7a892" },
        { a: "#f2ede2", b: "#e5482c", c: "#30323a", f: "#c9c4ba", t: "#e5482c", e: "#f2ede2" },
        { a: "#f0b43a", b: "#f8d978", c: "#f0b43a", f: "#d99a2b", t: "#e9a02c", e: "#f8d978" },
        { a: "#ec6a3c", b: "#f2ede2", c: "#ec6a3c", f: "#d9562c", t: "#ec6a3c", e: "#f7a892" },
        { a: "#f2ede2", b: "#30323a", c: "#f2ede2", f: "#c9c4ba", t: "#30323a", e: "#f2ede2" },
      ],
    },
  ],
} satisfies Pack;
