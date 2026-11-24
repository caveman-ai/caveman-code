// A fetched page as the model reads it (docs/ "Tools"): markdown, its outline, and BM25 over
// heading-bounded chunks. Small pages come back whole; larger ones as the outline and the passages that best match
// the question (or the start), with every passage's offset so `offset` reads on from any point. The markdown comes
// from the page reader process (pageText.ts), so the runtime itself never loads an HTML or PDF parser.
import { cutToFit, fitsInline, MAX_URL_CHARS } from "./inline.ts";

export interface Page {
  readonly url: string;
  readonly title: string;
  readonly markdown: string;
  /** Built with the page in its reader process (indexPage); built on first use when absent. */
  readonly index?: PageIndex;
}

/** Pages up to this many characters of markdown come back whole. */
export const WHOLE_PAGE_CHARS = 12_000;
/** A chunk BM25 scores: a heading's section, split at paragraphs past this. */
const CHUNK_CHARS = 1_500;
/** What a larger page returns besides its outline: passages, or a window read from an offset. */
const PASSAGE_CHARS = 8_000;
const WINDOW_CHARS = 10_000;
const OUTLINE_CHARS = 2_500;

const httpLink = (href: string, base: string) => {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
};

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`)\]}]+/g;
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * The http(s) links written in `text`, in order and once each: markdown link targets (resolved against `base`,
 * since a markdown page may link relatively) and bare URLs. Fragments off; none longer than web_fetch takes.
 */
export function linksIn(text: string, base: string): Array<string> {
  const found = [...text.matchAll(MARKDOWN_LINK)].map((m) => ({ at: m.index, link: httpLink(m[1]!, base) }));
  for (const m of text.matchAll(URL_IN_TEXT)) found.push({ at: m.index, link: httpLink(m[0].replace(/[.,;:!?]+$/, ""), base) });
  const links = found.sort((a, b) => a.at - b.at).map((f) => f.link);
  return [...new Set(links.filter((l): l is string => l !== undefined && l.length <= MAX_URL_CHARS))];
}

// ------------------------------------------------------------- outline and chunks

export interface Heading {
  readonly level: number;
  readonly text: string;
  /** Where its line starts in the markdown. */
  readonly offset: number;
}

/** ATX headings outside code fences, with their offsets. */
export function outlineOf(markdown: string): ReadonlyArray<Heading> {
  const headings: Array<Heading> = [];
  let fence: string | undefined;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker !== undefined && (fence === undefined || marker === fence)) fence = fence === undefined ? marker : undefined;
    else if (fence === undefined) {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) headings.push({ level: m[1]!.length, text: m[2]!, offset });
    }
    offset += line.length + 1;
  }
  return headings;
}

/** A span of the markdown BM25 scores: `markdown.slice(offset, end)`. */
export interface Chunk {
  readonly offset: number;
  readonly end: number;
  /** Its section's headings, outermost first: `Install › Linux`. */
  readonly path: string;
}

/** Heading-bounded sections, each split at paragraph breaks (or, failing that, lines) to about CHUNK_CHARS. */
export function chunksOf(markdown: string, headings: ReadonlyArray<Heading>): ReadonlyArray<Chunk> {
  const starts = [0, ...headings.map((h) => h.offset).filter((o) => o > 0), markdown.length];
  const chunks: Array<Chunk> = [];
  const trail: Array<Heading> = [];
  // Headings come in offset order, as the starts do: one walk finds each section's.
  let next = 0;
  for (let i = 0; i + 1 < starts.length; i++) {
    const start = starts[i]!;
    while (next < headings.length && headings[next]!.offset < start) next += 1;
    const heading = headings[next]?.offset === start ? headings[next] : undefined;
    if (heading) {
      while (trail.length > 0 && trail.at(-1)!.level >= heading.level) trail.pop();
      trail.push(heading);
    }
    const path = trail.map((h) => h.text).join(" › ");
    const section = markdown.slice(start, starts[i + 1]);
    let at = 0;
    while (at < section.length) {
      let end = Math.min(section.length, at + CHUNK_CHARS);
      if (end < section.length) {
        // A paragraph break, else a line break, else a sentence's end, else a space: never mid-word.
        const min = at + CHUNK_CHARS / 3;
        const paragraph = section.lastIndexOf("\n\n", end);
        const line = section.lastIndexOf("\n", end);
        const sentence = section.lastIndexOf(". ", end);
        const space = section.lastIndexOf(" ", end);
        end = paragraph > min ? paragraph + 2 : line > min ? line + 1 : sentence > min ? sentence + 2 : space > min ? space + 1 : end;
      }
      if (section.slice(at, end).trim() !== "") chunks.push({ offset: start + at, end: start + end, path });
      at = end;
    }
  }
  return chunks;
}

const STOP = new Set(
  "a an and are as at be but by can do does for from how i if in into is it its of on or that the their then there these this to was what when where which who why will with you your".split(" "),
);
const terms = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)));

/**
 * What a large page's reads need, computed once: its outline, its chunks, and each term's postings (the chunks it
 * is in, how often) with each chunk's length in terms, its heading path counted with its text. A read then scores
 * only the question's terms' postings, never the whole page again.
 */
export interface PageIndex {
  readonly headings: ReadonlyArray<Heading>;
  readonly chunks: ReadonlyArray<Chunk>;
  readonly lengths: Uint32Array;
  /** Per term: [chunk, count, chunk, count, …]. */
  readonly postings: Map<string, Uint32Array>;
}

export function indexPage(markdown: string): PageIndex {
  const headings = outlineOf(markdown);
  const chunks = chunksOf(markdown, headings);
  const lengths = new Uint32Array(chunks.length);
  const growing = new Map<string, Array<number>>();
  chunks.forEach((chunk, i) => {
    const words = terms(`${chunk.path} ${markdown.slice(chunk.offset, chunk.end)}`);
    lengths[i] = words.length;
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const [word, n] of counts) {
      const list = growing.get(word);
      if (list === undefined) growing.set(word, [i, n]);
      else list.push(i, n);
    }
  });
  return { headings, chunks, lengths, postings: new Map([...growing].map(([word, list]) => [word, Uint32Array.from(list)])) };
}

/** The index's size in memory, roughly, for the page cache's budget. */
export const indexBytes = (index: PageIndex) => {
  let bytes = index.lengths.byteLength + index.chunks.length * 64 + index.headings.length * 64;
  for (const [word, list] of index.postings) bytes += word.length * 2 + list.byteLength + 48;
  return bytes;
};

const indexes = new WeakMap<Page, PageIndex>();
const indexOf = (page: Page) => {
  let index = page.index ?? indexes.get(page);
  if (index === undefined) indexes.set(page, (index = indexPage(page.markdown)));
  return index;
};

/** Okapi BM25 (k1 1.2, b 0.75) of each chunk against `query`, its heading path counted with its text. */
export function bm25(index: PageIndex, query: string): Float64Array {
  const scores = new Float64Array(index.chunks.length);
  const wanted = [...new Set(terms(query))];
  if (wanted.length === 0 || index.chunks.length === 0) return scores;
  const avg = index.lengths.reduce((n, l) => n + l, 0) / index.lengths.length || 1;
  for (const word of wanted) {
    const list = index.postings.get(word);
    if (list === undefined) continue;
    const n = list.length / 2;
    const idf = Math.log(1 + (index.chunks.length - n + 0.5) / (n + 0.5));
    for (let at = 0; at < list.length; at += 2) {
      const chunk = list[at]!;
      const f = list[at + 1]!;
      scores[chunk]! += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * index.lengths[chunk]!) / avg));
    }
  }
  return scores;
}

// ------------------------------------------------------------- what the model reads

export interface PageView {
  /** The body, without the untrusted wrapper (WebTools adds it). */
  readonly text: string;
  /** Where the next read starts, when there is more after what was returned. */
  readonly next?: number;
}

/** At most `chars`, ending at a line break when there is one in the last fifth. */
const window = (markdown: string, from: number, chars: number) => {
  let end = Math.min(markdown.length, from + chars);
  if (end < markdown.length) {
    const line = markdown.lastIndexOf("\n", end);
    if (line > from + chars * 0.8) end = line + 1;
  }
  return { text: markdown.slice(from, end), end };
};

function outlineText(headings: ReadonlyArray<Heading>, budget: number): string {
  const line = (h: Heading) => `${"  ".repeat(h.level - 1)}- ${h.text} (offset ${h.offset})`;
  for (const depth of [6, 3, 2, 1]) {
    const lines = headings.filter((h) => h.level <= depth).map(line);
    const text = lines.join("\n");
    if (text.length <= budget) return depth < 6 ? `${text}\n(deeper headings left out)` : text;
  }
  const lines: Array<string> = [];
  let used = 0;
  for (const h of headings) {
    const l = line(h);
    if (used + l.length > budget) break;
    lines.push(l);
    used += l.length + 1;
  }
  return `${lines.join("\n")}\n(… ${headings.length - lines.length} more headings)`;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * What one web_fetch returns of `page`: the whole page when small; else from `offset`; else the outline and the
 * passages that best match `question`, or the outline and the start. Kept to what `fits`: WebTools checks the
 * whole answer, wrapper and head included, against the inline cap (inline.ts).
 */
export function viewPage(
  page: Page,
  options: { readonly question?: string | undefined; readonly offset?: number | undefined },
  fits: (text: string) => boolean = fitsInline,
): PageView {
  const md = page.markdown;
  if (options.offset === undefined && md.length <= WHOLE_PAGE_CHARS && fits(md)) return { text: md };
  // Indexed once per page, scored once per read: each smaller try below reuses both.
  const index = indexOf(page);
  const question = options.question?.trim() || undefined;
  const scores = question === undefined ? undefined : bm25(index, question);
  const ranked =
    scores &&
    Array.from(scores.keys())
      .filter((i) => scores[i]! > 0)
      .sort((a, b) => scores[b]! - scores[a]!)
      .map((i) => index.chunks[i]!);
  const read: Read = { offset: options.offset, question, ranked };
  let view = largeView(page, index, read, 1);
  for (let scale = 1 / 2; !fits(view.text) && scale >= 1 / 32; scale /= 2) view = largeView(page, index, read, scale);
  // Still too big (a long question, an outline of huge headings): the smallest view, cut.
  return fits(view.text) ? view : { ...view, text: cutToFit(view.text, fits) };
}

interface Read {
  readonly offset: number | undefined;
  readonly question: string | undefined;
  /** The chunks that match the question, best first. */
  readonly ranked: ReadonlyArray<Chunk> | undefined;
}

function largeView(page: Page, index: PageIndex, read: Read, scale: number): PageView {
  const md = page.markdown;
  const total = `${count(md.length)} characters`;
  if (read.offset !== undefined) {
    const from = Math.min(Math.max(0, Math.floor(read.offset)), md.length);
    if (from >= md.length) return { text: `The page is ${total}: nothing at offset ${from}.` };
    const { text, end } = window(md, from, Math.floor(WINDOW_CHARS * scale));
    const more = end < md.length;
    return { text: `${total} · characters ${count(from)}–${count(end)}${more ? ` · read on at offset ${end}` : " · the end"}\n\n${text}`, ...(more ? { next: end } : {}) };
  }
  const outline = index.headings.length === 0 ? "" : `Outline:\n${outlineText(index.headings, Math.floor(OUTLINE_CHARS * scale))}\n\n`;
  const question = read.question;
  if (question !== undefined && read.ranked !== undefined) {
    const picked: Array<Chunk> = [];
    let used = 0;
    for (const chunk of read.ranked) {
      const length = chunk.end - chunk.offset;
      if (used + length > PASSAGE_CHARS * scale && picked.length > 0) continue;
      picked.push(chunk);
      used += length;
      if (used >= PASSAGE_CHARS * scale) break;
    }
    if (picked.length > 0) {
      // In page order, neighbours joined into one passage.
      const joined: Array<Chunk> = [];
      for (const c of picked.sort((a, b) => a.offset - b.offset)) {
        const last = joined.at(-1);
        if (last !== undefined && last.end === c.offset) joined[joined.length - 1] = { ...last, end: c.end };
        else joined.push(c);
      }
      const passages = joined
        .map((c) => `[offset ${c.offset}${c.path ? ` · ${c.path}` : ""}]\n${md.slice(c.offset, Math.min(c.end, c.offset + Math.floor(PASSAGE_CHARS * scale))).trim()}`)
        .join("\n\n");
      return { text: `${total} · ${picked.length} passage${picked.length === 1 ? "" : "s"} matching "${question}" · read any part with offset\n\n${outline}${passages}` };
    }
    const { text, end } = window(md, 0, Math.floor((PASSAGE_CHARS / 2) * scale));
    return { text: `${total} · nothing matched "${question}"; the start follows · read on at offset ${end}\n\n${outline}${text}`, next: end };
  }
  const { text, end } = window(md, 0, Math.floor((PASSAGE_CHARS * 3) / 4 * scale));
  return { text: `${total} · the start · read on at offset ${end}, or ask with question\n\n${outline}${text}`, next: end };
}
