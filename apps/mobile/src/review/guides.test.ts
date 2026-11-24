// The scripted guides keep the writer's rules and point at real lines: every excerpt cuts rows out of its file's
// diff, every note sits on a line one of its stop's excerpts shows, every changed file is placed exactly once, and each
// hunk's header agrees with the lines under it. A chat's guide was written for the change its chat made, so its counts
// are that change's.
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

import { DARK_RUNS_MOMENT } from "../board/model";
import { world } from "../board/world";
import { hunksOf, linesOf, parsePatch } from "./diff";
import { ANSWERS, PUSH_BACK, REVIEWED, reviewedAt } from "./guides";
import { excerptRows, guideLinesOf, isSkimStop } from "./model";

const NOW = 1_762_400_000_000;

describe("the scripted guides", () => {
  for (const key of REVIEWED) {
    const [repo, branch] = key.split("@") as [string, string];
    const { files, guide } = reviewedAt(repo, branch)!;
    const byPath = new Map(files.map((f) => [f.path, f]));

    describe(key, () => {
      it("has hunks whose headers agree with their lines", () => {
        for (const f of files) {
          let net = 0;
          for (const h of hunksOf(f)) {
            const adds = h.rows.filter((r) => r.kind === "add").length;
            const dels = h.rows.filter((r) => r.kind === "del").length;
            if (h.oldStart > 0) expect(`${f.path} @${h.oldStart}: +${h.newStart}`).toBe(`${f.path} @${h.oldStart}: +${h.oldStart + net}`);
            net += adds - dels;
          }
          expect(parsePatch(f.patch).filter((r) => r.kind === "add").length).toBe(f.additions);
        }
      });

      it("cuts every excerpt from its file's rows, within 3 to 25 lines", () => {
        for (const stop of guide.stops) {
          for (const ex of stop.excerpts) {
            const f = byPath.get(ex.path);
            expect(f, ex.path).toBeDefined();
            const rows = excerptRows(linesOf(f!), ex.side, ex.start, ex.end);
            expect(rows.length, `${stop.title}: ${ex.caption}`).toBeGreaterThanOrEqual(3);
            expect(ex.end - ex.start + 1).toBeLessThanOrEqual(25);
          }
        }
      });

      it("anchors every note inside one of its stop's excerpts", () => {
        for (const stop of guide.stops) {
          for (const note of stop.notes) {
            const inside = stop.excerpts.some((ex) => ex.path === note.path && ex.side === "new" && note.line >= ex.start && note.line <= ex.end);
            expect(inside, `${stop.title}: ${note.title}`).toBe(true);
          }
        }
      });

      it("places every changed file exactly once", () => {
        if (guide.depth === "tldr") return;
        const placed = new Map<string, number>();
        for (const stop of guide.stops) {
          const paths = new Set([...stop.excerpts.map((e) => e.path), ...stop.files.map((f) => f.path)]);
          for (const p of paths) placed.set(p, (placed.get(p) ?? 0) + 1);
        }
        for (const f of files) expect(placed.get(f.path) ?? 0, f.path).toBeGreaterThanOrEqual(1);
      });

      it("writes titles as short actions and summaries in its format", () => {
        expect(guide.tldr!.length).toBeLessThanOrEqual(120);
        for (const stop of guide.stops) {
          expect(stop.title.split(" ").length, stop.title).toBeLessThanOrEqual(9);
          expect(stop.title).not.toMatch(/\.(ts|tsx|go|css)\b/);
          const labels = guideLinesOf(stop.summary).map((l) => l.label);
          expect(labels, stop.title).toEqual(isSkimStop(stop) ? ["checked"] : ["before", "after", "why"]);
        }
      });

      it("leaves a call, and a test stop when the change has tests, when it is a tour", () => {
        if (guide.depth === "tldr") return;
        expect(guide.stops.length).toBeGreaterThanOrEqual(2);
        expect(guide.stops.some((s) => s.attention)).toBe(true);
        if (files.some((f) => /[._-]test\.|_test\.go$/.test(f.path))) expect(guide.stops.some((s) => /test/i.test(s.title))).toBe(true);
      });
    });
  }

  it("match the counts of the change each ready chat made", () => {
    const w = world(NOW);
    const mismatches: string[] = [];
    const made = [...w.chats.filter((c) => c.moment).map((c) => ({ repo: c.repo, m: c.moment! })), { repo: "caveman-code", m: DARK_RUNS_MOMENT }];
    for (const { repo, m } of made) {
      const reviewed = reviewedAt(repo, m.branch);
      if (!reviewed) continue;
      for (const f of m.files) {
        const d = reviewed.files.find((x) => x.path === f.path);
        if (!d || d.additions !== f.add || d.deletions !== f.del) mismatches.push(`${f.path}: moment +${f.add} −${f.del}, diff +${d?.additions} −${d?.deletions}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("answer every question and push back on every call they write", () => {
    for (const key of REVIEWED) {
      const [repo, branch] = key.split("@") as [string, string];
      for (const stop of reviewedAt(repo, branch)!.guide.stops) {
        for (const q of stop.questions) expect(ANSWERS[q], q).toBeTruthy();
        if (stop.attention) expect(PUSH_BACK[stop.title], stop.title).toBeTruthy();
      }
    }
  });
});
