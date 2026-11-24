// The Files surface's pure logic: the tree's visible rows from cached
// listings, reveal paths, markdown link resolution, fuzzy-match highlights,
// file kinds and a small CSV reader. No React, no runtime; tree.test.ts runs it.

export type EntryType = "file" | "dir" | "symlink";

export interface Entry {
  readonly name: string;
  readonly path: string;
  readonly type: EntryType;
  readonly size?: number;
  readonly ignored?: boolean;
}

export interface Listing {
  readonly entries: ReadonlyArray<Entry>;
  readonly truncated: boolean;
}

export type Row =
  | {
      readonly kind: "entry";
      readonly key: string;
      readonly entry: Entry;
      readonly depth: number;
      readonly expanded: boolean;
      /** Position among its siblings, for aria-posinset/aria-setsize (rows outside the window are not in the DOM). */
      readonly pos: number;
      readonly size: number;
    }
  | { readonly kind: "result"; readonly key: string; readonly path: string; readonly matches: ReadonlyArray<number>; readonly pos: number; readonly size: number }
  | { readonly kind: "note"; readonly key: string; readonly depth: number; readonly dir: string; readonly text: string; readonly error: boolean };

/** Depth-first: each expanded, listed folder's children follow it. A folder still loading shows nothing under it yet. */
export function visibleRows(listings: ReadonlyMap<string, Listing>, expanded: ReadonlySet<string>, errors: ReadonlyMap<string, string> = new Map()): Row[] {
  const rows: Row[] = [];
  const visit = (dir: string, depth: number) => {
    const error = errors.get(dir);
    const listing = listings.get(dir);
    if (!listing) {
      if (error !== undefined) rows.push({ kind: "note", key: `note:${dir}`, depth, dir, text: error, error: true });
      return;
    }
    const n = listing.entries.length;
    listing.entries.forEach((entry, i) => {
      const open = entry.type === "dir" && expanded.has(entry.path);
      rows.push({ kind: "entry", key: entry.path, entry, depth, expanded: open, pos: i + 1, size: n });
      if (open) visit(entry.path, depth + 1);
    });
    if (listing.truncated) rows.push({ kind: "note", key: `note:${dir}`, depth, dir, text: "More entries not shown", error: false });
    else if (n === 0 && depth > 0) rows.push({ kind: "note", key: `note:${dir}`, depth, dir, text: "Empty folder", error: false });
  };
  visit("", 0);
  return rows;
}

/** The folders that hold a path, outermost first, root excluded: "a/b/c.ts" -> ["a", "a/b"]. */
export function parentDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;
/** A workspace path under the worktree root (This Mac only; `root_path`). */
/** A workspace path as its computer writes paths: backslashes when the folder is on Windows (T3 #19201), else as given. */
export const nativePath = (root: string | null | undefined, path: string) => (root && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root) ? path.replaceAll("/", "\\") : path);
export const absolutePath = (root: string, path: string) => nativePath(root, path ? `${root.replace(/[\\/]+$/, "")}/${path}` : root);
export const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export type LinkTarget =
  | { readonly kind: "external"; readonly href: string }
  /** Any other scheme (javascript:, data:, file:, protocol-relative //host): never followed. */
  | { readonly kind: "blocked" }
  | { readonly kind: "anchor"; readonly id: string }
  | { readonly kind: "file"; readonly path: string; readonly line?: number };

/**
 * Where a link in a workspace markdown file goes. Only http(s) and mailto
 * leave the app. Relative paths resolve against the file's folder, `/x`
 * against the workspace root (GitHub's reading), `#L12` picks a line. Null:
 * it leaves the workspace.
 */
export function resolveLink(fromFile: string, href: string): LinkTarget | null {
  const h = href.trim();
  if (h.startsWith("#")) return { kind: "anchor", id: safeDecode(h.slice(1)) };
  if (/^(https?|mailto):/i.test(h)) return { kind: "external", href: h };
  const [beforeHash = "", rawHash = ""] = h.split("#", 2);
  // The renderer percent-encodes every destination (`%5C%5Chost%5Cshare`): decoded once, here, it is the path it names, and
  // every check below reads that path, never a form a later decode could turn into a share.
  const path = safeDecode(beforeHash.split("?", 1)[0] ?? "");
  const hash = safeDecode(rawHash);
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/][\\/]|\\)/i.test(path)) return { kind: "blocked" };
  if (!path) return hash ? { kind: "anchor", id: hash } : null;
  const file = path.startsWith("/") ? workspaceJoin("", path.slice(1)) : workspaceJoin(dirName(fromFile), path);
  if (file === null) return null;
  const line = /^L(\d+)/.exec(hash)?.[1];
  return { kind: "file", path: file, ...(line ? { line: Number(line) } : {}) };
}

/** Names the host, not a file in the workspace: a root, a share (`\\host`), a drive (`C:\`, drive-relative `D:x`) or a scheme. */
const HOST_PATH = /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i;

/**
 * `path` (decoded, `/` between names) in the workspace folder `dir`, with `.`
 * and `..` resolved. Null when it climbs out of the workspace, or when it
 * names the host before or after joining (`./\\host\share`, `a/../D:x`): a
 * Windows runtime resolves such a path, and reaches the share, before its
 * containment check can refuse it.
 */
export function workspaceJoin(dir: string, path: string): string | null {
  if (HOST_PATH.test(path)) return null;
  const parts = dir.split("/").filter(Boolean);
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") parts.push(seg);
    else if (parts.pop() === undefined) return null;
  }
  const joined = parts.join("/");
  return joined && !HOST_PATH.test(joined) ? joined : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Which characters of `path` a fuzzy `query` matched, for highlighting a
 * search result. Each word of the query on its own: a contiguous hit in the
 * file name, else anywhere in the path, else a subsequence taken from the
 * right so it lands in the name.
 */
// ponytail: a heuristic, not the runtime's scorer; it can mark different letters than the ones fs.search ranked on.
export function matchIndices(path: string, query: string): number[] {
  const p = path.toLowerCase();
  const nameAt = p.lastIndexOf("/") + 1;
  const out = new Set<number>();
  for (const q of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const range = (at: number) => q.split("").forEach((_, i) => out.add(at + i));
    const inName = p.indexOf(q, nameAt);
    const anywhere = p.lastIndexOf(q);
    if (inName >= 0) range(inName);
    else if (anywhere >= 0) range(anywhere);
    else {
      const hits: number[] = [];
      let j = p.length - 1;
      for (let i = q.length - 1; i >= 0 && j >= 0; i--, j--) {
        while (j >= 0 && p[j] !== q[i]) j--;
        if (j >= 0) hits.push(j);
      }
      if (hits.length === q.length) hits.forEach((h) => out.add(h));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** The next row (after `from`, wrapping) whose name starts with `prefix`; -1 when none does. */
export function typeAhead(rows: ReadonlyArray<Row>, from: number, prefix: string): number {
  const p = prefix.toLowerCase();
  // One repeated letter cycles through the rows that start with it.
  const step = p.length === 1 || [...p].every((c) => c === p[0]) ? 1 : 0;
  const q = step && p.length > 1 ? p[0]! : p;
  for (let k = 0; k < rows.length; k++) {
    const i = (from + step + k + rows.length) % rows.length;
    const row = rows[i]!;
    const name = row.kind === "entry" ? row.entry.name : row.kind === "result" ? baseName(row.path) : "";
    if (name.toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

export type FileKind = "markdown" | "image" | "table" | "diagram" | "media" | "font" | "text";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

const ext = (path: string) => {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function fileKind(path: string): FileKind {
  const e = ext(path);
  if (e === "md" || e === "mdx" || e === "markdown") return "markdown";
  if (e in IMAGE_TYPES) return "image";
  if (e === "csv" || e === "tsv") return "table";
  if (e === "mmd" || e === "mermaid") return "diagram";
  if (e in MEDIA_TYPES) return "media";
  if (e in FONT_TYPES) return "font";
  return "text";
}

/** Audio and video the viewer plays, and fonts it sets a sample in (T3 #21363, #21362), by extension. */
const MEDIA_TYPES: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  aif: "audio/aiff", aiff: "audio/aiff", weba: "audio/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg",
};
const FONT_TYPES: Record<string, string> = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };
export const mediaType = (path: string): string => MEDIA_TYPES[ext(path)] ?? "application/octet-stream";
export const fontType = (path: string): string => FONT_TYPES[ext(path)] ?? "font/ttf";

export const imageType = (path: string): string => IMAGE_TYPES[ext(path)] ?? "application/octet-stream";

export function formatBytes(n: number): string {
 // The unit is picked after rounding: 1023.6 KB reads "1 MB", never "1024 KB" (upstream #26067).
  if (Math.round(n) < 1024) return `${Math.round(n)} B`;
  const kb = Math.round(n / 1024);
  if (kb < 1024) return `${kb} KB`;
  const shown = (v: number) => v.toFixed(v < 9.95 ? 1 : 0).replace(/\.0$/, "");
  const mb = shown(n / 1024 ** 2);
  return Number(mb) < 1024 ? `${mb} MB` : `${shown(n / 1024 ** 3)} GB`;
}

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. Stops reading at the caps. */
export function parseDelimited(text: string, delimiter: "," | "\t", maxRows = 200, maxCols = 30): { rows: string[][]; moreRows: boolean; moreCols: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let moreCols = false;
  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else moreCols = true;
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endField();
      rows.push(row);
      row = [];
      // One row past the cap tells us there is more.
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), moreRows: true, moreCols };
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    endField();
    rows.push(row);
  }
  return { rows: rows.slice(0, maxRows), moreRows: rows.length > maxRows, moreCols };
}
