import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { closedFence, Response, splitBlocks } from "./response.tsx";

const html = (md: string, hideImages = true) => renderToStaticMarkup(<Response hideImages={hideImages}>{md}</Response>);

test("hideImages: the strip's images leave the text, with the paragraphs and bullets that only held them", () => {
  const out = html(["Proof:", "", "![wide](/Users/me/My App (Dev)/wide.png)", "", "- ![phone](</tmp/a b.png>)", "- ![dark](/tmp/dark.png)", "", "After ![inline](/tmp/i.png) text."].join("\n"));
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<ul");
  expect(out).not.toContain("<li");
  expect(out).toContain("<p");
  expect(out).toContain("Proof:");
  expect(out).toContain("After  text.");
});

test("hideImages: while a live reply fades in, the bullets and paragraphs that only held strip images leave too", () => {
  // revealOnMount={false}: the text already here shows whole, so the fade is the only difference from a finished reply.
  const live = (md: string) => renderToStaticMarkup(<Response paced streaming revealOnMount={false} hideImages>{md}</Response>);
  const list = live(["Screenshots:", "- ![before](/tmp/shots/before.png)", "- ![after](/tmp/shots/after.png)", "", "Both screens match the mockup."].join("\n"));
  expect(list).toContain("word-fading");
  expect(list).not.toContain("<img");
  expect(list).not.toContain("<ul");
  expect(list).not.toContain("<li");
  const paragraph = live(["Proof:", "", "![wide](/tmp/wide.png)", "", "That is the new [header](https://x.dev)."].join("\n"));
  expect(paragraph.match(/<p/g)).toHaveLength(2);
});

test("hideImages: an image the strip can't see stays in the text", () => {
  // A reference image (its definition in the same block; splitBlocks parses blocks apart).
  const out = html(["[shot]: /tmp/ref.png", "![ref][shot]"].join("\n"));
  expect(out).toContain('src="/tmp/ref.png"');
});

test("without hideImages every image draws", () => {
  expect(html("![wide](/tmp/wide.png)", false)).toContain('src="/tmp/wide.png"');
});

test("a streaming mermaid fence draws once its closing fence arrives (T3 #18308)", () => {
  const open = "Here:\n\n```mermaid\ngraph TD\n  A-->B";
  const streamed = (md: string) => renderToStaticMarkup(<Response streaming>{md}</Response>);
  expect(streamed(open)).not.toContain('data-slot="mermaid"');
  expect(streamed(open)).toContain("graph TD");
  // Closed (closedFence below) or finished, it draws: that needs a DOM, so the browser check covers it.
});

test("closedFence: only a real closer, of the opener's kind and length, closes", () => {
  const fence = (text: string, code: string) => closedFence({ position: { start: { offset: 0 }, end: { offset: text.length } } }, text, code);
  expect(fence("```mermaid\na\n```", "a")).toBe(true);
  expect(fence("````mermaid\na\n```", "a")).toBe(false);
  expect(fence("~~~mermaid\na\n```", "a")).toBe(false);
  expect(fence("```mermaid\na\n```b", "a\n```b")).toBe(false);
  expect(fence("```mermaid\na\r", "a")).toBe(false);
  expect(closedFence(undefined, "```\na\n```", "a")).toBe(false);
});

test("a Windows path keeps its backslashes; an escape outside a path still escapes", () => {
  const out = html(String.raw`Saved to C:\Users\me\.t3\_build and \*this\*.`, false);
  expect(out).toContain(String.raw`C:\Users\me\.t3\_build`);
  expect(out).toContain("*this*.");
});

test("an image alone on its line under a label keeps its line; an inline badge stays inline", () => {
  const own = html("**Palette**\n![Palette](/tmp/palette.png)\n**Hero**", false);
  expect(own).toMatch(/Palette<\/strong><br\/>\s*<img[^>]*palette\.png[^>]*\/><br\/>\s*<strong/);
  const inline = html("Built [![CI](/ci.svg)](/ci)\nand wrapped", false);
  expect(inline).not.toContain("<br");
});

test("audio and video play in place through the host, other files are their chip, and none join the strip (T3 #21363)", () => {
  const out = renderToStaticMarkup(
    <Response hideImages media={(src, kind) => <span data-media={kind}>{src}</span>} inlineCode={(text) => <span data-chip>{text}</span>}>
      {"Listen: ![take](/tmp/take.mp3)\n\n![demo](/tmp/demo.mp4)\n\n![report](out/report.pdf)\n\n![shot](/tmp/shot.png)"}
    </Response>,
  );
  expect(out).toContain(`<span data-media="audio">/tmp/take.mp3</span>`);
  expect(out).toContain(`<span data-media="video">/tmp/demo.mp4</span>`);
  expect(out).toContain(`<span data-chip="true">out/report.pdf</span>`);
  expect(out).not.toContain("shot.png");
  // Without a host, a web address still plays.
  expect(html("![t](https://example.com/t.mp3)", false)).toContain(`<audio controls="" preload="metadata" src="https://example.com/t.mp3"`);
});

test("a file `![]()` names reaches the host as the answer wrote it, not as the renderer percent-encodes it", () => {
  const md = "![spec](C:\\docs\\spec.pdf)\n\n![notes](<docs/my notes.pdf>)";
  // The host's file chip reads it as a link's destination; without one, a code span's chip gets its path.
  const named = renderToStaticMarkup(<Response hideImages file={(path) => <span data-file>{path}</span>} inlineCode={(text) => <span data-chip>{text}</span>}>{md}</Response>);
  expect(named).toContain(`<span data-file="true">C:\\docs\\spec.pdf</span>`);
  expect(named).toContain(`<span data-file="true">docs/my notes.pdf</span>`);
  expect(named).not.toContain("data-chip");
  const code = renderToStaticMarkup(<Response hideImages inlineCode={(text) => <span data-chip>{text}</span>}>{md}</Response>);
  expect(code).toContain(`<span data-chip="true">C:\\docs\\spec.pdf</span>`);
  // With neither, its path shows as written.
  expect(html("![](C:\\docs\\spec.pdf)")).toContain(">C:\\docs\\spec.pdf</span>");
});

test("a fence line indented four spaces past its opener is code: the block stays whole and the prose after it stays prose", () => {
  const readme = ["Here is your README:", "", "```markdown", "# Tool", "", "1. Install:", "", "    ```bash", "    npm i tool", "    ```", "", "## Usage", "", "Run it.", "```", "", "Done."].join("\n");
  expect(splitBlocks(readme).map((b) => b.text)).toEqual(["Here is your README:\n", readme.split("\n").slice(2, 16).join("\n"), "Done."]);
  const out = renderToStaticMarkup(<Response>{readme}</Response>);
  expect(out).not.toContain("<h2");
  expect(out).toMatch(/<p[^>]*>Done\.<\/p>/);
  const template = ["```python", 'PROMPT = """', "Reply as:", "    ```json", '    {"ok": true}', "    ```", '"""', "", "def main():", "    pass", "```", "", "Done."].join("\n");
  expect(splitBlocks(template).map((b) => b.offset)).toEqual([0, 12]);
  // A fence opened inside a list item still closes at its own indent.
  expect(splitBlocks("1. Install:\n\n    ```bash\n    npm i\n    ```\n\nDone.").map((b) => b.offset)).toEqual([0, 6]);
});

test("an image line the reply draws as code stays as written and out of the strip; the image after the fence goes to it", () => {
  const readme = ["Here is your README:", "", "```markdown", "1. Install:", "", "    ```bash", "    npm i tool", "    ```", "", "![Demo](docs/my demo.png)", "```", "", "![After](/tmp/after.png)"].join("\n");
  const out = html(readme);
  expect(out).toContain("![Demo](docs/my demo.png)");
  expect(out).not.toContain("after.png");
});

// Whitespace between top-level blocks collapses in the rendered reply.
const whole = (md: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>).replace(/>\s+</g, "><").trim();

test.each([
  "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
  "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter",
 // An indented fence in a list item that the item's end closes; the ``` after it opens a fence of its own (upstream #28285).
  "- a\n\n  ```\n  x\n\n```\n\nb",
  "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
])("each streamed block draws as the whole reply does, at every prefix: %j", (text) => {
  for (let end = 0; end <= text.length; end++) {
    const source = text.slice(0, end);
    const blocks = splitBlocks(source);
    expect(blocks.map((b) => b.text).join("\n")).toBe(source);
    expect(blocks.map((b) => whole(b.text)).join("")).toBe(whole(source));
  }
});

test("a bare URL keeps its trailing underscores and tildes (T3 #27794)", () => {
  const out = html("See https://example.com/docs/a_b__ and https://example.com/~user~ now.");
  expect(out).toContain('href="https://example.com/docs/a_b__"');
  expect(out).toContain('href="https://example.com/~user~"');
  // A written link is left alone.
  expect(html("[docs](https://example.com/x)_")).toContain('href="https://example.com/x"');
});
