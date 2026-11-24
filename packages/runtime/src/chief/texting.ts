/** The Chief's texting rules, checked outside its session. No model or runtime needed. */
export type TextingRule =
  | "heading"
  | "bold"
  | "list"
  | "steps"
  | "opener"
  | "filler"
  | "hedge"
  | "machinery"
  | "long_paragraph"
  | "long_sentence";

/** Blank ignored syntax without changing offsets, so diagnostics quote the original reply. */
const blank = (text: string) => text.replace(/[^\n\r]/g, " ");

const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
const tableDivider = (line: string) =>
  line.includes("|") && tableCells(line).every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));

const proseOf = (reply: string): string => {
  const lines = reply.split("\n");
  let fence: { mark: string; size: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (
        mark !== null &&
        mark[1]![0] === fence.mark &&
        mark[1]!.length >= fence.size &&
        mark[2]!.trim() === ""
      )
        fence = undefined;
      lines[i] = blank(line);
    } else if (mark !== null) {
      fence = { mark: mark[1]![0]!, size: mark[1]!.length };
      lines[i] = blank(line);
    } else if (line.includes("|") && tableDivider(lines[i + 1] ?? "")) {
      lines[i] = blank(line);
      lines[++i] = blank(lines[i]!);
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim() !== "") {
        lines[++i] = blank(lines[i]!);
      }
    }
  }
  return (
    lines
      .join("\n")
      .replace(/(`+)([\s\S]*?)\1(?!`)/g, blank)
      .replace(/\[\[(?:\d+|chat:[^\]\n]+)\]\]/g, blank)
      .replace(/!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, blank)
      .replace(/!?\[[^\]\n]+\]\[[^\]\n]*\]/g, blank)
      .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, blank)
      .replace(/<(?:https?:\/\/|mailto:)[^>\n]+>/gi, blank)
      // Keep trailing sentence punctuation outside a bare URL.
      .replace(/\b(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.!?,;:]/gi, blank)
  );
};

/** Sentence spans in masked prose. Internal dots in versions, paths and URLs are not boundaries. */
const sentencesOf = (
  paragraph: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  const text = paragraph
    .replace(/^[\t ]*(?:[-+*•]|\d+[.)])[\t ]+/gm, blank)
    .replace(/\b(?:e\.g|i\.e)\./gi, (abbreviation) => abbreviation.replaceAll(".", " "));
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?]+["'”’)\]]*(?=\s|$)/g)) {
    const end = match.index + match[0].length;
    if (/[\p{L}\p{N}]/u.test(text.slice(start, end))) spans.push({ start, end });
    start = end;
  }
  if (/[\p{L}\p{N}]/u.test(text.slice(start))) spans.push({ start, end: text.length });
  return spans;
};

/** Heuristic voice lint, not a grammar checker. Code, links, references and tables are opaque. */
export function textingProblems(
  reply: string,
  opts?: { readonly listAsked?: boolean },
): ReadonlyArray<{ readonly rule: TextingRule; readonly at: string }> {
  const prose = proseOf(reply);
  const problems: Array<{ rule: TextingRule; at: string }> = [];
  const add = (rule: TextingRule, start: number, end: number) => {
    const quote = reply.slice(start, end).replace(/\s+/g, " ").trim();
    problems.push({ rule, at: quote.length > 80 ? `${quote.slice(0, 79)}…` : quote });
  };
  const check = (rule: TextingRule, pattern: RegExp) => {
    for (const match of prose.matchAll(pattern))
      add(rule, match.index, match.index + match[0].length);
  };
  check("heading", /^ {0,3}#{1,6}(?:[\t ]+[^\n]*|$)/gm);
  check("heading", /^[^\s\n][^\n]*\n {0,3}(?:={3,}|-{3,})[\t ]*$/gm);
  check("bold", /\*\*(?=\S)[\s\S]*?\S\*\*|__(?=\S)[\s\S]*?\S__/g);
  if (!opts?.listAsked) check("list", /^[\t ]*(?:[-+*•]|\d+[.)])[\t ]+[^\n]+/gm);
  check("steps", /\bstep[\t ]+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi);
  check(
    "opener",
    /^\s*(?:sure|great question|absolutely|got it|of course)\b[^\n.!?]*(?:[.!?]|$)/gi,
  );
  check("filler", /^\s*(?:(?:done|queued|started|on it|noted)\b[.!]?\s*)+$/gi);
  check("hedge", /\b(?:I|we)\s+(?:would|could)\b|\bI['’]d\s+suggest\b/gi);
  check(
    "machinery",
    // Tool names as they are written (remember and schedule are also plain words, so only their tool forms count),
    // the brief and the board, and the tags the runtime writes.
    /\b(?:chat_[a-z_]+|queue_[a-z_]+|view_(?:open|close|list)|memory_sql|playbook|brief|(?:the|my)\s+board)\b|<(?:note|chat_update)\b/gi,
  );

  // A list item is its own thought; requested lists may contain more than two items.
  for (const paragraph of prose.matchAll(
    /\S[\s\S]*?(?=\r?\n[\t ]*\r?\n|\r?\n[\t ]*(?:[-+*•]|\d+[.)])[\t ]+|$)/g,
  )) {
    const start = paragraph.index;
    const sentences = sentencesOf(paragraph[0]);
    if (sentences.length > 2) add("long_paragraph", start, start + paragraph[0].length);
    for (const sentence of sentences) {
      const text = paragraph[0]
        .slice(sentence.start, sentence.end)
        .replace(/^[\t ]*(?:[-+*•]|\d+[.)])[\t ]+/gm, blank);
      const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
      if (words.length > 25) add("long_sentence", start + sentence.start, start + sentence.end);
    }
  }
  return problems;
}
