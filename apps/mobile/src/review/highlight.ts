// Code coloured the way the desktop's highlighter colours it (packages/ui/src/ai/code-block.tsx CODE_THEME): keywords,
// strings, functions and constants each in one of the deck's chart inks, comments and punctuation in grey, the rest in
// ink. The desktop runs Shiki; a phone has no WASM to spare for a handful of excerpts, so this reads a line at a time
// with a few patterns per language, which is enough for a reader to tell a call from a string. Constants never take
// the deck's amber here: on the phone amber is only ever what waits on you.
import type { Colors } from "../theme";

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "fn" | "type" | "punct" | "tag";

export interface Token {
  kind: TokenKind;
  text: string;
}

export type Language = "ts" | "go" | "css" | "markup" | "text";

/** The language a path is read in. */
export function languageOf(path: string): Language {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (ext === "go") return "go";
  if (["css", "scss"].includes(ext)) return "css";
  if (["astro", "html", "svelte", "vue"].includes(ext)) return "markup";
  return "text";
}

const KEYWORDS: Record<Language, ReadonlySet<string>> = {
  ts: new Set(
    "import export from as default const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends implements interface type enum async await yield try catch finally throw this super null undefined true false void readonly keyof satisfies declare namespace".split(
      " ",
    ),
  ),
  go: new Set("package import func return if else for range switch case default break continue go defer select chan map struct interface type var const nil true false make new len cap append".split(" ")),
  css: new Set(["@media", "@supports", "!important", "var", "hsl", "rgb", "calc"]),
  markup: new Set(["const", "import", "from", "export", "let", "return"]),
  text: new Set(),
};

const PATTERN: Record<Language, RegExp> = {
  ts: /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`]+)/y,
  go: /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|`[^`]*`?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)|(\s+)|([^\sA-Za-z_\d"'`]+)/y,
  css: /()(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(-?\b\d[\d.]*(?:px|pt|rem|em|ms|s|%)?\b)|(@?[A-Za-z_-][\w-]*)|(\s+)|([^\sA-Za-z_\d"'@-]+)/y,
  markup: /(<!--.*?(?:-->|$))|(<\/?[A-Za-z][\w.-]*|\/?>)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d.]*\b)|([A-Za-z_][\w-]*)|(\s+)|([^\sA-Za-z_\d"'<>]+)/y,
  text: /()()()()([^\s]+)|(\s+)|()/y,
};

/** One line's tokens. */
export function tokenize(line: string, language: Language): Token[] {
  if (language === "text" || !line) return [{ kind: "plain", text: line }];
  const re = PATTERN[language];
  const keywords = KEYWORDS[language];
  const out: Token[] = [];
  let at = 0;
  while (at < line.length) {
    re.lastIndex = at;
    const m = re.exec(line);
    if (!m || m[0].length === 0) {
      out.push({ kind: "plain", text: line.slice(at) });
      break;
    }
    const text = m[0];
    let kind: TokenKind = "plain";
    if (language === "markup") {
      if (m[1]) kind = "comment";
      else if (m[2]) kind = "tag";
      else if (m[3]) kind = "string";
      else if (m[4]) kind = "number";
      else if (m[5]) kind = keywords.has(text) ? "keyword" : line[at + text.length] === "=" ? "fn" : "plain";
      else if (m[7]) kind = "punct";
    } else if (m[1] || m[2]) kind = "comment";
    else if (m[3]) kind = "string";
    else if (m[4]) kind = "number";
    else if (m[5]) {
      if (keywords.has(text)) kind = "keyword";
      else if (language === "css") kind = line.slice(at + text.length).trimStart().startsWith(":") ? "fn" : "plain";
      else if (/^\s*\(/.test(line.slice(at + text.length))) kind = "fn";
      else if (/^[A-Z]/.test(text)) kind = "type";
    } else if (m[7]) kind = "punct";
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
    at += text.length;
  }
  return out;
}

/** Each kind's ink in this theme: the deck's chart inks for keywords, strings and functions; amber nowhere. */
export function inkOf(kind: TokenKind, c: Colors, dark: boolean): string {
  switch (kind) {
    case "keyword":
      return dark ? "#a993f0" : "#6e45c9";
    case "string":
      return dark ? "#5ccf9b" : "#13804f";
    case "fn":
      return dark ? "#76aef8" : "#2563c4";
    case "number":
      return dark ? "#4fc1cf" : "#0e7581";
    case "type":
      return dark ? "#d7c6ff" : "#5a3fa8";
    case "tag":
      return dark ? "#76aef8" : "#2563c4";
    case "comment":
      return c.subtle;
    case "punct":
      return c.muted;
    default:
      return c.text;
  }
}
