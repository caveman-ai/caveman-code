import type { PrGuideStop } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { hunkOwners, linesLeft, markPart, partAt, partRows, partsOf, partViewed, sectionsOf } from "./sections.ts";

const file = (path: string, patch: string, additions = 1, deletions = 1): DiffFile => ({ path, status: "modified", additions, deletions, patch });
const hunk = (newStart: number, body: string[]) => [`@@ -${newStart},${body.length - 1} +${newStart},${body.length - 1} @@`, ...body].join("\n");

// install.js: three hunks at 10, 100 and 300; config.js: one; a lockfile; a test.
const install = file("installer/install.js", [hunk(10, [" a", "-b", "+B"]), hunk(100, [" c", "-d", "+D"]), hunk(300, [" e", "-f", "+F"])].join("\n"), 3, 3);
const config = file("src/config.js", hunk(5, [" x", "-y", "+Y"]));
const lock = file("pnpm-lock.yaml", hunk(1, ["-v1", "+v2"]));
const spec = file("tests/install.test.mjs", hunk(1, [" t", "+u"]), 1, 0);
const binary: DiffFile = { path: "logo.png", status: "modified", additions: 0, deletions: 0, patch: "" };

const stop = (title: string, over: Partial<PrGuideStop> = {}): PrGuideStop => ({ title, summary: `${title}.`, attention: null, excerpts: [], files: [], notes: [], questions: [], ...over });
const ex = (path: string, start: number, end: number) => ({ path, side: "new" as const, start, end, caption: "" });

describe("sectionsOf", () => {
  test("without a tour: code, tests, then generated", () => {
    const s = sectionsOf([lock, spec, install, config], null);
    expect(s.map((x) => x.title)).toEqual(["Code", "Tests", "Generated and lockfiles"]);
    expect(s[0]!.parts.map((p) => [p.file.path, p.part, p.of])).toEqual([
      ["installer/install.js", 1, 1],
      ["src/config.js", 1, 1],
    ]);
  });

  test("a tour splits a file by the hunks each stop shows", () => {
    const stops = [
      stop("Add flag", { excerpts: [ex("installer/install.js", 10, 12), ex("src/config.js", 5, 6)] }),
      stop("Bun fallback", { excerpts: [ex("installer/install.js", 300, 301)], files: [{ path: "tests/install.test.mjs" }] }),
      stop("Lockfile", { files: [{ path: "pnpm-lock.yaml" }, { path: "logo.png" }] }),
    ];
    const s = sectionsOf([install, config, lock, spec, binary], stops);
    expect(s.map((x) => [x.id, x.title])).toEqual([
      ["stop-0", "Add flag"],
      ["stop-1", "Bun fallback"],
      ["stop-2", "Lockfile"],
    ]);
    // Hunk 1 (line 100) is nobody's: it stays with the hunk above it, in stop 0.
    expect(s[0]!.parts.map((p) => [p.file.path, p.hunks, p.part, p.of])).toEqual([
      ["installer/install.js", [0, 1], 1, 2],
      ["src/config.js", [0], 1, 1],
    ]);
    expect(s[1]!.parts.map((p) => [p.file.path, p.hunks, p.part, p.of])).toEqual([
      ["installer/install.js", [2], 2, 2],
      ["tests/install.test.mjs", [0], 1, 1],
    ]);
    // A split part counts its own hunks; a whole file the host's numbers.
    expect(s[1]!.parts[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(s[2]!.parts.map((p) => p.file.path)).toEqual(["pnpm-lock.yaml", "logo.png"]);
  });

  test("what no stop claims ends in Everything else; a stop with nothing in the diff drops", () => {
    const s = sectionsOf([install, config], [stop("Gone", { excerpts: [ex("deleted.ts", 1, 3)] }), stop("Config", { files: [{ path: "src/config.js" }] })]);
    expect(s.map((x) => x.title)).toEqual(["Config", "Everything else"]);
    expect(s[1]!.parts[0]).toMatchObject({ hunks: [0, 1, 2], part: 1, of: 1 });
  });

  test("skim stops come after the stops with code", () => {
    const s = sectionsOf([install, lock], [stop("Lockfile", { files: [{ path: "pnpm-lock.yaml" }] }), stop("Installer", { excerpts: [ex("installer/install.js", 10, 10)] })]);
    expect(s.map((x) => x.stop)).toEqual([1, 0]);
  });
});

describe("viewed parts", () => {
  const stops = [stop("One", { excerpts: [ex("installer/install.js", 10, 10)] }), stop("Two", { excerpts: [ex("installer/install.js", 300, 300)] })];
  const parts = partsOf(sectionsOf([install, config], stops));
  const [first, second] = parts.filter((p) => p.file === install);

  test("a split file goes to the host once all its parts are viewed", () => {
    const a = markPart(first!, true, parts, new Set(), new Set());
    expect(a).toEqual({ local: new Set([first!.key]), host: null });
    const b = markPart(second!, true, parts, new Set(), a.local);
    expect(b.host).toEqual({ path: install.path, viewed: true });
  });

  test("unmarking one part of a viewed file keeps the others", () => {
    const r = markPart(first!, false, parts, new Set([install.path]), new Set());
    expect(r).toEqual({ local: new Set([second!.key]), host: { path: install.path, viewed: false } });
    expect(partViewed(second!, new Set(), r.local)).toBe(true);
  });

  test("a whole file is the host's mark alone", () => {
    const whole = parts.find((p) => p.file === config)!;
    expect(markPart(whole, true, parts, new Set(), new Set()).host).toEqual({ path: config.path, viewed: true });
    expect(markPart(whole, true, parts, new Set([config.path]), new Set()).host).toBeNull();
  });

  test("lines left and which part shows a line", () => {
    expect(linesLeft(parts, () => false)).toBe(parts.reduce((n, p) => n + p.additions + p.deletions, 0));
    expect(linesLeft(parts, (p) => p.file === install)).toBe(2);
    expect(partAt(parts, install.path, 300)).toBe(second);
    expect(partAt(parts, install.path)).toBe(first);
    expect(partAt(parts, "nope.ts")).toBeNull();
  });
});

describe("partRows", () => {
  const stops = [stop("One", { excerpts: [ex("installer/install.js", 10, 10), ex("installer/install.js", 300, 300)] }), stop("Two", { excerpts: [ex("installer/install.js", 100, 100)] })];
  const parts = partsOf(sectionsOf([install], stops));
  const owners = hunkOwners(parts).get(install)!;
  const one = parts.find((p) => p.part === 1)!;
  const two = parts.find((p) => p.part === 2)!;
  const shape = (r: ReturnType<typeof partRows>) => r.rows.map((row) => (r.bars.has(row) ? (r.bars.get(row)!.kind === "gap" ? `gap:${(r.bars.get(row) as { hidden: number | null }).hidden}` : "elsewhere") : `${row.kind}:${row.newNo ?? row.oldNo}`));

  test("hidden lines and the other section's hunk show as bars", () => {
    expect(shape(partRows(one, owners, new Map(), null))).toEqual(["gap:9", "ctx:10", "del:11", "add:11", "elsewhere", "ctx:300", "del:301", "add:301", "gap:null"]);
    expect(shape(partRows(two, owners, new Map(), null))).toEqual(["elsewhere", "ctx:100", "del:101", "add:101", "elsewhere"]);
    const r = partRows(two, owners, new Map(), null);
    expect(r.bars.get(r.rows[0]!)).toEqual({ kind: "elsewhere", changes: 1, part: one });
  });

  test("opened lines come from the file at the head", () => {
    const head = Array.from({ length: 310 }, (_, i) => `line ${i + 1}`);
    const r = partRows(one, owners, new Map([[0, { top: 0, bottom: 3 }], [3, { top: 2, bottom: 0 }]]), head);
    expect(shape(r).slice(0, 5)).toEqual(["gap:6", "ctx:7", "ctx:8", "ctx:9", "ctx:10"]);
    expect(r.rows[1]).toEqual({ kind: "ctx", text: "line 7", oldNo: 7, newNo: 7 });
    // The tail: 302..310, two opened, seven still hidden.
    expect(shape(r).slice(-3)).toEqual(["ctx:302", "ctx:303", "gap:7"]);
  });

  test("an added file has no gaps", () => {
    const added: DiffFile = { path: "new.js", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b\n" };
    const [p] = partsOf(sectionsOf([added], null));
    expect(shape(partRows(p!, hunkOwners([p!]).get(added)!, new Map(), null))).toEqual(["add:1", "add:2"]);
  });
});
