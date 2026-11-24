// Files' sections, pure (apps/web/src/routes/review/sections.ts): every changed hunk under the chapter that explains
// it, in the order the guide reads. A chapter claims the hunks its excerpts show; a hunk no excerpt shows goes with the
// nearest hunk of its file that one does, a file no excerpt shows goes to the chapter that names it, and what no
// chapter claims goes last under "Everything else". So a file the guide reads in three places reads in three parts
// ("notify.ts · 1 of 3"). Without a tour: code, then tests, then generated files, each file whole. No React here.
import { type DiffFile, type Hunk, hunksOf } from "./diff";
import { fileKind, isSkimStop, type PrGuide, type PrGuideAttention } from "./model";

/** Some of a file's hunks, read together under one section. */
export interface Part {
  /** "src/a.ts#2": the file and the first hunk the part opens with. */
  id: string;
  path: string;
  /** Its hunks, by index in the file. */
  hunks: readonly number[];
  /** Which part of its file it is, from 1, and of how many. */
  index: number;
  of: number;
}

export interface Section {
  id: string;
  /** The chapter it reads under, by index; null for "Everything else" and the groups without a tour. */
  stop: number | null;
  title: string;
  call: PrGuideAttention["kind"] | null;
  parts: readonly Part[];
}

const oldCount = (h: Hunk) => h.rows.filter((r) => r.kind !== "add").length;

/** Whether an excerpt shows any of a hunk's lines, on the side it was cut from. */
function shows(h: Hunk, ex: { side: "new" | "old"; start: number; end: number }): boolean {
  const from = ex.side === "new" ? h.newStart : h.oldStart;
  const count = ex.side === "new" ? h.newCount : oldCount(h);
  return ex.start <= from + Math.max(count, 1) - 1 && ex.end >= from;
}

/** Every file's hunks by section (sectionsOf, at a hunk's grain). */
export function sectionsOf(guide: PrGuide | null, paths: readonly string[], files: ReadonlyMap<string, DiffFile>): Section[] {
  const out: Section[] = [];
  const whole = (path: string): Part => ({ id: `${path}#0`, path, hunks: (files.get(path) ? hunksOf(files.get(path)!) : []).map((h) => h.index), index: 1, of: 1 });
  if (guide && (guide.depth ?? "tour") === "tour" && guide.stops.length) {
    const order = guide.stops.map((stop, i) => ({ stop, i })).sort((a, b) => Number(isSkimStop(a.stop)) - Number(isSkimStop(b.stop)) || a.i - b.i);
    // Each hunk's chapter: the first in reading order whose excerpts show it.
    const owner = new Map<string, (number | null)[]>();
    for (const path of paths) {
      const f = files.get(path);
      const hunks = f ? hunksOf(f) : [];
      const own = hunks.map((h) => order.find(({ stop }) => stop.excerpts.some((ex) => ex.path === path && shows(h, ex)))?.i ?? null);
      // A hunk nobody shows goes with the nearest one somebody does; a file nobody shows, to the chapter that names it.
      const named = order.find(({ stop }) => stop.files.some((x) => x.path === path))?.i ?? null;
      const filled = own.map((o, k) => {
        if (o !== null) return o;
        let best: number | null = null;
        let far = Infinity;
        own.forEach((p, j) => {
          if (p !== null && Math.abs(j - k) < far) {
            far = Math.abs(j - k);
            best = p;
          }
        });
        return best ?? named;
      });
      owner.set(path, hunks.length ? filled : [named]);
    }
    const partsBy = new Map<number | null, Part[]>();
    const counted = new Map<string, number>();
    const add = (stop: number | null, path: string, hunks: number[]) => {
      const list = partsBy.get(stop) ?? [];
      list.push({ id: `${path}#${hunks[0] ?? 0}`, path, hunks, index: 0, of: 0 });
      partsBy.set(stop, list);
      counted.set(path, (counted.get(path) ?? 0) + 1);
    };
    for (const { stop, i } of order) {
      // The chapter's own order: the files its excerpts show, then the files it names.
      const mine = [...new Set([...stop.excerpts.map((e) => e.path), ...stop.files.map((f) => f.path), ...paths])];
      for (const path of mine) {
        const own = owner.get(path);
        if (!own) continue;
        const hunks = own.map((o, k) => (o === i ? k : -1)).filter((k) => k >= 0);
        if (hunks.length) add(i, path, own.length === 1 && !files.get(path) ? [] : hunks);
      }
    }
    for (const path of paths) {
      const own = owner.get(path) ?? [];
      const hunks = own.map((o, k) => (o === null ? k : -1)).filter((k) => k >= 0);
      if (hunks.length) add(null, path, files.get(path) ? hunks : []);
    }
    // Number each file's parts in reading order.
    const seen = new Map<string, number>();
    const number = (p: Part): Part => {
      const k = (seen.get(p.path) ?? 0) + 1;
      seen.set(p.path, k);
      return { ...p, index: k, of: counted.get(p.path) ?? 1 };
    };
    for (const { stop, i } of order) {
      const parts = partsBy.get(i);
      if (parts?.length) out.push({ id: `stop-${i}`, stop: i, title: stop.title, call: stop.attention?.kind ?? null, parts: parts.map(number) });
    }
    const rest = partsBy.get(null);
    if (rest?.length) out.push({ id: "rest", stop: null, title: "Everything else", call: null, parts: rest.map(number) });
    return out;
  }
  const groups: [string, string][] = [
    ["code", "Code"],
    ["test", "Tests"],
    ["generated", "Generated and lockfiles"],
  ];
  for (const [kind, title] of groups) {
    const mine = paths.filter((p) => fileKind(p) === kind);
    if (mine.length) out.push({ id: kind, stop: null, title, call: null, parts: mine.map(whole) });
  }
  return out;
}

/** Every part, in reading order. */
export const partsOf = (sections: readonly Section[]): Part[] => sections.flatMap((s) => s.parts);
