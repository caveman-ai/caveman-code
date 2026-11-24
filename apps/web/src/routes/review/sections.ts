// Files, read in the guide's order. Each stop of the tour is a section holding the hunks its excerpts show and the
// files it names; a file whose hunks belong to several stops is split, and each piece says which it is ("1 of 3").
// What no stop claims ends in "Everything else", code before tests before lockfiles. Without a tour the sections are
// those three kinds. Pure: no React, no wire.
import type { PrGuideStop } from "@caveman-app/session-protocol";
import { contextRows, gapBefore, hunksOf, type Hunk } from "../../panels/diff/hunks.ts";
import type { DiffFile, DiffLine } from "../../panels/diff/parsePatch.ts";
import { fileKind, isSkimStop, type FileKind } from "./model.ts";

/** One file's share of one section: some of its hunks (all of them when it is not split). */
export interface Part {
  /** `path#n`: unique on the page, stable for a head. */
  readonly key: string;
  readonly file: DiffFile;
  /** Indexes into hunksOf(file), ascending. Empty for a file without hunks (binary, mode, a pure rename). */
  readonly hunks: ReadonlyArray<number>;
  /** 1-based among the file's parts, and how many it has. */
  readonly part: number;
  readonly of: number;
  readonly section: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface Section {
  /** `stop-3`, `kind-code`, `rest`. */
  readonly id: string;
  /** The guide stop it is (index into the stops), null for a kind section. */
  readonly stop: number | null;
  readonly title: string;
  readonly summary: string | null;
  /** The stop asks the maintainer for a call. */
  readonly attention: boolean;
  readonly parts: ReadonlyArray<Part>;
}

const KIND_ORDER: Record<FileKind, number> = { code: 0, test: 1, generated: 2 };
const KIND_TITLE: Record<FileKind, string> = { code: "Code", test: "Tests", generated: "Generated and lockfiles" };

const byKindThenPath = (a: DiffFile, b: DiffFile) => KIND_ORDER[fileKind(a.path)] - KIND_ORDER[fileKind(b.path)] || a.path.localeCompare(b.path);

/** The sections of a change: by the guide's stops when there is a tour, else by kind of file. */
export function sectionsOf(files: ReadonlyArray<DiffFile>, stops: ReadonlyArray<PrGuideStop> | null): Section[] {
  if (!stops || stops.length === 0) return byKind(files);
  // The tour's own order: stops with code first, then the skim stops (Guide.tsx draws them last too).
  const order = stops.map((stop, i) => ({ stop, i })).sort((a, b) => Number(isSkimStop(a.stop)) - Number(isSkimStop(b.stop)) || a.i - b.i);
  const owner = new Map<DiffFile, Array<number | null>>(); // hunk index → place in `order`, null while unclaimed
  const whole = new Map<DiffFile, number>(); // a file without hunks → place in `order`
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const f of files) owner.set(f, hunksOf(f).map((): number | null => null));

  // 1. Hunks an excerpt shows go to the first stop (in reading order) that shows them.
  order.forEach(({ stop }, at) => {
    for (const ex of stop.excerpts) {
      const f = byPath.get(ex.path);
      if (!f) continue;
      const claims = owner.get(f)!;
      hunksOf(f).forEach((h, k) => {
        if (claims[k] === null && overlaps(h, ex.side, ex.start, ex.end)) claims[k] = at;
      });
      if (hunksOf(f).length === 0 && !whole.has(f)) whole.set(f, at);
    }
  });
  // 2. A file a stop names takes its unclaimed hunks there, unless an excerpt already placed some of it.
  order.forEach(({ stop }, at) => {
    for (const named of stop.files) {
      const f = byPath.get(named.path);
      if (!f) continue;
      const claims = owner.get(f)!;
      if (claims.length === 0) {
        if (!whole.has(f)) whole.set(f, at);
      } else if (!claims.some((c) => c !== null)) claims.fill(at);
    }
  });
  // 3. A partly placed file's other hunks stay with the nearest placed hunk above them (else below).
  for (const claims of owner.values()) {
    if (claims.every((c) => c === null) || claims.every((c) => c !== null)) continue;
    let last: number | null = null;
    for (let k = 0; k < claims.length; k++) claims[k] === null ? (claims[k] = last) : (last = claims[k]!);
    let next: number | null = null;
    for (let k = claims.length - 1; k >= 0; k--) claims[k] === null ? (claims[k] = next) : (next = claims[k]!);
  }

  // Sections in tour order, then what is left; parts in the order their stop first shows them.
  const buckets = order.map(({ stop, i }, at) => ({
    at,
    id: `stop-${i}`,
    stop: i as number | null,
    title: stop.title,
    summary: stop.summary.trim() || null,
    attention: stop.attention !== null,
    files: [] as Array<{ file: DiffFile; hunks: number[] }>,
  }));
  const rest: DiffFile[] = [];
  const seen = (at: number, f: DiffFile) => buckets[at]!.files.find((x) => x.file === f);
  const place = (at: number, f: DiffFile, k: number | null) => {
    const entry = seen(at, f) ?? buckets[at]!.files[buckets[at]!.files.push({ file: f, hunks: [] }) - 1]!;
    if (k !== null) entry.hunks.push(k);
  };
  // Files in the order the stop meets them: its excerpts, then its file list, then the rest by path.
  const met = new Map<number, string[]>();
  order.forEach(({ stop }, at) => met.set(at, [...stop.excerpts.map((e) => e.path), ...stop.files.map((f) => f.path)]));
  const rank = (at: number, path: string) => {
    const i = met.get(at)!.indexOf(path);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  for (const f of [...files].sort(byKindThenPath)) {
    const claims = owner.get(f)!;
    if (claims.length === 0) {
      const at = whole.get(f);
      if (at === undefined) rest.push(f);
      else place(at, f, null);
      continue;
    }
    if (claims.every((c) => c === null)) {
      rest.push(f);
      continue;
    }
    claims.forEach((at, k) => place(at!, f, k));
  }
  const sections = buckets
    .filter((b) => b.files.length > 0)
    .map(({ at, ...b }) => ({ ...b, files: [...b.files].sort((x, y) => rank(at, x.file.path) - rank(at, y.file.path)) }));
  if (rest.length > 0)
    sections.push({ id: "rest", stop: null, title: "Everything else", summary: null, attention: false, files: rest.map((file) => ({ file, hunks: hunksOf(file).map((_, k) => k) })) });
  return withParts(sections);
}

/** Without a tour: code, then tests, then generated files and lockfiles. */
function byKind(files: ReadonlyArray<DiffFile>): Section[] {
  const kinds: FileKind[] = ["code", "test", "generated"];
  return withParts(
    kinds
      .map((kind) => ({
        id: `kind-${kind}`,
        stop: null,
        title: KIND_TITLE[kind],
        summary: null,
        attention: false,
        files: files
          .filter((f) => fileKind(f.path) === kind)
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({ file, hunks: hunksOf(file).map((_, k) => k) })),
      }))
      .filter((s) => s.files.length > 0),
  );
}

/** Numbers each file's pieces across the sections and counts what each piece changes. */
function withParts(sections: ReadonlyArray<Omit<Section, "parts"> & { files: ReadonlyArray<{ file: DiffFile; hunks: ReadonlyArray<number> }> }>): Section[] {
  const total = new Map<DiffFile, number>();
  for (const s of sections) for (const { file } of s.files) total.set(file, (total.get(file) ?? 0) + 1);
  const count = new Map<DiffFile, number>();
  return sections.map(({ files, ...s }, section) => ({
    ...s,
    parts: files.map(({ file, hunks }) => {
      const part = (count.get(file) ?? 0) + 1;
      count.set(file, part);
      const of = total.get(file)!;
      const all = hunksOf(file);
      const sorted = [...hunks].sort((a, b) => a - b);
      // An unsplit file counts the host's numbers (they cover what the patch could not show).
      const additions = of === 1 ? file.additions : sorted.reduce((n, k) => n + all[k]!.additions, 0);
      const deletions = of === 1 ? file.deletions : sorted.reduce((n, k) => n + all[k]!.deletions, 0);
      return { key: `${file.path}#${part}`, file, hunks: sorted, part, of, section, additions, deletions };
    }),
  }));
}

/** Whether a hunk shows any line of [start, end] on `side`. */
export function overlaps(h: Hunk, side: "new" | "old", start: number, end: number): boolean {
  return h.rows.some((r) => {
    const n = side === "new" ? r.newNo : r.oldNo;
    return n !== null && n >= start && n <= end;
  });
}

/** Every part, in page order. */
export const partsOf = (sections: ReadonlyArray<Section>): Part[] => sections.flatMap((s) => s.parts);

/** Lines a reader still has to read: what the parts not yet viewed add and remove. */
export const linesLeft = (parts: ReadonlyArray<Part>, viewed: (part: Part) => boolean): number => parts.reduce((n, p) => (viewed(p) ? n : n + p.additions + p.deletions), 0);

/**
 * Which part shows a line: the part holding the hunk with that line on that side, else the file's first part. Null
 * when no part has the file.
 */
export function partAt(parts: ReadonlyArray<Part>, path: string, line?: number, side: "new" | "old" = "new"): Part | null {
  const mine = parts.filter((p) => p.file.path === path);
  if (mine.length === 0) return null;
  if (line === undefined) return mine[0]!;
  const hunks = hunksOf(mine[0]!.file);
  return mine.find((p) => p.hunks.some((k) => overlaps(hunks[k]!, side, line, line))) ?? mine[0]!;
}

/**
 * Viewed, per part. A file's mark on the host covers every part of it; a split file's parts are marked here first
 * (`local`), and the file goes to the host as viewed once all its parts are.
 */
export function partViewed(part: Part, hostViewed: ReadonlySet<string>, local: ReadonlySet<string>): boolean {
  return hostViewed.has(part.file.path) || local.has(part.key);
}

/**
 * What marking `part` viewed (or not) changes: the local part marks afterwards, and the host write to make, if any.
 * Unmarking a part of a file the host holds as viewed keeps its other parts marked here.
 */
export function markPart(
  part: Part,
  viewed: boolean,
  parts: ReadonlyArray<Part>,
  hostViewed: ReadonlySet<string>,
  local: ReadonlySet<string>,
): { local: Set<string>; host: { path: string; viewed: boolean } | null } {
  const siblings = parts.filter((p) => p.file === part.file);
  const next = new Set(local);
  if (part.of === 1) {
    next.delete(part.key);
    return { local: next, host: hostViewed.has(part.file.path) === viewed ? null : { path: part.file.path, viewed } };
  }
  if (viewed) {
    next.add(part.key);
    const all = siblings.every((p) => next.has(p.key));
    return { local: next, host: all && !hostViewed.has(part.file.path) ? { path: part.file.path, viewed: true } : null };
  }
  next.delete(part.key);
  if (!hostViewed.has(part.file.path)) return { local: next, host: null };
  for (const p of siblings) if (p !== part) next.add(p.key);
  return { local: next, host: { path: part.file.path, viewed: false } };
}

/** For each hunk of a part's file, the part that shows it. */
export function hunkOwners(parts: ReadonlyArray<Part>): Map<DiffFile, Part[]> {
  const owners = new Map<DiffFile, Part[]>();
  for (const p of parts) {
    const list = owners.get(p.file) ?? [];
    for (const k of p.hunks) list[k] = p;
    owners.set(p.file, list);
  }
  return owners;
}

/** How much of one gap of unchanged lines a reader opened: lines from its top and from its bottom. */
export interface Expansion {
  readonly top: number;
  readonly bottom: number;
}

/** A row between hunks: unchanged lines that can be opened, or this file's changes another section shows. */
export type Bar =
  | {
      readonly kind: "gap";
      /** The hunk the gap sits before (the file's hunk count for the tail). */
      readonly gap: number;
      /** Where it sits: before the first hunk, between two, after the last. */
      readonly edge: "top" | "between" | "tail";
      /** Lines still hidden; null while the file's length is unknown (the tail before the file was read). */
      readonly hidden: number | null;
      /** What git says the next hunk sits in ("function parseArgs"), if anything. */
      readonly context: string;
    }
  | { readonly kind: "elsewhere"; readonly changes: number; readonly part: Part };

/**
 * A part's rows in file order: its hunks, the unchanged lines opened around them (`newLines`, the file at the head,
 * once read), a gap bar where lines stay hidden, and an "elsewhere" bar for each run of this file's hunks another
 * section shows. Bars are `hunk` rows (DiffRows draws those through the caller), told apart by `bars`.
 */
export function partRows(
  part: Part,
  owners: ReadonlyArray<Part | undefined>,
  expanded: ReadonlyMap<number, Expansion>,
  newLines: ReadonlyArray<string> | null,
): { rows: DiffLine[]; bars: Map<DiffLine, Bar> } {
  const hunks = hunksOf(part.file);
  const rows: DiffLine[] = [];
  const bars = new Map<DiffLine, Bar>();
  const bar = (b: Bar) => {
    const row: DiffLine = { kind: "hunk", text: "", oldNo: null, newNo: null };
    bars.set(row, b);
    rows.push(row);
  };
  const mine = (k: number) => owners[k] === part;
  // A file added or deleted whole has nothing outside its hunks.
  const gaps = part.file.status !== "added" && part.file.status !== "deleted";
  const gap = (k: number) => {
    const g = gapBefore(hunks, k, newLines?.length);
    if (!g) return;
    const edge = k === 0 ? "top" : k === hunks.length ? "tail" : "between";
    const open = newLines ? (expanded.get(k) ?? { top: 0, bottom: 0 }) : { top: 0, bottom: 0 };
    const size = g.to === null ? null : g.to - g.from + 1;
    const top = size === null ? 0 : Math.min(open.top, size);
    const bottom = size === null ? 0 : Math.min(open.bottom, size - top);
    if (newLines && top > 0) rows.push(...contextRows(newLines, g.from, g.from + top - 1, g.delta));
    const hidden = size === null ? null : size - top - bottom;
    if (hidden !== 0) bar({ kind: "gap", gap: k, edge, hidden, context: hunks[k]?.context ?? "" });
    if (newLines && bottom > 0 && g.to !== null) rows.push(...contextRows(newLines, g.to - bottom + 1, g.to, g.delta));
  };
  for (let k = 0; k < hunks.length; k++) {
    if (!mine(k)) {
      let end = k;
      while (end + 1 < hunks.length && !mine(end + 1)) end++;
      const other = owners[k];
      if (other) bar({ kind: "elsewhere", changes: end - k + 1, part: other });
      k = end;
      continue;
    }
    if (gaps && (k === 0 || mine(k - 1))) gap(k);
    rows.push(...hunks[k]!.rows);
  }
  if (gaps && hunks.length > 0 && mine(hunks.length - 1)) gap(hunks.length);
  return { rows, bars };
}
