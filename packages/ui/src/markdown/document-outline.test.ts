import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { unified } from "unified";
import { afterEach, expect, test, vi } from "vitest";
import { Markdown, markdownOutline } from "./Markdown";
import { MarkdownDocument } from "./MarkdownDocument";

afterEach(() => vi.restoreAllMocks());
const countParses = () => vi.spyOn(Object.getPrototypeOf(unified), "parse");
const render = (source: string) => renderToStaticMarkup(createElement(MarkdownDocument, { source }));

test("a cold document shares its heading parse with the outline, including references, alerts and duplicate slugs", () => {
  const body = [
    "# Shared cold document", "", "## Install [guide][docs] ![diagram](./diagram.png)", "",
    "## Install guide diagram", "", "> [!NOTE]", "> Read this.", ">", "> ### Quoted *heading*", "",
    "Café & *friends*", "---", "", "```md", "# not a heading", "```", "",
    "<div>", "# not an HTML heading", "</div>", "", "- [ ] first task", "", "[docs]: ./guide.md",
  ].join("\n");
  const parse = countParses();
  const html = render(`---\ntitle: Cold document\n---\n${body}`);
  expect(parse).toHaveBeenCalledTimes(1);
  const outline = markdownOutline(body);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(outline.map((h) => h.id)).toEqual([
    "md-shared-cold-document", "md-install-guide-diagram", "md-install-guide-diagram-1", "md-quoted-heading", "md-café--friends",
  ]);
  expect([...html.matchAll(/<h[1-6][^>]* id="([^"]+)"/g)].map((m) => m[1])).toEqual(outline.map((h) => h.id));
  expect(html).toContain('aria-label="Outline, 5 sections"');
  expect(html).toContain('href="./guide.md"');
  expect(html).toContain('data-task="0"');
});

test("changed and revisited documents get their own matching outlines without another parse", () => {
  const parse = countParses();
  const first = "# Shared changing document\n\n## Before";
  const next = first.replace("Before", "After");
  expect(render(first)).toContain('id="md-before"');
  expect(render(next)).toContain('id="md-after"');
  expect(render(first)).not.toContain('id="md-after"');
  // The bodies still parse on each mount; no additional outline parses or syntax trees are cached.
  expect(parse).toHaveBeenCalledTimes(3);
  expect(markdownOutline(next).at(-1)?.id).toBe("md-after");
  expect(markdownOutline(first).at(-1)?.id).toBe("md-before");
  expect(parse).toHaveBeenCalledTimes(3);
});

// Renders a 550 KB document: 2 to 4.4 s on CI runners, over vitest's 5 s default once on Windows.
test("an oversized source uses the independent outline fallback without evicting a small rendered outline", { timeout: 30_000 }, () => {
  const small = "# Kept rendered outline\n\n## Section";
  render(small);
  const parse = countParses();
  const huge = "# Oversized cold document\n\n## Section\n\n" + "word ".repeat(110_000);
  expect(render(huge)).toContain('aria-label="Outline, 2 sections"');
  expect(parse).toHaveBeenCalledTimes(2);
  markdownOutline(small);
  expect(parse).toHaveBeenCalledTimes(2);
});

test("outlines published by rendering obey the existing entry limit and recency policy", () => {
  const source = (i: number) => `# Rendered outline limit ${i}`;
  for (let i = 0; i < 32; i++) render(source(i));
  const parse = countParses();
  markdownOutline(source(0));
  expect(parse).not.toHaveBeenCalled();
  render(source(32));
  markdownOutline(source(0));
  expect(parse).toHaveBeenCalledTimes(1);
  markdownOutline(source(1));
  expect(parse).toHaveBeenCalledTimes(2);
});

test("hosted and streaming Markdown keep their own pipelines and do not cache partial document outlines", () => {
  const parse = countParses();
  const hosted = "# Hosted outline boundary\n\n[link](javascript:alert(1))";
  const html = renderToStaticMarkup(createElement(Markdown, { source: hosted, hosted: { breaks: true }, cacheOutline: true }));
  expect(html).not.toContain('href="javascript:');
  const afterHosted = parse.mock.calls.length;
  markdownOutline(hosted);
  expect(parse).toHaveBeenCalledTimes(afterHosted + 1);
  const streaming = "# Partial outline boundary\n\n## Later";
  renderToStaticMarkup(createElement(Markdown, { source: streaming, streaming: true, cacheOutline: true }));
  const afterStream = parse.mock.calls.length;
  markdownOutline(streaming);
  expect(parse).toHaveBeenCalledTimes(afterStream + 1);
});
