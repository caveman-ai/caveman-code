import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { linkAction, Response, urlTransform } from "./response";

test("a link in an answer leaves the app only for the web and mail; a file link is held for the chat", () => {
  expect(linkAction("https://github.com/x/y/pull/1")).toBe("external");
  expect(linkAction("mailto:a@b.c")).toBe("external");
  expect(linkAction("#user-content-fn-1")).toBe("anchor");
  // A relative href would navigate the hash-routed app itself away (react-router's 404).
  expect(linkAction("retry.ts#L2")).toBe("hold");
  expect(linkAction("/Users/me/repo/retry.ts")).toBe("hold");
  expect(linkAction("file:///Users/me/repo/retry.ts")).toBe("hold");
  expect(linkAction("#")).toBe("hold");
  expect(linkAction(undefined)).toBe("hold");
});

test("file links keep their href for the click handler; unsafe schemes still lose theirs", () => {
  expect(urlTransform("file:///Users/me/repo/a.ts", "href")).toBe("file:///Users/me/repo/a.ts");
  expect(urlTransform("src/a.ts:12", "href")).toBe("src/a.ts:12");
  expect(urlTransform("javascript:alert(1)", "href")).toBe("");
  expect(urlTransform("localhost:3000", "href")).toBe("");
  expect(urlTransform("file:///etc/passwd", "src")).toBe("");
  const html = renderToStaticMarkup(createElement(Response, { children: "[web](https://x.dev) [file](retry.ts#L2)" }));
  expect(html).toContain('href="https://x.dev" target="_blank"');
  expect(html).toContain('href="retry.ts#L2"');
  expect(html).not.toContain('href="retry.ts#L2" target');
});

test("a Windows file an answer links or embeds keeps its drive path, as a POSIX path does", () => {
  for (const path of [String.raw`C:\Users\me\proj\src\app.ts`, "C:/Users/me/proj/src/app.ts", "C:%5CUsers%5Cme%5Capp.ts"]) {
    expect(urlTransform(path, "href")).toBe(path);
    expect(urlTransform(path, "src")).toBe(path);
  }
  expect(urlTransform("c:alert(1)", "href")).toBe("");
  // The renderer percent-encodes every destination, a space in a POSIX path too; the chat's chatLink and mediaRef
  // decode it (apps/web links.test.ts follows these to the file they open).
  const link = renderToStaticMarkup(createElement(Response, { children: String.raw`See [app.ts](C:\Users\me\proj\src\app.ts) and [b](</Users/me/my b.ts>)` }));
  expect([...link.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["C:%5CUsers%5Cme%5Cproj%5Csrc%5Capp.ts", "/Users/me/my%20b.ts"]);
  const played: string[] = [];
  const media = (src: string) => (played.push(src), createElement("span", { "data-media": src }));
  renderToStaticMarkup(createElement(Response, { media, children: "![talk](/Users/me/rec/talk.mp3)" }));
  renderToStaticMarkup(createElement(Response, { media, children: String.raw`![talk](C:\rec\talk.mp3)` }));
  expect(played).toEqual(["/Users/me/rec/talk.mp3", "C:%5Crec%5Ctalk.mp3"]);
});
