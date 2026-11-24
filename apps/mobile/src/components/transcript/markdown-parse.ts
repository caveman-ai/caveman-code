// The markdown engines write, read into blocks and inline runs for Markdown.tsx to set: paragraphs, headings, lists
// (task lists too), quotes, rules, fenced code with its language or file, and tables. Inline: **bold**, *italic*,
// `code`, [links](…), bare addresses, and a chat named by its id ([[chat-id]], as a Chief writes them; `text` is the
// id). Pure, so a test can read it without React Native.

export type Inline = { kind: "text" | "bold" | "italic" | "code" | "link" | "ref"; text: string; href?: string };
export type ListItem = { inlines: Inline[]; checked?: boolean; depth: number };
export type Block =
  | { kind: "p"; inlines: Inline[] }
  | { kind: "h"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "code"; language: string | null; file: string | null; code: string }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "hr" };

const INLINE = /(\[\[[\w.-]+\]\]|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]*[^\s).,;:!?]|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))/;

function inlines(text: string): Inline[] {
  const out: Inline[] = [];
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (/^\[\[[\w.-]+\]\]$/.test(part)) out.push({ kind: "ref", text: part.slice(2, -2) });
    else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ kind: "bold", text: part.slice(2, -2) });
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push({ kind: "code", text: part.slice(1, -1) });
    else if (/^\[[^\]]+\]\([^)\s]+\)$/.test(part)) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)!;
      out.push({ kind: "link", text: m[1]!, href: m[2]! });
    } else if (/^https?:\/\//.test(part)) out.push({ kind: "link", text: part, href: part });
    else if (/^(\*[^*].*\*|_[^_].*_)$/.test(part)) out.push({ kind: "italic", text: part.slice(1, -1) });
    else out.push({ kind: "text", text: part });
  }
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => inlines(cell.trim()));

/** The markdown engines write, read into blocks. A fence still streaming (no closing ```) is a block all the same. */
export function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```\s*([\w#+-]*)\s*(.*)$/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) body.push(lines[i++]!);
      i++;
      const title = /title="([^"]+)"/.exec(fence[2] ?? "");
      blocks.push({ kind: "code", language: fence[1] || null, file: title?.[1] ?? null, code: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1]!.length, inlines: inlines(heading[2]!) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", inlines: inlines(quoted.join(" ")) });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const items: ListItem[] = [];
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m) {
          // A wrapped line carries on the item above it.
          if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
            items.at(-1)!.inlines.push({ kind: "text", text: ` ${lines[i]!.trim()}` });
            i++;
            continue;
          }
          break;
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!);
        items.push({ inlines: inlines(task ? task[2]! : m[3]!), checked: task ? task[1] !== " " : undefined, depth: Math.min(2, Math.floor(m[1]!.length / 2)) });
        i++;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    if (!para.length) para.push(lines[i++]!.trim());
    blocks.push({ kind: "p", inlines: inlines(para.join(" ")) });
  }
  return blocks;
}


const TABLE_ROW = /^\s*\|/;
const DELIMITER = /^\s*\|?[\s:|-]+\|?\s*$/;

/**
 * What of a streaming answer is ready to set: a table waits whole until its delimiter row is in, so no frame shows a
 * raw "|" line or a header with nothing under it. Once it is in, the row still arriving is set as its words arrive (its
 * open end closed, so it reads as a row and never as a "|" line); only a row with no words yet waits.
 */
export function holdBack(text: string): string {
  let lines = text.split("\n");
  const tail = lines.at(-1) ?? "";
  if (TABLE_ROW.test(tail)) {
    lines = lines.slice(0, -1);
    // A row on its way into a table already under way: set with what it has.
    const above = lines.length;
    let top = above;
    while (top > 0 && TABLE_ROW.test(lines[top - 1]!)) top--;
    const ready = above - top >= 2 && DELIMITER.test(lines[top + 1]!) && lines[top + 1]!.includes("-");
    const words = tail.replace(/\|/g, "").trim();
    if (ready && words && !DELIMITER.test(tail)) lines.push(/\|\s*$/.test(tail) ? tail : `${tail.replace(/\s+$/, "")} |`);
  }
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  let start = end;
  while (start > 0 && TABLE_ROW.test(lines[start - 1]!)) start--;
  const table = lines.slice(start, end);
  if (table.length && !(table.length >= 2 && DELIMITER.test(table[1]!) && table[1]!.includes("-"))) lines = lines.slice(0, start);
  return lines.join("\n");
}
