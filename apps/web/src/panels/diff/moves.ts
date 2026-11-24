// Code that moved: a block of removed lines that comes back, line for line (indentation aside), as added lines
// somewhere else in the change. Shown as a move, not as a wall of red here and a wall of green there, each end
// pointing at the other. A block reworked in place (removed and re-added at the same spot, only its indentation
// changed) is an edit, not a move, and is left to the word marks.
import { linesOf, type DiffFile, type DiffLine } from "./parsePatch.ts";

/** One end of a move: where the block went (on removed rows) or came from (on added rows). */
export interface MoveMark {
  readonly to: { readonly path: string; readonly line: number; readonly side: "old" | "new" };
  /** The block's first row: it carries the label. */
  readonly first: boolean;
  /** Lines in the block. */
  readonly size: number;
}

/** A block must carry at least this many lines with something in them to be called a move. */
const MIN_LINES = 3;
/** Candidates tried per removed line: a common line ("return null;") appears everywhere. */
const MAX_CANDIDATES = 24;

const norm = (text: string) => text.trim();
/** A line that says nothing alone: blank, a brace, a bracket. */
const trivial = (text: string) => text.length < 4 || /^[\s{}()[\];,]*$/.test(text);

interface At {
  readonly file: DiffFile;
  readonly rows: ReadonlyArray<DiffLine>;
  readonly i: number;
}

/** Every moved row of the change, keyed by the row object (linesOf's rows, stable per file). */
export function findMoves(files: ReadonlyArray<DiffFile>): Map<DiffLine, MoveMark> {
  const marks = new Map<DiffLine, MoveMark>();
  const added = new Map<string, At[]>();
  const all = files.map((file) => ({ file, rows: linesOf(file) }));
  for (const { file, rows } of all)
    rows.forEach((row, i) => {
      if (row.kind !== "add") return;
      const key = norm(row.text);
      if (trivial(key)) return;
      const list = added.get(key);
      if (list) list.length < MAX_CANDIDATES && list.push({ file, rows, i });
      else added.set(key, [{ file, rows, i }]);
    });
  if (added.size === 0) return marks;

  for (const { file, rows } of all) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.kind !== "del" || marks.has(row) || trivial(norm(row.text))) continue;
      let best: { at: At; length: number; weight: number } | null = null;
      for (const at of added.get(norm(row.text)) ?? []) {
        if (marks.has(at.rows[at.i]!)) continue;
        let length = 0;
        let weight = 0;
        for (;;) {
          const d = rows[i + length];
          const a = at.rows[at.i + length];
          if (!d || !a || d.kind !== "del" || a.kind !== "add" || marks.has(d) || marks.has(a) || norm(d.text) !== norm(a.text)) break;
          if (!trivial(norm(d.text))) weight++;
          length++;
        }
        if (weight < MIN_LINES || inPlace(file, rows, i, at)) continue;
        if (!best || weight > best.weight) best = { at, length, weight };
      }
      if (!best) continue;
      const { at, length } = best;
      const from = { path: file.path, line: row.oldNo ?? 0, side: "old" as const };
      const to = { path: at.file.path, line: at.rows[at.i]!.newNo ?? 0, side: "new" as const };
      for (let k = 0; k < length; k++) {
        marks.set(rows[i + k]!, { to, first: k === 0, size: length });
        marks.set(at.rows[at.i + k]!, { to: from, first: k === 0, size: length });
      }
      i += length - 1;
    }
  }
  return marks;
}

/**
 * The added block sits where the removed one stood: the same file, the added run right after the removed run that
 * holds row `i`, at the same offset into it. That is a re-indent or rewrap, not a move.
 */
function inPlace(file: DiffFile, rows: ReadonlyArray<DiffLine>, i: number, at: At): boolean {
  if (at.file !== file) return false;
  let start = i;
  while (start > 0 && rows[start - 1]!.kind === "del") start--;
  let end = i;
  while (end < rows.length && rows[end]!.kind === "del") end++;
  return at.i === end + (i - start);
}
