// A file's unified diff as rows and hunks, and the words that changed inside a changed line: the desktop's diff
// readers (apps/web/src/panels/diff/parsePatch.ts, hunks.ts and intraline.ts) as they are, for the guide's excerpts and
// its Files. Each hunk is read by its header's counts, so a removed "-- comment" stays content and "\ No newline"
// never counts.

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx";
  /** The line without its +/-/space marker; a hunk row's whole `@@` header. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** One changed file of a pull request, as `pr.diff` sends it. */
export interface DiffFile {
  path: string;
  old_path?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = raw[0];
      if (mark === "+") {
        out.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
        newLeft--;
        continue;
      }
      if (mark === "-") {
        out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
        oldLeft--;
        continue;
      }
      // An empty line is a blank context line whose space a tool trimmed.
      if (mark === " " || raw === "") {
        out.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (mark === "\\") continue;
      oldLeft = newLeft = 0;
    }
    const m = HUNK.exec(raw);
    if (!m) continue;
    oldNo = Number(m[1]);
    newNo = Number(m[3]);
    oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    newLeft = m[4] === undefined ? 1 : Number(m[4]);
    out.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
  }
  return out;
}

const parsed = new WeakMap<DiffFile, DiffLine[]>();

/** The file's rows, parsed once per file object. */
export function linesOf(file: DiffFile): DiffLine[] {
  let lines = parsed.get(file);
  if (!lines) parsed.set(file, (lines = parsePatch(file.patch)));
  return lines;
}

export interface Hunk {
  index: number;
  oldStart: number;
  newStart: number;
  newCount: number;
  /** What git names after the second `@@`: the function or block the hunk sits in, often empty. */
  context: string;
  rows: readonly DiffLine[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const hunkCache = new WeakMap<DiffFile, Hunk[]>();

export function hunksOf(file: DiffFile): Hunk[] {
  const was = hunkCache.get(file);
  if (was) return was;
  const hunks: Hunk[] = [];
  let open: { rows: DiffLine[]; m: RegExpExecArray } | null = null;
  const close = () => {
    if (!open) return;
    const { rows, m } = open;
    hunks.push({ index: hunks.length, oldStart: Number(m[1]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), context: (m[5] ?? "").trim(), rows });
    open = null;
  };
  for (const line of linesOf(file)) {
    if (line.kind === "hunk") {
      close();
      const m = HEADER.exec(line.text);
      if (m) open = { rows: [], m };
    } else open?.rows.push(line);
  }
  close();
  hunkCache.set(file, hunks);
  return hunks;
}

/** The unchanged lines between the end of hunk `i - 1` (or the file's top) and hunk `i`, by new-side numbers. */
export function gapBefore(hunks: readonly Hunk[], i: number): number {
  const next = hunks[i];
  if (!next) return 0;
  const prev = hunks[i - 1];
  const from = prev ? prev.newStart + prev.newCount : 1;
  return Math.max(0, next.newStart - from);
}

// ---------------------------------------------------------------- intraline

/** A changed stretch of a line's text: [start, end) in characters. */
export type Span = readonly [number, number];

/** Words, runs of space, and single punctuation marks: the units a reader compares. */
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;
const MAX_TOKENS = 400;
/** A pair keeps its marks only when at least this share of its characters is common to both lines. */
const MIN_SHARED = 0.4;

const tokens = (text: string): string[] => text.match(TOKEN) ?? [];

/** The changed spans of each line in one removed/added pair, or null when the lines are too unlike to mark. */
export function diffPair(before: string, after: string): { before: Span[]; after: Span[] } | null {
  if (before === after) return { before: [], after: [] };
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
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

/** The changed tokens as spans; changes split only by a space or two read as one stretch, and space alone is never marked. */
function spansOf(parts: readonly string[], kept: readonly boolean[]): Span[] {
  const text = parts.join("");
  const spans: [number, number][] = [];
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

/** Every changed line's spans, by its index in `lines`: a run of removed lines then added ones is paired line by line. */
export function intraline(lines: readonly DiffLine[]): Map<number, Span[]> {
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
