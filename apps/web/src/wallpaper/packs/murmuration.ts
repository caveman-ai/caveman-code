import type { Pack } from "../swarm.ts";

// Starlings over the reed beds at dusk: one flock that is never one shape, folding through itself. A click is a
// falcon: the flock opens round it and closes again behind.
export default {
  id: "murmuration",
  name: "Murmuration",
  ground: "#0c1318",
  glyphs: "vV^<>.'`-~",
  count: 130,
  spark: "#c8d4e4",
  kinds: [
    {
      speed: 11,
      beat: 7,
      wander: 0.5,
      flock: 1,
      flee: 2.6,
      frames: [
        ["a...a", ".aaa.", "..a.."],
        [".....", "aaaaa", "..a.."],
        [".....", ".aaa.", "a.a.a"],
        [".....", "aaaaa", "..a.."],
      ],
      coats: [{ a: "#c8d4e4" }, { a: "#a4b4cc" }, { a: "#8898b4" }, { a: "#dcd4c4" }],
    },
  ],
} satisfies Pack;
