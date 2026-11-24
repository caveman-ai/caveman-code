import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { expect, test } from "vitest";
import { Response } from "../ai/response.tsx";
import { rehypeTextDirection } from "../ai/text-direction.ts";
import { Markdown } from "./Markdown.tsx";
import { markdownCacheSize, markdownRenderer } from "./render-cache.ts";

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`;
const REMARK = [remarkGfm];
const REHYPE = [rehypeTextDirection];
const render = markdownRenderer({
  remarkPlugins: REMARK,
  rehypePlugins: REHYPE,
  components: {},
  urlTransform,
});

test.each([
  '# Title\n\nText with `code`, **bold**, [a link](https://example.com "t") and https://bare.example.com.',
  "![shot](./shot.png) and [file](file:///C:/repo/a.ts) and [bad](javascript:alert(1))",
  "| a | b |\n| - | - |\n| x | [x](#frag) |\n\n- [ ] task\n- [x] done",
  "Footnote[^1] and ~~strike~~\n\n[^1]: the note",
])("draws what react-markdown draws, and the same element again: %j", (source) => {
  const expected = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} urlTransform={urlTransform}>
      {source}
    </ReactMarkdown>,
  );
  const element = render(source, true);
  expect(renderToStaticMarkup(element)).toBe(expected);
  expect(render(source, true)).toBe(element);
});

test("the same plugin lists share one renderer; text drawn uncached is parsed afresh", () => {
  expect(
    markdownRenderer({
      remarkPlugins: REMARK,
      rehypePlugins: REHYPE,
      components: {},
      urlTransform,
    }),
  ).toBe(render);
  const first = render("Still *growing*", false);
  expect(render("Still *growing*", false)).not.toBe(first);
});

test("keeps what it has when one block far larger than the cache is drawn", () => {
  const element = render("Kept *message*", true);
  render("x".repeat(600_000), true);
  expect(render("Kept *message*", true)).toBe(element);
});

test("a streaming reply's finished blocks are kept; its open tail is not (T3's #27823)", () => {
  const before = markdownCacheSize().entries;
  renderToStaticMarkup(
    <Response streaming>{"Finished block, unique to this test\n\nStill growing"}</Response>,
  );
  expect(markdownCacheSize().entries).toBe(before + 1);
  // Finished, the whole reply is kept (the first block a hit, the last one new).
  renderToStaticMarkup(
    <Response>{"Finished block, unique to this test\n\nStill growing"}</Response>,
  );
  expect(markdownCacheSize().entries).toBe(before + 2);
 // A pull request's comment is kept too (upstream #27808); a file tab's document keeps only its outline.
  renderToStaticMarkup(
    <Markdown source={"A **comment** unique to this test"} hosted={{ breaks: true }} />,
  );
  expect(markdownCacheSize().entries).toBe(before + 3);
  renderToStaticMarkup(<Markdown source={"# A file unique to this test"} cacheOutline />);
  expect(markdownCacheSize().entries).toBe(before + 3);
});

test("a cached block still reads its context when it draws: the same element, shown with the strip, hides its image", () => {
  const source = "![proof, unique to this test](/tmp/proof.png)";
  expect(renderToStaticMarkup(<Response>{source}</Response>)).toContain("<img");
  const before = markdownCacheSize().entries;
  expect(renderToStaticMarkup(<Response hideImages>{source}</Response>)).not.toContain("<img");
  // A hit, not a second parse.
  expect(markdownCacheSize().entries).toBe(before);
});
