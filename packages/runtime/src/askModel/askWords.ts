// What Caveman Cloud's router reads of a task brief before and beside the ask model: the person's words without a
// harness's wrappers (askWords), whether it is a slash command (typedSlash), and the judgement-call cue that keeps a
// coding ask high (judgementAsk). A port of gateway-managed/internal/routedecide ask_words.go.
import { fields, headBytes, headRunes, tailBytes, toLower, trimSpace } from "./goText.ts";
import { re2, re2Source } from "./re2.ts";

// The blocks a harness injects into the user's turn, read as the router's `(?s)<(names)>.*?</(names)>` reads them.
const HARNESS_TAGS = [
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "user-prompt-submit-hook",
  "task-notification",
];

const REMINDER_TAG = ["system-reminder"];

/** Commands Claude Code answers itself: the record of one is never the ask. */
const LOCAL_COMMANDS = new Set(
  fields(`clear compact exit quit model login logout help config cost status resume mcp doctor memory permissions vim theme
		terminal-setup ide hooks agents add-dir bug release-notes context usage export rewind fast effort output-style statusline plugin plugins
		skills upgrade privacy-settings tasks bashes stats feedback rename sandbox todos install-github-app migrate-installer approved-tools copy
		color branch fork new diff undo mention approvals init-verifiers keybindings remote-control mobile chrome btw stickers passes
		extra-usage rate-limit-options think-back voice desktop teleport remote-env reload-plugins heapdump insights
		plan redo share unshare sessions models themes editor details thinking`),
);

const CODEX_INJECTED = [
  "<environment_context>",
  "<user_instructions>",
  "<user_shell_command>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
];

const typedSlashRE = re2(String.raw`^/[A-Za-z][\w:.-]*(?:\s|$)`);
const rootPathRE = re2(
  String.raw`^/(?:Users|home|tmp|var|etc|opt|usr|mnt|private|root|workspace|data|app|src|bin|lib|dev|proc|sys|Volumes|Library|Applications)\b`,
);

/** An ask that is a slash command or skill ("/name …"), an absolute path apart. */
export const typedSlash = (text: string): boolean =>
  typedSlashRE.test(text) && !rootPathRE.test(text);

/**
 * A user turn's text as the model's training data records the ask: a slash command or skill as "/name args"; else
 * the person's words, without interrupt notes, a compaction summary or Codex's injected context.
 */
export const askWords = (text: string): string => {
  const command = slashCommand(text);
  if (command !== "") return command;
  let words = userWords(text);
  while (words.startsWith("[Request interrupted")) {
    const nl = words.indexOf("\n");
    words = trimSpace(nl < 0 ? "" : words.slice(nl + 1));
  }
  if (
    words.startsWith("This session is being continued from a previous conversation") ||
    CODEX_INJECTED.some((prefix) => words.startsWith(prefix))
  ) {
    return "";
  }
  // Codex's IDE extension sends its context and the ask as one text.
  const marker = "## My request for Codex:";
  const at = words.indexOf(marker);
  if (at >= 0 && words.startsWith("#")) return trimSpace(words.slice(at + marker.length));
  return words;
};

/**
 * The user's words in a text: without the harness's tags, another session's message, or a turn of tags only; a reply
 * to the agent's question is unwrapped.
 */
export const userWords = (text: string): string => {
  const words = trimSpace(stripTags(text, HARNESS_TAGS, HARNESS_TAGS));
  if (words.startsWith("Another Claude session sent a message")) return "";
  const [open, closing] = [
    "<send_user_message_question_reply",
    "</send_user_message_question_reply>",
  ];
  if (words.startsWith(open) && words.endsWith(closing)) {
    // The opening tag must end before the closing one begins.
    const start = words.indexOf(">");
    if (start >= 0 && start + 1 <= words.length - closing.length)
      return trimSpace(words.slice(start + 1, words.length - closing.length));
  }
  return tagsOnly(words) ? "" : words;
};

/**
 * The slash command or skill a Claude Code turn runs, as "/name args": the harness sends it in <command-…> tags and
 * its expansion as the text. "" when it runs none, or one the harness answered itself.
 */
const slashCommand = (text: string): string => {
  const block = trimSpace(stripTags(text, REMINDER_TAG, REMINDER_TAG));
  if (!block.startsWith("<command-") || block.includes("<local-command-std")) return "";
  const name = commandName(block);
  if (name === "" || LOCAL_COMMANDS.has(name)) return "";
  const args = tagBody(block, "<command-args>", "</command-args>");
  return args !== undefined && trimSpace(args) !== "" ? `/${name} ${trimSpace(args)}` : `/${name}`;
};

/**
 * Removes what `(?s)<(opens)>.*?</(closes)>` matches: from the earliest opening tag to the earliest closing tag after
 * it, again after that. An opening tag with no closing tag after it ends the pass, as no later one has one either.
 */
const stripTags = (
  text: string,
  opens: ReadonlyArray<string>,
  closes: ReadonlyArray<string>,
): string => {
  let out = "";
  let pos = 0;
  for (;;) {
    const [at, open] = findTag(text, pos, "<", opens);
    if (at < 0) break;
    const [end, closing] = findTag(text, at + open, "</", closes);
    if (end < 0) break;
    out += text.slice(pos, at);
    pos = end + closing;
  }
  return pos === 0 ? text : out + text.slice(pos);
};

/**
 * The first index at or after from where text holds prefix ("<" or "</"), one of names and ">", and that tag's
 * length; -1 when there is none.
 */
const findTag = (
  text: string,
  from: number,
  prefix: "<" | "</",
  names: ReadonlyArray<string>,
): readonly [number, number] => {
  for (let i = text.indexOf("<", from); i >= 0; i = text.indexOf("<", i + 1)) {
    let rest = i + 1;
    if (prefix === "</") {
      if (text[rest] !== "/") continue;
      rest++;
    }
    for (const name of names) {
      if (text.startsWith(name, rest) && text[rest + name.length] === ">")
        return [i, prefix.length + name.length + 1];
    }
  }
  return [-1, 0];
};

const isRe2Space = (c: string | undefined): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/** The name `<command-name>\s*\/?([^<\s]+)\s*</command-name>` captures first (\s is RE2's). */
const commandName = (text: string): string => {
  const [open, closing] = ["<command-name>", "</command-name>"];
  for (let from = 0; ;) {
    const i = text.indexOf(open, from);
    if (i < 0) return "";
    from = i + open.length;
    let k = from;
    while (k < text.length && isRe2Space(text[k])) k++;
    const start = k;
    if (text[k] === "/") k++;
    const run = k;
    while (k < text.length && text[k] !== "<" && !isRe2Space(text[k])) k++;
    let name = text.slice(run, k);
    // "/" alone: the optional slash gives way to the name.
    if (name === "" && run > start) name = "/";
    while (k < text.length && isRe2Space(text[k])) k++;
    if (name !== "" && text.startsWith(closing, k)) return name;
  }
};

/** What `(?s)open(.*?)closing` captures: the text between the first opening and the first closing after it. */
const tagBody = (text: string, open: string, closing: string): string | undefined => {
  const i = text.indexOf(open);
  if (i < 0) return undefined;
  const j = text.indexOf(closing, i + open.length);
  return j < 0 ? undefined : text.slice(i + open.length, j);
};

/** text is one or more <tag …>…</tag> blocks and nothing else. */
const tagsOnly = (input: string): boolean => {
  let text = input;
  if (text === "" || text[0] !== "<") return false;
  while (text !== "") {
    const end = text.search(/[ \t\n>]/);
    if (text[0] !== "<" || end <= 1) return false;
    const closing = `</${text.slice(1, end)}>`;
    const at = text.indexOf(closing);
    if (at < 0) return false;
    text = trimSpace(text.slice(at + closing.length));
  }
  return true;
};

// The router's hard cues (localpolicy taskclass.go hardCue, prompt.go), for the one it keeps a coding ask high on:
// a judgement call.
const traceRE = re2(
  String.raw`(?m)Traceback \(most recent|^\s+at .+\(.+:\d+:\d+\)|panic:|Error:|Exception|error TS\d+|\.\w{1,5}:\d+:\d+|FAIL\b|exit code|stack trace|npm ERR`,
);
const pathRE = re2(
  String.raw`(?:~|\.{0,2}/)?[\w@.-]+(?:/[\w@.+-]+)+|[\w-]+\.(?:py|ts|tsx|js|jsx|go|rs|swift|md|json|yaml|yml|sql|sh|css|html|toml|mjs|tf)\b`,
);
const bulletRE = re2(String.raw`(?m)^\s*(?:[-*•]|\d+[.)])\s`);
const fixRE = re2(
  String.raw`\b(?:fix|bugs?|broken|errors?|fail|fails|failing|failed|failure|crash(?:es|ing)?|panics?|regression|flaky|exception|500|404|doesn'?t work|not working|wrong|leaks?|slow|hangs?|timeouts?|deadlocks?)\b`,
);
const errCodeRE = re2(String.raw`\b[45]\d\d\b`);
const whyRE = re2(
  String.raw`^\W*(?:why|how come)\b|\bwhy (?:is|are|does|do|did|didn'?t|doesn'?t|isn'?t|not|would|can'?t|won'?t|was)\b|\bhow come\b`,
);
const correctionRE = re2(
  String.raw`^\W*(?:no|nope|wrong)(?:\W*$|\s*[,.!])|^\W*(?:nope|wrong)\b|\bstill\b|\bdoesn'?t work|\bdidn'?t work|\bnot working\b|\bthat'?s (?:not|wrong)\b|\byou broke\b|\bnot what i\b|\btry again\b|\bsame (?:error|issue|problem)\b|\bnothing changed\b|\brevert\b|\bundo\b`,
);
const judgeRE = re2(
  String.raw`\bshould (?:we|i|it|this|they)\b|\bworth\b|\bwhat if\b|\bbetter\b|\bis (?:it|this|that) (?:smart|safe|secure|correct|right|fair|good|ok|enough)\b|\bcompar\w*|\bversus\b|\bvs\.?\s|\bhonest\w*|\bsmart\b|\brecommend\w*|\bsuggest\w*|\bideas?\b|\bassess\w*|\bevaluat\w*|\breview\w*|\baudit\w*|\bgaps?\b|\bsecur\w+|\binvestigat\w*|\bresearch\w*|\bdebug\w*|\broot cause|\bwhat do you think\b|\bdecid\w*|\bimprov\w*|\boptimi[sz]\w*|\bunderstand\b|\bpositive\b|\bsure\?`,
);
const fillerRE = new RegExp(
  re2Source(
    String.raw`^\W*((ok(ay)?|so|and|but|wait|hm+|um+|well|also|then|yeah|yes|no|hmm|right|cool|nice|lol|like|actually|now)\b[\s,.!]*)+`,
  ),
  "u",
);

/**
 * The first n bytes of s lower-cased as Go's strings.ToLower(s[:n]) gives them: a rune the cut splits becomes one
 * U+FFFD per byte kept.
 */
const lowerByteCut = (s: string, n: number): string => {
  const head = headBytes(s, n);
  const split =
    Buffer.byteLength(head) < n && head.length < s.length ? n - Buffer.byteLength(head) : 0;
  return toLower(head) + "�".repeat(split);
};

/**
 * judgementAsk: the router's first hard cue for the ask is a judgement call. None of the cues it checks first holds
 * (a trace or code, a paste or an image, more than 40 words or a list, two paths, a correction, a why, a fix), and
 * judgeRE matches. It reads the ask as the router's Prompt does: its first 8 KiB and last 2 KiB, and the cues the
 * first 2 KiB of that.
 */
export const judgementAsk = (text: string): boolean => {
  const bounded =
    Buffer.byteLength(text) > 10 << 10
      ? `${headBytes(text, 8 << 10)}\n${tailBytes(text, 2 << 10)}`
      : text;
  const low = trimSpace(lowerByteCut(bounded, 2 << 10));
  if (!judgeRE.test(low)) return false;
  const lead = headRunes(lowerByteCut(bounded, 256), 50);
  const count = (sub: string) => text.split(sub).length - 1;
  return !(
    traceRE.test(bounded) ||
    count("```") >= 2 ||
    text.includes("[Image") ||
    lead.includes("image") ||
    low.includes("<pasted_content") ||
    count("\n") >= 6 ||
    promptWords(bounded) > 40 ||
    bulletRE.count(bounded) >= 2 ||
    pathRE.count(bounded) >= 2 ||
    correctionRE.test(low) ||
    whyRE.test(low) ||
    fixRE.test(low) ||
    errCodeRE.test(low)
  );
};

/** An ask's words as the router's taxonomy evidence counts them: its first 4,000 runes, lower-cased, without an opening of filler words. */
const promptWords = (input: string): number => {
  const text = toLower(headRunes(trimSpace(input), 4000));
  const low = text.replace(fillerRE, "");
  return fields(low !== "" ? low : text).length;
};
