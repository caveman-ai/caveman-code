// A step's log links what it names: addresses, files in the chat's folder, and HTML pages anywhere.
import { expect, test } from "vitest";
import { logLinks } from "./log-links.ts";

const root = "/Users/me/repo";
const links = (text: string) => logLinks(text, root).filter((p) => typeof p !== "string");

test("a server's address links, without the punctuation or the bracket around it", () => {
  expect(links("  ➜  Local:   http://localhost:5173/")).toEqual([{ text: "http://localhost:5173/", url: "http://localhost:5173/" }]);
  expect(links("(see https://example.com/a?b=1&c=2).")).toEqual([{ text: "https://example.com/a?b=1&c=2", url: "https://example.com/a?b=1&c=2" }]);
  expect(links("https://en.wikipedia.org/wiki/Foo_(bar), next")).toEqual([{ text: "https://en.wikipedia.org/wiki/Foo_(bar)", url: "https://en.wikipedia.org/wiki/Foo_(bar)" }]);
});

test("files in the chat's folder link at their line; a stack frame's file:// path too", () => {
  expect(links("FAIL src/retry.test.ts:12:5 expected 2")).toEqual([{ text: "src/retry.test.ts:12:5", file: { path: "src/retry.test.ts", line: 12 } }]);
  expect(links("    at run (/Users/me/repo/lib/a.js:3:1)")).toEqual([{ text: "/Users/me/repo/lib/a.js:3:1", file: { path: "lib/a.js", line: 3 } }]);
  expect(links("at file:///Users/me/repo/lib/b.mjs:7:2")).toEqual([{ text: "file:///Users/me/repo/lib/b.mjs:7:2", file: { path: "lib/b.mjs", line: 7 } }]);
  // A file URL is decoded once: a name holding an encoded % ("report%20final.mjs") opens by that name.
  expect(links("at file:///Users/me/repo/lib/report%2520final.mjs:7:2")).toEqual([{ text: "file:///Users/me/repo/lib/report%2520final.mjs:7:2", file: { path: "lib/report%20final.mjs", line: 7 } }]);
  expect(links("wrote --out=dist/report.html.")).toEqual([{ text: "dist/report.html", file: { path: "dist/report.html" } }]);
});

test("an HTML page links anywhere; any other file outside the folder does not", () => {
  expect(links("Saved /tmp/proof/page.html")).toEqual([{ text: "/tmp/proof/page.html", file: { path: "/tmp/proof/page.html" } }]);
  expect(links("cat /etc/hosts.conf")).toEqual([]);
});

test("folders, versions, host names and bare words stay text", () => {
  expect(links("cd /Users/me/repo/src && node v20.11.1 on example.com, done.")).toEqual([]);
  expect(links("ok 3 tests (1.2s)")).toEqual([]);
});

test("the pieces put back together are the text", () => {
  const text = "Local: http://localhost:3000/ and src/a.ts:4.\nnext";
  expect(logLinks(text, root).map((p) => (typeof p === "string" ? p : p.text)).join("")).toBe(text);
  expect(logLinks("", root)).toEqual([""]);
});
