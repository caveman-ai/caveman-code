// web_fetch's page reader (page-worker.ts, a child process): a fetched body as markdown and a title. HTML goes
// through Defuddle on linkedom (main content only, no third-party calls), Turndown when Defuddle finds nothing; PDFs
// through unpdf; JSON, XML and text as they are. Apart from pages.ts, so the runtime, which only reads and indexes
// the markdown, loads none of these parsers (Caveman Cloud the spec addendum 2026-10-24).
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { getDocumentProxy } from "unpdf";

import type { BodyKind } from "./fetchPage.ts";
import type { Page } from "./pages.ts";

/** Defuddle's async extractors call third-party APIs (YouTube transcripts, oEmbed); `useAsync: false` keeps them off and this catches any other. */
const noNetwork: typeof fetch = () => Promise.reject(new Error("web_fetch's extraction makes no requests"));

const decode = (body: Uint8Array, charset: string | undefined) => {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
};

const firstHeading = (markdown: string) => /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1]?.trim();

const turndown = () => {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "form", "nav", "footer", "img"] as never);
  return service;
};

async function htmlPage(url: string, html: string): Promise<Page> {
  const { document } = parseHTML(html);
  const htmlTitle = document.querySelector("title")?.textContent?.trim() ?? "";
  let markdown = "";
  let title = htmlTitle;
  try {
    const result = await Defuddle(document as unknown as Document, url, { markdown: true, useAsync: false, fetch: noNetwork, removeImages: true });
    markdown = result.content.trim();
    title = result.title?.trim() || htmlTitle;
  } catch {
    // Turndown below.
  }
  if (markdown === "") {
    const { document: fresh } = parseHTML(html);
    markdown = turndown().turndown((fresh.body?.innerHTML ?? html) as string).trim();
  }
  return { url, title: title || firstHeading(markdown) || url, markdown: tidyMarkdown(markdown) };
}

/** A PDF's first pages only: past that, the reader's memory goes on pages nobody asked for. */
export const MAX_PDF_PAGES = 100;

async function pdfPage(url: string, body: Uint8Array): Promise<Page> {
  const pdf = await getDocumentProxy(new Uint8Array(body), { useSystemFonts: false, disableFontFace: true, stopAtErrors: false, verbosity: 0 });
  try {
    // One page at a time (unpdf's extractText reads them all at once), as extractText joins a page's text.
    const text: Array<string> = [];
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PDF_PAGES); n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      text.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join(""));
      page.cleanup();
    }
    const info = (await pdf.getMetadata().catch(() => undefined))?.info as { Title?: unknown } | undefined;
    // A heading per page, so the outline points at pages.
    const pages = text.map((page, i) => `## Page ${i + 1}\n\n${page.trim()}`);
    if (pdf.numPages > MAX_PDF_PAGES) pages.push(`(The PDF has ${pdf.numPages.toLocaleString("en-US")} pages; web_fetch read the first ${MAX_PDF_PAGES}.)`);
    const markdown = pages.join("\n\n");
    const title = typeof info?.Title === "string" && info.Title.trim() !== "" ? info.Title.trim() : (decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || url);
    return { url, title, markdown: tidyMarkdown(markdown) };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

const tidyMarkdown = (markdown: string) =>
  markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export interface PageInput {
  readonly url: string;
  readonly bodyKind: BodyKind;
  readonly charset: string | undefined;
  readonly body: Uint8Array;
}

/** The page's markdown and title from a fetched body (in a page reader process, pageProcess.ts). */
export async function toPage(input: PageInput): Promise<Page> {
  if (input.bodyKind === "pdf") return pdfPage(input.url, input.body);
  const text = decode(input.body, input.charset);
  if (input.bodyKind === "html") return htmlPage(input.url, text);
  const markdown = input.bodyKind === "markdown" || input.bodyKind === "text" ? tidyMarkdown(text) : text.trim();
  const title = (input.bodyKind === "markdown" ? firstHeading(markdown) : undefined) ?? (new URL(input.url).pathname.split("/").pop() || input.url);
  return { url: input.url, title, markdown };
}
