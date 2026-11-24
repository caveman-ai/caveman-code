// Code navigation on the Review page without a language server: a name clicked in the diff is looked up by its
// shape. Where the change itself defines or uses it comes from the diff (instant, the head's own lines); where the
// rest of the repository does comes from `git grep` in this computer's checkout (pr.symbol). A line defines the name
// when it reads like a declaration in the languages people review most (JS/TS, Python, Go, Rust, Java/Kotlin/C#,
// Ruby, shell). Heuristic by design: no index to build, nothing to install, right for the common case.
import { linesOf, type DiffFile } from "../../panels/diff/parsePatch.ts";

/** Words that are the language, not a name anyone would look up. */
const KEYWORDS = new Set(
  (
    "abstract and as assert async await break case catch class const continue def default del delete do elif else enum " +
    "except export extends false final finally fn for from func function go if impl implements import in instanceof " +
    "interface is let match mod module mut namespace new nil none not null of or override package pass private " +
    "protected pub public raise readonly return self static struct super switch this throw throws trait true try type " +
    "typeof undefined unless until use var void while with yield None True False Self string number boolean any unknown " +
    "never object int bool str float"
  ).split(" "),
);

/** A name worth looking up: an identifier, two characters at least, not a keyword, not a number. */
export function isSymbol(word: string): boolean {
  return /^[A-Za-z_$][\w$]{1,199}$/.test(word) && !KEYWORDS.has(word);
}

/** The identifier around `offset` in `text`, if the offset falls on one. */
export function wordAt(text: string, offset: number): string | null {
  const isWord = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
  if (!isWord(text[offset]) && !isWord(text[offset - 1])) return null;
  let start = isWord(text[offset]) ? offset : offset - 1;
  let end = start;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  const word = text.slice(start, end);
  return isSymbol(word) ? word : null;
}

const escape = (s: string) => s.replace(/[$]/g, "\\$&");

/** Whether `text` declares `name` (a function, class, type, variable, method, field). */
export function isDefinition(text: string, name: string): boolean {
  const n = escape(name);
  const b = "(?![\\w$])";
  return [
    // function f, class C, type T, def f, fn f, func f, struct S, let/const/var x, val x, enum E, interface I, trait T
    new RegExp(`(?:^|[^\\w$.])(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|module|namespace|record|object|protocol|val|var|let|const|alias)\\s+${n}${b}`),
    // export default function / async function f
    new RegExp(`(?:^|\\s)(?:async\\s+)?function\\s*\\*?\\s*${n}${b}`),
    // destructured: const { a, name } = / let [x, name] =
    new RegExp(`(?:const|let|var)\\s*[{[][^=]*(?<![\\w$])${n}${b}[^=]*[}\\]]\\s*=`),
    // Go method: func (r *T) name(
    new RegExp(`^\\s*func\\s*\\([^)]*\\)\\s*${n}\\s*[(\\[]`),
    // a method or object member: name(args) {   name: (…) =>   name = (…) =>   async name(
    new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set|export|default)\\s+)*\\*?${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`),
    new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|export)\\s+)*${n}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\([^)]*\\)\\s*(?::[^=]+)?=>|[\\w$]+\\s*=>)`),
    // a class field or interface member with a type: name: Type;  name?: Type
    new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|declare)\\s+)*${n}\\??\\s*:\\s*[^=,;]+;?\\s*$`),
    // Python / Ruby / shell
    new RegExp(`^\\s*(?:async\\s+)?def\\s+(?:self\\.)?${n}${b}`),
    new RegExp(`^\\s*${n}\\s*\\(\\)\\s*\\{`),
    // Java / C# / Kotlin / C: Type name( … ) {  (a return type, then the name)
    new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|override|virtual|abstract|suspend|inline|export)\\s+)+[\\w$<>\\[\\],.? ]+\\s+${n}\\s*\\(`),
    // A top-level assignment: NAME = …  (Python constants, shell variables, Makefiles)
    new RegExp(`^${n}\\s*:?=(?!=)`),
  ].some((re) => re.test(text));
}

/** A line of the change that names the symbol. */
export interface SymbolHit {
  readonly path: string;
  readonly line: number;
  /** "old": only on a removed line (the name was there before this change). */
  readonly side: "new" | "old";
  readonly text: string;
  readonly definition: boolean;
}

/**
 * Where the change defines and uses `name`, from its patches: new-side lines (added and unchanged) first, then
 * removed lines (a definition this change deletes is still worth knowing). Each line once.
 */
export function findInDiff(files: ReadonlyArray<DiffFile>, name: string): SymbolHit[] {
  const word = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  const now: SymbolHit[] = [];
  const gone: SymbolHit[] = [];
  for (const file of files)
    for (const row of linesOf(file)) {
      if (row.kind === "hunk" || !word.test(row.text)) continue;
      const hit = { path: file.path, text: row.text, definition: isDefinition(row.text, name) };
      if (row.kind === "del") gone.push({ ...hit, line: row.oldNo ?? 0, side: "old" });
      else now.push({ ...hit, line: row.newNo ?? 0, side: "new" });
    }
  return [...now, ...gone];
}

/**
 * The repository's lines (pr.symbol) as hits, definitions first, without the lines the diff already shows. Searched
 * at the head, a changed file's other lines are right as they are; searched at the base, a changed file's numbers
 * no longer hold, so its lines are left to the diff.
 */
export function repoHits(
  hits: ReadonlyArray<{ path: string; line: number; text: string }>,
  name: string,
  at: "head" | "base",
  changed: ReadonlySet<string>,
  inDiff: ReadonlyArray<SymbolHit>,
): SymbolHit[] {
  const shown = new Set(inDiff.filter((h) => h.side === "new").map((h) => `${h.path}:${h.line}`));
  return hits
    .filter((h) => (at === "head" ? !shown.has(`${h.path}:${h.line}`) : !changed.has(h.path)))
    .map((h) => ({ path: h.path, line: h.line, text: h.text, side: "new" as const, definition: isDefinition(h.text, name) }))
    .sort((a, b) => Number(b.definition) - Number(a.definition));
}
