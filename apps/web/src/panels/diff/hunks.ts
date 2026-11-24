// A file's patch as hunks: where each starts and ends on both sides, its rows, and the unchanged lines between
// hunks a reader can open (Files' "Show N lines"). Parsed once per file object, like linesOf.
import { linesOf, type DiffFile, type DiffLine } from "./parsePatch.ts";

export interface Hunk {
  /** Its place in the file, from 0. */
  readonly index: number;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** What git names after the second `@@`: the function or block the hunk sits in, often empty. */
  readonly context: string;
  /** Its `@@` row in linesOf(file). */
  readonly header: DiffLine;
  /** Its rows, without the header, as linesOf(file) holds them (the same objects). */
  readonly rows: ReadonlyArray<DiffLine>;
  readonly additions: number;
  readonly deletions: number;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const cache = new WeakMap<DiffFile, Hunk[]>();

export function hunksOf(file: DiffFile): Hunk[] {
  let hunks = cache.get(file);
  if (hunks) return hunks;
  hunks = [];
  let open: { header: DiffLine; rows: DiffLine[]; m: RegExpExecArray } | null = null;
  const close = () => {
    if (!open) return;
    const { header, rows, m } = open;
    hunks!.push({
      index: hunks!.length,
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
      context: (m[5] ?? "").trim(),
      header,
      rows,
      additions: rows.filter((r) => r.kind === "add").length,
      deletions: rows.filter((r) => r.kind === "del").length,
    });
    open = null;
  };
  for (const line of linesOf(file)) {
    if (line.kind === "hunk") {
      close();
      const m = HEADER.exec(line.text);
      if (m) open = { header: line, rows: [], m };
    } else open?.rows.push(line);
  }
  close();
  cache.set(file, hunks);
  return hunks;
}

/** The first new-side line after a hunk, and how far new numbering runs ahead of old there. */
export function hunkEnd(h: Hunk): { newLine: number; delta: number } {
  // A hunk with no new lines (`+5,0`) names the line before where it would be.
  const newEnd = h.newCount === 0 ? h.newStart + 1 : h.newStart + h.newCount;
  const oldEnd = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart + h.oldCount;
  return { newLine: newEnd, delta: newEnd - oldEnd };
}

/** The first new-side line of a hunk (for a hunk that adds nothing, where its lines were). */
export const hunkStart = (h: Hunk): number => (h.newCount === 0 ? h.newStart + 1 : h.newStart);

/**
 * The unchanged lines before hunk `i` (new-side numbers, inclusive), and the delta (new − old) that holds in them;
 * `i === hunks.length` is the tail after the last hunk, whose end only the whole file knows (`newLines`, else
 * open-ended: null `to`). Null when nothing lies there.
 */
export function gapBefore(hunks: ReadonlyArray<Hunk>, i: number, newLines?: number): { from: number; to: number | null; delta: number } | null {
  const prev = i > 0 ? hunks[i - 1] : undefined;
  const start = prev ? hunkEnd(prev) : { newLine: 1, delta: 0 };
  const next = hunks[i];
  if (next) {
    const to = hunkStart(next) - 1;
    // The delta read off the next hunk's own start: old and new agree on it whatever came before.
    const delta = hunkStart(next) - (next.oldCount === 0 ? next.oldStart + 1 : next.oldStart);
    return to >= start.newLine ? { from: start.newLine, to, delta } : null;
  }
  if (newLines === undefined) return { from: start.newLine, to: null, delta: start.delta };
  return newLines >= start.newLine ? { from: start.newLine, to: newLines, delta: start.delta } : null;
}

/** Unchanged rows `from`..`to` (new-side numbers) taken from the file at its head. */
export function contextRows(newText: ReadonlyArray<string>, from: number, to: number, delta: number): DiffLine[] {
  const out: DiffLine[] = [];
  for (let n = from; n <= to && n <= newText.length; n++) out.push({ kind: "ctx", text: newText[n - 1] ?? "", oldNo: n - delta, newNo: n });
  return out;
}

/** A file's text as lines, without the empty one a trailing newline leaves. */
export function fileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}
