// The featurizer's Go regexps (RE2 syntax, leftmost-first) as JS regexes that answer the same on any well-formed
// text. Under the u flag a JS regex reads code points, as RE2 reads runes, and \w, \W, \d and \b are ASCII in both.
// What differs is rewritten: RE2's \s is [\t\n\f\r ] (JS's adds \v and Unicode spaces); its . is any rune but \n
// (JS's also stops at \r, U+2028 and U+2029); under (?m) its ^ and $ are line ends at \n alone. Anything else
// (case folding, other flags, POSIX classes) is refused rather than guessed at.

const SPACE = "\\t\\n\\f\\r ";
const SYNTAX = "^$\\.*+?()[]{}|/";

/** The JS source (for the u flag) of an RE2 expression: flags are an optional leading (?m) and nothing else. */
export const re2Source = (expr: string): string => {
  let src = expr;
  let multiline = false;
  if (src.startsWith("(?m)")) {
    multiline = true;
    src = src.slice(4);
  }
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[++i];
      if (n === undefined) throw new Error(`re2: trailing backslash in ${expr}`);
      if (n === "s") out += inClass ? SPACE : `[${SPACE}]`;
      else if (n === "S" && !inClass) out += `[^${SPACE}]`;
      else if ("bBwWdDnt".includes(n) || SYNTAX.includes(n) || (inClass && n === "-"))
        out += `\\${n}`;
      else throw new Error(`re2: unsupported escape \\${n} in ${expr}`);
      continue;
    }
    if (inClass) {
      if (c === "[") throw new Error(`re2: unsupported class syntax in ${expr}`);
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    switch (c) {
      case "[":
        inClass = true;
        out += c;
        if (src[i + 1] === "^") out += src[++i];
        if (src[i + 1] === "]") throw new Error(`re2: unsupported class syntax in ${expr}`);
        break;
      case ".":
        out += "[^\\n]";
        break;
      case "^":
        out += multiline ? "(?<![^\\n])" : "^";
        break;
      case "$":
        out += multiline ? "(?![^\\n])" : "$";
        break;
      case "(":
        if (src[i + 1] === "?" && src[i + 2] !== ":")
          throw new Error(`re2: unsupported group flags in ${expr}`);
        out += c;
        break;
      default:
        out += c;
    }
  }
  if (inClass) throw new Error(`re2: unclosed class in ${expr}`);
  return out;
};

/** One Go regexp: MatchString, and the number of matches FindAllStringIndex finds. */
export interface Re2 {
  readonly test: (s: string) => boolean;
  readonly count: (s: string) => number;
}

export const re2 = (expr: string): Re2 => {
  const source = re2Source(expr);
  const once = new RegExp(source, "u");
  const all = new RegExp(source, "gu");
  return {
    test: (s) => once.test(s),
    // Go's allMatches: after a match it searches on from the match's end; an empty match steps one rune, and does
    // not count when it starts where the previous match ended.
    count: (s) => {
      let n = 0;
      let prevEnd = -1;
      for (let pos = 0; pos <= s.length;) {
        all.lastIndex = pos;
        const m = all.exec(s);
        if (m === null) break;
        const end = m.index + m[0].length;
        let accept = true;
        if (end === pos) {
          accept = m.index !== prevEnd;
          pos += pos < s.length && s.codePointAt(pos)! > 0xffff ? 2 : 1;
        } else pos = end;
        prevEnd = end;
        if (accept) n++;
      }
      return n;
    },
  };
};
