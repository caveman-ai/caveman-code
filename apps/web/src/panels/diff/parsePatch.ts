// One file's unified diff (fs.diff's `patch`) as rows. Ported from the
// previous ChangesPanel (WorkspacePanels.tsx @ b48720e) and tightened: each
// hunk is read by its header's counts, so a deleted "-- comment" or an added
// "++ x" stays content, header lines (index, mode, rename, "Binary files")
// never become rows, and "\ No newline at end of file" never counts.

export interface DiffLine {
  readonly kind: "hunk" | "add" | "del" | "ctx";
  /** The line without its +/-/space marker; a hunk row's whole `@@` header. */
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
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
      // Anything else ends a short hunk; read it as a header below.
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

/** The widest line number, for sizing the gutters. */
export function maxLineNo(lines: ReadonlyArray<DiffLine>): number {
  let max = 0;
  for (const l of lines) max = Math.max(max, l.oldNo ?? 0, l.newNo ?? 0);
  return max;
}

/** What fs.diff returns per file. */
export interface DiffFile {
  readonly path: string;
  readonly old_path?: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

export interface Diff {
  readonly from: string;
  readonly to: string;
  readonly files: ReadonlyArray<DiffFile>;
}

/** Files above this many patch lines start collapsed: fs.diff has no size cap (lockfiles, generated code). */
export const LARGE_LINES = 2000;

const lineCounts = new WeakMap<DiffFile, number>();

/** The patch's line count, counted once per file object. */
export function patchLines(file: DiffFile): number {
  let n = lineCounts.get(file);
  if (n === undefined) {
    n = 0;
    for (let i = file.patch.indexOf("\n"); i >= 0; i = file.patch.indexOf("\n", i + 1)) n++;
    lineCounts.set(file, n);
  }
  return n;
}

const parsed = new WeakMap<DiffFile, DiffLine[]>();

/** The file's rows, parsed once per file object. */
export function linesOf(file: DiffFile): DiffLine[] {
  let lines = parsed.get(file);
  if (!lines) parsed.set(file, (lines = parsePatch(file.patch)));
  return lines;
}

/**
 * A reload keeps the previous object for every file whose patch didn't change, so its rows don't
 * re-render or re-parse, and the previous diff itself when nothing changed at all.
 */
export function reuseUnchanged(prev: Diff | null, next: Diff): Diff {
  if (!prev) return next;
  const old = new Map(prev.files.map((f) => [f.path, f]));
  const files = next.files.map((f) => {
    const o = old.get(f.path);
    return o && o.patch === f.patch && o.status === f.status && o.old_path === f.old_path && o.additions === f.additions && o.deletions === f.deletions ? o : f;
  });
  const same = prev.from === next.from && prev.to === next.to && files.length === prev.files.length && files.every((f, i) => f === prev.files[i]);
  return same ? prev : { from: next.from, to: next.to, files };
}
