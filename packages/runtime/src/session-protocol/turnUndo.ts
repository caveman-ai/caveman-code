// The Changes card's Undo (checkpoint.undo), using compact styling, upstream
// src-tauri/src/checkpoint/turn.rs `changes` and `restorable`): the files a finished turn changed go back to the
// checkpoint taken as it began, and only while each is still exactly what the turn left. A file that changed again
// since (the person, another turn, another program) blocks the whole Undo, so nothing is half put back.
import * as fs from "node:fs";
import * as path from "node:path";

export interface Blob {
  readonly mode: string;
  readonly oid: string;
}

/** One file between the turn's two checkpoints; `null` where it did not exist. Paths are from the repository's top. */
export interface TurnChange {
  readonly path: string;
  readonly before: Blob | null;
  readonly after: Blob | null;
}

/** `git diff --raw -z --no-renames --no-abbrev` output: `:<mode> <mode> <oid> <oid> <status>\0<path>\0` per file. */
export function parseRawDiff(stdout: string): Array<TurnChange> {
  const parts = stdout.split("\0");
  const out: Array<TurnChange> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const header = parts[i]!;
    if (!header.startsWith(":")) break;
    const [srcMode, dstMode, srcOid, dstOid] = header.slice(1).split(" ");
    const blob = (mode: string | undefined, oid: string | undefined) => (mode && oid && mode !== "000000" ? { mode, oid } : null);
    out.push({ path: parts[i + 1]!, before: blob(srcMode, srcOid), after: blob(dstMode, dstOid) });
  }
  return out;
}

// Windows limits a command line to 32,767 characters (CheckpointDiffQuery's batches).
const MAX_PATH_CHARS = 24_000;

/** Paths split into lists that each fit on one git command line. */
export function pathBatches(paths: ReadonlyArray<string>): Array<Array<string>> {
  const batches: Array<Array<string>> = [];
  let batch: Array<string> = [];
  let length = 0;
  for (const p of paths) {
    if (batch.length > 0 && length + p.length + 1 > MAX_PATH_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(p);
    length += p.length + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** `a/b/c` → `a`, `a/b`. */
export function parentsOf(file: string): Array<string> {
  const parts = file.split("/");
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** What is at `file`, not following a link; undefined when nothing is, a file on the way included (lstat's ENOTDIR). */
export function entryAt(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Whether every file under the directory `dir` (the repository's `rel`) is one in `made`. */
function holdsOnly(dir: string, rel: string, made: ReadonlySet<string>): boolean {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .every((entry) => (entry.isDirectory() ? holdsOnly(path.join(dir, entry.name), `${rel}/${entry.name}`, made) : made.has(`${rel}/${entry.name}`)));
}

const REGULAR = new Set(["100644", "100755"]);

/**
 * Why `change` cannot go back, or null when it can: the file must be what the turn left (its blob, its mode; gone if
 * the turn deleted it), a regular file on both sides, and reached without a link. `worktreeOid` is `git hash-object`
 * of the file as it is now (absent when it is not a regular file). `made` is every file the turn added, which may
 * stand where a file it deleted was, or where a directory holding it was. `fileMode` is the repository's core.fileMode:
 * whether the checkpoint recorded the execute bit at all.
 */
export function undoBlocker(top: string, change: TurnChange, worktreeOid: string | undefined, made: ReadonlySet<string>, fileMode = true): "link" | "changed" | null {
  if ((change.before && !REGULAR.has(change.before.mode)) || (change.after && !REGULAR.has(change.after.mode))) return "link";
  // git names the top with forward slashes on Windows.
  const root = path.resolve(top);
  const file = path.join(root, change.path);
  let fileOnTheWay: string | undefined;
  for (const dir of parentsOf(change.path)) {
    const stat = entryAt(path.join(root, dir));
    // A directory on the way that is a link would put the write somewhere else.
    if (stat?.isSymbolicLink()) return "link";
    if (stat && !stat.isDirectory()) fileOnTheWay = dir;
  }
  if (fileOnTheWay !== undefined) return change.after === null && made.has(fileOnTheWay) ? null : "changed";
  const stat = entryAt(file);
  // A directory where the turn deleted a file is the turn's while it holds only what the turn made: putting the file
  // back takes the whole directory away.
  if (change.after === null) return !stat || (stat.isDirectory() && holdsOnly(file, change.path, made)) ? null : "changed";
  if (!stat?.isFile()) return "changed";
  // As git records it: the owner's execute bit alone. With core.fileMode off (always on Windows, which has no execute
  // bit) git keeps the index's mode whatever the disk says, so only the contents can tell.
  const mode = process.platform === "win32" || !fileMode ? change.after.mode : stat.mode & 0o100 ? "100755" : "100644";
  return mode !== change.after.mode || worktreeOid !== change.after.oid ? "changed" : null;
}

/** "a.md", "a.md and b.md", "a.md, b.md and 3 more files". */
export function fileList(paths: ReadonlyArray<string>): string {
  if (paths.length <= 2) return paths.join(" and ");
  return `${paths.slice(0, 2).join(", ")} and ${paths.length - 2} more ${paths.length === 3 ? "file" : "files"}`;
}
