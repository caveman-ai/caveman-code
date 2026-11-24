import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Response } from "./response";
import { closeInline, stableStreamingTail } from "./streaming-markdown";

const render = (md: string, streaming: boolean) => renderToStaticMarkup(createElement(Response, { streaming, children: md }));
const BLOCK_TAGS = /<(p|ul|ol|li|h[1-6]|table|thead|tbody|tr|th|td|blockquote|pre|hr)[\s>]/g;
const blockTags = (html: string) => [...html.matchAll(BLOCK_TAGS)].map((m) => m[1]);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
// What the reader sees: the text without tags, buttons' labels left out (a code block's Copy), whitespace collapsed.
const visible = (html: string) =>
  html
    .replace(/<button[\s\S]*?<\/button>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[#a-z0-9]+;/g, (e) => ENTITIES[e] ?? e)
    // A code block's header counts its lines as they arrive.
    .replace(/\b\d+ lines?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const DOCS = {
  prose: [
    "I'll look at the **repository layout** first, then the `README.md` and the [design docs](docs/).",
    "",
    "## What it is",
    "",
    "Caveman Code is a *desktop app* with a ~~web~~ local runtime. It has:",
    "",
    "- an Electron shell (`apps/desktop`)",
    "- a React client in **apps/web**",
    "  - nested: the transcript",
    "1. first step",
    "2. second step with `code` and **bold _mixed_ text**",
    "",
    "> A quote about snake_case_names and 2 * 3 = 6.",
    "",
    "Done.",
  ].join("\n"),
  code: [
    "Here is the flow:",
    "",
    "```ts",
    "export function title(text: string) {",
    "  return text.slice(0, 40); // `trim` **not** markdown",
    "}",
    "```",
    "",
    "And after the fence, a final line with a [link](https://example.com/a_b).",
  ].join("\n"),
  mixed: [
    "**Locating the title flow**",
    "",
    "Titles come from `generateTitle()`:",
    "1. The runtime asks a small model",
    "   ```ts",
    "   await title(text)",
    "   ```",
    "2. The web shows it",
    "",
    "### Notes",
    "Bold across a **soft",
    "break** and *nested **strong** text* end.",
    "",
    "- [x] done item",
    "- [ ] open item with ![img](a.png) inside",
  ].join("\n"),
  labels: [
    "It is the main bet.",
    "",
    "**What lives here.**",
    "- `apps/desktop`: the Electron shell",
    "- **Runtime**: one server per computer",
    "1. `pnpm dev` starts it",
  ].join("\n"),
  table: [
    "| File | Role |",
    "| --- | :--: |",
    "| `titles.ts` | makes the **title** |",
    "| `chat.ts` | calls it |",
    "",
    "That's the table.",
  ].join("\n"),
};

describe("a streaming reply never reshapes", () => {
  it.each(Object.entries(DOCS))("%s: every prefix draws as the start of the finished reply", (_name, doc) => {
    const finalHtml = render(doc, false);
    const finalTags = blockTags(finalHtml);
    const finalText = visible(finalHtml);
    for (let n = 1; n <= doc.length; n++) {
      const html = render(doc.slice(0, n), true);
      const text = visible(html);
      // No marker drawn as text that the finished reply draws as markup (a literal "**", a pipe row, a "-").
      expect(finalText.startsWith(text), `prefix ${n}: ${JSON.stringify(doc.slice(0, n))}\n  draws ${JSON.stringify(text)}`).toBe(true);
      // No block that turns into another kind (a paragraph into a list, a table or a heading).
      const tags = blockTags(html);
      expect(finalTags.slice(0, tags.length), `prefix ${n}: ${JSON.stringify(doc.slice(0, n))}`).toEqual(tags);
    }
  }, 60_000);

  it("draws the finished reply exactly as it is", () => {
    // React's own ids (a code block's useId) follow the component tree, which blocks deepen; the DOM is the same.
    const ids = (html: string) => html.replace(/_R_[0-9a-z]+_/g, "_R_");
    for (const doc of Object.values(DOCS)) expect(ids(render(doc, true))).toBe(ids(render(doc, false).replace('data-slot="response"', 'data-slot="response" data-streaming="true"')));
  });
});

describe("stableStreamingTail", () => {
  it("shows a first word at once", () => {
    expect(stableStreamingTail("Ok")).toBe("Ok");
    expect(stableStreamingTail("I'll loo")).toBe("I'll loo");
  });

  it("holds a line that is only a block marker so far", () => {
    for (const marker of ["-", "- ", "1", "1.", "##", "```ts", "|", "| --- |", ">", "**", "- `", "1. **"]) {
      expect(stableStreamingTail(`Intro\n\n${marker}`)).toBe("Intro\n\n");
    }
  });

  it("shows an open fence as the code so far, and holds what may be its closing fence", () => {
    expect(stableStreamingTail("```ts\nconst a = 1;\nconst b")).toBe("```ts\nconst a = 1;\nconst b");
    expect(stableStreamingTail("```ts\nconst a = 1;\n``")).toBe("```ts\nconst a = 1;\n");
  });

  it("holds a table until its delimiter row is whole, then grows it a row at a time", () => {
    expect(stableStreamingTail("Intro\n\n| a | b |\n| --")).toBe("Intro\n");
    expect(stableStreamingTail("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |")).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("closes the emphasis, code and links the unfinished paragraph opened", () => {
    expect(closeInline("the **impor")).toBe("the **impor**");
    expect(closeInline("a *b **c")).toBe("a *b **c***");
    expect(closeInline("run `make te")).toBe("run `make te`");
    expect(closeInline("see **")).toBe("see ");
    expect(closeInline("see [the do")).toBe("see the do");
    expect(closeInline("see [the docs](https://exa")).toBe("see the docs");
    expect(closeInline("2 * 3 and snake_case_name")).toBe("2 * 3 and snake_case_name");
    expect(closeInline("~~old")).toBe("~~old~~");
    expect(closeInline("**done** and `x`")).toBe("**done** and `x`");
  });
});
