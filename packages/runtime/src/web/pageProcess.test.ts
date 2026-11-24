// The page readers: real ones turn a page into markdown in a child process and are killed with their memory when a
// page balloons (a PDF bomb); scripted ones show the timers: a page's time starts when its reading does, a reader
// that stops reporting is killed, and killing one reader touches no other page.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pdfBomb } from "./fixtures/pdf.ts";
import { makePageParser, MAX_RSS_BYTES, type PageParser } from "./pageProcess.ts";

const parsers: Array<PageParser> = [];
const track = (parser: PageParser) => (parsers.push(parser), parser);
afterEach(() => {
  for (const parser of parsers.splice(0)) parser.close();
});

const input = (url: string, body = new Uint8Array()) => ({ url, bodyKind: "html" as const, charset: undefined, body });
const html = (heading: string) =>
  new TextEncoder().encode(`<html><head><title>T</title></head><body><main><h1>File system</h1><h2>${heading}</h2><p>Words about the file system here.</p></main></body></html>`);
const settled = <A>(promise: Promise<A>) =>
  promise.then(
    (page) => ({ page }),
    (error: Error) => ({ error: error.message }),
  );

describe("a real reader", () => {
  it("reads a page in a child process", async () => {
    const parser = track(makePageParser());
    const page = await parser.parse(input("https://nodejs.org/api/fs.html", html("Callback example")));
    expect(page.markdown).toMatch(/## Callback example/);
  });

  it(`is killed above ${MAX_RSS_BYTES / 1024 / 1024} MB, the runtime's memory untouched, and the next page gets a fresh one`, async () => {
    const body = await pdfBomb(1_200);
    expect(body.length).toBeLessThan(1.5 * 1024 * 1024);
    const parser = track(makePageParser());
    const before = process.memoryUsage.rss();
    let peak = before;
    const watch = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 20);
    const out = await settled(parser.parse({ url: "https://example.com/bomb.pdf", bodyKind: "pdf", charset: undefined, body }));
    clearInterval(watch);
    expect(out).toEqual({ error: "it needed more than 512 MB of memory to read" });
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
    const page = await parser.parse(input("https://example.com/after", html("Still reading pages")));
    expect(page.markdown).toMatch(/## Still reading pages/);
  }, 30_000);
});

// A reader that speaks the protocol: "slow:<ms>" answers after ms, "mute" stops reporting and never answers,
// "hang" keeps reporting and never answers.
const scripted = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "page-reader-"));
  const file = path.join(dir, "reader.mjs");
  writeFileSync(
    file,
    `import { writeSync } from "node:fs";
    let reporting = setInterval(() => { try { writeSync(4, process.memoryUsage.rss() + "\\n"); } catch {} }, 50);
    process.on("message", async ({ input }) => {
      const [kind, ms] = input.url.split(":");
      if (kind === "mute") return clearInterval(reporting);
      if (kind === "hang") return;
      await new Promise((resolve) => setTimeout(resolve, Number(ms)));
      process.send({ page: { url: input.url, title: input.url, markdown: "read " + input.url } });
    });
    process.on("disconnect", () => process.exit(0));`,
  );
  return file;
})();

describe("the readers' timers", () => {
  it("starts a page's time when its reading starts, not while it waits for a reader", async () => {
    const parser = track(makePageParser({ entry: scripted, size: 1, timeoutMs: 1_000 }));
    const [first, second] = await Promise.all([settled(parser.parse(input("slow:700"))), settled(parser.parse(input("slow:700")))]);
    expect(first).toMatchObject({ page: { markdown: "read slow:700" } });
    expect(second).toMatchObject({ page: { markdown: "read slow:700" } });
  });

  it("reads two pages at once", async () => {
    const parser = track(makePageParser({ entry: scripted }));
    const started = Date.now();
    await Promise.all([parser.parse(input("slow:600")), parser.parse(input("slow:600"))]);
    expect(Date.now() - started).toBeLessThan(1_150);
  });

  it("kills a reader that stops reporting", async () => {
    const parser = track(makePageParser({ entry: scripted, missedMs: 600 }));
    expect(await settled(parser.parse(input("mute")))).toEqual({ error: "the page reader stopped responding" });
  });

  it("kills only the reader whose page ran out of time", async () => {
    const parser = track(makePageParser({ entry: scripted, timeoutMs: 800 }));
    const hung = settled(parser.parse(input("hang")));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const other = settled(parser.parse(input("slow:600")));
    expect(await hung).toEqual({ error: "the page took longer than 0.8 s to read" });
    expect(await other).toMatchObject({ page: { markdown: "read slow:600" } });
  });

  it("refuses waiting and in-flight pages when closed", async () => {
    const parser = makePageParser({ entry: scripted, size: 1 });
    const reading = settled(parser.parse(input("slow:5000")));
    const waiting = settled(parser.parse(input("slow:10")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    parser.close();
    expect(await reading).toEqual({ error: "web_fetch is shutting down" });
    expect(await waiting).toEqual({ error: "web_fetch is shutting down" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(await settled(parser.parse(input("slow:10")))).toEqual({ error: "web_fetch is shutting down" });
  });
});
