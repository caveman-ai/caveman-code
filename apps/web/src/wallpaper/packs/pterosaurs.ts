import type { Pack } from "../swarm.ts";

// Last light over the valley: pteranodons crossing it on slow wings, crest back, beak into the wind. A click is a
// rock off the cliff: they bank away from it.
const HEAD = [
  ".......ccc.................",
  ".........cccbbb............",
  "............bebkkkk........",
  "............bbb............",
];
const UP = [
  "...........................",
  "w.........................w",
  "ww.....ccc...............ww",
  "www......cccbbb.........www",
  ".wwww.......bebkkkk...wwww.",
  "..wwwww.....bbb.....wwwww..",
  "...wwwwwww.aaaaa.wwwwwww...",
  ".....wwwwwwaaaaawwwwww.....",
  ".......w.wwaaaaaww.w.......",
  "............aaa............",
  "...........l...l...........",
];
const LEVEL = [
  "...........................",
  "...........................",
  ...HEAD,
  "wwwwwwwww..aaaaa..wwwwwwwww",
  ".wwwwwwwwwwaaaaawwwwwwwwww.",
  "...ww.ww.wwaaaaaww.ww.ww...",
  "............aaa............",
  "...........l...l...........",
];
const DOWN = [
  "...........................",
  "...........................",
  ...HEAD,
  "........wwwaaaaawww........",
  "....wwwwwwwaaaaawwwwwww....",
  "..wwwwwww.waaaaaw.wwwwwww..",
  ".wwww.w.....aaa.....w.wwww.",
  "ww.........l...l.........ww",
];

export default {
  id: "pterosaurs",
  name: "Pterosaurs",
  ground: "#120e1a",
  glyphs: "<>^vV/\\|~-=",
  count: 12,
  spark: "#e8d8b0",
  kinds: [
    {
      speed: 6.5,
      beat: 3,
      wander: 0.4,
      flock: 0.25,
      flee: 3,
      frames: [UP, LEVEL, DOWN, LEVEL],
      coats: [
        {
          a: "#a87048",
          w: "#d09c64",
          b: "#a87048",
          c: "#d86838",
          k: "#e8d8b0",
          e: "#1a100c",
          l: "#885430",
        },
        {
          a: "#84667a",
          w: "#b08ea0",
          b: "#84667a",
          c: "#d8a038",
          k: "#e8d8b0",
          e: "#1a100c",
          l: "#644a5a",
        },
        {
          a: "#647880",
          w: "#90a8b0",
          b: "#647880",
          c: "#d05c4c",
          k: "#e8d8b0",
          e: "#1a100c",
          l: "#485860",
        },
      ],
    },
  ],
} satisfies Pack;
