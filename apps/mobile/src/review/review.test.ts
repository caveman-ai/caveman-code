// The guide's reading rules, off the screen: every change has code to read (a sketched patch carries the counts it
// was asked for), Files places every hunk of every file exactly once and in the guide's order, the writer on the phone
// leaves a guide whose excerpts cut real rows, a question is answered from the agent's own words or the guide, and a
// head is the same head whatever order its files come in.
import { describe, expect, it, vi } from "vitest";

vi.mock("../store/persist", () => ({
  KEYS: { board: "board", inbox: "inbox", sessions: "sessions", boot: "boot" },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

import type { Pr } from "../screens/pages/review-model";
import { answerFor } from "./ask";
import { hunksOf, linesOf, parsePatch } from "./diff";
import { partsOf, sectionsOf } from "./sections";
import { headOf, sketch } from "./fixture";
import { ANSWERS, REVIEWED, reviewedAt } from "./guides";
import { reviewOf } from "./source";
import { excerptRows, guideLinesOf } from "./model";
import { draftGuide } from "./write";

const pr = (over: Partial<Pr>): Pr => ({
  repo: "caveman-ai/caveman-code",
  number: 900,
  title: "Date lines in the transcript",
  state: "open",
  author: "jb",
  mine: true,
  asksYou: false,
  guideReady: false,
  branch: "transcript-date-lines",
  base: "main",
  files: [
    { path: "src/components/transcript/lines.ts", add: 18, del: 2 },
    { path: "src/components/Transcript.tsx", add: 26, del: 3 },
    { path: "src/components/transcript/DateLine.tsx", add: 41, del: 0 },
    { path: "src/components/transcript/lines.test.ts", add: 12, del: 0 },
  ],
  commits: 1,
  openedAt: 0,
  updatedAt: 0,
  head: "",
  about: ["A centred date line where two messages are 30 minutes apart", "Today and Yesterday by name, then the date", "Folded turns keep their lines"],
  body: "Date lines are in. Where two messages are more than 30 minutes apart, a centred line says when the next one was.",
  ...over,
});

describe("a sketched patch", () => {
  it("carries the counts it was asked for, in hunks that agree with their headers", () => {
    for (const [path, add, del] of [["src/a.ts", 18, 4], ["docs/audit.md", 412, 0], ["relay/x.go", 6, 1], ["site/index.astro", 12, 19], ["src/b.test.ts", 6, 2], ["src/c.ts", 90, 7]] as const) {
      const f = sketch(path, add, del, ["the change itself, kept small", "a test that would have caught it"]);
      expect([f.additions, f.deletions], path).toEqual([add, del]);
      const rows = parsePatch(f.patch);
      expect(rows.filter((r) => r.kind === "add").length, path).toBe(add);
      expect(rows.filter((r) => r.kind === "del").length, path).toBe(del);
    }
  });
});

describe("Files in the guide's order", () => {
  for (const key of REVIEWED) {
    const [repo, branch] = key.split("@") as [string, string];
    const { files, guide } = reviewedAt(repo, branch)!;
    it(`${key}: places every hunk exactly once`, () => {
      const byPath = new Map(files.map((f) => [f.path, f]));
      const sections = sectionsOf(guide, files.map((f) => f.path), byPath);
      const seen = new Map<string, number[]>();
      for (const part of partsOf(sections)) seen.set(part.path, [...(seen.get(part.path) ?? []), ...part.hunks]);
      for (const f of files) expect([...(seen.get(f.path) ?? [])].sort(), f.path).toEqual(hunksOf(f).map((h) => h.index));
      for (const part of partsOf(sections)) expect(part.index).toBeLessThanOrEqual(part.of);
    });
  }
});

describe("the writer on the phone", () => {
  const change = pr({});
  const head = headOf(change.files);
  const p = { ...change, head };
  const files = [...reviewOf(p).files.values()];

  it("writes a tour whose excerpts cut real rows and whose chapters read in its format", () => {
    const guide = draftGuide(p, files);
    expect(guide.depth).toBe("tour");
    expect(guide.head_sha).toBe(head);
    expect(guide.stops.length).toBeGreaterThanOrEqual(2);
    for (const stop of guide.stops) {
      expect(stop.title.split(" ").length, stop.title).toBeLessThanOrEqual(8);
      if (stop.excerpts.length) expect(guideLinesOf(stop.summary).map((l) => l.label)).toEqual(["before", "after", "why"]);
      for (const ex of stop.excerpts) {
        const f = files.find((x) => x.path === ex.path)!;
        expect(excerptRows(linesOf(f), ex.side, ex.start, ex.end).length, ex.path).toBeGreaterThanOrEqual(3);
      }
    }
    expect(guide.stops.some((s) => /test/i.test(s.title))).toBe(true);
  });

  it("leaves a short change its TL;DR and the diff", () => {
    const short = { ...p, files: [{ path: "src/a.ts", add: 8, del: 2 }], head: headOf([{ path: "src/a.ts", add: 8, del: 2 }]) };
    const guide = draftGuide(short, [...reviewOf(short).files.values()]);
    expect(guide.depth).toBe("tldr");
    expect(guide.tldr!.length).toBeLessThanOrEqual(120);
  });
});

describe("asking", () => {
  const [repo, branch] = "caveman-code@chief-push".split("@") as [string, string];
  const written = reviewedAt(repo, branch)!;
  const review = { result: { guide: written.guide, running: false }, files: new Map(written.files.map((f) => [f.path, f])), threads: [], reviews: [] };

  it("answers a guide's own question in the agent's words", () => {
    const q = written.guide.stops[2]!.questions[0]!;
    expect(answerFor(review, 2, q)).toBe(ANSWERS[q]);
  });

  it("answers anything else about a chapter from its after, its why and its call", () => {
    const a = answerFor(review, 1, "Is this safe to ship today?");
    expect(a).toMatch(/sendPush/);
    expect(a).toMatch(/TooManyProviderTokenUpdates/);
  });

  it("answers about a noted line with its note", () => {
    const note = written.guide.stops[0]!.notes[0]!;
    expect(answerFor(review, 0, "What's this?", { path: note.path, line: note.line })).toMatch(note.title);
  });
});

it("reads one head whatever order the files come in", () => {
  const a = [
    { path: "a.ts", add: 1, del: 0 },
    { path: "b.ts", add: 2, del: 3 },
  ];
  expect(headOf(a)).toBe(headOf([...a].reverse()));
  expect(headOf(a)).not.toBe(headOf([{ path: "a.ts", add: 1, del: 1 }, a[1]!]));
});
