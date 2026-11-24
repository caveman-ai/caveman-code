// The ask model's inputs: one ask's dense features and its hashed tokens, a port of Caveman Cloud's
// gateway-managed/internal/askmodel feat.go (itself the research featurizer of lane r4-tier0). Every name, regex,
// bound and constant is that file's; it is frozen with the model artifact. Go reads strings as UTF-8 bytes: the
// byte bounds, the hashes and the character grams here read bytes too (goText.ts).
import {
  byteLength,
  countOf,
  fields,
  headBytes,
  headRunes,
  isDigit,
  isLetter,
  isSpace,
  isUpper,
  lastRunes,
  runeCount,
  tailBytes,
  toLower,
  trimNonLetters,
  trimRightSpace,
  trimSpace,
  utf8,
  wordCount,
} from "./goText.ts";
import { re2 } from "./re2.ts";

/** The ask being classified, as it stands the moment it is typed. */
export interface AskInput {
  /** The person's words, harness wrappers stripped. */
  readonly text: string;
  /** The session's previous ask (at most PREV_TEXT_RUNES), "" when this is the first. */
  readonly prevText: string;
  /** The tail of the agent's last text reply before the ask (replyTail). */
  readonly prevAsst: string;
  /** Human asks before this one. */
  readonly turnIdx: number;
  /** claude-code | codex | pi | opencode | cursor | gemini-cli | other. */
  readonly harness: string;
  /** A slash command or skill invocation. */
  readonly slash: boolean;
  /** When it was typed, in epoch milliseconds; undefined when unknown. */
  readonly ts: number | undefined;
}

/** An earlier ask of the same session: its size and the work it turned into. A NaN count is one nobody can tell. */
export interface Hist {
  /** Of its text, cut at CAP_BYTES. */
  readonly words: number;
  readonly runes: number;
  readonly bytes: number;
  readonly ts: number | undefined;
  readonly slash: boolean;
  readonly nReq: number;
  readonly nTool: number;
  readonly nEdit: number;
  readonly nSpawn: number;
  readonly files: number;
  readonly tokOut: number;
  readonly toolErr: number;
  readonly testFail: number;
}

const TEXT_HEAD = 3 << 10; // bytes of the ask the regexes and the hashed tokens read from its start
const TEXT_TAIL = 1 << 10; // and from its end
const CUE_BYTES = 1 << 10; // the cue regexes read the lower-cased opening
const HASH_BITS = 17;
export const HASH_SIZE = 1 << HASH_BITS;
const MAX_TOK = 1200;
/** Nothing reads past this much of any text. */
const CAP_BYTES = 256 << 10;
/** Of the previous ask. */
export const PREV_TEXT_RUNES = 1500;
/** Of the agent's last reply. */
export const REPLY_RUNES = 2000;
/** A short follow-up: at most this many words. */
export const SHORT_WORDS = 5;
const REPLY_END = 400;
const CHAR_TOK = 300;

/** The record of an ask typed at ts, its counts at 0. */
export const newHist = (text: string, slash: boolean, ts: number | undefined): Hist => {
  const cut = headBytes(text.toWellFormed(), CAP_BYTES);
  return {
    words: wordCount(cut),
    runes: runeCount(cut),
    bytes: byteLength(cut),
    ts,
    slash,
    nReq: 0,
    nTool: 0,
    nEdit: 0,
    nSpawn: 0,
    files: 0,
    tokOut: 0,
    toolErr: 0,
    testFail: 0,
  };
};

/**
 * The tail of an assistant message as the training records hold it: its text blocks, each cut to its last 2,000
 * characters, joined by a space and trimmed, then the last 2,000 characters.
 */
export const replyTail = (texts: ReadonlyArray<string>): string =>
  lastRunes(trimSpace(texts.map((text) => lastRunes(text, REPLY_RUNES)).join(" ")), REPLY_RUNES);

/** The previous ask as a session keeps it for the next one: its first PREV_TEXT_RUNES runes. */
export const prevText = (text: string): string => headRunes(text, PREV_TEXT_RUNES);

const boundText = (text: string, head: number, tail: number): string =>
  byteLength(text) <= head + tail ? text : `${headBytes(text, head)}\n${tailBytes(text, tail)}`;

const pathRE = re2(
  String.raw`(?:~|\.{0,2}/)?[\w@.-]+(?:/[\w@.+-]+)+|[\w-]+\.(?:py|ts|tsx|js|jsx|go|rs|swift|md|json|yaml|yml|sql|sh|css|html|toml|mjs|tf)\b`,
);
const urlRE = re2(String.raw`https?://\S+`);
const traceRE = re2(
  String.raw`(?m)Traceback \(most recent|^\s+at .+\(.+:\d+:\d+\)|panic:|Error:|Exception|error TS\d+|\.\w{1,5}:\d+:\d+|FAIL\b|exit code|stack trace|npm ERR`,
);
const inlineCodeRE = re2("`[^`\n]+`");
const bulletRE = re2(String.raw`(?m)^\s*(?:[-*•]|\d+[.)])\s`);
const headingRE = re2(String.raw`(?m)^\s{0,3}#{1,6}\s+\S`);
const codeLineRE = re2(
  String.raw`(?m)^(?:    |\t)\S|^\s*(?:def|class|import|from|function|const|let|var|func|return|if|for|while|public|private|package)\b`,
);
const identRE = re2(
  String.raw`\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b`,
);
const callRE = re2(String.raw`\b[A-Za-z_]\w*\(`);
const lineRefRE = re2(String.raw`\.\w{1,5}:\d+|\bline \d+\b|#L\d+`);

/** Cue regexes over the lower-cased opening of a text. Order = feature order. */
const cueREs: ReadonlyArray<readonly [string, ReturnType<typeof re2>]> = [
  [
    "plan",
    re2(
      String.raw`\b(brainstorm\w*|architect(ure|ing)?\b|design (doc|the|a|an|our|how)\b|trade-?offs?|pros and cons|how should (we|i)\b|what('s| is) the best (way|approach)|think (this |it )?through|approach(es)? (for|to)\b|strategy|roadmap|\brfc\b|spec(ification)? for|proposal|let'?s plan|plan (out|the|a|an|how|for)\b|come up with a plan|make a plan|planning)`,
    ),
  ],
  [
    "chore",
    re2(
      String.raw`^\W*(?:git |please |now |ok,? |okay,? |good,? |yes,? |great,? |and )?(?:commit|push|pull(?: (?:from )?(?:origin|main|master|upstream|--rebase))*\s*$|stash|stage|status|checkout|tag|open (?:a )?pr|create (?:a )?pr|make (?:a )?pr)\b|^\W*(?:ok,? |okay,? |good,? |yes,? |great,? )?merge(?: (?:it|this|that|them|the prs?|to main|into main))?\s*(?:$|and\b|&|\+)|\b(?:commit|push) (?:and|&|then) (?:push|commit|open)|\bgit status\b|\bthen commit\b|\bcommit (?:it|this|that|them|the changes)\b`,
    ),
  ],
  [
    "lookup",
    re2(String.raw`^\W*(?:what|which)\b.{0,60}\b(?:version|name|port|value|path|url|branch)\b`),
  ],
  [
    "refactor",
    re2(
      String.raw`\brefactor|\brename\b|\bmigrate\b|\bmove\b.{0,40}\b(?:to|into)\b|\bextract\b|\brestructur|\breorgani[sz]|\bconsolidat|\bdedup|\bsplit\b.{0,30}\binto\b|\breplace (?:all|every)\b|\bconvert\b.{0,40}\bto\b`,
    ),
  ],
  [
    "wide",
    re2(
      String.raw`\bacross\b|\beverywhere\b|\ball (?:the )?(?:files|packages|services|modules|callers|call sites|usages|handlers)\b|\b(?:whole|entire) (?:codebase|repo|project|monorepo)\b|\bcodebase-wide\b`,
    ),
  ],
  [
    "edit",
    re2(
      String.raw`\b(?:fix|add|implement|change|update|refactor|rename|write|create|remove|delete|make|build|migrate|replace|move|convert|wire|edit|modify|patch|bump|extract|split|introduce|support|redesign|rewrite|clean ?up)\b`,
    ),
  ],
  [
    "tiny",
    re2(
      String.raw`\btypos?\b|\bspelling\b|\bwording\b|\bcomment\b|\bbump (?:the )?version\b|\bindent|\bwhitespace\b|\blog line\b|\bone[- ]liner\b|\bcopy change\b`,
    ),
  ],
  [
    "ui",
    re2(
      String.raw`\b(?:ui|ux|css|scss|tailwind|styles?|styling|components?|button|modal|dialog|layout|responsive|dark mode|theme|animations?|animate|hover|fonts?|colou?rs?|spacing|padding|margins?|navbar|sidebar|tooltip|dropdown|page|screen|tsx|jsx|react|vue|svelte|frontend|front-end|icons?|svg|form)\b`,
    ),
  ],
  [
    "fix",
    re2(
      String.raw`\b(?:fix|bugs?|broken|errors?|fail|fails|failing|failed|failure|crash(?:es|ing)?|panics?|regression|flaky|exception|500|404|doesn'?t work|not working|wrong|leaks?|slow|hangs?|timeouts?|deadlocks?)\b`,
    ),
  ],
  [
    "ask",
    re2(
      String.raw`^\W*(?:why|how|what|where|when|which|who|is|are|does|do|did|can|could|should|would)\b`,
    ),
  ],
  [
    "why",
    re2(
      String.raw`^\W*(?:why|how come)\b|\bwhy (?:is|are|does|do|did|didn'?t|doesn'?t|isn'?t|not|would|can'?t|won'?t|was)\b|\bhow come\b`,
    ),
  ],
  [
    "correction",
    re2(
      String.raw`^\W*(?:no|nope|wrong)(?:\W*$|\s*[,.!])|^\W*(?:nope|wrong)\b|\bstill\b|\bdoesn'?t work|\bdidn'?t work|\bnot working\b|\bthat'?s (?:not|wrong)\b|\byou broke\b|\bnot what i\b|\btry again\b|\bsame (?:error|issue|problem)\b|\bnothing changed\b|\brevert\b|\bundo\b`,
    ),
  ],
  [
    "judge",
    re2(
      String.raw`\bshould (?:we|i|it|this|they)\b|\bworth\b|\bwhat if\b|\bbetter\b|\bis (?:it|this|that) (?:smart|safe|secure|correct|right|fair|good|ok|enough)\b|\bcompar\w*|\bversus\b|\bvs\.?\s|\bhonest\w*|\brecommend\w*|\bsuggest\w*|\bideas?\b|\bassess\w*|\bevaluat\w*|\breview\w*|\baudit\w*|\bgaps?\b|\bsecur\w+|\binvestigat\w*|\bresearch\w*|\bdebug\w*|\broot cause|\bwhat do you think\b|\bdecid\w*|\bimprov\w*|\boptimi[sz]\w*|\bunderstand\b`,
    ),
  ],
  [
    "progress",
    re2(
      String.raw`^\W*(?:so )?(?:status|progress|eta|any updates?|updates?)(?: (?:now|check|update|report|so far))?\W*$|^\W*status check\b|\bhow (?:much )?longer\b|\bhow long (?:will|until|till|left|is it going)\b|\bhow'?s it (?:going|coming)\b|\bresults? so far\b|\b(?:done|finished) yet\b|\bwhere are we\b`,
    ),
  ],
  [
    "ack",
    re2(
      String.raw`^\W*(?:(?:thanks?|thank you|thx|ty)\b[^?]{0,20}|nice|great|perfect|cool|awesome|love it|lol|good|better|hi|hey|hello|testing|test)\W*$`,
    ),
  ],
  [
    "approve",
    re2(
      String.raw`^\W*(?:yes|yep|yeah|yup|y|ok|okay|sure|go|go ahead|go for it|do it|do that|do this|proceed|continue|keep going|carry on|lgtm|sounds good|looks good|approved?|ship it|please do|let'?s do it|let'?s go|both|all of them|option \w|[1-9a-d])\b[^?]{0,40}$`,
    ),
  ],
  [
    "locate",
    re2(
      String.raw`^\W*(?:where (?:is|are|do|does|did|can)|which (?:file|files|function|module|package|service|dir|directory|branch|port|version|command)|what(?:'s| is| are) (?:\w+ ){0,3}(?:name|path|port|url|uri|version|value|branch|command|email|emails|password|key)s?\b\W*(?:$|of\b|for\b|in\b|on\b|to\b|at\b)|find (?:where|the file|all|every)|list (?:the |all |my )?\w+)\b`,
    ),
  ],
  [
    "opscmd",
    re2(
      String.raw`^\W*(?:please |can you |now |ok,? |okay,? )?(?:(?:re-?)?run (?:the )?(?:unit |go |all )?(?:tests?|linters?|lint|formatter|fmt|gofmt|typecheck|type ?check)|(?:brew|npm|pnpm|yarn|pip|go) (?:install|add|get|i)\b|(?:release|publish|tag|bump)\b|(?:create|cut|make|do) (?:a |the |new |another )*(?:github |npm )?release|(?:restart|stop|kill|start) (?:the )?(?:dev )?(?:server|daemon|process|container))\b`,
    ),
  ],
  [
    "risky",
    re2(
      String.raw`\bdeploy\w*|\bprod(?:uction)?\b|\binfra\w*|\bvpc\b|\bmigrat\w*|\bterraform\b|\bk8s\b|\bkubernetes\b|\bcluster\b|\bdatabase\b|\bdb\b|\bsecrets?\b`,
    ),
  ],
  ["recap", re2(String.raw`^\W*(?:explain|summari[sz]e|recap|tl;?dr)\b`)],
  [
    "nochange",
    re2(
      String.raw`\b(?:just|only) (?:explain|tell me|answer|describe)\b|\b(?:don'?t|do not) (?:change|edit|touch|modify) anything\b|\bno code changes\b`,
    ),
  ],
  [
    "conflict",
    re2(
      String.raw`\brebase|\bamend|\bcherry-?pick|\bfetch\b|\bmerge (?:\w+ )?(?:(?:to|into|in|from|with) )?(?:origin/)?(?:main|master|develop)\b|\bmerge .{0,20}\binto\b|\bresolve|\bconflicts?\b|\bsquash`,
    ),
  ],
  ["errcode", re2(String.raw`\b[45]\d\d\b`)],
  [
    "defer",
    re2(
      String.raw`\bwhen (?:done|finished|you'?re done)\b|\bwhile (?:working|you)\b|\bonce\b|\bafter\b`,
    ),
  ],
  ["request", re2(String.raw`^\W*(?:please\s+)?(?:can|could|would|will)\s+(?:you|u|we)\b`)],
  [
    "harddom",
    re2(
      String.raw`\b(?:intermittent\w*|sometimes|flaky|random(?:ly)?|race condition|races?|deadlock\w*|concurren\w*|threads?|thread-safe|async\w*|memory leak|leak\w*|performance|slow\w*|precision|overflow|unicode|encoding|timezones?|regex\w*|recursion|recursive|cache|caching|edge cases?|corner cases?)\b`,
    ),
  ],
  [
    "multi",
    re2(
      String.raw`\b(?:and also|also|additionally|as well|after that|then|plus|furthermore|moreover)\b`,
    ),
  ],
  [
    "feature",
    re2(
      String.raw`\b(?:support (?:for )?|add (?:a |an )?(?:new )?(?:option|feature|parameter|argument|flag|setting|endpoint|command)|new feature|feature request|deprecat\w*|backwards?[- ]compat\w*|enhancement)\b`,
    ),
  ],
  ["should", re2(String.raw`\b(?:should|expected|instead|but (?:it|got|i get)|however)\b`)],
  ["tests", re2(String.raw`\b(?:tests?|pytest|unittest|jest|vitest|spec|coverage|ci)\b`)],
  [
    "vague",
    re2(
      String.raw`\b(?:something|somehow|anything|whatever|stuff|things?|everything|figure out|not sure|idk|i think|maybe|weird|strange|odd)\b`,
    ),
  ],
  [
    "agents",
    re2(
      String.raw`\b(?:sub-?agents?|agents?|in parallel|parallel|orchestrat\w*|workflow|swarm|team of)\b`,
    ),
  ],
  [
    "thorough",
    re2(
      String.raw`\b(?:thorough\w*|careful\w*|deep(?:ly)?|comprehensive\w*|end[- ]to[- ]end|e2e|ultrathink|think hard\w*|step by step|in depth|exhaustive\w*|full(?:y)?|complete(?:ly)?|everything|all of)\b`,
    ),
  ],
  [
    "show",
    re2(
      String.raw`^\W*(?:show|print|display|list|cat|open|read|give me|tell me|what(?:'s| is| are| was| were| did))\b`,
    ),
  ],
];

const offerRE = re2(
  String.raw`\b(?:want me to|would you like|shall i|should i|do you want|let me know (?:if|which|how|what)|if you(?:'d| would) like|i can (?:also |now )?|which (?:option|approach|one)|ready to (?:proceed|start|implement)|approve|confirm|proceed\?)`,
);
const doneRE = re2(
  String.raw`\b(?:done|completed?|finished|implemented|fixed|updated|added|created|pushed|committed|merged|passes|passing|all tests pass|successfully|works now)\b`,
);
const aErrRE = re2(
  String.raw`\b(?:errors?|failed|failing|fails|failure|cannot|can'?t|unable|blocked|issues?|problems?|bugs?|unfortunately|couldn'?t|didn'?t)\b`,
);
const aPlanRE = re2(
  String.raw`\b(?:plan|proposal|approach|options?|steps?|phases?|design|recommend\w*|next steps?|todo)\b`,
);

// Reply-state cues: what the agent's last reply just did, read from its tail. `end` = the last REPLY_END bytes,
// lower-cased; the others read the whole tail.
const eProceedRE = re2(
  String.raw`\b(?:proceed|go ahead|continue|approve|confirm|ready (?:to|for)|shall i|should i|want me to|would you like|do you want|like me to)\b`,
);
const eOptionRE = re2(String.raw`(?m)^\s*(?:\(?[1-9a-d][.)]\s|[-*]?\s*\*{0,2}option [a-d1-9])`);
const eChoiceRE = re2(String.raw`\bor\b[^.?!\n]{0,80}\?`);
const eTestsRE = re2(
  String.raw`\b(?:all )?tests? (?:pass|passed|passing|are green|green)\b|\b\d+ (?:tests? )?passed\b|\bbuild (?:succeeded|passes|passed)\b|\bno errors\b`,
);
const eSummaryRE = re2(
  String.raw`(?m)^\s*(?:#{1,4}\s*|\*\*)?(?:summary|changes|what (?:i|changed|was)|results?|done|completed)\b`,
);
const eFailRE = re2(
  String.raw`\b(?:still (?:failing|fails|broken|not|see|get)|fail(?:s|ed|ing|ure)?|errors?|cannot|can'?t|could ?n'?t|unable|did ?n'?t work|not working|broken|timed out|crash(?:ed|es)?)\b`,
);
const eBlockerRE = re2(
  String.raw`\b(?:blocked|blocker|needs? (?:your|you to|a decision|approval|permission|input)|waiting (?:for|on)|your (?:call|decision|choice)|let me know|tell me|which (?:one|option|approach)|please (?:confirm|provide|share|choose|decide))\b`,
);
const eNextRE = re2(
  String.raw`\bnext steps?\b|\bremaining\b|\btodo\b|\bstill (?:need|to do)\b|\bfollow-?ups?\b|\bnot yet\b`,
);
const ePlanRE = re2(
  String.raw`(?m)^\s*(?:#{1,4}\s*|\*\*)?(?:plan|phase \d|step \d|proposal|approach|design|recommendation)\b`,
);
const eStepRE = re2(String.raw`(?m)^\s*\d+[.)]\s`);
const eCommitRE = re2(String.raw`\b(?:commit|push|pr|pull request|merge|deploy|release|ship)\b`);

/** What none of a model's heads reads: a cue family (c_, qc_), the reply-state features (e_), a token block. */
export type Skip = ReadonlySet<string>;

/** One ask's dense features, in the order they are added, as float32. named: their names too. */
export class Vec {
  readonly x: Array<number> = [];
  readonly names: Array<string> = [];
  readonly named: boolean;
  constructor(named: boolean) {
    this.named = named;
  }
  add(name: string, x: number): void {
    if (this.named) this.names.push(name);
    this.x.push(Math.fround(x));
  }
  cnt(name: string, n: number): void {
    this.add(name, Math.log1p(n));
  }
  flag(name: string, b: boolean): void {
    this.add(name, b ? 1 : 0);
  }
}

const replyState = (v: Vec, paIn: string, lowAsstIn: string, skip: Skip): void => {
  // No head reads them: the regexes run on nothing.
  const [pa, lowAsst] = skip.has("e_") ? ["", ""] : [paIn, lowAsstIn];
  const end = tailBytes(lowAsst, REPLY_END);
  const i = end.replace(/[ \n\t]+$/, "").lastIndexOf("\n");
  const last = i >= 0 ? end.slice(i + 1) : end;
  v.cnt("e_q_end", countOf(end, "?"));
  v.flag("e_offer_end", offerRE.test(end));
  v.flag("e_proceed", eProceedRE.test(end));
  v.cnt("e_options", eOptionRE.count(lowAsst));
  v.flag("e_choice", eChoiceRE.test(end));
  v.cnt("e_done_end", doneRE.count(end));
  v.flag("e_tests_pass", eTestsRE.test(lowAsst));
  v.flag("e_summary", eSummaryRE.test(lowAsst));
  v.cnt("e_fail_end", eFailRE.count(end));
  v.flag("e_blocker", eBlockerRE.test(end));
  v.flag("e_next", eNextRE.test(lowAsst));
  v.cnt("e_plan", ePlanRE.count(lowAsst));
  v.cnt("e_steps", eStepRE.count(pa));
  v.flag("e_commit", eCommitRE.test(end));
  const paBytes = byteLength(pa);
  v.flag(
    "e_short_answer",
    paBytes > 0 && paBytes < 300 && !pa.includes("```") && !bulletRE.test(pa),
  );
  v.flag("e_full", paBytes >= 1990);
  v.cnt("e_last_len", runeCount(trimSpace(last)));
  v.flag("e_code_end", tailBytes(end, 120).includes("```"));
};

const zero = (x: number): number => (Number.isNaN(x) ? 0 : x);

const l1p = (x: number): number => (Number.isNaN(x) ? NaN : Math.log1p(Math.max(x, 0)));

/** The realized level of an earlier ask with its unknown counts at 0. */
const rank = (h: Hist): number => {
  const [f, n, sp, tf, te, to] = [
    zero(h.files),
    zero(h.nTool),
    zero(h.nSpawn),
    zero(h.testFail),
    zero(h.toolErr),
    zero(h.tokOut),
  ];
  if (f >= 8 || n >= 80 || sp >= 3 || (tf >= 4 && f >= 1)) return 3;
  if (f >= 2 || n >= 20 || sp >= 1 || (tf >= 1 && f >= 1) || te >= 3) return 2;
  if (f >= 1 || n >= 5 || to >= 5000) return 1;
  return 0;
};

/** The f_ features: where this ask sits in a chain of short asks, and what the session did since its last long ask. */
const followUp = (v: Vec, hist: ReadonlyArray<Hist>): void => {
  const k = hist.length;
  let anchor = -1;
  let chain = 0;
  for (let i = k - 1; i >= 0; i--) {
    if (hist[i]!.words > SHORT_WORDS) {
      anchor = i;
      break;
    }
    chain++;
  }
  let [since, prevShort, prevEdited] = [NaN, NaN, NaN];
  let [aw, at, ae, af, ar] = [NaN, NaN, NaN, NaN, NaN];
  let [st, se, sf] = [NaN, NaN, NaN];
  if (k > 0) {
    const prev = hist[k - 1]!;
    prevShort = prev.words <= SHORT_WORDS ? 1 : 0;
    if (!Number.isNaN(prev.nEdit)) prevEdited = prev.nEdit > 0 ? 1 : 0;
  }
  if (anchor >= 0) {
    const a = hist[anchor]!;
    since = k - anchor;
    [aw, at, ae, af, ar] = [Math.log1p(a.words), l1p(a.nTool), l1p(a.nEdit), l1p(a.files), rank(a)];
    let [t, e, f] = [0, 0, 0];
    for (let i = anchor; i < k; i++) {
      const h = hist[i]!;
      [t, e, f] = [t + zero(h.nTool), e + zero(h.nEdit), f + zero(h.files)];
    }
    [st, se, sf] = [Math.log1p(t), Math.log1p(e), Math.log1p(f)];
  }
  let [tt, te, tf] = [0, 0, 0];
  for (const h of hist) [tt, te, tf] = [tt + zero(h.nTool), te + zero(h.nEdit), tf + zero(h.files)];
  v.add("f_since_long", l1p(since));
  v.cnt("f_short_chain", chain);
  v.add("f_prev_short", prevShort);
  v.add("f_prev_edited", prevEdited);
  v.add("f_anchor_words", aw);
  v.add("f_anchor_tool", at);
  v.add("f_anchor_edit", ae);
  v.add("f_anchor_files", af);
  v.add("f_anchor_rank", ar);
  v.add("f_since_tool", st);
  v.add("f_since_edit", se);
  v.add("f_since_files", sf);
  v.add("f_sum_tool", Math.log1p(tt));
  v.add("f_sum_edit", Math.log1p(te));
  v.add("f_sum_files", Math.log1p(tf));
};

const wordSet = (s: string): ReadonlySet<string> => new Set(fields(s));

const questionWords = wordSet("why how what where when which who is are can could does do should");
const imperativeVerbs =
  wordSet(`add build create make implement fix debug refactor rename move remove delete update change write migrate review audit
	check test run deploy explain find investigate improve optimize clean merge commit push rebase document design redo
	continue finish ship install set setup configure port convert replace rewrite research analyze plan spec draft`);

/** headBytes then strings.ToLower then strings.TrimSpace: the opening the cue regexes read. */
const lowHead = (text: string): string => trimSpace(toLower(headBytes(text, CUE_BYTES)));

/** Shape counts over one text. Whole-text counts need no regex; the regexes read the bounded text. */
const shape = (v: Vec, pre: string, text: string, bounded: string): number => {
  let [upper, chars, nonASCII, qm, excl, lines, maxLine, cur, words] = [0, 0, 0, 0, 0, 1, 0, 0, 0];
  let inWord = false;
  for (let i = 0; i < text.length;) {
    const r = text.codePointAt(i)!;
    i += r > 0xffff ? 2 : 1;
    chars++;
    cur++;
    if (r === 0x0a) {
      lines++;
      [maxLine, cur] = [Math.max(maxLine, cur), 0];
    } else if (r === 0x3f) qm++;
    else if (r === 0x21) excl++;
    if (r > 127) nonASCII++;
    if (isUpper(r)) upper++;
    const space = isSpace(r);
    if (!space && !inWord) words++;
    inWord = !space;
  }
  maxLine = Math.max(maxLine, cur);
  v.cnt(`${pre}chars`, chars);
  v.cnt(`${pre}words`, words);
  v.cnt(`${pre}lines`, lines);
  v.cnt(`${pre}max_line`, maxLine);
  v.add(`${pre}word_len`, chars / Math.max(1, words));
  v.add(`${pre}upper_ratio`, upper / Math.max(1, chars));
  v.add(`${pre}nonascii`, nonASCII / Math.max(1, chars));
  v.cnt(`${pre}qmarks`, qm);
  v.cnt(`${pre}excl`, excl);
  v.cnt(`${pre}code_blocks`, Math.trunc(countOf(text, "```") / 2));
  v.cnt(`${pre}inline_code`, inlineCodeRE.count(bounded));
  v.cnt(`${pre}paths`, pathRE.count(bounded));
  v.cnt(`${pre}urls`, urlRE.count(bounded));
  v.cnt(`${pre}trace_n`, traceRE.count(bounded));
  v.cnt(`${pre}bullets`, bulletRE.count(bounded));
  v.cnt(`${pre}headings`, headingRE.count(bounded));
  v.add(`${pre}code_line_share`, codeLineRE.count(bounded) / (countOf(bounded, "\n") + 1));
  v.cnt(`${pre}idents`, identRE.count(bounded));
  v.cnt(`${pre}calls`, callRE.count(bounded));
  v.cnt(`${pre}line_refs`, lineRefRE.count(bounded));
  v.flag(`${pre}q_end`, trimRightSpace(bounded).endsWith("?"));
  return words;
};

/** One flag per cue regex. */
const cues = (v: Vec, pre: string, low: string, skip: Skip): void => {
  const read = !skip.has(pre);
  for (const [name, re] of cueREs) v.flag(pre + name, read && re.test(low));
};

/** Mean and max of the values that are not NaN. */
class Agg {
  sum = 0;
  max = 0;
  n = 0;
  add(x: number): void {
    if (Number.isNaN(x)) return;
    this.sum += x;
    this.n++;
    if (this.n === 1 || x > this.max) this.max = x;
  }
  mean(): number {
    return this.n === 0 ? NaN : this.sum / this.n;
  }
  mx(): number {
    return this.n === 0 ? NaN : this.max;
  }
}

/** time.Duration.Minutes and Seconds of a duration in whole milliseconds, computed as Go computes them. */
const minutes = (ms: number): number => {
  const whole = Math.trunc(ms / 60_000);
  return whole + ((ms - whole * 60_000) * 1e6) / 60e9;
};
const seconds = (ms: number): number => {
  const whole = Math.trunc(ms / 1000);
  return whole + ((ms - whole * 1000) * 1e6) / 1e9;
};

const history = (v: Vec, input: AskInput, hist: ReadonlyArray<Hist>): void => {
  const k = hist.length;
  v.add("s_turn_idx", Math.log1p(input.turnIdx));
  v.flag("s_first", input.turnIdx === 0);
  v.cnt("s_hist_n", k);
  const now = input.ts;
  let [gap, elapsed, meanGap] = [NaN, NaN, NaN];
  if (k > 0 && now !== undefined) {
    const lastTs = hist[k - 1]!.ts;
    if (lastTs !== undefined) gap = Math.log1p(Math.max(minutes(now - lastTs), 0));
    const firstTs = hist[0]!.ts;
    if (firstTs !== undefined) {
      const e = Math.max(minutes(now - firstTs), 0);
      [elapsed, meanGap] = [Math.log1p(e), Math.log1p(e / k)];
    }
  }
  v.add("s_gap", gap);
  v.add("s_elapsed", elapsed);
  v.add("s_mean_gap", meanGap);

  const prev: Hist = k > 0 ? hist[k - 1]! : newHist("", false, undefined);
  // The previous ask's count, NaN when there is none or it is unknown.
  const pv = (x: number): number => (k === 0 ? NaN : l1p(x));
  v.add("h_prev_tool", pv(prev.nTool));
  v.add("h_prev_edit", pv(prev.nEdit));
  v.add("h_prev_files", pv(prev.files));
  v.add("h_prev_spawn", pv(prev.nSpawn));
  v.add("h_prev_err", pv(prev.toolErr));
  v.add("h_prev_testfail", pv(prev.testFail));
  v.add("hx_prev_req", pv(prev.nReq));
  v.add("hx_prev_tok", pv(prev.tokOut));
  const [prevRank, prevChars, prevSlash] =
    k > 0 ? [rank(prev), Math.log1p(prev.runes), prev.slash ? 1 : 0] : [NaN, NaN, NaN];
  v.add("h_prev_rank", prevRank);
  v.add("h_prev_chars", prevChars);
  v.add("h_prev_slash", prevSlash);

  const [tool, edit, files, ranks, chars, last3tool, last3rank, tok] = Array.from(
    { length: 8 },
    () => new Agg(),
  ) as [Agg, Agg, Agg, Agg, Agg, Agg, Agg, Agg];
  let [nHigh, nEdit, spawn, errs, sinceHigh] = [0, 0, 0, 0, NaN];
  let [emaTool, emaRank] = [NaN, NaN];
  hist.forEach((h, i) => {
    const [r, t] = [rank(h), l1p(h.nTool)];
    tool.add(t);
    edit.add(l1p(h.nEdit));
    files.add(l1p(h.files));
    tok.add(l1p(h.tokOut));
    ranks.add(r);
    chars.add(Math.log1p(h.bytes));
    if (i >= k - 3) {
      last3tool.add(t);
      last3rank.add(r);
    }
    if (r === 3) {
      nHigh++;
      sinceHigh = 0;
    } else if (!Number.isNaN(sinceHigh)) sinceHigh++;
    if (zero(h.nEdit) > 0) nEdit++;
    spawn += zero(h.nSpawn);
    errs += zero(h.toolErr);
    if (!Number.isNaN(t)) emaTool = Number.isNaN(emaTool) ? t : 0.5 * emaTool + 0.5 * t;
    emaRank = Number.isNaN(emaRank) ? r : 0.5 * emaRank + 0.5 * r;
  });
  const share = (n: number): number => (k === 0 ? NaN : n / k);
  v.add("h_mean_tool", tool.mean());
  v.add("h_max_tool", tool.mx());
  v.add("h_mean_edit", edit.mean());
  v.add("h_mean_files", files.mean());
  v.add("h_max_files", files.mx());
  v.add("hx_mean_tok", tok.mean());
  v.add("h_mean_rank", ranks.mean());
  v.add("h_max_rank", ranks.mx());
  v.add("h_mean_chars", chars.mean());
  v.add("h_last3_tool", last3tool.mean());
  v.add("h_last3_rank", last3rank.mean());
  v.add("h_ema_tool", emaTool);
  v.add("h_ema_rank", emaRank);
  v.add("h_share_high", share(nHigh));
  v.add("h_share_edit", share(nEdit));
  v.add("h_n_high", Math.log1p(nHigh));
  v.add("h_since_high", l1p(sinceHigh));
  v.add("h_sum_spawn", Math.log1p(spawn));
  v.add("h_sum_err", Math.log1p(errs));
  // The ask before the previous one, and this session's level relative to its own past.
  const [prev2Tool, prev2Rank] = k > 1 ? [l1p(hist[k - 2]!.nTool), rank(hist[k - 2]!)] : [NaN, NaN];
  v.add("h_prev2_tool", prev2Tool);
  v.add("h_prev2_rank", prev2Rank);
  v.add("r_prev_tool_vs_mean", pv(prev.nTool) - tool.mean());
  v.add("r_prev_rank_vs_mean", prevRank - ranks.mean());
  v.add("r_chars_vs_mean", Math.log1p(byteLength(input.text)) - chars.mean());
  v.add(
    "r_chars_vs_prev",
    k > 0 ? Math.log1p(byteLength(input.text)) - Math.log1p(prev.bytes) : NaN,
  );
  const gapPerTool =
    k > 0 && now !== undefined && prev.ts !== undefined
      ? Math.log1p(Math.max(seconds(now - prev.ts), 0) / (zero(prev.nTool) + 1))
      : NaN;
  v.add("r_gap_per_tool", gapPerTool);
};

const HARNESSES = ["claude-code", "codex", "pi", "opencode", "cursor", "gemini-cli"];

/**
 * The hashed token ids of the texts, with repeats (a count is the number of repeats): T the ask, P the previous ask,
 * A the reply tail, G the ask's character grams, E the last REPLY_END bytes of the reply.
 */
export interface Sparse {
  readonly T: ReadonlyArray<number>;
  readonly P: ReadonlyArray<number>;
  readonly A: ReadonlyArray<number>;
  readonly G: ReadonlyArray<number>;
  readonly E: ReadonlyArray<number>;
}

/**
 * The dense vector and the hashed tokens of one ask. It bounds what it reads whatever the caller hands it: the texts
 * at CAP_BYTES, the reply at the tail the training records held (REPLY_RUNES).
 */
export const features = (v: Vec, raw: AskInput, hist: ReadonlyArray<Hist>, skip: Skip): Sparse => {
  const input: AskInput = {
    ...raw,
    text: headBytes(raw.text.toWellFormed(), CAP_BYTES),
    prevText: headBytes(raw.prevText.toWellFormed(), CAP_BYTES),
    prevAsst: lastRunes(raw.prevAsst.toWellFormed(), REPLY_RUNES),
  };
  const text = input.text;
  const bounded = boundText(text, TEXT_HEAD, TEXT_TAIL);
  const low = lowHead(text);
  const words = shape(v, "p_", text, bounded);
  const opening = fields(headBytes(low, 256))[0];
  const first = opening === undefined ? "" : trimNonLetters(opening);
  v.flag("p_question", trimRightSpace(bounded).endsWith("?") || questionWords.has(first));
  v.flag("p_imperative", imperativeVerbs.has(first));
  v.flag("p_image", text.includes("[Image") || headBytes(low, 80).includes("image"));
  v.flag("p_slash", input.slash || text.startsWith("/"));
  v.flag("p_short", words <= 3);
  cues(v, "c_", low, skip);

  // The previous ask (prevText) and the agent's last reply (prevAsst).
  const pt = input.prevText;
  const lowPrev = lowHead(pt);
  v.cnt("q_chars", runeCount(pt));
  v.cnt("q_words", wordCount(pt));
  v.cnt("q_paths", pathRE.count(pt));
  v.cnt("q_code_blocks", Math.trunc(countOf(pt, "```") / 2));
  v.flag("q_same", pt !== "" && trimSpace(pt) === trimSpace(text));
  cues(v, "qc_", lowPrev, skip);
  const pa = input.prevAsst;
  const lowAsst = toLower(pa);
  v.cnt("a_chars", runeCount(pa));
  v.flag("a_q_end", trimRightSpace(pa).endsWith("?"));
  v.cnt("a_qmarks", countOf(pa, "?"));
  v.cnt("a_offer", offerRE.count(lowAsst));
  v.cnt("a_done", doneRE.count(lowAsst));
  v.cnt("a_err", aErrRE.count(lowAsst));
  v.cnt("a_plan", aPlanRE.count(lowAsst));
  v.cnt("a_bullets", bulletRE.count(pa));
  v.cnt("a_code_blocks", Math.trunc(countOf(pa, "```") / 2));
  v.cnt("a_paths", pathRE.count(pa));
  v.cnt("a_inline_code", inlineCodeRE.count(pa));

  for (const h of HARNESSES) v.flag(`z_${h}`, input.harness === h);
  history(v, input, hist);
  replyState(v, pa, lowAsst, skip);
  followUp(v, hist);

  const [tt, tp, ta] = [tokens(bounded), tokens(pt), tokens(pa)];
  v.add("q_jaccard", jaccard(tt, tp));
  v.add("a_jaccard", jaccard(tt, ta));
  return {
    T: hashGrams(tt, true),
    P: hashGrams(tp, false),
    A: hashGrams(ta, false),
    G: skip.has("G") ? [] : charGrams(tt),
    E: skip.has("E") ? [] : hashGrams(tokens(tailBytes(pa, REPLY_END)), false),
  };
};

let names: ReadonlyArray<string> | undefined;

/** The dense vector's order: it never changes. */
export const featureNames = (): ReadonlyArray<string> => {
  if (names === undefined) {
    const v = new Vec(true);
    features(
      v,
      {
        text: "",
        prevText: "",
        prevAsst: "",
        turnIdx: 0,
        harness: "",
        slash: false,
        ts: undefined,
      },
      [],
      new Set(),
    );
    names = v.names;
  }
  return names;
};

/** Lower-cased runs of letters, digits and '_'; every CJK rune and every '?' is its own token. */
const tokens = (s: string): Array<string> => {
  const out: Array<string> = [];
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0) {
      out.push(toLower(s.slice(start, end)));
      start = -1;
    }
  };
  for (let i = 0; i < s.length;) {
    const r = s.codePointAt(i)!;
    if (out.length >= MAX_TOK) break;
    if (r >= 0x2e80 && isLetter(r)) {
      flush(i);
      out.push(String.fromCodePoint(r));
    } else if (isLetter(r) || isDigit(r) || r === 0x5f) {
      if (start < 0) start = i;
    } else {
      flush(i);
      if (r === 0x3f) out.push("?");
    }
    i += r > 0xffff ? 2 : 1;
  }
  flush(s.length);
  return out;
};

const jaccard = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  if (a.length === 0 || b.length === 0) return NaN;
  const sa = new Set(a);
  const sb = new Set<string>();
  let inter = 0;
  for (const w of b) {
    if (!sb.has(w)) {
      sb.add(w);
      if (sa.has(w)) inter++;
    }
  }
  return inter / (sa.size + sb.size - inter);
};

/** FNV-1a over bytes, its offset basis xored with seed (uint32). */
const fnvBytes = (seed: number, bytes: Uint8Array, from: number, to: number): number => {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = from; i < to; i++) h = Math.imul(h ^ bytes[i]!, 16777619) >>> 0;
  return h;
};

/** FNV-1a over the UTF-8 bytes of s. */
const fnv = (seed: number, s: string): number => {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) {
      const bytes = utf8(s);
      return fnvBytes(seed, bytes, 0, bytes.length);
    }
    h = Math.imul(h ^ c, 16777619) >>> 0;
  }
  return h;
};

const MASK = HASH_SIZE - 1;

/** Unigrams and bigrams (and the opening word and opening bigram for the ask itself), into HASH_SIZE buckets. */
const hashGrams = (tok: ReadonlyArray<string>, opening: boolean): Array<number> => {
  const out: Array<number> = [];
  tok.forEach((w, i) => {
    const h = fnv(0, w);
    out.push(h & MASK);
    if (i + 1 < tok.length) out.push((Math.imul(fnv(h, tok[i + 1]!), 31) + 7) & MASK);
  });
  if (opening && tok.length > 0) {
    const t0 = tok[0]!;
    out.push(fnv(0x9e3779b9, t0) & MASK);
    // A second word: the opening bigram; else the whole ask is this one word.
    out.push((tok.length > 1 ? fnv(fnv(0x9e3779b9, t0), tok[1]!) : fnv(0x85ebca6b, t0)) & MASK);
  }
  return out;
};

/** 3- to 5-grams of bytes inside each of the first CHAR_TOK tokens, padded with a space each side (char_wb), hashed. */
const charGrams = (tok: ReadonlyArray<string>): Array<number> => {
  const out: Array<number> = [];
  for (let i = 0; i < tok.length && i < CHAR_TOK; i++) {
    const w = utf8(tok[i]!);
    if (w.length < 3 || w.length > 24) continue;
    const p = new Uint8Array(w.length + 2);
    p[0] = 0x20;
    p.set(w, 1);
    p[w.length + 1] = 0x20;
    for (let n = 3; n <= 5; n++) {
      for (let j = 0; j + n <= p.length; j++) {
        if ((p[j]! & 0xc0) !== 0x80) out.push(fnvBytes(n, p, j, j + n) & MASK);
      }
    }
  }
  return out;
};
