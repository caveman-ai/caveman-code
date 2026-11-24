import { Response } from "@caveman-app/ui/ai/response";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { mediaRef } from "../../state/media.ts";
import { chatLink } from "./links.ts";

const root = "/Users/me/state/worktrees/repo/fix-retry--e658b536";

test("a file an answer links opens in the chat's folder, at its line", () => {
  expect(chatLink("retry.ts#L2", root)).toEqual({ kind: "file", path: "retry.ts", line: 2 });
  expect(chatLink("./src/a.ts", root)).toEqual({ kind: "file", path: "src/a.ts" });
  expect(chatLink(`${root}/src/a.ts#L5`, root)).toEqual({ kind: "file", path: "src/a.ts", line: 5 });
  expect(chatLink(`file://${root}/src/a.ts`, root)).toEqual({ kind: "file", path: "src/a.ts" });
  expect(chatLink("src/a.ts:12", root)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
  expect(chatLink("src/a.ts:12:4", root)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
  expect(chatLink("src/my%20file.ts", root)).toEqual({ kind: "file", path: "src/my file.ts" });
});

test("folder links retain an explicit directory hint; unmarked paths are checked on open", () => {
  expect(chatLink("apps/web/src/", root)).toEqual({ kind: "file", path: "apps/web/src", directory: true });
  expect(chatLink(`file://${root}/docs/design%20notes/`, root)).toEqual({ kind: "file", path: "docs/design notes", directory: true });
  expect(chatLink("apps/web/src", root)).toEqual({ kind: "file", path: "apps/web/src" });
});

test("HTML output links preserve explicit temporary paths, including file URLs and escaped spaces", () => {
  for (const href of ["/tmp/report.html", "file:///tmp/report.html", "file://localhost/tmp/report.html"]) {
    expect(chatLink(href, root)).toEqual({ kind: "file", path: "/tmp/report.html" });
  }
  expect(chatLink("/tmp/my%20report.HTML?view=1#summary", null)).toEqual({ kind: "file", path: "/tmp/my report.HTML" });
  expect(chatLink("~/reports/chart.htm", root)).toEqual({ kind: "file", path: "~/reports/chart.htm" });
  expect(chatLink(`${root}/report.html`, root)).toEqual({ kind: "file", path: "report.html" });
  expect(chatLink("docs/report.htm", root)).toEqual({ kind: "file", path: "docs/report.htm" });
  for (const href of [`${root}/report.html#L12`, "/tmp/report.html#L12", `file://${root}/report.html#L12`, "docs/report.htm#L12"]) {
    const target = chatLink(href, root);
    expect(target).toMatchObject({ kind: "file", line: 12 });
  }
  for (const href of ["//host/report.html", "javascript:report.html", "../report.html", "data:text/html,report.html"]) expect(chatLink(href, root)).toBeNull();
});

test("web links, anchors and non-HTML files outside the folder are not files", () => {
  expect(chatLink("https://github.com/x/y", root)).toBeNull();
  expect(chatLink("mailto:a@b.c", root)).toBeNull();
  expect(chatLink("#user-content-fn-1", root)).toEqual({ kind: "anchor", id: "user-content-fn-1" });
  expect(chatLink("/etc/passwd", root)).toBeNull();
  expect(chatLink(`${root}-other/a.ts`, root)).toBeNull();
  expect(chatLink("../outside.ts", root)).toBeNull();
  // `~/` is the home folder: inside the chat's folder it opens there; anywhere else, or with no folder to infer it from, it can't (T3 #20950).
  expect(chatLink("~/state/worktrees/repo/fix-retry--e658b536/src/a.ts:3", root)).toEqual({ kind: "file", path: "src/a.ts", line: 3 });
  expect(chatLink("~/.claude/CLAUDE.md", root)).toBeNull();
  expect(chatLink("~/notes.md", "/work/project")).toBeNull();
  expect(chatLink("~/notes.md", null)).toBeNull();
  // A `..` that climbs out of the folder is outside it, however it starts (T3 #22853).
  expect(chatLink(`${root}/../other/notes.md`, root)).toBeNull();
  expect(chatLink(`${root}/docs/a/../b.md`, root)).toEqual({ kind: "file", path: "docs/b.md" });
  expect(chatLink("javascript:alert(1)", root)).toBeNull();
  expect(chatLink("localhost:3000", root)).toBeNull();
  expect(chatLink("", root)).toBeNull();
  // A Cloud computer has no folder path to match an absolute path against.
  expect(chatLink(`${root}/a.ts`, null)).toBeNull();
});

/** What an answer's markdown hands the chat once Response has rendered it: each link's href and each media source. */
function rendered(markdown: string): { hrefs: string[]; media: string[] } {
  const media: string[] = [];
  const html = renderToStaticMarkup(createElement(Response, { hideImages: true, media: (src: string) => (media.push(src), null), children: markdown }));
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  return { hrefs, media };
}

test("a Windows file an answer links opens in the chat's folder from the href the answer renders", () => {
  const winRoot = String.raw`C:\Users\me\proj`;
  const open = (markdown: string, root: string | null = winRoot) => rendered(markdown).hrefs.map((href) => chatLink(href, root));
  expect(open(String.raw`See [app.ts](C:\Users\me\proj\src\app.ts)`)).toEqual([{ kind: "file", path: "src/app.ts" }]);
  expect(open("See [app.ts](C:/Users/me/proj/src/app.ts)")).toEqual([{ kind: "file", path: "src/app.ts" }]);
  expect(open(String.raw`See [app.ts](C:\Users\me\proj\src\app.ts#L12)`)).toEqual([{ kind: "file", path: "src/app.ts", line: 12 }]);
  expect(open(String.raw`See [app.ts](C:\Users\me\proj\src\app.ts:12)`)).toEqual([{ kind: "file", path: "src/app.ts", line: 12 }]);
  expect(open(String.raw`See [notes](<C:\Users\me\proj\docs\my notes.md>)`)).toEqual([{ kind: "file", path: "docs/my notes.md" }]);
  expect(open(String.raw`See [app.ts](~\proj\src\app.ts)`)).toEqual([{ kind: "file", path: "src/app.ts" }]);
  // Windows names a folder in any case; the engine may write the drive letter either way.
  expect(open(String.raw`See [app.ts](c:\users\me\proj\src\app.ts)`)).toEqual([{ kind: "file", path: "src/app.ts" }]);
  // A folder link's closing backslash would escape markdown's `)`; as the renderer encodes one that gets through:
  expect(chatLink("C:%5CUsers%5Cme%5Cproj%5Cdocs%5C", winRoot)).toEqual({ kind: "file", path: "docs", directory: true });
  // Outside the chat's folder, climbing out of it, or with no folder to match (a Cloud computer): nothing opens.
  expect(open(String.raw`See [ini](C:\Windows\system.ini)`)).toEqual([null]);
  expect(open(String.raw`See [x](C:\Users\me\proj\..\other\x.ts)`)).toEqual([null]);
  // A name that starts with a drive is a path on that drive's own folder (`D:x.ts`), never one in the chat's.
  expect(open("See [x](./D:x.ts) and [y](src/../D:y.ts)")).toEqual([null, null]);
  expect(open(String.raw`See [app.ts](C:\Users\me\proj\src\app.ts)`, null)).toEqual([null]);
  expect(open(String.raw`See [app.ts](C:\Users\me\proj\src\app.ts)`, root)).toEqual([null]);
});

test("a link to a network share never opens, however the answer writes it", () => {
  // Windows reads each of these as \\attacker.example\share\…: opening one would reach out to that host.
  const shares = [
    String.raw`[notes](\\attacker.example\share\notes.ts)`,
    String.raw`[notes](\\attacker.example\share\report.html)`,
    String.raw`[notes](%5C/attacker.example/share/notes.ts)`,
    String.raw`[notes](/%5Cattacker.example%5Cshare%5Creport.html)`,
    "[notes](%2F%2Fattacker.example%2Fshare%2Fnotes.ts)",
    "[notes](./%5C%5Cattacker.example%5Cshare%5Cnotes.ts)",
    "[notes](docs/../%5C/attacker.example/share/notes.ts)",
  ];
  for (const folder of [String.raw`C:\Users\me\proj`, root, null]) {
    expect(shares.flatMap((markdown) => rendered(markdown).hrefs.map((href) => chatLink(href, folder)))).toEqual(shares.map(() => null));
  }
});

test("a file an answer links opens by the name its link spells, decoded once however the path is written", () => {
  const winRoot = String.raw`C:\Users\me\proj`;
  const open = (markdown: string, folder: string) => rendered(markdown).hrefs.map((href) => chatLink(href, folder));
  // A file literally named "report%20final.md": its link spells the % as %25.
  expect(open(`[r](file://${root}/report%2520final.md)`, root)).toEqual([{ kind: "file", path: "report%20final.md" }]);
  expect(open(`[r](${root}/report%2520final.md)`, root)).toEqual([{ kind: "file", path: "report%20final.md" }]);
  expect(open("[r](docs/report%2520final.md)", root)).toEqual([{ kind: "file", path: "docs/report%20final.md" }]);
  expect(open(String.raw`[r](C:\Users\me\proj\report%2520final.md)`, winRoot)).toEqual([{ kind: "file", path: "report%20final.md" }]);
  expect(open(String.raw`[r](~\proj\report%2520final.md)`, winRoot)).toEqual([{ kind: "file", path: "report%20final.md" }]);
  // A space or a # in a name, in the chat's folder or the file's own.
  expect(open("[a](</Users/me/my proj/src/a.ts>)", "/Users/me/my proj")).toEqual([{ kind: "file", path: "src/a.ts" }]);
  expect(open("[a](</Users/me/proj/issue%23 12.md#L3>)", "/Users/me/proj")).toEqual([{ kind: "file", path: "issue# 12.md", line: 3 }]);
  expect(open("[a](<docs/my notes.md:12>)", root)).toEqual([{ kind: "file", path: "docs/my notes.md", line: 12 }]);
  expect(open(String.raw`[a](<C:\Users\me\proj\docs\my notes.md:12>)`, winRoot)).toEqual([{ kind: "file", path: "docs/my notes.md", line: 12 }]);
});

test("a file an answer links is the file its escapes name, decoded once, in a folder with a space or an accent too", () => {
  const open = (markdown: string, at: string) => rendered(markdown).hrefs.map((href) => chatLink(href, at));
  expect(open("See [a](/Users/josé/proj/docs/a.pdf)", "/Users/josé/proj")).toEqual([{ kind: "file", path: "docs/a.pdf" }]);
  expect(open("See [a](</Users/me/My Repo/docs/a.pdf>)", "/Users/me/My Repo")).toEqual([{ kind: "file", path: "docs/a.pdf" }]);
  // `%25` is a `%` in the file's name, however the path is written.
  expect(open("See [a](docs/a%2541.pdf)", "/repo")).toEqual([{ kind: "file", path: "docs/a%41.pdf" }]);
  expect(open("See [a](/repo/docs/a%2541.pdf)", "/repo")).toEqual([{ kind: "file", path: "docs/a%41.pdf" }]);
  expect(open("See [a](file:///repo/docs/a%2541.pdf)", "/repo")).toEqual([{ kind: "file", path: "docs/a%41.pdf" }]);
  expect(open(String.raw`See [a](C:\Users\me\proj\docs\a%2541.pdf)`, String.raw`C:\Users\me\proj`)).toEqual([{ kind: "file", path: "docs/a%41.pdf" }]);
  // A `#` or `?` the answer escaped is part of the name, not a line or a query.
  expect(open("See [a](docs/a%23b.md)", "/repo")).toEqual([{ kind: "file", path: "docs/a#b.md" }]);
});

test("audio an answer plays from a Windows path is read from that path", () => {
  expect(rendered(String.raw`![talk](C:\rec\talk.mp3)`).media.map(mediaRef)).toEqual([{ kind: "file", path: String.raw`C:\rec\talk.mp3` }]);
  expect(rendered(String.raw`![talk](<C:\rec\my talk.mp3>)`).media.map(mediaRef)).toEqual([{ kind: "file", path: String.raw`C:\rec\my talk.mp3` }]);
  expect(rendered("![talk](C:/rec/talk.mp3)").media.map(mediaRef)).toEqual([{ kind: "file", path: "C:/rec/talk.mp3" }]);
  expect(rendered("![talk](/Users/me/rec/my%20talk.mp3)").media.map(mediaRef)).toEqual([{ kind: "file", path: "/Users/me/rec/my talk.mp3" }]);
});
