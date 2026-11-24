// The unfinished end of a streaming reply, made safe to render: what is drawn now is what the finished text will
// draw there, so nothing reshapes as the rest arrives (the runtime streams text as it comes, README.md).
// Response applies it to the last block only; every finished block above it is already stable.
//
//   - A line still being written that is only the start of a block marker ("-", "1.", "##", "```ts", "|", ">",
//     "- [x")
//     waits for its first words: shown now, it would draw as text and then jump into a list, heading or fence.
//   - Inside an open code fence every line shows: an unclosed fence already draws as a code block that grows.
//     A line that may be its closing fence waits.
//   - A table shows once its header and delimiter rows are complete, then grows a whole row at a time; before
//     that its rows would draw as a paragraph of pipes.
//   - Emphasis, strikethrough and inline code the unfinished paragraph opened are closed for the draw ("the
//     **impor" draws "the **impor**"), and a link whose target is still arriving draws as its text.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// Only a block marker so far, no words yet: wait for the line's first words.
const MARKER_ONLY = /^ {0,3}(?:[-*+_=]+|\d{1,9}[.)]?|#{1,6}|>|`{1,2}|~{1,2}|\|[-:| ]*|(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]?\]?)?[ \t]*$/;
const TABLE_ROW = /^ {0,3}\|/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// A line that starts a new block: inline markup never runs across one.
const BLOCK_START = /^[ \t]*$|^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]|^ {0,3}#{1,6}[ \t]|^ {0,3}>/;

export function stableStreamingTail(md: string): string {
  const lines = md.split("\n");
  let partial = lines.pop()!;
  // Fences over the finished lines: inside an open one, the rest is code.
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
    } else if (f) fence = f[1]!;
  }
  if (fence) {
    const closing = partial.trim();
    const mayClose = closing.length > 0 && [...closing].every((c) => c === fence![0]);
    return [...lines, mayClose ? "" : partial].join("\n");
  }
  // Also once an inline marker is cut from its end ("- `", "1. **"): an empty item would turn the line above into a
  // heading (a lone "-" under a paragraph is a setext underline).
  if (MARKER_ONLY.test(partial) || MARKER_ONLY.test(partial.replace(/[*_~`!]+$/, "")) || FENCE.test(partial)) partial = "";
  // A table: rows from the last line that is not one; held until its delimiter row is whole, then row by row.
  let rowStart = lines.length;
  while (rowStart > 0 && TABLE_ROW.test(lines[rowStart - 1]!)) rowStart--;
  const rows = lines.length - rowStart;
  const partialIsRow = TABLE_ROW.test(partial);
  if (rows > 0 || partialIsRow) {
    const started = rows >= 2 && DELIMITER_ROW.test(lines[rowStart + 1]!);
    if (!started && rows > 0 && (rowStart === 0 || BLOCK_START.test(lines[rowStart - 1]!) || lines[rowStart - 1]!.trim() === "")) {
      return trimEnd(lines.slice(0, rowStart).join("\n"));
    }
    if (partialIsRow) return lines.join("\n");
  }
  // The paragraph (or list item) still being written: inline markup runs from the last line that started a block.
  const all = partial === "" ? lines : [...lines, partial];
  const newline = partial === "" && lines.length > 0 ? "\n" : "";
  if (all.length === 0 || all.at(-1)!.trim() === "") return [...lines, partial].join("\n");
  let start = all.length - 1;
  while (start > 0 && !BLOCK_START.test(all[start]!) && all[start - 1]!.trim() !== "") start--;
  const head = all.slice(0, start);
  return [...head, closeInline(all.slice(start).join("\n"))].join("\n") + newline;
}

const trimEnd = (s: string) => s.replace(/[ \t]+$/, "");

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isPunct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

/** Closes, for the draw, the emphasis, strikethrough, code span and link the unfinished paragraph left open. */
export function closeInline(paragraph: string): string {
  // A marker run at the very end: an opener with no words yet ("see **") waits for them, and a closer that may be
  // half there ("**bold*") is dropped and closed again below, whole.
  // A lone "!" after a space may open an image.
  let text = paragraph.replace(/[*_~`]+$/, "").replace(/(^|\s)!$/, "$1");
  const open: Array<string> = [];
  let link: { at: number; image: boolean } | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const run = "`".repeat(n);
      const close = findRun(text, run, i + n);
      if (close === -1) {
        // The rest is code until its closing run arrives.
        return finish(text + run, open, link);
      }
      i = close + n;
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let n = 1;
      while (text[i + n] === c) n++;
      const before = text[i - 1];
      const after = text[i + n];
      const rightFlanking = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const leftFlanking = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      // Underscores inside a word (snake_case) neither open nor close.
      const canClose = rightFlanking && (c !== "_" || !leftFlanking || isPunct(after));
      const canOpen = leftFlanking && (c !== "_" || !rightFlanking || isPunct(before));
      if (c === "~" && n !== 2) {
        i += n;
        continue;
      }
      const markers = c === "~" ? ["~~"] : n >= 3 ? [c, c + c] : [c.repeat(n)];
      let closed = false;
      if (canClose) {
        for (const m of [...markers].reverse()) {
          const at = open.lastIndexOf(m);
          if (at !== -1) {
            open.splice(at);
            closed = true;
          }
        }
      }
      if (!closed && canOpen) open.push(...markers);
      i += n;
      continue;
    }
    if (c === "[") {
      link = { at: i, image: text[i - 1] === "!" };
      i++;
      continue;
    }
    if (c === "]" && link !== null) {
      if (text[i + 1] === "(" || i + 1 === text.length) {
        // "[text]" at the very end may still get its "(target)".
        const end = i + 1 === text.length ? -1 : text.indexOf(")", i + 2);
        if (end === -1) {
          // The target is still arriving: the link draws as its text, an image not at all.
          const label = text.slice(link.at + 1, i);
          text = link.image ? text.slice(0, link.at - 1) : text.slice(0, link.at) + label;
          return finish(text, open, null);
        }
        i = end + 1;
      } else i++;
      link = null;
      continue;
    }
    i++;
  }
  return finish(text, open, link);
}

function findRun(text: string, run: string, from: number): number {
  for (let at = text.indexOf(run, from); at !== -1; at = text.indexOf(run, at + 1)) {
    if (text[at - 1] !== "`" && text[at + run.length] !== "`") return at;
  }
  return -1;
}

function finish(text: string, open: ReadonlyArray<string>, link: { at: number; image: boolean } | null): string {
  let out = text;
  // A link whose text is still arriving draws as that text so far; an image whose alt text is still arriving
  // draws nothing yet.
  if (link !== null) out = link.image ? out.slice(0, link.at - 1) : out.slice(0, link.at) + out.slice(link.at + 1);
  // Close what is open, innermost first, without leaving the closer after a space ("**bold **" would not close).
  const trailing = /\s*$/.exec(out)![0];
  out = out.slice(0, out.length - trailing.length);
  if (out.length === 0) return trailing;
  return out + [...open].reverse().join("") + trailing;
}
