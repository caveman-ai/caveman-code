import type { Pack } from "../swarm.ts";

// The steppe on a winter night: woolly mammoths and their calves walking east through falling snow, the far ones
// small and faint. A click is a spear landing: the herd wheels away from it, then finds its way east again.
const BODY = [
  "...............hhhh.....",
  "........hhhh.hhhaaaa....",
  ".....hhhaaaaaaaaaaaaa...",
  "...haaaaaaaaaaaaaaeaa...",
  "..aaaaaaaaaaaaaaaaaaaa..",
  ".aaaaaaaaaaaaaaaaaaaaa..",
  ".aaaaaaaaaaaaaaaaaaaaa..",
  "taaaaaaaaaaaaaaaawaaaa..",
  "t.aaaaaaaaaaaaaaa.waaa.w",
  "t.aaaadaadadaaaaa..waa.w",
];
const CALF = [
  "........hhhh..",
  "....hhhhaaaaa.",
  "..haaaaaaaaea.",
  ".aaaaaaaaaaaa.",
  "taaaaaaaaaaaa.",
  "t.aaaaaaaa.aa.",
];

export default {
  id: "mammoths",
  name: "Mammoths",
  ground: "#0b111f",
  glyphs: "#%&@mMwWnN^",
  count: 50,
  spark: "#e8eefc",
  kinds: [
    {
      share: 5,
      speed: 1.6,
      beat: 2.2,
      wander: 0.12,
      home: 0,
      flee: 5,
      frames: [
        [
          ...BODY,
          "..aaaaddd..ddaaaa...wwww",
          "..aaaaddd..ddaaaa...aa..",
          "..aaaa.dd..ddaaaa...aa..",
          "..aaaa.dd..ddaaaa...aa..",
          "..aaaa.dd..ddaaaa..aa...",
          "..dddd.dd..dddddd.......",
        ],
        [
          ...BODY,
          "..ddaaaa...aaaadd...wwww",
          "..ddaaaa...aaaadd...aa..",
          "..dd.aaaa..aaaa.dd..aa..",
          "..dd.aaaa..aaaa.dd..aa..",
          "..dd.aaaa..aaaa.dd.aa...",
          "..dd.dddd..dddd.dd......",
        ],
      ],
      coats: [
        { a: "#8c5b3b", h: "#a87450", d: "#5f3d28", w: "#f0e7d2", e: "#2a1a12", t: "#5f3d28" },
        { a: "#7a5238", h: "#94694a", d: "#523625", w: "#f0e7d2", e: "#2a1a12", t: "#523625" },
        { a: "#9a6a44", h: "#b8855a", d: "#6b4830", w: "#f0e7d2", e: "#2a1a12", t: "#6b4830" },
      ],
    },
    {
      share: 3,
      speed: 1.9,
      beat: 3.2,
      wander: 0.2,
      home: 0,
      flee: 5,
      frames: [
        [...CALF, "..aaaddaaa.aa.", "..aaa.d.aaa.a.", "..aaa.d.aaa.aa", "..ddd.d.ddd..."],
        [...CALF, "..daaa.aaad.a.", "..d.aaaaa.d.a.", "..d.aa.aa.d.aa", "..d.dd.dd.d..."],
      ],
      coats: [
        { a: "#9a6a44", h: "#b8855a", d: "#6b4830", e: "#2a1a12", t: "#6b4830" },
        { a: "#a87850", h: "#c4946a", d: "#74503a", e: "#2a1a12", t: "#74503a" },
      ],
    },
    {
      // Snow. It falls the height of the page and comes round again at the top, so it snows everywhere.
      share: 42,
      speed: 2.6,
      wander: 1.4,
      home: Math.PI / 2,
      flee: 6,
      // A flake is its character and nothing else.
      bare: { a: "*+." },
      frames: [["a"]],
      coats: [{ a: "#e8eefc" }, { a: "#b9c6e4" }, { a: "#8fa0c8" }],
    },
  ],
} satisfies Pack;
