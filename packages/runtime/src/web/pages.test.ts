// What web_fetch makes of a page: a docs page's main content as markdown (no navigation, no third-party calls),
// a markdown answer as is, a PDF's text page by page; then a small page whole, a large one as its outline and the
// passages BM25 picks, read on with offset, all within the engine's inline limit.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { pdfOf, textPage } from "./fixtures/pdf.ts";
import { MAX_RESULT_BYTES } from "./inline.ts";
import { bm25, chunksOf, indexPage, linksIn, outlineOf, viewPage, WHOLE_PAGE_CHARS, type Page } from "./pages.ts";
import { MAX_PDF_PAGES, toPage } from "./pageText.ts";

const DOCS_HTML = `<!doctype html>
<html><head><title>fs | Node docs</title></head>
<body>
  <nav><a href="/">Home</a> <a href="/api/">Index</a> Navigation menu entries</nav>
  <header>Site header banner</header>
  <main><article>
    <h1>File system</h1>
    <p>The <code>node:fs</code> module enables interacting with the file system in a way modeled on standard POSIX functions.</p>
    <h2>Promise example</h2>
    <p>Promise-based operations return a promise that is fulfilled when the asynchronous operation is complete. See <a href="https://nodejs.org/api/fs.html#promises-api">the promises API</a>.</p>
    <pre><code class="language-js">import { unlink } from 'node:fs/promises';
await unlink('/tmp/hello');</code></pre>
    <h2>Callback example</h2>
    <p>The callback form takes a completion callback function as its last argument and invokes the operation asynchronously.</p>
  </article></main>
  <footer>Copyright footer text</footer>
  <script>window.tracking = true;</script>
</body></html>`;

const encode = (text: string) => new TextEncoder().encode(text);

describe("toPage", () => {
  it("reads an HTML docs page's main content as markdown, keeping its links and title", async () => {
    const page = await toPage({ url: "https://nodejs.org/api/fs.html", bodyKind: "html", charset: undefined, body: encode(DOCS_HTML) });
    expect(page.title).toMatch(/Node docs/);
    expect(page.markdown).toMatch(/## Promise example/);
    expect(page.markdown).toMatch(/```(js)?\nimport \{ unlink \} from 'node:fs\/promises';/);
    expect(page.markdown).not.toMatch(/Navigation menu|Copyright footer|tracking/);
    // Only links the markdown shows: none from the navigation.
    expect(linksIn(page.markdown, page.url)).toEqual(["https://nodejs.org/api/fs.html"]);
  });

  it("finds the links text shows: markdown targets resolved against the page, bare URLs, in order and once each", () => {
    const text = `See [api](/api#x), [rel](other.md "Other") and https://bare.example.org/y. Again [api](https://docs.example.com/api); not ftp://x.example. Long: https://l.example.com/${"a".repeat(2_000)}`;
    expect(linksIn(text, "https://docs.example.com/guide/index.md")).toEqual([
      "https://docs.example.com/api",
      "https://docs.example.com/guide/other.md",
      "https://bare.example.org/y",
    ]);
  });

  it("falls back to Turndown when Defuddle finds no content", async () => {
    const page = await toPage({ url: "https://example.com/x", bodyKind: "html", charset: undefined, body: encode("<html><body><h3>Only</h3><p>tiny</p></body></html>") });
    expect(page.markdown).toMatch(/Only/);
    expect(page.markdown).toMatch(/tiny/);
  });

  it("keeps a markdown answer as it came, titled by its first heading", async () => {
    const md = "# Guide\n\nRead [the API](https://docs.example.com/api).\n\n\n\n## Next\n\nMore.";
    const page = await toPage({ url: "https://docs.example.com/guide.md", bodyKind: "markdown", charset: "utf-8", body: encode(md) });
    expect(page).toEqual({ url: "https://docs.example.com/guide.md", title: "Guide", markdown: "# Guide\n\nRead [the API](https://docs.example.com/api).\n\n## Next\n\nMore." });
  });

  it("reads a PDF's text page by page, with its title and the links in it", async () => {
    const body = new Uint8Array(readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)));
    const page = await toPage({ url: "https://example.com/sample.pdf", bodyKind: "pdf", charset: undefined, body });
    expect(page.title).toBe("Web tools sample");
    expect(page.markdown).toMatch(/^## Page 1\n\nCaveman web fetch reads PDFs through unpdf\./);
    expect(page.markdown).toMatch(/## Page 2\n\nSecond page: see https:\/\/example\.com\/pdf-link for more\./);
    expect(linksIn(page.markdown, page.url)).toEqual(["https://example.com/pdf-link"]);
  });

  it(`reads a PDF's first ${MAX_PDF_PAGES} pages and says how many it has`, async () => {
    const body = await pdfOf(Array.from({ length: MAX_PDF_PAGES + 5 }, (_, i) => textPage(`Text of page ${i + 1}`)));
    const page = await toPage({ url: "https://example.com/long.pdf", bodyKind: "pdf", charset: undefined, body });
    expect(page.markdown).toMatch(new RegExp(`## Page ${MAX_PDF_PAGES}\n\nText of page ${MAX_PDF_PAGES}\n`));
    expect(page.markdown).not.toMatch(/Text of page 101/);
    expect(page.markdown.endsWith(`(The PDF has ${MAX_PDF_PAGES + 5} pages; web_fetch read the first ${MAX_PDF_PAGES}.)`)).toBe(true);
  });
});

const section = (title: string, words: string, n: number) => `## ${title}\n\n${Array.from({ length: n }, (_, i) => `${words} sentence ${i}.`).join(" ")}\n`;
const LARGE: Page = {
  url: "https://docs.example.com/big",
  title: "Big",
  markdown: [
    "# Big reference",
    section("Install", "Install the package with your package manager", 60),
    section("Configuration", "Configure retries and timeouts in the config file", 60),
    "```sh\n# not a heading\nnpm i\n```",
    section("Streaming", "Stream responses with backpressure and cancellation tokens", 60),
    section("Errors", "Errors carry a code and a retry hint for the caller", 60),
  ].join("\n\n"),
};

describe("outline, chunks and BM25", () => {
  it("lists ATX headings outside code fences, with their offsets", () => {
    const outline = outlineOf(LARGE.markdown);
    expect(outline.map((h) => [h.level, h.text])).toEqual([
      [1, "Big reference"],
      [2, "Install"],
      [2, "Configuration"],
      [2, "Streaming"],
      [2, "Errors"],
    ]);
    for (const h of outline) expect(LARGE.markdown.slice(h.offset)).toMatch(new RegExp(`^#+ ${h.text}`));
  });

  it("scores the chunk about the question highest", () => {
    const index = indexPage(LARGE.markdown);
    expect(index.chunks.every((c) => c.end - c.offset <= 1_600)).toBe(true);
    const scores = [...bm25(index, "how do I cancel a stream?")];
    const best = index.chunks[scores.indexOf(Math.max(...scores))]!;
    expect(best.path).toBe("Big reference › Streaming");
    expect([...bm25(index, "the a of")]).toEqual(index.chunks.map(() => 0));
  });

  it("indexes a page of 20,000 sections in one pass, and a read of it scores only the question's terms", () => {
    const sections = (n: number) => Array.from({ length: n }, (_, i) => `## 第${i}節 設定\n\n${"漢字の文章です。設定の説明があります。".repeat(14)}`).join("\n\n");
    // The fastest of three runs, so a busy shared runner's pause doesn't count.
    const fastest = (run: () => unknown) => Math.min(...[0, 1, 2].map(() => { const started = performance.now(); run(); return performance.now() - started; }));
    const md = sections(20_000);
    const small = sections(2_000);
    expect(chunksOf(md, outlineOf(md))).toHaveLength(20_000);
    // One walk grows with the page (about 10x for 10x the sections); finding each section's heading by search grew
    // with its square (200 ms here for 20,000). A ratio holds on any machine where a wall-clock bound does not.
    const growth = fastest(() => chunksOf(md, outlineOf(md))) / fastest(() => chunksOf(small, outlineOf(small)));
    // Measured 11-20x; the search grew about 100x.
    expect(growth).toBeLessThan(50);
    const page: Page = { url: "u", title: "t", markdown: md, index: indexPage(md) };
    const view = viewPage(page, { question: "設定 説明" });
    expect(view.text).toMatch(/passages? matching "設定 説明"/);
    expect(fastest(() => viewPage(page, { question: "設定 説明" }))).toBeLessThan(100);
  });
});

describe("viewPage", () => {
  it("returns a small page whole", () => {
    const small: Page = { url: "u", title: "t", markdown: "# Hi\n\nshort" };
    expect(viewPage(small, {})).toEqual({ text: "# Hi\n\nshort" });
  });

  it("returns a large page's outline and the passages that match the question, with their offsets", () => {
    expect(LARGE.markdown.length).toBeGreaterThan(WHOLE_PAGE_CHARS);
    const view = viewPage(LARGE, { question: "retry hint error code" });
    expect(view.text).toMatch(/^\d[\d,]* characters · \d+ passages? matching "retry hint error code"/);
    expect(view.text).toMatch(/Outline:\n- Big reference \(offset 0\)\n {2}- Install \(offset \d+\)/);
    const offset = Number(/\[offset (\d+) · Big reference › Errors\]/.exec(view.text)?.[1]);
    expect(LARGE.markdown.slice(offset)).toMatch(/^## Errors|^Errors carry/);
    expect(view.text).not.toMatch(/Install the package with your package manager sentence 1\./);
  });

  it("reads on from an offset, saying where the next read starts", () => {
    const first = viewPage(LARGE, {});
    expect(first.next).toBeGreaterThan(0);
    const next = viewPage(LARGE, { offset: first.next });
    expect(next.text).toContain(LARGE.markdown.slice(first.next!, first.next! + 200));
    const end = viewPage(LARGE, { offset: LARGE.markdown.length - 10 });
    expect(end.text).toMatch(/the end/);
    expect(end.next).toBeUndefined();
  });

  it("stays within the engine's inline limit for text of three bytes a character", () => {
    const wide: Page = { url: "u", title: "t", markdown: Array.from({ length: 400 }, (_, i) => `## 第${i}節\n\n${"漢字の文章です。".repeat(40)}`).join("\n\n") };
    for (const view of [viewPage(wide, {}), viewPage(wide, { question: "文章" }), viewPage(wide, { offset: 5_000 })]) {
      expect(Buffer.byteLength(JSON.stringify(view.text))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    }
  });

  it("cuts the smallest view when nothing else fits", () => {
    const view = viewPage(LARGE, { question: "install ".repeat(4_000) });
    expect(Buffer.byteLength(JSON.stringify(view.text))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(view.text.endsWith("…")).toBe(true);
  });
});
