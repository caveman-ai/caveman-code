// Fenced code in engine markdown, read line by line the same way by the image
// reader (markdown-images.ts) and the streaming splitter's display-math look-ahead
// (markdown-blocks.ts): a line inside a fence is code to both.

/** An open fence: its marker and its opener's indent in columns. */
export interface Fence {
  readonly marker: string;
  readonly indent: number;
}

const FENCE_LINE = /^(\s*)(`{3,}|~{3,})/;

/** Leading whitespace's width in columns, a tab reaching the next multiple of four (CommonMark's tab stops). */
const columns = (lead: string) =>
  [...lead].reduce((col, c) => (c === "\t" ? col + 4 - (col % 4) : col + 1), 0);

/** The fence open after `line`, given the one open before it. A line is code when either is set. */
export function fenceAfter(open: Fence | null, line: string): Fence | null {
  const f = FENCE_LINE.exec(line);
  if (!open) return f ? { marker: f[2]!, indent: columns(f[1]!) } : null;
  // A closer indented four columns past the opener is the fence's text (CommonMark allows three past its
  // container; the opener's indent stands in for a list item's, which neither reader tracks).
  const closes =
    f !== null &&
    f[2]![0] === open.marker[0] &&
    f[2]!.length >= open.marker.length &&
    line.trim() === f[2] &&
    columns(f[1]!) < open.indent + 4;
  return closes ? null : open;
}
