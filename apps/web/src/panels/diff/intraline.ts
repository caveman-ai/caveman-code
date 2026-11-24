// What changed inside a changed line: a run of removed lines followed by a run of added ones is read as edits, the
// i-th removed line against the i-th added one, and the words that differ between them are marked so a reader sees
// "the mode" → "a setting" at a glance instead of two whole lines to compare. Lines too unlike to be one edit (a
// rewrite) get no marks: marking everything says nothing.
import type { DiffLine } from "./parsePatch.ts";

/** A changed stretch of a line's text: [start, end) in characters. */
export type Span = readonly [number, number];

/** Words, runs of space, and single punctuation marks: the units a reader compares. */
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;
/** Past this many tokens on a side a pair is left unmarked (the table is tokens × tokens). */
const MAX_TOKENS = 400;
/** A pair keeps its marks only when at least this share of its characters is common to both lines. */
const MIN_SHARED = 0.4;

const tokens = (text: string): string[] => text.match(TOKEN) ?? [];

/**
 * The changed spans of each line in one removed/added pair, or null when the lines are too unlike to mark (or too
 * long to compare). Equal lines (a whitespace-only change is not equal) have no spans.
 */
export function diffPair(before: string, after: string): { before: Span[]; after: Span[] } | null {
  if (before === after) return { before: [], after: [] };
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  // Longest common subsequence of tokens, then walk it back to tell kept tokens from changed ones.
  const n = a.length;
  const m = b.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) table[at(i, j)] = a[i] === b[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
  const keptA = new Array<boolean>(n).fill(false);
  const keptB = new Array<boolean>(m).fill(false);
  let shared = 0;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      keptA[i] = keptB[j] = true;
      shared += a[i]!.length;
      i++;
      j++;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) i++;
    else j++;
  }
  if (shared / Math.max(before.length, after.length) < MIN_SHARED) return null;
  return { before: spansOf(a, keptA), after: spansOf(b, keptB) };
}

/**
 * The changed tokens as spans. Changes split only by a space or two read as one stretch ("the mode" is one mark, not
 * two); space alone is never marked, so a re-indented line shows no marks.
 */
function spansOf(parts: ReadonlyArray<string>, kept: ReadonlyArray<boolean>): Span[] {
  const text = parts.join("");
  const spans: Array<[number, number]> = [];
  let pos = 0;
  parts.forEach((part, i) => {
    const start = pos;
    pos += part.length;
    if (kept[i] || /^\s+$/.test(part)) return;
    const last = spans[spans.length - 1];
    if (last && /^[ \t]{0,2}$/.test(text.slice(last[1], start))) last[1] = pos;
    else spans.push([start, pos]);
  });
  return spans;
}

/**
 * Every changed line's spans, by its index in `lines`: each run of removed lines directly followed by added lines is
 * paired line by line; the lines of a run with no partner (more added than removed) have none.
 */
export function intraline(lines: ReadonlyArray<DiffLine>): Map<number, Span[]> {
  const marks = new Map<number, Span[]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.kind === "del") i++;
    const addStart = i;
    while (i < lines.length && lines[i]!.kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = diffPair(lines[delStart + k]!.text, lines[addStart + k]!.text);
      if (!d) continue;
      if (d.before.length > 0) marks.set(delStart + k, d.before);
      if (d.after.length > 0) marks.set(addStart + k, d.after);
    }
  }
  return marks;
}
