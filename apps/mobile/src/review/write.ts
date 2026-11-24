// The guide writer for a change the scripted world wrote no guide for: a chat's change made on the phone, one asked
// to change and back, a teammate's still being read. The desktop writes a chat's guide the moment its pull request is
// linked and anyone's the moment it is opened, so a guide never rests on "no tour yet": opening one
// starts the writer, Pending says "Caveman is reading the change…", and a few seconds later the guide lands. What it
// writes is the runtime's shape (`pr.guide`): a short change gets its TL;DR and the diff; a longer one a chapter for
// each code file, in the order the change describes itself, then one for its tests, each with its first hunk. It
// finds no calls: a call is a judgment, and this writer only reads the shape of the change.
import { keep } from "../screens/pages/keep";
import type { Pr } from "../screens/pages/review-model";
import { type DiffFile, hunksOf } from "./diff";
import { DEFAULT_SHORT_LINES, fileKind, guideLines, isShortChange, type PrGuide, type PrGuideExcerpt, type PrGuideStop, splitPath } from "./model";
import { marksKey } from "./state";

/** How long the writer reads before its guide lands. */
const WRITE_MS = 3200;

/** Guides being written, by pull request and head, with when each started. */
const writing = keep<Readonly<Record<string, number>>>(() => ({}));
/** What the writer wrote, by pull request and head. */
const drafts = keep<Readonly<Record<string, PrGuide>>>(() => ({}));

export const useWriting = () => writing.use();
export const useDrafts = () => drafts.use();

/** A plain TL;DR of at most 120 characters, cut at a word. */
export function capTldr(text: string): string {
  const plain = text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= 120) return plain;
  const cut = plain.slice(0, 119);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "")}…`;
}

/** The first sentence of an author's words, plain. */
export function firstSentence(markdown: string): string {
  const plain = markdown.replace(/\*\*|__|`/g, "").replace(/^[-*>]\s+/gm, "").split("\n").find((l) => l.trim()) ?? "";
  const end = plain.search(/[.!?](\s|$)/);
  return (end > 0 ? plain.slice(0, end + 1) : plain).trim().replace(/:$/, ".");
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** A chapter's title from a line of the change: its first clause, at most eight words, never ending on a word that leads on. */
const stopTitle = (line: string) => {
  const words = (line.split(/[,;:.]/)[0] ?? line).trim().split(/\s+/).slice(0, 8);
  while (words.length > 2 && /^(a|an|the|to|for|of|in|on|at|and|or|with|from|into|by|is|are|it|its|that|which|when|so|as|move|moves)$/i.test(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
};

/** The sentences of an author's words, plain, for chapters when the change didn't list what it does. */
const sentencesOf = (markdown: string) =>
  markdown
    .replace(/\*\*|__|`/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.replace(/^[-*>\d.]+\s*/, "").trim())
    // A line about the pull request itself ("Still a draft: …") isn't something the change does.
    .filter((x) => x.length > 12 && !/^(still|note|todo|wip|this is a draft)\b/i.test(x));

/** The first rows of a file's first hunk, as an excerpt: up to 14 lines on the side it has. */
function excerptOf(file: DiffFile, caption: string): PrGuideExcerpt | null {
  const hunk = hunksOf(file)[0];
  if (!hunk) return null;
  const side = hunk.rows.some((r) => r.newNo !== null) ? "new" : "old";
  const nos = hunk.rows.map((r) => (side === "new" ? r.newNo : r.oldNo)).filter((n): n is number => n !== null);
  // Start at the first changed row, a line of context above it when there is one.
  const firstChanged = hunk.rows.findIndex((r) => r.kind !== "ctx");
  const lead = hunk.rows.slice(0, Math.max(0, firstChanged)).map((r) => (side === "new" ? r.newNo : r.oldNo)).filter((n): n is number => n !== null);
  const start = lead.length ? lead[lead.length - 1]! : nos[0]!;
  const last = nos[nos.length - 1]!;
  const end = Math.min(last, start + 13);
  return end - start + 1 >= 3 ? { path: file.path, side, start, end, caption } : null;
}

/** What the writer leaves for this change at its head: a TL;DR for a short one, a tour for the rest. */
export function draftGuide(pr: Pr, files: readonly DiffFile[], now = Date.now()): PrGuide {
  const tldr = capTldr(pr.tldr ?? (pr.body ? firstSentence(pr.body) : pr.title));
  const base = { head_sha: pr.head, generated_at: new Date(now).toISOString(), by: "model" as const, tldr };
  if (isShortChange(guideLines(pr.files), DEFAULT_SHORT_LINES)) return { ...base, model: "Claude Haiku 5.5 · TL;DR", depth: "tldr", stops: [] };
  const about = pr.about?.length ? pr.about : pr.body ? sentencesOf(pr.body) : [];
  // The why is the author's own words, a sentence that isn't the chapter's what already.
  const said = pr.body ? sentencesOf(pr.body) : [];
  const whyFor = (what: string) => lower(said.find((x) => x !== what) ?? "it is what the pull request sets out to do.");
  const code = files.filter((f) => fileKind(f.path) === "code");
  const tests = files.filter((f) => fileKind(f.path) === "test");
  const rest = files.filter((f) => fileKind(f.path) === "generated");
  const stops: PrGuideStop[] = code.map((f, i) => {
    const { name } = splitPath(f.path);
    const what = about[i] ?? `${f.status === "added" ? "Adds" : "Changes"} ${name}`;
    const excerpt = excerptOf(f, f.status === "added" ? "The new file's start" : "Where it changes");
    return {
      title: stopTitle(what),
      summary: `before: ${f.status === "added" ? `there was no \`${name}\`` : `\`${name}\` as it is on ${pr.base}`}.\nafter: ${lower(what).replace(/\.$/, "")}.\nwhy: ${whyFor(what)}`,
      attention: null,
      excerpts: excerpt ? [excerpt] : [],
      files: excerpt ? [] : [{ path: f.path }],
      notes: [],
      questions: [],
    };
  });
  if (tests.length) {
    const excerpt = excerptOf(tests[0]!, "The first test");
    stops.push({
      title: "Tests cover the change",
      summary: `before: ${tests.length === 1 ? "this test" : "these tests"} didn't cover it.\nafter: ${tests.length} test ${tests.length === 1 ? "file covers" : "files cover"} what changed.\nwhy: the checks that pass are the ones that read it.`,
      attention: null,
      excerpts: excerpt ? [excerpt] : [],
      files: tests.slice(excerpt ? 1 : 0).map((f) => ({ path: f.path })),
      notes: [],
      questions: [],
    });
  }
  if (rest.length) stops.push({ title: "Generated files follow", summary: "checked: generated and lockfiles, nothing to judge.", attention: null, excerpts: [], files: rest.map((f) => ({ path: f.path })), notes: [], questions: [] });
  return { ...base, model: "Claude Haiku 5.5 · single pass", depth: "tour", stops };
}

/** Starts the writer on a pull request's head, unless it is writing or has written for it already. */
export function writeGuide(pr: Pr, files: readonly DiffFile[]) {
  const key = marksKey(pr);
  if (writing.get()[key] || drafts.get()[key]) return;
  writing.set((was) => ({ ...was, [key]: Date.now() }));
  setTimeout(() => {
    drafts.set((was) => ({ ...was, [key]: draftGuide(pr, files) }));
    writing.set((was) => {
      const { [key]: _done, ...rest } = was;
      return rest;
    });
  }, WRITE_MS);
}
