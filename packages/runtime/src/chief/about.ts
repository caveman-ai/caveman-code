// What a chat is about, read from its own words with no model call: the few key terms its board line carries
// (`about:`), and the score chat_search ranks chats by. A chat's title can be anything (the first 80 characters of a
// note that opens with filler, a title that went stale), so both read the chat's goal (its first message) and the
// person's latest ask too. Pure but for chatFacts, one small read of the chat's journal.
import * as Effect from "effect/Effect";

import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";

/**
 * A chat's own words: its first message (the goal: the person's note, or the brief its Chief wrote), its latest message
 * from the person (where it turned: never a Chief's, another agent's or a scheduled task's), its latest answer.
 */
export interface ChatFacts {
  readonly goal?: string;
  readonly ask?: string;
  readonly answer?: string;
}

/** One read of a chat's journal for its facts. */
export const chatFacts = (
  store: SessionStore["Service"],
  record: WorkspaceRecord,
): Effect.Effect<ChatFacts> =>
  store.sql<{ goal: string | null; ask: string | null; answer: string | null }>`SELECT
      (SELECT json_extract(event, '$.payload.text') FROM caveman_sp_events WHERE session_id = ${record.session.id} AND type = 'message.done'
        AND json_extract(event, '$.payload.role') = 'user' ORDER BY cursor ASC LIMIT 1) AS goal,
      (SELECT json_extract(event, '$.payload.text') FROM caveman_sp_events WHERE session_id = ${record.session.id} AND type = 'message.done'
        AND json_extract(event, '$.payload.role') = 'user' AND json_extract(event, '$.payload.from') IS NULL
        AND json_extract(event, '$.payload.scheduled_task') IS NULL ORDER BY cursor DESC LIMIT 1) AS ask,
      (SELECT json_extract(event, '$.payload.text') FROM caveman_sp_events WHERE session_id = ${record.session.id} AND type = 'message.done'
        AND json_extract(event, '$.payload.role') = 'assistant' AND trim(coalesce(json_extract(event, '$.payload.text'), '')) != ''
        ORDER BY cursor DESC LIMIT 1) AS answer`.pipe(
    Effect.map(([row]) => {
      const goal = row?.goal ? ownWords(row.goal) : undefined;
      const ask = row?.ask ? ownWords(row.ask) : undefined;
      return {
        ...(goal ? { goal } : {}),
        ...(ask && ask !== goal ? { ask } : {}),
        ...(row?.answer?.trim() ? { answer: ownWords(row.answer) } : {}),
      };
    }),
    Effect.orElseSucceed(() => ({})),
  );

/**
 * A message as its writer meant it: without what the runtime appends to a task the Chief starts (crew rules, a change
 * set's footer, the crew contract, prompt.ts), and with thread links, URLs and markup read as words. A pull request
 * URL stays as its number (#123).
 */
export const ownWords = (text: string) =>
  text
    .split(/\n\n(?:\[Chief\] |\[Change set "|<crew_rules>)/)[0]!
    .replace(/\[([^\]]*)\]\(t3-context:[^)]*\)/g, "$1")
    .replace(/https?:\/\/\S*\/pulls?\/(\d+)\S*/g, "#$1")
    .replace(/[a-z][\w+.-]*:\/\/\S+/gi, " ")
    .trim();

// Words that say nothing about what a chat is for: English glue, the filler people open a note with, and how they
// refer to a chat at all ("the session", "that one").
const STOP = new Set(
  (
    "a about above after again all also am an and any are around as at be because been before being below between both but by can cannot could " +
    "did do does doing done dont down during each else even ever every few for from further get gets getting go goes going gonna got had has have having he her here " +
    "hers him his how however i id if im in into is isnt it its itself ive just let lets like make makes making me might more most much must my myself need needs no " +
    "nor not now of off ok okay on once one only or other our ours out over own please pls re really same see she should so some something still such sure take " +
    "than thanks that thats the their them then there these they thing things this those through thx to too try u under until up us use very want wanna wants was " +
    "way we were what whatever when where which while who whom why will with within without would yeah yes yet you your yours youre " +
    "actually basically definitely deep deeply dig every everything potentially probably quickly quite rather realy simply totally truly " +
    "goal help look able know think sort kind bit lot lots stuff hey hi new w ur via etc " +
    "don doesn didn isn wasn aren won can couldn shouldn wouldn haven hasn ll ve"
  ).split(" "),
);
/** Words a note uses to point at a chat, not to say what it is about: dropped from a search, never from a chat's own terms. */
const POINTERS = new Set(
  "chat chats session sessions thread threads task tasks work working agent conversation one ones guy".split(
    " ",
  ),
);
/** What people write for one thing in several ways: searched, and counted, as one. */
const ALIAS: Readonly<Record<string, string>> = {
  mac: "macos",
  osx: "macos",
  darwin: "macos",
  win: "windows",
  win10: "windows",
  win11: "windows",
  pr: "pull",
  prs: "pull",
  repo: "repository",
  repos: "repository",
  ui: "interface",
};
/** Platforms, a pull request's number: what tells two chats in one project apart, so they lead a chat's terms. */
const SALIENT =
  /^(?:windows|macos|linux|ubuntu|ios|android|web|desktop|mobile|electron|docker|cloud|#\d+)$/;

/** One word as it is compared: lower case, its alias, and a light stem (installs, installing and installed are install). */
export const stem = (word: string) => {
  const lower = word.toLowerCase();
  const w = ALIAS[lower] ?? lower;
  if (w.startsWith("#") || /\d/.test(w) || w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 5) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && /(?:ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  // Not macos, status, analysis, focus.
  if (w.endsWith("s") && !/(?:ss|us|is|os)$/.test(w)) return w.slice(0, -1);
  return w;
};

/** The words of a text that could say what it is about, as written (#123, file names and dotted names whole). */
const words = (text: string) =>
  (text.match(/#\d+|[A-Za-z0-9][\w+.-]*[\w+]|[A-Za-z]/g) ?? [])
    .map((w) => w.replace(/'s$/, ""))
    .filter((w) => {
      const lower = w.toLowerCase();
      if (STOP.has(lower) || STOP.has(lower.replace(/'/g, ""))) return false;
      return w.startsWith("#") || (lower.length >= 3 && !/^\d+$/.test(lower));
    });

/**
 * A chat's key terms, most telling first: words its title, goal and latest ask share count most, a platform or a pull
 * request leads, and words of its project's own name (said by every chat there) are left out. At most `max`.
 */
export const keyTerms = (
  input: {
    readonly title?: string;
    readonly goal?: string;
    readonly ask?: string;
    readonly project?: string;
  },
  max = 6,
) => {
  const skip = new Set(words((input.project ?? "").replace(/[-_./]/g, " ")).map(stem));
  // A title that is only the start of the goal (a chat named from its first line) says nothing the goal does not.
  const flatTitle = (input.title ?? "").replace(/\s+/g, " ").replace(/…$/, "").trim().toLowerCase();
  const raw =
    flatTitle !== "" &&
    (input.goal ?? "").replace(/\s+/g, " ").trim().toLowerCase().startsWith(flatTitle);
  const seen = new Map<string, { word: string; score: number; first: number }>();
  let position = 0;
  const count = (text: string | undefined, weight: number) => {
    for (const word of words(text ?? "")) {
      const key = stem(word);
      if (skip.has(key)) continue;
      const found = seen.get(key);
      const shown = (ALIAS[word.toLowerCase()] ?? word).toLowerCase();
      if (found === undefined)
        seen.set(key, {
          word: shown,
          score: weight + (SALIENT.test(shown) ? 2 : 0),
          first: position++,
        });
      else found.score += weight;
    }
  };
  if (!raw) count(input.title, 2);
  count(input.goal, 1);
  count(input.ask, 1);
  return [...seen.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, max)
    .map((t) => t.word);
};

/** A chat as chat_search reads it: each field weighs what a match there says about it. */
export interface SearchDoc {
  readonly title: string;
  readonly about?: ReadonlyArray<string>;
  readonly goal?: string;
  readonly ask?: string;
  readonly answer?: string;
  readonly branch?: string;
  /** The sources it works in, in a project of several (Chief.ts chatRepos). */
  readonly repos?: ReadonlyArray<string>;
}
const FIELDS: ReadonlyArray<readonly [keyof SearchDoc, number]> = [
  ["title", 3],
  ["about", 3],
  ["goal", 2],
  ["ask", 2],
  ["repos", 2],
  ["branch", 1],
  ["answer", 1],
];

/** A search's words: what it is about, without the words that only point at a chat. */
export const queryTerms = (query: string) => [
  ...new Set(
    words(query)
      .map(stem)
      .filter((w) => !POINTERS.has(w)),
  ),
];

/**
 * How well a chat matches a search's terms: for each term, the weight of the best field that has it (a whole word,
 * or the start of one, so "onboard" finds "onboarding"), and which terms matched where.
 */
export const score = (terms: ReadonlyArray<string>, doc: SearchDoc) => {
  const fields = FIELDS.map(([key, weight]) => {
    const value = doc[key];
    const text = Array.isArray(value) ? value.join(" ") : ((value as string | undefined) ?? "");
    // The branch is one slug: its parts are its words.
    return { key, weight, stems: new Set(words(text.replace(/[/_-]/g, " ")).map(stem)) };
  });
  let total = 0;
  const matched: Array<string> = [];
  for (const term of terms) {
    const hit = fields.find(
      (f) =>
        f.stems.has(term) ||
        (term.length >= 4 &&
          [...f.stems].some((s) => s.startsWith(term) || (s.length >= 4 && term.startsWith(s)))),
    );
    if (hit === undefined) continue;
    total += hit.weight;
    matched.push(`${term} (${hit.key})`);
  }
  return { score: total, matched };
};
