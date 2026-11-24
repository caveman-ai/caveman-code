import type { Client } from "@caveman-app/session-protocol/client";
import { MarkdownDocument } from "@caveman-app/ui/markdown/MarkdownDocument";
import { win32 } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { absolutePath, fileKind, fontType, formatBytes, matchIndices, mediaType, parentDirs, parseDelimited, resolveLink, typeAhead, visibleRows, type Entry, type Listing } from "./tree.ts";
import { TreeStore } from "./treeStore.ts";

const dir = (path: string, ignored = false): Entry => ({ name: path.split("/").pop()!, path, type: "dir", ...(ignored ? { ignored } : {}) });
const file = (path: string): Entry => ({ name: path.split("/").pop()!, path, type: "file" });
const FS: Record<string, Listing> = {
  "": { entries: [dir("apps"), dir("node_modules", true), file("README.md")], truncated: false },
  apps: { entries: [dir("apps/web"), file("apps/x.ts")], truncated: false },
  "apps/web": { entries: [file("apps/web/a.ts")], truncated: true },
};

test("visible rows: expanded, listed folders open in place; truncated and failed listings get a note", () => {
  const listings = new Map(Object.entries(FS));
  const shown = (expanded: string[], errors = new Map<string, string>()) =>
    visibleRows(listings, new Set(expanded), errors).map((r) => `${"  ".repeat(r.kind === "result" ? 0 : r.depth)}${r.kind === "entry" ? r.entry.name : r.kind === "note" ? `(${r.text})` : r.path}`);
  expect(shown([])).toEqual(["apps", "node_modules", "README.md"]);
  expect(shown(["apps", "apps/web"])).toEqual(["apps", "  web", "    a.ts", "    (More entries not shown)", "  x.ts", "node_modules", "README.md"]);
  // A collapsed parent hides an expanded child; a folder still loading shows nothing under it.
  expect(shown(["apps/web"])).toEqual(["apps", "node_modules", "README.md"]);
  expect(shown(["node_modules"])).toEqual(["apps", "node_modules", "README.md"]);
  expect(shown(["node_modules"], new Map([["node_modules", "EACCES"]]))).toEqual(["apps", "node_modules", "  (EACCES)", "README.md"]);
  const web = visibleRows(listings, new Set(["apps"]))[1]!;
  expect(web.kind === "entry" && [web.pos, web.size, web.expanded]).toEqual([1, 2, false]);
});

test("reveal expands every folder above the path and lists them in order", async () => {
  const calls: string[] = [];
  const client = { call: async (_: string, p: { path: string }) => (calls.push(p.path), { path: p.path, ...FS[p.path]! }) } as unknown as Client;
  const store = new TreeStore("w");
  store.reset(client);
  expect(parentDirs("apps/web/a.ts")).toEqual(["apps", "apps/web"]);
  await store.reveal("apps/web/a.ts");
  expect([...store.state.expanded]).toEqual(["apps", "apps/web"]);
  expect(calls).toEqual(["", "apps", "apps/web"]);
  expect(store.state.scrollTo).toBe("apps/web/a.ts");
  // A path that isn't listed stops waiting for its row.
  await store.reveal("apps/gone.ts");
  expect(store.state.scrollTo).toBeNull();
  // A folder reveals itself expanded; nothing is listed twice.
  store.collapseAll();
  await store.reveal("apps/web", true);
  expect([...store.state.expanded]).toEqual(["apps", "apps/web"]);
  expect(calls).toEqual(["", "apps", "apps/web"]);
});

test("a burst of listings renders once per frame; a request from before a reset can't clear a newer one", async () => {
  const fast = { call: async (_: string, p: { path: string }) => ({ path: p.path, ...(FS[p.path] ?? { entries: [], truncated: false }) }) } as unknown as Client;
  const store = new TreeStore("w");
  store.reset(fast);
  let renders = 0;
  store.subscribe(() => renders++);
  await store.expandAll();
  await new Promise((r) => setTimeout(r, 40));
  expect([...store.state.expanded].sort()).toEqual(["apps", "apps/web"]); // node_modules is ignored
  expect(renders).toBe(1);

  let release: () => void = () => undefined;
  const slow = { call: () => new Promise((resolve) => (release = () => resolve({ path: "", entries: [], truncated: false }))) } as unknown as Client;
  let calls = 0;
  const next = { call: () => (calls++, new Promise<never>(() => undefined)) } as unknown as Client;
  const s2 = new TreeStore("w2");
  s2.reset(slow);
  const old = s2.load("");
  s2.reset(next);
  void s2.load("");
  release();
  await old;
  expect(s2.state.listings.has("")).toBe(false); // the stale answer was dropped
  expect(s2.state.loading.has("")).toBe(true); // the newer request still owns the flag
  void s2.load("");
  expect(calls).toBe(1); // and its in-flight entry: no duplicate fs.list
});

// Deferred RPCs make the refresh race deterministic, including requests queued behind the concurrency cap.
function deferredTree() {
  const calls: Array<{ path: string; resolve: (listing: Listing) => void; reject: (error: Error) => void }> = [];
  const store = new TreeStore("refresh");
  store.reset({ call: (_: string, p: { path: string }) => new Promise<Listing>((resolve, reject) => calls.push({ path: p.path, resolve, reject })) } as unknown as Client);
  return { store, calls };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const listing = (path: string): Listing => ({ entries: [file(path)], truncated: false });

test("refresh during the initial root listing queues a fresh listing after the stale answer", async () => {
  const { store, calls } = deferredTree();
  const initial = store.load("");
  store.refresh();
  expect(calls.map((c) => c.path)).toEqual([""]); // share the pending request, then refresh
  calls[0]!.resolve(listing("old.ts"));
  await initial;
  await settle();
  expect(calls.map((c) => c.path)).toEqual(["", ""]);
  calls[1]!.resolve(listing("new.ts"));
  await settle();
  expect(store.state.listings.get("")).toEqual(listing("new.ts"));
  expect(store.state.loading.size).toBe(0);
});

test("refresh always requests the root, including after an initial failure", async () => {
  const { store, calls } = deferredTree();
  store.refresh();
  expect(calls.map((c) => c.path)).toEqual([""]);
  calls[0]!.reject(new Error("offline"));
  await settle();
  expect(store.state.errors.get("")).toBe("offline");
  store.refresh();
  expect(calls.map((c) => c.path)).toEqual(["", ""]);
  calls[1]!.resolve(FS[""]!);
  await settle();
  expect(store.state.listings.get("")).toEqual(FS[""]);
  expect(store.state.errors.size).toBe(0);
});

test("refresh includes visible pending and queued folders, but not folders hidden by a collapsed ancestor", async () => {
  const { store, calls } = deferredTree();
  // Root plus four folders: the fourth folder waits for one of the four RPC slots.
  const initial = store.load("");
  for (const d of ["apps", "apps/web", "docs", "packages"]) store.setExpanded(d, true);
  store.setExpanded("apps", false); // apps/web remains expanded but is hidden
  store.refresh();
  expect(calls.map((c) => c.path)).toEqual(["", "apps", "apps/web", "docs"]);
  for (const call of [...calls]) call.resolve(listing(`${call.path}/old.ts`));
  await initial;
  await settle();
  expect(calls.filter((c) => c.path === "apps")).toHaveLength(1);
  expect(calls.filter((c) => c.path === "apps/web")).toHaveLength(1);
  expect(calls.filter((c) => c.path === "docs")).toHaveLength(2);
  expect(calls.filter((c) => c.path === "")).toHaveLength(2);
  const packages = calls.find((c) => c.path === "packages")!;
  packages.resolve(listing("packages/old.ts"));
  await settle();
  expect(calls.filter((c) => c.path === "packages")).toHaveLength(2);
  for (const call of calls.slice(5)) call.resolve(listing(`${call.path}/new.ts`));
  await settle();
  expect(store.state.listings.get("packages")).toEqual(listing("packages/new.ts"));
  expect(store.state.listings.get("docs")).toEqual(listing("docs/new.ts"));
});

test("refresh preserves visible cached children, drops hidden cache, and retries visible failures", async () => {
  const { store, calls } = deferredTree();
  const initial = store.load("");
  store.setExpanded("apps", true);
  store.setExpanded("docs", true);
  store.setExpanded("hidden", true);
  calls[0]!.resolve(FS[""]!);
  calls[1]!.resolve(FS.apps!);
  calls[2]!.reject(new Error("EACCES"));
  calls[3]!.resolve(listing("hidden/old.ts"));
  await initial;
  await settle();
  store.setExpanded("hidden", false);
  store.refresh();
  expect(calls.slice(4).map((c) => c.path).sort()).toEqual(["", "apps", "docs"]);
  expect(store.state.listings.get("apps")).toEqual(FS.apps); // no blank frame while refreshing
  expect(store.state.listings.has("hidden")).toBe(false);
  for (const call of calls.slice(4)) call.resolve(listing(`${call.path}/new.ts`));
  await settle();
  expect(store.state.errors.has("docs")).toBe(false);
  expect(store.state.listings.get("docs")).toEqual(listing("docs/new.ts"));
});

test("markdown links resolve against the file's folder and stay in the workspace", () => {
  expect(resolveLink("docs/", "../WHY.md")).toEqual({ kind: "file", path: "README.md" });
  expect(resolveLink("README.md", "./design/x%20y.png")).toEqual({ kind: "file", path: "docs/ y.png" });
  expect(resolveLink("README.md", "/packages/ui/STYLE.md#L12")).toEqual({ kind: "file", path: "packages/ui/STYLE.md", line: 12 });
  expect(resolveLink("README.md", "store.ts?raw=1#section")).toEqual({ kind: "file", path: "docs/store.ts" });
  expect(resolveLink("README.md", "#the-log")).toEqual({ kind: "anchor", id: "the-log" });
  expect(resolveLink("README.md", "https://example.com/a")).toEqual({ kind: "external", href: "https://example.com/a" });
  expect(resolveLink("README.md", "mailto:x@y.z")).toEqual({ kind: "external", href: "mailto:x@y.z" });
  expect(resolveLink("README.md", "../secrets.txt")).toBeNull();
  for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.example/x", "vscode://x"]) expect(resolveLink("README.md", bad)).toEqual({ kind: "blocked" });
  expect(absolutePath("/Users/me/repo/", "README.md")).toBe("/Users/me/repo/README.md");
});

/** What a markdown file hands the Files surface once the reader has rendered it: each link's href and each image's source. */
function rendered(source: string): { hrefs: string[]; images: string[] } {
  const images: string[] = [];
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { source, image: (src: string) => (images.push(src), null) }));
  const hrefs = [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  return { hrefs, images };
}

test("a markdown file's link or image never resolves to a network share or another drive, wherever the file sits", () => {
  // Windows reads each of these as \\attacker.example\share\…, or as a path on another drive: the image is read, and the share
  // reached, as soon as the file is previewed.
  const shares = [
    String.raw`\\attacker.example\share\x.png`,
    "%5C%5Cattacker.example%5Cshare%5Cx.png",
    "%5C/attacker.example/share/x.png",
    "%2F%2Fattacker.example%2Fshare%2Fx.png",
    "/%5C%5Cattacker.example%5Cshare%5Cx.png",
    "./%5C%5Cattacker.example%5Cshare%5Cx.png",
    "a/../%5C%5Cattacker.example%5Cshare%5Cx.png",
    "C%3A%5CUsers%5Cme%5Cx.png",
    "./D:x.png",
  ];
  const winRoot = String.raw`C:\Users\me\proj`;
  for (const [from, prefix] of [["README.md", ""], ["docs/README.md", "../"]] as const) {
    const markdown = shares.map((src) => `![x](${prefix}${src}) [x](${prefix}${src})`).join("\n\n");
    const { hrefs, images } = rendered(markdown);
    expect(images).toHaveLength(shares.length);
    expect(hrefs).toHaveLength(shares.length);
    // Every file it opens, Windows reads inside the workspace.
    const files = [...images, ...hrefs].flatMap((href) => { const target = resolveLink(from, href); return target?.kind === "file" ? [target.path] : []; });
    expect(files.filter((file) => !win32.resolve(winRoot, file).startsWith(`${winRoot}\\`))).toEqual([]);
  }
});

test("a markdown file's link opens the name it spells, decoded once, and never climbs out through an encoded slash", () => {
  expect(resolveLink("docs/README.md", "report%2520final.md")).toEqual({ kind: "file", path: "docs/report%20final.md" });
  expect(resolveLink("docs/README.md", "issue%23%2012.md#L3")).toEqual({ kind: "file", path: "docs/issue# 12.md", line: 3 });
  expect(resolveLink("docs/README.md", "design%2Fx.png")).toEqual({ kind: "file", path: "docs/" });
  expect(resolveLink("docs/README.md", "..%2F..%2Fsecrets.txt")).toBeNull();
  // A malformed escape is left as written, not thrown from the click.
  expect(resolveLink("docs/README.md", "#%E0%A4%A")).toEqual({ kind: "anchor", id: "%E0%A4%A" });
  expect(resolveLink("docs/README.md", "notes.md#%E0%A4%A")).toEqual({ kind: "file", path: "docs/notes.md" });
});

test("search highlights prefer the file name; type-ahead finds the next row by name", () => {
  expect(matchIndices("apps/web/src/panels/store.ts", "store")).toEqual([20, 21, 22, 23, 24]);
  expect(matchIndices("apps/web/src/panels/store.ts", "sts")).toEqual([20, 26, 27]);
  expect(matchIndices("apps/web/src/panels/store.ts", "panels store")).toEqual([13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24]);
  expect(matchIndices("a/b.ts", "zz")).toEqual([]);
  const rows = visibleRows(new Map(Object.entries(FS)), new Set(["apps"]));
  expect(typeAhead(rows, 0, "w")).toBe(1);
  expect(typeAhead(rows, 0, "re")).toBe(4);
  expect(typeAhead(rows, 1, "a")).toBe(0); // wraps
});

test("CSV: quotes, doubled quotes and newlines in fields; caps rows and columns", () => {
  expect(parseDelimited('a,b\r\n"x, y","say ""hi""\nthere"\n', ",").rows).toEqual([
    ["a", "b"],
    ["x, y", 'say "hi"\nthere'],
  ]);
  const big = parseDelimited(Array.from({ length: 300 }, (_, i) => `${i}\t${i}\t${i}`).join("\n"), "\t", 200, 2);
  expect([big.rows.length, big.rows[0], big.moreRows, big.moreCols]).toEqual([200, ["0", "0"], true, true]);
});

test("the viewer plays audio and video and sets fonts; the rest stays text (T3 #21363, #21362)", () => {
  expect(["take.mp3", "a/voice.WAV", "demo.mp4", "clip.mov", "s.webm"].map(fileKind)).toEqual(["media", "media", "media", "media", "media"]);
  expect(["Inter.ttf", "x.woff2", "y.otf"].map(fileKind)).toEqual(["font", "font", "font"]);
  expect([mediaType("demo.mp4"), mediaType("take.mp3"), fontType("x.woff2")]).toEqual(["video/mp4", "audio/mpeg", "font/woff2"]);
  expect(["notes.md", "shot.png", "data.csv", "flow.mmd", "main.ts"].map(fileKind)).toEqual(["markdown", "image", "table", "diagram", "text"]);
});

test("formatBytes picks its unit after rounding, so a size just under the next unit reads as that unit (T3's #26067)", () => {
  expect([0, 1023, 1024, 1536, 1_047_552].map(formatBytes)).toEqual(["0 B", "1023 B", "1 KB", "2 KB", "1023 KB"]);
  expect(formatBytes(1023.6)).toBe("1 KB");
  expect(formatBytes(1_048_100)).toBe("1 MB");
  expect(formatBytes(1_048_576)).toBe("1 MB");
  expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MB");
  expect(formatBytes(10.2 * 1024 ** 2)).toBe("10 MB");
  expect(formatBytes(1_073_217_536)).toBe("1 GB");
  expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
});
