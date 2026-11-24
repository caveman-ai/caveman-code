// How chat search reads what the person typed. People ask questions ("where did I set up stripe functionality"),
// so the words that carry nothing (where, did, I) go, and each remaining concept becomes a group of FTS5
// alternatives: "setup" also finds "set up", "set up" also finds "setup". Each group is weighed by how rare it
// is in this computer's chats, so "stripe" decides and "functionality" barely counts.

/**
 * Words that carry no topic in a question about past chats: function words, question words, and the words
 * people use about the chats themselves ("chat", "conversation", "talked").
 */
const STOP = new Set(
  (
    "a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't " +
    "could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he " +
    "her here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself just let's me more most my myself no nor " +
    "not now of off on once only or other ought our ours ourselves out over own same she should shouldn't so some such than that that's the their " +
    "theirs them themselves then there these they this those through to too under until up very was wasn't we we'd we'll we're we've were weren't " +
    "what what's when where where's which while who whom why will with won't would wouldn't you your yours yourself yourselves " +
    "ago also back chat chats conversation conversations discuss discussed earlier ever find found get got anywhere somewhere thing things " +
    "last talk talked mention mentioned remember said say told tell thread threads time week yesterday today one " +
    "functionality stuff much many"
  ).split(" "),
);

/** The particles of phrasal verbs that people also write joined: "set up"/"setup", "log in"/"login", "check out"/"checkout". */
const PARTICLES = ["up", "in", "out", "down", "on", "off", "back", "over"];

export interface Alternative {
  /** Lower-case words; more than one is a phrase (adjacent, in order). */
  readonly words: ReadonlyArray<string>;
  /** The last word is still being typed: match it as a prefix. */
  readonly prefix: boolean;
}

/** One concept of the query: matching any alternative counts as matching it. */
export interface Group {
  readonly label: string;
  readonly alternatives: ReadonlyArray<Alternative>;
}

const WORD = /[\p{L}\p{N}_]+(?:'[\p{L}]+)?/gu;

const content = (word: string) => !STOP.has(word) && (word.length > 1 || /\d/.test(word));

/** A joined word that splits into a verb and a particle ("setup" -> "set up"): both halves at least two letters. */
function splitParticle(word: string): ReadonlyArray<string> | undefined {
  for (const particle of PARTICLES) {
    if (word.length >= particle.length + 2 && word.endsWith(particle)) return [word.slice(0, -particle.length), particle];
  }
  return undefined;
}

/**
 * The query's groups, in the order typed. Quoted text is one exact phrase. A word followed by a particle
 * ("set up") is one group: the phrase, the joined word, or the word alone. The last word is a prefix while it is
 * still being typed (no space after it) and has three letters or more.
 */
export function parseQuery(raw: string): Group[] {
  const groups: Group[] = [];
  const typing = raw.length > 0 && !/\s$/.test(raw) && !raw.endsWith('"');
  // Quoted phrases first, out of the rest.
  const rest = raw.replace(/"([^"]*)"/g, (_, quoted: string) => {
    const words = quoted.toLowerCase().match(WORD) ?? [];
    if (words.length > 0) groups.push({ label: words.join(" "), alternatives: [{ words, prefix: false }] });
    return " ";
  });
  const words = (rest.toLowerCase().match(WORD) ?? []).map((w) => w.replace(/'s$/, ""));
  const lastAt = words.length - 1;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = words[i + 1];
    const prefix = typing && i === lastAt && word.length >= 3;
    if (next !== undefined && PARTICLES.includes(next) && content(word)) {
      // The bare word too: "the webhook in that chat" is about the webhook, not a phrasal verb.
      groups.push({
        label: word,
        alternatives: [{ words: [word, next], prefix: typing && i + 1 === lastAt }, { words: [word + next], prefix: false }, { words: [word], prefix: false }],
      });
      i++;
      continue;
    }
    if (!content(word)) continue;
    const split = splitParticle(word);
    groups.push({ label: word, alternatives: split && !prefix ? [{ words: [word], prefix }, { words: split, prefix: false }] : [{ words: [word], prefix }] });
  }
  // Only stop words ("how did we do it"): search them as typed rather than nothing.
  if (groups.length === 0 && words.length > 0) {
    for (const word of words) groups.push({ label: word, alternatives: [{ words: [word], prefix: typing && word === words[lastAt] && word.length >= 3 }] });
  }
  // A long paste is not a search: its first dozen concepts are.
  return groups.slice(0, 12);
}

const quote = (word: string) => `"${word.replaceAll('"', '""')}"`;

/** An FTS5 expression for one alternative: a quoted string is a term or, tokenized, a phrase; `*` makes its last token a prefix. */
const alternativeFts = (alt: Alternative) => `${quote(alt.words.join(" "))}${alt.prefix ? " *" : ""}`;

/** An FTS5 expression matching any of a group's alternatives. */
export const groupFts = (group: Group): string => {
  const parts = group.alternatives.map(alternativeFts);
  return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
};

/** Any group: the candidates, ranked by bm25 before coverage decides. */
export const anyFts = (groups: ReadonlyArray<Group>): string => groups.map(groupFts).join(" OR ");

/**
 * Optimal string alignment distance (insert, delete, substitute, swap two neighbours), or `max + 1` once it
 * is sure to exceed `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** How far a typo may be from the word meant: one edit for short words, two from seven letters. */
export const typoBudget = (word: string) => (word.length >= 7 ? 2 : word.length >= 4 ? 1 : 0);

/**
 * The indexed word a typo most likely meant: the nearest within the budget, ties to the word in the most
 * passages. `terms` are the index's own (stemmed) terms that start with the same letter.
 */
export function correction(word: string, terms: ReadonlyArray<{ readonly term: string; readonly doc: number }>): string | undefined {
  const budget = typoBudget(word);
  if (budget === 0) return undefined;
  let best: { term: string; distance: number; doc: number } | undefined;
  for (const { term, doc } of terms) {
    if (term === word || /\d/.test(term)) continue;
    const distance = editDistance(word, term, budget);
    if (distance > budget) continue;
    if (!best || distance < best.distance || (distance === best.distance && doc > best.doc)) best = { term, distance, doc };
  }
  return best?.term;
}
