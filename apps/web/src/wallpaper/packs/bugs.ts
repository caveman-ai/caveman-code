import type { Pack } from "../swarm.ts";

// What lives in the code: beetles, ladybirds and ants going about on squared paper, seen from above, keeping to
// its lines. A click is the light coming on: they scurry.
export default {
  id: "bugs",
  name: "Bugs",
  ground: "#0b110d",
  glyphs: "{}[]();=<>/!?",
  count: 26,
  spark: "#b8f0c8",
  kinds: [
    {
      // A beetle.
      share: 3,
      turns: "square",
      bare: { l: "'", n: "." },
      speed: 3.4,
      beat: 9,
      wander: 1.5,
      flee: 6,
      frames: [
        [
          ".l...l.....",
          "..l..l..l.n",
          "..aaaabbl.n",
          ".aaaaabbhh.",
          ".ddddddbhh.",
          ".aaaaabbhh.",
          "..aaaabbl.n",
          "..l..l..l.n",
          ".l...l.....",
        ],
        [
          "...l..l....",
          "..l..l.l..n",
          "..aaaabbl.n",
          ".aaaaabbhh.",
          ".ddddddbhh.",
          ".aaaaabbhh.",
          "..aaaabbl.n",
          "..l..l.l..n",
          "...l..l....",
        ],
      ],
      coats: [
        { a: "#3fae7c", b: "#2c8660", d: "#1e5c44", h: "#24382e", l: "#587060", n: "#587060" },
        { a: "#4a7ad0", b: "#365ca4", d: "#284478", h: "#222c40", l: "#58688c", n: "#58688c" },
        { a: "#a060c8", b: "#7c489c", d: "#583470", h: "#30243c", l: "#786088", n: "#786088" },
        { a: "#d0a040", b: "#a47c2c", d: "#785a20", h: "#3c3020", l: "#8c7c58", n: "#8c7c58" },
      ],
    },
    {
      // A ladybird.
      share: 3,
      turns: "square",
      bare: { l: "'" },
      speed: 2.6,
      beat: 8,
      wander: 1.7,
      flee: 6,
      frames: [
        [".l..l....", "..aaaa.l.", ".asaasah.", ".aaaaadhh", ".asaasah.", "..aaaa.l.", ".l..l...."],
        ["..l..l...", "..aaaa.l.", ".asaasah.", ".aaaaadhh", ".asaasah.", "..aaaa.l.", "..l..l..."],
      ],
      coats: [
        { a: "#dc3c2c", s: "#241c1c", d: "#a82c20", h: "#241c1c", l: "#6c5c58" },
        { a: "#f08a2c", s: "#241c1c", d: "#c06a1c", h: "#241c1c", l: "#6c5c58" },
        { a: "#f0c83c", s: "#241c1c", d: "#c09c28", h: "#241c1c", l: "#6c5c58" },
      ],
    },
    {
      // An ant.
      share: 5,
      turns: "square",
      bare: { l: "'", n: "." },
      speed: 5,
      beat: 12,
      wander: 2,
      flock: 0.15,
      flee: 5,
      frames: [
        [
          "..l..l.l..",
          "...l.l.l.n",
          ".aa.bb.hh.",
          "aaaabbbhh.",
          ".aa.bb.hh.",
          "...l.l.l.n",
          "..l..l.l..",
        ],
        [
          "...l.l..l.",
          "...l.l.l.n",
          ".aa.bb.hh.",
          "aaaabbbhh.",
          ".aa.bb.hh.",
          "...l.l.l.n",
          "...l.l..l.",
        ],
      ],
      coats: [
        { a: "#b4502c", b: "#8c3c20", h: "#b4502c", l: "#7c5444", n: "#7c5444" },
        { a: "#786c64", b: "#5c544c", h: "#786c64", l: "#5c544c", n: "#5c544c" },
      ],
    },
  ],
} satisfies Pack;
