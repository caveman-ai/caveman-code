// The guide an agent writes for a pull request, in the Session Protocol's own shape (packages/session-protocol
// protocol.ts PrGuide, PrGuideStop, PrGuideResult), and the desktop's pure rules for reading it
// (apps/web/src/routes/review/model.ts and parts.tsx): which rows an excerpt shows, which files a reader can skim, how
// big a change reads, and what an agent started from a guide is told. The phone has no runtime to ask yet, so the
// scripted world fills these from review/guides.ts; a connected phone gets the same shapes from `pr.guide` and
// `pr.diff`. No React here.
import type { DiffLine } from "./diff";

/** The one call a maintainer should make at a stop. Never a bug or a nit: review agents own those. */
export interface PrGuideAttention {
  kind: "tradeoff" | "contract" | "product" | "risk" | "accessibility";
  note: string;
}

export interface PrGuideExcerpt {
  path: string;
  side: "new" | "old";
  /** Lines on `side`, inclusive: 3 to 25 of them, inside one hunk. */
  start: number;
  end: number;
  caption: string;
}

/** One stop of the tour, in reading order. Excerpts and notes are clamped to lines the change touched. */
export interface PrGuideStop {
  /** What the stop accomplishes, as an action ("Merge gate blocks red CI"); never a file name. */
  title: string;
  /** `before:`, `after:` and `why:` lines; a skim stop writes one `checked:` line. */
  summary: string;
  attention: PrGuideAttention | null;
  excerpts: readonly PrGuideExcerpt[];
  /** Changed files it owns that no excerpt shows, each with a one-line note. */
  files: readonly { path: string; note?: string }[];
  /** Why a line is shaped this way, anchored to a line inside one of the stop's excerpts. */
  notes: readonly { path: string; line: number; title: string; body: string }[];
  /** "Why" questions about intent a reader might ask an agent here. */
  questions: readonly string[];
}

/** The behaviour before and after, as indented pseudo-code rows; `stop` is the 1-based stop that implements a row. */
export interface PrGuideBeforeAfter {
  title: string;
  rows: readonly { op: " " | "-" | "+"; depth: number; text: string; stop?: number }[];
}

export interface PrGuide {
  /** The head it was written for; another head now means it is stale. */
  head_sha: string;
  generated_at: string;
  /** The writer, as a person would name it ("Claude Haiku 5.5 · single pass"). */
  model?: string;
  /** The whole change in one or two sentences, at most 120 characters: what it does, then why. */
  tldr?: string;
  /** `what:` and `why:` lines. */
  overview?: string;
  before_after?: PrGuideBeforeAfter;
  stops: readonly PrGuideStop[];
  /** tldr: a short change, its TL;DR and call only, the diff is the rest. Absent means a tour. */
  depth?: "tldr" | "tour";
  /** A short change's one call; a tour puts its calls on its stops. */
  attention?: PrGuideAttention;
  by?: "chat" | "model" | "template";
  /** The chat that wrote a chat's TL;DR. */
  workspace_id?: string;
}

export interface PrGuideResult {
  guide: PrGuide | null;
  /** A run is writing one for the current head. */
  running: boolean;
  /** Why the last run for this head failed. */
  failed?: string;
  /** The pull request's head now. */
  head_sha?: string;
}

/** A review thread on a line (PrThread): who said what, oldest first, and whether it is settled. */
export interface PrThread {
  id: string;
  path: string;
  line: number;
  side: "new" | "old";
  resolved: boolean;
  comments: readonly { author: string; body: string; at: number }[];
}

export const CALL_WORD: Record<PrGuideAttention["kind"], string> = {
  tradeoff: "Trade-off",
  contract: "Contract",
  product: "Product call",
  risk: "Risk taken",
  accessibility: "Accessibility",
};

/** Two-digit stop numbers, as the desktop prints them ("03"). */
export const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The rows of one excerpt: from the first to the last row on `side` inside [start, end], with the other side's rows
 * that fall between them, so a reader sees what an added block replaced. Never a hunk header.
 */
export function excerptRows(rows: readonly DiffLine[], side: "new" | "old", start: number, end: number): DiffLine[] {
  const no = (row: DiffLine) => (side === "new" ? row.newNo : row.oldNo);
  let first = -1;
  let last = -1;
  rows.forEach((row, i) => {
    const n = no(row);
    if (row.kind === "hunk" || n === null || n < start || n > end) return;
    if (first < 0) first = i;
    last = i;
  });
  return first < 0 ? [] : rows.slice(first, last + 1).filter((row) => row.kind !== "hunk");
}

export type FileKind = "code" | "test" | "generated";

const TEST = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|__snapshots__|testdata)\/|[._-](test|spec)\.[a-z0-9]+$|_test\.go$|\.snap$/i;
const GENERATED =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.generated\.|\.gen\.|(^|\/)(dist|build|vendor|generated)\/|\.min\.(js|css)$|\.pb\.go$|schema\/[^/]+\.json$/i;

/** Code first; tests and generated files (lockfiles, vendored, built) fold to the foot of Files. */
export function fileKind(path: string): FileKind {
  if (GENERATED.test(path)) return "generated";
  if (TEST.test(path)) return "test";
  return "code";
}

const SNAPSHOT = /(^|\/)__snapshots__\/|\.snap$/i;

/** Lines of code and tests a change touches, as the guide writer counts them: lockfiles, generated and snapshots left out. */
export function guideLines(files: readonly { path: string; add: number; del: number }[]): number {
  return files.reduce((n, f) => (fileKind(f.path) === "generated" || SNAPSHOT.test(f.path) ? n : n + f.add + f.del), 0);
}

/** Settings > Review's short-change limit when the runtime reports none (`review_short_lines`). */
export const DEFAULT_SHORT_LINES = 30;

export const isShortChange = (lines: number, limit: number): boolean => limit > 0 && lines > 0 && lines <= limit;

/**
 * What the guide draws: a tour once one is written; otherwise the size decides, as the runtime writes by: a short
 * change shows its TL;DR and the diff at once, a long one with only its chat's TL;DR shows the tour on its way.
 */
export function guideDepth(guide: Pick<PrGuide, "depth"> | null | undefined, short: boolean): "tldr" | "tour" {
  if (guide && (guide.depth ?? "tour") === "tour") return "tour";
  return short ? "tldr" : "tour";
}

/** A stop that only accounts for mechanical files: no code to show, so it reads as one folded line. */
export const isSkimStop = (stop: PrGuideStop): boolean => stop.excerpts.length === 0 && stop.files.length > 0;

/** A guide written for another head than the one the pull request is on now. */
export const isStale = (result: PrGuideResult): boolean => Boolean(result.guide && result.head_sha && result.guide.head_sha !== result.head_sha);

/**
 * The overview, only when it is in the guide's format: a writer that sent back an empty object or a raw string
 * (`{"what":"","why":""}`) would print it as a paragraph, so an overview without a filled `what:` or `why:` is dropped.
 */
export function overviewOf(guide: Pick<PrGuide, "overview">): string | null {
  const text = guide.overview?.trim();
  if (!text) return null;
  return /^(what|why):\s*\S/im.test(text) ? text : null;
}

export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return { dir: at < 0 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** How big a change reads, by lines of code and tests (parts.tsx SIZES). */
export const SIZES = [
  { label: "XS", max: 30 },
  { label: "S", max: 150 },
  { label: "M", max: 500 },
  { label: "L", max: 1500 },
  { label: "XL", max: Number.POSITIVE_INFINITY },
] as const;

export const sizeLabel = (lines: number) => SIZES.find((s) => lines <= s.max)?.label ?? "XL";

const LABEL = /^(before|after|why|what|checked):\s*/i;

/** A guide's lines in its format: `before:` / `after:` / `why:` (`what:`, `checked:`) as labelled rows, any other line plain. */
export function guideLinesOf(text: string): { label: string | null; text: string }[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = LABEL.exec(line);
      return m ? { label: m[1]!.toLowerCase(), text: line.slice(m[0].length) } : { label: null, text: line };
    });
}

/** Inline `code` in guide prose: the runs to set in mono, the rest as words. */
export function proseRuns(text: string): { code: boolean; text: string }[] {
  return text
    .split(/(`[^`\n]+`)/g)
    .filter(Boolean)
    .map((part) => (part.length > 2 && part.startsWith("`") && part.endsWith("`") ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}

/** Where a passage came from, said in the agent's task. */
export interface Passage {
  /** "guide stop 2 “Merge gate blocks red CI”", "src/a.ts:12-30". */
  where: string;
  quote: string;
}

const QUOTE_MAX = 1200;

/**
 * What a chat started from a guide is told (the desktop's agentTask): the pull request by reference, what to do, where
 * the passage came from, the passage, then the person's words. Short on purpose; the agent reads the code itself.
 */
export function agentTask(input: { pr: { number: number; title: string; repo: string; branch: string }; mode: "ask" | "fix"; passage?: Passage; text: string }): string {
  const { pr, mode, passage, text } = input;
  const lines = [`Pull request #${pr.number} “${pr.title}” in ${pr.repo}; you are on its head branch \`${pr.branch}\`.`];
  lines.push(
    mode === "fix"
      ? "Make the change below on this branch, keep it small, run the checks that cover it, then commit and push so the pull request updates."
      : "Answer the question below about this pull request. Read the code; change nothing.",
  );
  if (passage) {
    const quote = passage.quote.length > QUOTE_MAX ? `${passage.quote.slice(0, QUOTE_MAX)}…` : passage.quote;
    lines.push("", `From ${passage.where}:`, ...quote.split("\n").map((l) => `> ${l}`));
  }
  const ask = text.trim();
  lines.push("", ask || (mode === "fix" ? "Fix this." : "Explain this: what it does and why."));
  return lines.join("\n");
}

/**
 * What the chat that made the change hears when you ask it from its own guide: your words, led by the passage's place
 * when you asked from one, since it already knows the pull request.
 */
export function steerText(text: string, passage?: Passage): string {
  const words = text.trim();
  return passage ? `About ${passage.where}: ${words}` : words;
}
