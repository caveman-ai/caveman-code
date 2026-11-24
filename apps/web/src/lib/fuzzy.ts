// Fuzzy search over a few short fields, with where it hit so a row can mark the match. Pure.

/** A half-open `[start, end)` range of matched characters. */
export type Range = readonly [number, number];

export interface TextMatch {
  /** Higher is better: a whole-word hit beats a substring beats letters in order. */
  readonly score: number;
  readonly ranges: ReadonlyArray<Range>;
}

/**
 * One query word against one text, any case: the substring if it is there (at a word start scores best),
 * else its letters in order with gaps, for a word of three letters or more (so "slk" finds Slack but "s"
 * alone does not light up every row). Null when it does not match.
 */
export function matchWord(word: string, text: string): TextMatch | null {
  const w = word.toLowerCase();
  const t = text.toLowerCase();
  if (w === "") return null;
  const at = t.indexOf(w);
  if (at >= 0) {
    const wordStart = at === 0 || /[^\p{L}\p{N}]/u.test(t[at - 1]!);
    const whole = wordStart && (at + w.length === t.length || /[^\p{L}\p{N}]/u.test(t[at + w.length]!));
    return { score: (whole ? 100 : wordStart ? 80 : 60) - Math.min(20, at) / 2, ranges: [[at, at + w.length]] };
  }
  if (w.length < 3) return null;
  // From each place the first letter occurs, the greedy run; the tightest one wins ("isue" lights up
  // "issues", not the i of "Jira" before it).
  let best: TextMatch | null = null;
  for (let start = t.indexOf(w[0]!); start >= 0; start = t.indexOf(w[0]!, start + 1)) {
    const run = subsequence(w, t, start);
    if (run && (!best || run.score > best.score)) best = run;
  }
  return best;
}

function subsequence(w: string, t: string, start: number): TextMatch | null {
  const ranges: Array<[number, number]> = [];
  let from = start;
  let gaps = 0;
  for (const c of w) {
    const i = t.indexOf(c, from);
    if (i < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else {
      if (last) gaps += 1;
      ranges.push([i, i + 1]);
    }
    from = i + 1;
  }
  // Letters spread across the text are a weak hit; too spread out is noise.
  const spread = ranges[ranges.length - 1]![1] - ranges[0]![0];
  if (spread > w.length * 3 + 2) return null;
  return { score: 30 - gaps * 4 - Math.min(10, spread - w.length), ranges };
}

/** The query's words. */
export const queryWords = (query: string): ReadonlyArray<string> => query.trim().split(/\s+/).filter(Boolean);

export interface Field {
  readonly text: string;
  /** How much a hit here counts, 0 to 1; the field a row shows first takes 1. */
  readonly weight: number;
}

export interface FieldsMatch {
  readonly score: number;
  /** Where the query hit each field, by the field's index. */
  readonly ranges: ReadonlyArray<ReadonlyArray<Range>>;
}

const EVERYTHING = (n: number): FieldsMatch => ({ score: 0, ranges: Array.from({ length: n }, () => []) });

/**
 * The whole query against a row's fields: every word must hit some field, each on its own; a word's best
 * field scores it, with a bonus for the first field. Null when one word hits nothing. An empty query
 * matches everything with nothing to mark.
 */
export function matchFields(query: string, fields: ReadonlyArray<Field>): FieldsMatch | null {
  const words = queryWords(query);
  if (words.length === 0) return EVERYTHING(fields.length);
  let score = 0;
  const ranges = fields.map((): Array<Range> => []);
  for (const word of words) {
    let best = -1;
    fields.forEach((f, i) => {
      const m = matchWord(word, f.text);
      if (!m) return;
      best = Math.max(best, m.score * f.weight + (i === 0 ? 20 : 0));
      ranges[i]!.push(...m.ranges);
    });
    if (best < 0) return null;
    score += best;
  }
  return { score, ranges: ranges.map(merge) };
}

/** Ranges sorted and overlapping ones joined, so a highlight never nests. */
export function merge(ranges: ReadonlyArray<Range>): ReadonlyArray<Range> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** `text` cut at its ranges: plain and matched pieces in order, for rendering with a mark around each hit. */
export function pieces(text: string, ranges: ReadonlyArray<Range>): ReadonlyArray<{ readonly text: string; readonly hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [s, e] of merge(ranges)) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
