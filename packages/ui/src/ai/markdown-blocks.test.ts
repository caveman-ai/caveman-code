import { expect, test } from "vitest";
import { createMarkdownBlocks, openMathLine } from "./markdown-blocks";

const finished = (md: string) => createMarkdownBlocks()(md, false);

/** Feeds `md` to one splitter `step` characters at a time, as a stream does; each call's blocks with its prefix. */
function stream(md: string, step: number) {
  const split = createMarkdownBlocks();
  const calls: Array<{ prefix: string; blocks: ReturnType<typeof finished> }> = [];
  for (let at = step; at < md.length; at += step)
    calls.push({ prefix: md.slice(0, at), blocks: split(md.slice(0, at), true) });
  calls.push({ prefix: md, blocks: split(md, false) });
  return calls;
}

const DOCS = [
  "Intro paragraph.\n\n## Heading\n\n- one\n- two\n\n  continued\n- three\n\nAfter the list.\n",
  "Para\n#not a heading\nstill para\n\n# Heading\n\n> quote\ncontinued lazily\n\n---\n\nEnd",
  "Table:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nThen code:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n    indented\n\n    code\n\nDone.",
  "1. first\n\n2. second\n\n   nested para\n\n3. third\n\nPrice is $5 and $6.\n\n$$\nx^2\n\ny\n$$\n\nAfter math.",
  "Line one\n***\nLine two\n- item\n\n<div>\nhtml\n\n</div>\n\ntext",
  "Display math:\n\n\\[\na + b\n\nc\n\\]\n\nInline $$x^2$$ and \\[y\\] too.\n\n```\n$$\n```\n\nEnd.",
  "Intro:\n- - -\n- - x and more\nsetext\n===\n\n#x y is text\n# real heading\n<details>\nhidden\n</details>\n\na | b\n- | -\nc | d\n\n1. 50 items\n\nend",
];

test("at every point of a stream, the blocks are exactly the blocks of the text so far", () => {
  for (const md of DOCS)
    for (const step of [1, 3, 7])
      for (const { prefix, blocks } of stream(md, step))
        expect(blocks, `${step}: ${JSON.stringify(prefix)}`).toEqual(finished(prefix));
}, 120_000);

test("a block keeps its line while the reply grows, so it is never drawn again elsewhere", () => {
  for (const md of DOCS) {
    const final = new Map(finished(md).map((b) => [b.offset, b.text]));
    for (const { blocks } of stream(md, 2))
      // Every block but the one at the end sits where the finished reply has a block.
      for (const block of blocks.slice(0, -1))
        expect(final.has(block.offset), JSON.stringify(block)).toBe(true);
  }
}, 60_000);

test("blocks rejoin to the source, at their line offsets", () => {
  for (const md of DOCS) {
    const lines = md.split("\n");
    for (const block of finished(md))
      expect(lines.slice(block.offset).join("\n").startsWith(block.text)).toBe(true);
  }
});

test("a block that starts on the line still being written draws on its own, and folds back if the line says so", () => {
  // "#" alone is an empty heading below the paragraph; "#x" makes it one paragraph again.
  const split = createMarkdownBlocks();
  expect(split("para\n#", true)).toEqual([
    { text: "para", offset: 0 },
    { text: "#", offset: 1 },
  ]);
  expect(split("para\n#x", true)).toEqual([{ text: "para\n#x", offset: 0 }]);
  expect(split("para\n#x\n\n# Title", true)).toEqual([
    { text: "para\n#x\n", offset: 0 },
    { text: "# Title", offset: 3 },
  ]);
});

test("display math holds everything from its unclosed opener open; a closed or one-line one doesn't", () => {
  expect(openMathLine(["a", "", "$$", "x", "", "y"])).toBe(2);
  expect(openMathLine(["a", "\\[", "x", "\\]", "b"])).toBe(5);
  expect(openMathLine(["$$x^2$$", "\\[y\\]", "```", "$$", "```"])).toBe(5);
  // Unclosed, the opener's lines are paragraphs; once "$$" closes them they are one math block at the opener's line.
  const split = createMarkdownBlocks();
  expect(split("Price $5.\n\n$$\nx^2\n\ny\n", true).map((b) => b.offset)).toEqual([0, 2, 5]);
  expect(split("Price $5.\n\n$$\nx^2\n\ny\n$$\n", true)).toEqual([
    { text: "Price $5.\n", offset: 0 },
    { text: "$$\nx^2\n\ny\n$$\n", offset: 2 },
  ]);
});

test("a list with blank lines between items and a lazy line is one block", () => {
  expect(finished("- a\n\n- b\n\n  more\n\nafter").map((b) => b.text)).toEqual([
    "- a\n\n- b\n\n  more\n",
    "after",
  ]);
});

test("a definition arriving later folds the reply into one block, so its uses above resolve", () => {
  const split = createMarkdownBlocks();
  expect(split("See [d].\n\nMore.\n\n", true)).toHaveLength(2);
  // Bounds move once a line is finished; so does a definition's.
  expect(split("See [d].\n\nMore.\n\n[d]: https://x.dev\n", true)).toEqual([
    { text: "See [d].\n\nMore.\n\n[d]: https://x.dev\n", offset: 0 },
  ]);
  expect(createMarkdownBlocks()("See [d].\n\nMore.\n\n[d]: https://x.dev", false)).toHaveLength(1);
});

test("words added to a settled line extend the last block", () => {
  const split = createMarkdownBlocks();
  expect(split("One.\n\nTw", true)).toEqual([
    { text: "One.\n", offset: 0 },
    { text: "Tw", offset: 2 },
  ]);
  expect(split("One.\n\nTwo and", true)).toEqual([
    { text: "One.\n", offset: 0 },
    { text: "Two and", offset: 2 },
  ]);
  expect(split("One.\n\nTwo and three", true)).toEqual([
    { text: "One.\n", offset: 0 },
    { text: "Two and three", offset: 2 },
  ]);
});

test("text that doesn't extend the last call starts over", () => {
  const split = createMarkdownBlocks();
  split("One.\n\nTwo.\n\nThree", true);
  expect(split("Other.\n\nText", false).map((b) => b.text)).toEqual(["Other.\n", "Text"]);
});
