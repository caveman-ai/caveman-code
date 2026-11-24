// Find in chat (⌘F), , so the browser's own
// find misses most of a long chat (and the desktop app has none). Matches are counted on the chat's messages, the
// person's and the answers in view (a finished turn's folded work is left out), so "3/12" covers rows not mounted yet;
// stepping to one mounts it, and the mounted rows are painted with the CSS Custom Highlight API.

export interface FindHit {
  /** The transcript item (a message of the person's, or an answer). */
  readonly id: string;
  /** Which match in that item, from 0, in reading order. */
  readonly occurrence: number;
}

/**
 * About the text an answer's markdown renders to, so a match counted here is one the page shows: no fence, emphasis,
 * heading or list markers, a link's words without its URL, an image's alt text.
 */
export function shownText(markdown: string): string {
  return markdown
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

/** Where `query` starts in `text`, case-insensitive and without overlaps. */
export function occurrences(text: string, query: string): number[] {
  const q = query.toLocaleLowerCase();
  if (!q) return [];
  const t = text.toLocaleLowerCase();
  const out: number[] = [];
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + q.length)) out.push(at);
  return out;
}

/** Every match in the searchable messages, in transcript order. */
export function findHits(messages: ReadonlyArray<{ readonly id: string; readonly text: string }>, query: string): FindHit[] {
  if (!query.trim()) return [];
  return messages.flatMap((m) => occurrences(m.text, query).map((_, occurrence) => ({ id: m.id, occurrence })));
}

/** The next (`delta` 1) or previous (-1) match, wrapping. */
export function stepHit(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return (((Math.min(Math.max(0, index), total - 1) + delta) % total) + total) % total;
}

/** "3/12", or "0/0" with nothing found (upstream count). */
export const hitCount = (index: number, total: number): string => (total <= 0 ? "0/0" : `${Math.min(index, total - 1) + 1}/${total}`);

/**
 * The matches of `query` in the rendered text under `scope`, as DOM ranges in reading order. Text is joined per
 * block, so a match across an inline element (`**retry**`) is found and one across two paragraphs is not.
 */
export function textRanges(scope: Element, query: string): Range[] {
  if (!query) return [];
  const doc = scope.ownerDocument;
  const out: Range[] = [];
  let text = "";
  let nodes: Array<{ node: Text; start: number; end: number }> = [];
  const flush = () => {
    let i = 0;
    for (const at of occurrences(text, query)) {
      while (i < nodes.length && nodes[i]!.end <= at) i++;
      let j = i;
      while (j < nodes.length && nodes[j]!.end < at + query.length) j++;
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      const range = doc.createRange();
      range.setStart(a.node, at - a.start);
      range.setEnd(b.node, at + query.length - b.start);
      out.push(range);
    }
    text = "";
    nodes = [];
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const value = (node as Text).nodeValue ?? "";
      nodes.push({ node: node as Text, start: text.length, end: text.length + value.length });
      text += value;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (el.matches("svg, button, [aria-hidden=true], [data-find-skip]")) return;
    const block = BLOCKS.has(el.tagName);
    if (block) flush();
    for (const child of el.childNodes) visit(child);
    if (block) flush();
  };
  visit(scope);
  flush();
  return out;
}

const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR", "TD", "TH", "SECTION", "BR"]);
