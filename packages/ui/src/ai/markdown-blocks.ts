// A growing reply's markdown, cut into its top-level blocks so a renderer can memoize each one and re-parse only the
// end still being written (Response, Markdown while streaming).
//
// The cuts come from the markdown parser itself, not a guess at blank lines, and every block draws on its own from
// its first character: a heading or list that starts below a paragraph is never first drawn inside it and then
// rebuilt elsewhere, so nothing on screen is replaced (a word that faded in never fades again).
//
// Each call parses only from the first block that may still change. In CommonMark a top-level block, once the next
// one starts, is closed for good: later text can't reopen it. The exceptions are document-wide (link and footnote
// definitions), and those keep the whole text as one block. A block that starts on the last line, still being
// written, can still fold back into the one above ("para\n#" is a paragraph and a heading, "para\n#x" one
// paragraph), so only a block whose successor starts on a finished line counts as closed. Display math is the other
// look-ahead: llm-math reads a `$$` or `\[` block only once its closer arrives (until then its lines are paragraphs),
// so nothing from an unclosed opener on closes. (upstream markdown-incremental.ts keeps a closed prefix the same
// way, at closed code fences.)
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { mayContainMath } from "@caveman-app/shared/markdownMath";
import { fenceAfter, type Fence } from "./fence.ts";

export interface MarkdownBlock {
  readonly text: string;
  /** The number of lines in the source before the block. */
  readonly offset: number;
}

interface Node {
  readonly type: string;
  readonly position?: { readonly start: { readonly line: number } } | undefined;
  readonly children?: ReadonlyArray<Node>;
}

// The syntax the renderers read (response.tsx REMARK and MATH, Markdown.tsx); transforms don't move a block's bounds.
const plain = unified().use(remarkParse).use(remarkGfm);
const withMath = unified()
  .use(remarkParse)
  .use(remarkMath, { singleDollarTextMath: true })
  .use(remarkGfm);
const parse = (md: string) => (mayContainMath(md) ? withMath : plain).parse(md) as Node;

const hasDefinitions = (node: Node): boolean =>
  node.type === "definition" ||
  node.type === "footnoteDefinition" ||
  (node.children?.some(hasDefinitions) ?? false);

/**
 * Text read as one document: a directive card needs the whole source (a blank line inside HTML or a fence must not
 * turn an example into a live card), and a CR may yet become half of a CRLF, a BOM past the start would be dropped.
 */
const WHOLE = /:(?:artifact-template|codex-file-citation|codex-followup)|[\r\uFEFF]/;

const MATH_OPEN = /^ {0,3}(\$\$|\\\[)/;

/** The line of a display-math opener (`$$`, `\[`) still waiting for its closer, outside code fences; else the line count. */
export function openMathLine(lines: ReadonlyArray<string>): number {
  let fence: Fence | null = null;
  let math: { line: number; close: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (math) {
      if (line.trimEnd().endsWith(math.close)) math = null;
      continue;
    }
    // Code is read as the image reader reads it (fence.ts): a `$$` inside a fence opens nothing.
    const open = fence;
    fence = fenceAfter(open, line);
    if (open || fence) continue;
    const m = MATH_OPEN.exec(line);
    if (!m) continue;
    const close = m[1] === "$$" ? "$$" : "\\]";
    // "$$x^2$$" and "\[x\]" open and close on one line.
    if (!line.slice(m[0].length).trimEnd().endsWith(close)) math = { line: i, close };
  }
  return math ? math.line : lines.length;
}

interface Closed {
  /** The source up to the first block still open, ending in a newline. */
  readonly source: string;
  readonly lines: number;
  readonly blocks: ReadonlyArray<MarkdownBlock>;
}
const NONE: Closed = { source: "", lines: 0, blocks: [] };

/**
 * A line still being written whose block is settled: its first word and a later one with a letter or digit are in,
 * so no more words can turn it into another kind of block. Not a line that may be HTML, a table, a definition or
 * math, whose kind can still turn on what comes next ("<de" before "<details>", "[d]: x" before "[d]: x y").
 */
const SETTLED_LINE = /^[ \t]*[^\s<|[$\\]\S*[ \t]+\S*[\p{L}\p{N}]/u;

/**
 * One renderer's splitter. Call it with the text so far and whether more may arrive (`open`): its top-level blocks,
 * each with its source text and line. Text that doesn't extend the last call's starts over.
 */
export function createMarkdownBlocks(): (md: string, open: boolean) => MarkdownBlock[] {
  let closed = NONE;
  let last: { md: string; blocks: MarkdownBlock[] } | null = null;
  return (md, open) => {
    // Words added to a settled line just extend the last block: no parse until the line ends.
    const added = last && open && md.startsWith(last.md) ? md.slice(last.md.length) : null;
    const tail = last?.blocks.at(-1);
    if (
      added !== null &&
      last &&
      tail &&
      !added.includes("\n") &&
      !WHOLE.test(added) &&
      SETTLED_LINE.test(last.md.slice(last.md.lastIndexOf("\n") + 1))
    ) {
      last = {
        md,
        blocks: [...last.blocks.slice(0, -1), { text: tail.text + added, offset: tail.offset }],
      };
      return last.blocks;
    }
    const blocks = split(md);
    last = open ? { md, blocks } : null;
    return blocks;
  };

  function split(md: string): MarkdownBlock[] {
    const whole = [{ text: md, offset: 0 }];
    if (WHOLE.test(md)) {
      closed = NONE;
      return whole;
    }
    if (!md.startsWith(closed.source)) closed = NONE;
    const rest = md.slice(closed.source.length);
    const tree = parse(rest);
    if (hasDefinitions(tree)) {
      closed = NONE;
      return whole;
    }
    const lines = rest.split("\n");
    // Lines that end in a newline, through an unclosed display-math opener: a block may start there (unclosed, it is
    // a paragraph; closed, math), but nothing after it is settled.
    const finished = Math.min(
      lines.length - 1,
      mayContainMath(rest) ? openMathLine(lines) + 1 : Infinity,
    );
    const starts = (tree.children ?? []).map((node) => (node.position?.start.line ?? 1) - 1);
    const span = (i: number): MarkdownBlock => ({
      text: lines.slice(starts[i], starts[i + 1]).join("\n"),
      offset: closed.lines + starts[i]!,
    });

    const blocks = [...closed.blocks];
    let i = 0;
    for (; i + 1 < starts.length && starts[i + 1]! < finished; i++) blocks.push(span(i));
    const open = starts.slice(i).map((_, k) => span(i + k));
    if (i > 0) {
      const cut = starts[i]!;
      closed = {
        source: closed.source + lines.slice(0, cut).join("\n") + "\n",
        lines: closed.lines + cut,
        blocks: blocks.slice(),
      };
    }
    return [...blocks, ...open];
  }
}
