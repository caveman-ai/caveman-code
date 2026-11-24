import type { Pack } from "../swarm.ts";

// The bath, from one end: rubber ducks, the kind a bug gets explained to, paddling across in no hurry. A click is
// a splash: they make off as fast as a rubber duck can.
const DUCK = [
  "......aaaa..",
  ".....aaaaaa.",
  ".....aaeaaoo",
  ".....aaaaaoo",
  "a.....aaaa..",
  "aa..aaaaaa..",
  "aaaaaahhaaa.",
  "aaaaahhhaaa.",
  ".aaaaaaaaa..",
];

export default {
  id: "ducks",
  name: "Ducks",
  ground: "#081620",
  glyphs: "?!;{}()=~oO",
  count: 15,
  spark: "#9cd4f0",
  kinds: [
    {
      speed: 1.8,
      beat: 2.4,
      wander: 0.35,
      home: 0,
      flee: 4.5,
      bare: { w: "~" },
      frames: [
        [...DUCK, "w.wwwwwww.w.", "............"],
        [...DUCK, ".wwwwwwwww..", "w.........w."],
      ],
      coats: [
        { a: "#f8cc3c", h: "#e0a82c", o: "#f07c2c", e: "#241c14", w: "#4c88a8" },
        { a: "#f8cc3c", h: "#e0a82c", o: "#e85c2c", e: "#241c14", w: "#4c88a8" },
        { a: "#f4dc6c", h: "#dcb844", o: "#f07c2c", e: "#241c14", w: "#4c88a8" },
      ],
    },
  ],
} satisfies Pack;
