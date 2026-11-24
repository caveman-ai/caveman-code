import type { Pack } from "../swarm.ts";

// The wall of hands: prints and stencils in red and yellow ochre and chalk coming up out of the rock and going
// back into it, as if the cave were remembering them. A click leaves yours.
export default {
  id: "hands",
  name: "Hands",
  ground: "#120e0c",
  glyphs: ".:'*+#%",
  count: 9,
  spark: "#c98a3c",
  click: { spawn: 1, kind: 0 },
  kinds: [
    {
      // A print: the palm pressed on the rock.
      share: 3,
      speed: 0,
      life: [18, 40],
      frames: [
        [
          "....a.a....",
          "..a.a.a.a..",
          "..a.a.a.a..",
          "..a.a.a.a..",
          "..a.a.a.a..",
          "a.a.a.a.a..",
          "a.aaaaaaa..",
          "aaaaaaaaa..",
          ".aaaaaaaa..",
          "..aaaaaaa..",
          "..aaaaaaa..",
          "...aaaaa...",
        ],
      ],
      coats: [{ a: "#b0401c" }, { a: "#c98a3c" }, { a: "#d9c6a0" }, { a: "#8f3418" }],
    },
    {
      // A stencil: pigment blown round a hand held to the wall.
      share: 2,
      speed: 0,
      life: [22, 46],
      frames: [
        [
          "....c.bcb.c.c....",
          "..c.cbababcb.c...",
          ".c.bababababcb.c.",
          "..cba.a.a.a.abc..",
          ".c.ba.a.a.a.ab.c.",
          "..cba.a.a.a.abc..",
          ".cbba.a.a.a.ab.c.",
          "cba.a.a.a.a.abc..",
          ".ba.a.......ab.c.",
          "cba.........abc..",
          ".cba........ab.c.",
          "..cba.......abc..",
          ".c.cba.....abc.c.",
          "..c.cbaaaaabc.c..",
          "...c.cbbbbbc.c...",
          ".....c.c.c.c.....",
        ],
      ],
      coats: [
        { a: "#b0401c", b: "#7a2c14", c: "#451a0e" },
        { a: "#c98a3c", b: "#8a5c26", c: "#4e3416" },
        { a: "#d9c6a0", b: "#8f8268", c: "#4c4538" },
      ],
    },
    {
      // The signs between the hands: a spiral.
      share: 1,
      speed: 0,
      life: [16, 34],
      frames: [
        [
          "..aaaaa..",
          ".a.....a.",
          "a..aaa..a",
          "a.a...a.a",
          "a.a.a.a.a",
          "a.a.aa..a",
          "a.a....a.",
          "a..aaaa..",
          ".a.......",
        ],
      ],
      coats: [{ a: "#c98a3c" }, { a: "#d9c6a0" }],
    },
  ],
} satisfies Pack;
