// Adapted from shadcn/ui lib/highlighter.tsx + hooks/use-highlighted-code.ts
// (registry/base-nova, MIT, 2026-10 AI Elements). The app's one Shiki: chat
// fences, diffs and the side panel's CodeView all tokenize here. Each
// language's grammar loads on first use, and a CSS-variables theme so token
// colours come from deck tokens (see CODE_THEME in code-block.tsx), not a
// vendor palette. While code streams, only the new lines are tokenized.
//
// Always the Oniguruma WASM engine: Shiki's JavaScript regex engine can
// backtrack catastrophically on some grammars and hang the tab (upstream pins
// the WASM engine for the same reason). WASM, engine and grammars are lazy
// chunks; nothing of Shiki is in the initial bundle.
import * as React from "react";
import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

export type { GrammarState };

// Keys are Shiki language ids (or an alias the grammar declares), so a key is
// also the `lang` passed to the tokenizer.
const languages = {
  bash: () => import("shiki/langs/shellscript.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  // The side panel opens any file in a repo, not only what a chat fences.
  astro: () => import("shiki/langs/astro.mjs"),
  asm: () => import("shiki/langs/asm.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  codeowners: () => import("shiki/langs/codeowners.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  csv: () => import("shiki/langs/csv.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  elm: () => import("shiki/langs/elm.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  fsharp: () => import("shiki/langs/fsharp.mjs"),
  gleam: () => import("shiki/langs/gleam.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsonl: () => import("shiki/langs/jsonl.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  just: () => import("shiki/langs/just.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  "objective-cpp": () => import("shiki/langs/objective-cpp.mjs"),
  ocaml: () => import("shiki/langs/ocaml.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  rst: () => import("shiki/langs/rst.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  tsv: () => import("shiki/langs/tsv.mjs"),
  viml: () => import("shiki/langs/viml.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};
type Lang = keyof typeof languages;

const aliases: Record<string, Lang> = {
  js: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  console: "bash",
  zsh: "bash",
  ts: "typescript",
  mts: "typescript",
  yml: "yaml",
  golang: "go",
  patch: "diff",
  // File extensions and fence names for the grammars above.
  cjs: "javascript", cts: "typescript", htm: "html", pyi: "python", ndjson: "jsonl",
  h: "c", cc: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", "c++": "cpp", cs: "csharp", fs: "fsharp",
  m: "objective-c", mm: "objective-cpp", objc: "objective-c", kt: "kotlin", kts: "kotlin", rb: "ruby",
  ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", ml: "ocaml", clj: "clojure", jl: "julia",
  pl: "perl", gql: "graphql", tf: "terraform", tfvars: "terraform", sol: "solidity", tex: "latex",
  vim: "viml", ps1: "powershell", cmd: "bat", svg: "xml", plist: "xml", properties: "ini", cfg: "ini",
  env: "dotenv", dockerfile: "docker", makefile: "make", justfile: "just",
 // Dialects with no grammar of their own read as their base language (upstream #25865); assembly by its usual names (#27899).
  luau: "lua", xsd: "xml", xsl: "xml", xslt: "xml", s: "asm", nasm: "asm", assembly: "asm",
};

/** File extension or fence info -> a language we highlight, or null (plain text). */
export function resolveLanguage(language: string | null | undefined): Lang | null {
  if (!language) return null;
  const name = language.toLowerCase().replace(/^\./, "");
  if (name in languages) return name as Lang;
  return aliases[name] ?? null;
}

// Files whose name, not extension, says what they are.
const FILENAMES: Record<string, Lang> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", justfile: "just",
  "cmakelists.txt": "cmake", gemfile: "ruby", rakefile: "ruby", jenkinsfile: "groovy", codeowners: "codeowners",
  "go.mod": "go", "go.work": "go", "tsconfig.json": "jsonc", "jsconfig.json": "jsonc",
  ".gitignore": "ini", ".gitattributes": "ini", ".dockerignore": "ini", ".npmignore": "ini", ".prettierignore": "ini",
  ".editorconfig": "ini", ".npmrc": "ini", ".gitconfig": "ini",
  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", ".bash_profile": "bash", ".zprofile": "bash",
};

/** A file path -> the language we highlight it as, or null (plain text). */
export function languageFromPath(path: string): Lang | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  const known = FILENAMES[name];
  if (known) return known;
  if (name.startsWith("dockerfile.")) return "docker";
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : resolveLanguage(name.slice(dot + 1));
}

/** ```go title="retry.go"  or  ```ts src/a.ts  -> the file name. */
export function fenceTitle(rest: string): string | null {
  const t = /title=["']?([^"'\s]+)/.exec(rest)?.[1] ?? /^\s*:?([\w./-]+\.\w+)\s*$/.exec(rest)?.[1];
  return t ? (t.split(/[\\/]/).pop() ?? t) : null;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", js: "JavaScript", javascript: "JavaScript", jsx: "JSX",
  go: "Go", rs: "Rust", rust: "Rust", py: "Python", python: "Python", sh: "Shell", bash: "Shell", zsh: "Shell",
  shell: "Shell", console: "Shell", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", sql: "SQL", diff: "Diff",
  patch: "Diff", md: "Markdown", markdown: "Markdown", css: "CSS", html: "HTML",
  c: "C", cpp: "C++", csharp: "C#", docker: "Dockerfile", dotenv: ".env", graphql: "GraphQL", ini: "INI", java: "Java",
  jsonc: "JSON", kotlin: "Kotlin", lua: "Lua", make: "Makefile", php: "PHP", ruby: "Ruby", scss: "SCSS", swift: "Swift",
  xml: "XML", vue: "Vue", svelte: "Svelte", terraform: "Terraform", proto: "Protobuf", powershell: "PowerShell",
  asm: "Assembly", luau: "Luau",
};

export function languageName(lang: string | null): string {
  if (!lang) return "Code";
  return LANGUAGE_NAMES[lang.toLowerCase()] ?? lang;
}

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/oniguruma")])
    .then(([core, engine]) =>
      core.createHighlighterCore({
        themes: [core.createCssVariablesTheme({ name: "caveman", variablePrefix: "--shiki-", fontStyle: true })],
        langs: [],
        engine: engine.createOnigurumaEngine(import("shiki/wasm")),
      }),
    )
    .catch((error: unknown) => {
      highlighter = undefined; // a failed WASM load is retried on the next use
      throw error;
    });
  return highlighter;
}

type Highlighter = {
  highlight(code: string, state?: GrammarState): { lines: React.ReactNode[]; state: GrammarState | undefined };
};

const loaded = new Map<Lang, Highlighter>();

async function loadHighlighter(lang: Lang): Promise<Highlighter> {
  const cached = loaded.get(lang);
  if (cached) return cached;
  const shiki = await getHighlighter();
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(languages[lang]);
  const h: Highlighter = {
    highlight(code, state) {
      const result = shiki.codeToTokens(code, {
        lang,
        theme: "caveman",
        tokenizeMaxLineLength: 4000, // a minified line stays plain instead of stalling the tokenizer
        ...(state ? { grammarState: state } : {}),
      });
      return { lines: result.tokens.map(renderLine), state: result.grammarState };
    },
  };
  loaded.set(lang, h);
  return h;
}

function renderLine(line: ThemedToken[]): React.ReactNode {
  // Spaces and tabs have no ink; avoid a styled span for every gap. Keep
  // italic whitespace spans so their font metrics remain unchanged.
  return line.map((token, i) =>
    /^[ \t]+$/.test(token.content) && token.fontStyle !== 1 ? token.content : React.createElement(
      "span",
      { key: i, style: { color: token.color, fontStyle: token.fontStyle === 1 ? "italic" : undefined } },
      token.content,
    ),
  );
}

const SLICE_LINES = 50;

/**
 * Tokenize one range of a file, continuing from the range above's `state`, for
 * viewers that highlight a big file in chunks (markdown/CodeView). Yields
 * between ~50-line slices (~5 ms each) so a long range never holds a frame.
 * Null when the language is not one we highlight.
 */
// ponytail: tokenizing runs on the main thread. Upgrade: a worker.
export async function highlightLines(
  code: string,
  language: string | null | undefined,
  state?: GrammarState,
): Promise<{ lines: React.ReactNode[]; state: GrammarState | undefined } | null> {
  const lang = resolveLanguage(language);
  if (!lang) return null;
  const h = await loadHighlighter(lang);
  const source = code.split("\n");
  const lines: React.ReactNode[] = [];
  let last = state;
  for (let i = 0; i < source.length; i += SLICE_LINES) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const r = h.highlight(source.slice(i, i + SLICE_LINES).join("\n"), last);
    lines.push(...r.lines);
    last = r.state;
  }
  return { lines, state: last };
}

/** One React node per line; plain strings until the language has loaded. */
export function useHighlightedCode(value: string, language: string | null | undefined): React.ReactNode[] {
  const lang = resolveLanguage(language);
  const code = value.endsWith("\n") ? value.slice(0, -1) : value;
  const [h, setH] = React.useState<{ lang: Lang; h: Highlighter } | null>(() => {
    const cached = lang ? loaded.get(lang) : undefined;
    return lang && cached ? { lang, h: cached } : null;
  });
  const current = h && h.lang === lang ? h.h : null;

  React.useEffect(() => {
    if (!lang || current) return;
    let cancelled = false;
    loadHighlighter(lang)
      .then((next) => !cancelled && setH({ lang, h: next }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lang, current]);

  // Complete lines are tokenized once; the line still being written re-tokenizes each render.
  const done = React.useRef<{ h: Highlighter | null; text: string; lines: React.ReactNode[]; state?: GrammarState | undefined }>({ h: null, text: "", lines: [] });
  return React.useMemo(() => {
    if (!current) return code.split("\n");
    let next = done.current;
    if (next.h !== current || !code.startsWith(next.text)) next = { h: current, text: "", lines: [] };
    const end = code.lastIndexOf("\n") + 1;
    if (end > next.text.length) {
      const r = current.highlight(code.slice(next.text.length, end - 1), next.state);
      next = { h: current, text: code.slice(0, end), lines: [...next.lines, ...r.lines], state: r.state };
    }
    done.current = next;
    return [...next.lines, current.highlight(code.slice(end), next.state).lines[0] ?? ""];
  }, [code, current]);
}
