// How the scripted world writes its pull requests' diffs and guides (review/guides.ts): a file as its hunks, each
// with its header's starts and its lines marked as a patch marks them, and a guide's excerpts and notes placed by the
// words they point at rather than by counted line numbers, which a hand-written diff gets wrong. What comes out is the
// wire's own shape (`pr.diff`'s files, `pr.guide`'s stops), so the screens read it as they would a runtime's.
import { type DiffFile, linesOf } from "./diff";
import type { PrGuideExcerpt } from "./model";

/** Tabs as a patch carries them; a hunk's body is written with them as two spaces would read wrong in Go. */
const TAB = "\t";

/**
 * One hunk: where it starts on each side, the block git names after its header, and its lines, each led by "+", "-"
 * or " " (a bare blank line is a blank context line). `»` stands for a tab, so Go reads as Go.
 */
export function hunk(oldStart: number, newStart: number, context: string, body: string): string {
  const lines = body.replace(/»/g, TAB).split("\n");
  if (lines[0] === "") lines.shift();
  if (lines[lines.length - 1] === "") lines.pop();
  const oldCount = lines.filter((l) => !l.startsWith("+")).length;
  const newCount = lines.filter((l) => !l.startsWith("-")).length;
  return [`@@ -${oldCount ? oldStart : 0},${oldCount} +${newStart},${newCount} @@${context ? ` ${context}` : ""}`, ...lines.map((l) => (l === "" ? " " : l))].join("\n");
}

/** A changed file from its hunks, its counts read off them. */
export function file(path: string, status: DiffFile["status"], ...hunks: string[]): DiffFile {
  const patch = hunks.join("\n");
  const rows = patch.split("\n");
  const additions = rows.filter((l) => l.startsWith("+")).length;
  const deletions = rows.filter((l) => l.startsWith("-")).length;
  return { path, status, additions, deletions, patch };
}

/** A whole new file, every line added. */
export function added(path: string, text: string): DiffFile {
  const body = text.replace(/^\n/, "").replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n");
  return file(path, "added", hunk(0, 1, "", body));
}

/** The line on `side` whose text holds `words`, the first after `after` (a line number) when given. */
function lineOf(f: DiffFile, words: string, side: "new" | "old", after = 0): number {
  const row = linesOf(f).find((r) => {
    const n = side === "new" ? r.newNo : r.oldNo;
    return r.kind !== "hunk" && n !== null && n > after && r.text.includes(words.replace(/»/g, TAB));
  });
  const n = row ? (side === "new" ? row.newNo : row.oldNo) : null;
  if (n === null || n === undefined) throw new Error(`${f.path}: no ${side} line holds “${words}”`);
  return n;
}

/** The guide's view of a diff: its files by path, and the excerpts and notes it places by their words. */
export function placer(files: readonly DiffFile[]) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const get = (path: string) => {
    const f = byPath.get(path);
    if (!f) throw new Error(`no file ${path}`);
    return f;
  };
  return {
    /** `count` lines from the one holding `words`. */
    excerpt(path: string, words: string, count: number, caption: string, side: "new" | "old" = "new"): PrGuideExcerpt {
      const start = lineOf(get(path), words, side);
      return { path, side, start, end: start + count - 1, caption };
    },
    /** A note on the line holding `words`. */
    note(path: string, words: string, title: string, body: string) {
      return { path, line: lineOf(get(path), words, "new"), title, body };
    },
  };
}

/** A short commit id from anything: the same input always gives the same seven characters. */
export function shaOf(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/** The head a change is at, from what it changed: another set of files or counts is another head, in any order. */
export const headOf = (files: readonly { path: string; add: number; del: number }[]) =>
  shaOf(
    files
      .map((f) => `${f.path}:${f.add}:${f.del}`)
      .sort()
      .join("|"),
  );

// ---------------------------------------------------------------- sketched diffs

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|with|that|for|its|now|are|was|one|two|has|not|but|from|into|when|then|than|this|they|them|their|what|your|you)$/.test(w));
const camel = (parts: readonly string[]) => parts.map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join("") || "change";
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/\.?$/, ".");

/** Lines in the file's own language that say what the change does, as many as asked, cycling through what it changed. */
function sketchLines(path: string, count: number, about: readonly string[], old: boolean): string[] {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const test = /[._-](test|spec)\.|_test\.go$/.test(path);
  const topics = about.length ? about : ["the change"];
  const out: string[] = [];
  let k = 0;
  while (out.length < count) {
    const topic = topics[k % topics.length]!;
    const name = camel(words(topic).slice(0, 3)) + (k >= topics.length ? String(Math.floor(k / topics.length) + 1) : "");
    let block: string[];
    if (ext === "md") block = k === 0 && !old ? [`# ${sentence(topic).replace(/\.$/, "")}`, ""] : [`## ${sentence(topic).replace(/\.$/, "")}`, "", old ? `Notes from before: ${topic}.` : `${sentence(topic)} The evidence is below, then the steps.`, `- ${old ? "Open question" : "Seen"}: ${topic}`, ""];
    else if (["astro", "html", "vue", "svelte"].includes(ext)) block = [`<p class="${old ? "old" : "line"}-${k}">${sentence(topic)}</p>`];
    else if (["css", "scss"].includes(ext)) block = [`.${name} {`, old ? "  margin: 0 0 24px;" : "  margin: 0 0 12px;", "}"];
    else if (ext === "go") block = test ? [`func Test${name.charAt(0).toUpperCase()}${name.slice(1)}(t *testing.T) {`, `\t// ${topic}`, "}"] : [`// ${name} handles ${topic}.`, `func ${name}() error {`, "\treturn nil", "}", ""];
    else if (test) block = [`it("${topic}", () => {`, `  expect(${name}(sample)).toEqual(expected);`, "});", ""];
    else if (old) block = [`// TODO: ${topic}`, `export const ${name} = null;`];
    else block = [`/** ${sentence(topic)} */`, `export function ${name}(input: Input): Output {`, `  return { ...input, ${name}: true };`, "}", ""];
    out.push(...block);
    k++;
  }
  return out.slice(0, count);
}

/**
 * A stand-in patch for a file the scripted world wrote no diff for: as many lines added and removed as the change
 * says, in the file's own language and about what the change did, so a chat's change always has code to read. A
 * change of more than 40 added lines splits into two hunks, so Files has an unchanged run to say.
 */
export function sketch(path: string, add: number, del: number, about: readonly string[]): DiffFile {
  if (!del && add) return file(path, "added", hunk(0, 1, "", sketchLines(path, add, about, false).map((l) => `+${l}`).join("\n")));
  const gone = sketchLines(path, del, about, true).map((l) => `-${l}`);
  const made = sketchLines(path, add, about, false).map((l) => `+${l}`);
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const ctx = ext === "md" ? [" "] : ext === "go" ? [" package main", " "] : [" "];
  if (add <= 40) return file(path, "modified", hunk(3, 3, "", [...ctx, ...gone, ...made, " "].join("\n")));
  const half = Math.ceil(made.length / 2);
  const first = [...ctx, ...gone, ...made.slice(0, half), " "];
  const net = half - gone.length;
  return file(path, "modified", hunk(3, 3, "", first.join("\n")), hunk(60, 60 + net, "", [" ", ...made.slice(half), " "].join("\n")));
}
