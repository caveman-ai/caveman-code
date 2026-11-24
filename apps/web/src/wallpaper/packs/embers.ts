import type { Pack } from "../swarm.ts";

// Looking up from the fire: sparks climbing off it into the dark, cooling as they go. A click strikes the flint:
// a burst of them from where it landed.
export default {
  id: "embers",
  name: "Embers",
  ground: "#100b09",
  glyphs: "*+^'.:!",
  count: 110,
  spark: "#ffd27a",
  click: { spawn: 22 },
  kinds: [
    {
      share: 3,
      speed: 6,
      wander: 2.2,
      home: -Math.PI / 2,
      flee: 4,
      life: [4, 12],
      born: "below",
      lit: "a",
      frames: [["a"]],
      coats: [{ a: "#ffd27a" }, { a: "#ff9a3c" }, { a: "#f0642a" }, { a: "#c8401c" }],
    },
    {
      // One that came off bigger: a bright heart and its two cooler ends.
      share: 1,
      speed: 4.6,
      wander: 1.6,
      home: -Math.PI / 2,
      flee: 4,
      life: [5, 13],
      born: "below",
      lit: "ab",
      solid: false,
      frames: [[".b.", "bab", ".b."]],
      coats: [
        { a: "#fff0c0", b: "#ff9a3c" },
        { a: "#ffd27a", b: "#f0642a" },
      ],
    },
    {
      // What a click throws.
      share: 0,
      speed: 5,
      wander: 2.6,
      home: -Math.PI / 2,
      flee: 6,
      life: [1.6, 4.4],
      lit: "a",
      frames: [["a"]],
      coats: [{ a: "#fff0c0" }, { a: "#ffd27a" }, { a: "#ff9a3c" }],
    },
  ],
} satisfies Pack;
