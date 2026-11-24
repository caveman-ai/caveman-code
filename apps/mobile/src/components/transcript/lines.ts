// What the transcript's lines say, as the desktop says them (apps/web/src/components/transcript/rows.ts and
// WorkRun.tsx): a turn's "Opus 5.5 worked for 3m 12s", a step as its verb in grey and its subject in mono, the lines a
// run added and removed, and a run folded into one line ("Searched for usage_events, read 3 files, ran the tests").
// The board's steps arrive as words ("Read globals.css", "pnpm test usage  22/22 passed"); these read them back into
// the desktop's parts. On a connected runtime the parts come with the tool items and nothing here guesses.
import type { Step, Tool } from "../../board/model";

/** "42s", "3m 12s", "3m", "1h 4m": a zero says nothing (rows.ts duration). */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** A running step's clock, "0:04" (WorkRun.tsx clock). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A turn's line: "Opus 5.5 worked for 43s", "working" while it runs, "Worked for 43s" with nobody to name (rows.ts turnLine). */
export function turnLine(who: string, ms: number | null, live = false): string {
  const verb = live ? "working" : "worked";
  if (!who) return ms === null ? (live ? "Working" : "Worked") : `${live ? "Working" : "Worked"} for ${duration(ms)}`;
  return ms === null ? `${who} ${verb}` : `${who} ${verb} for ${duration(ms)}`;
}

/** The lines a step added and removed, when its words carry them ("+64", "+212 −305"). */
export interface Counts {
  added: number;
  removed: number;
}

/** One step as the desktop's trace line draws it: the verb, the subject (mono when it names code), counts, a note. */
export interface StepParts {
  verb: string;
  subject: string;
  /** The subject names a file, a symbol or a path: it sets in mono, as TraceSubject does. */
  code: boolean;
  counts: Counts | null;
  /** The quiet words at the line's right (the desktop's duration slot): "14 results", "22/22 passed". */
  note: string;
  /** What the line opens to: the command as it ran with its output, or the files it read. */
  log: { command?: string; output?: string; files?: readonly string[] } | null;
}

const VERBS = /^(Searched the web for|Searched for|Searched|Read|Created|Edited|Wrote|Deleted|Ran|Opened|Took|Checked|Tested|Fetched|Applied)\s+(.+)$/;
const COMMAND = /^(\$ )?(pnpm|npm|npx|yarn|bun|go|vitest|cargo|git|make|python3?|node|docker|gh|tsc|psql)\b/;
const COUNTS = /^\+(\d+)(?:\s+[−-](\d+))?$/;
/** A subject that names code: a path, a file with its extension, a symbol with an underscore, camelCase or a dot. */
const CODEISH = /[./_#]|[a-z][A-Z]|^[A-Z][a-z]+[A-Z]/;

function countsOf(text: string): Counts | null {
  const m = COUNTS.exec(text.trim());
  return m ? { added: Number(m[1]), removed: Number(m[2] ?? 0) } : null;
}

/** "pnpm test usage  22/22 passed": the command, then what it printed, two spaces apart as the board writes them. */
function commandOf(text: string): { command: string; output: string } | null {
  if (!COMMAND.test(text.trim())) return null;
  const [command, ...rest] = text.trim().replace(/^\$ /, "").split(/\s{2,}/);
  return { command: command ?? "", output: rest.join("  ") };
}

/** A list of files ("db/schema.ts, usage/rollup.ts"): what a read opens to. */
function filesOf(text: string): string[] | null {
  const names = text.split(/,\s*/).map((s) => s.trim());
  return names.length > 1 && names.every((n) => /^[\w./-]+\.\w+$/.test(n)) ? names : null;
}

export function stepParts(step: Step): StepParts {
  const m = VERBS.exec(step.text);
  const verb = m ? m[1]! : step.text;
  const subject = m ? m[2]! : "";
  const detail = step.detail?.trim() ?? "";
  const counts = countsOf(detail);
  const command = counts ? null : commandOf(detail);
  const files = counts || command ? null : filesOf(detail);
  return {
    verb,
    subject,
    code: subject !== "" && CODEISH.test(subject) && !/\s/.test(subject.replace(/ → /, "")),
    counts,
    note: command ? command.output : counts || files ? "" : detail,
    log: command ? { command: command.command, output: command.output } : files ? { files } : null,
  };
}

/** A live line read as a running step: what it is doing now, in the present tense the desktop's running line uses. */
export interface LiveParts {
  kind: "tool" | "command" | "thought";
  tool: Tool;
  verb: string;
  subject: string;
  code: boolean;
  counts: Counts | null;
  /** What a running command has printed so far ("6/8"): the desktop's live output under its line. */
  output: string;
}

export function liveParts(line: string, tool: Tool): LiveParts {
  const [head = "", ...rest] = line.trim().split(/\s{2,}/);
  const tail = rest.join("  ");
  const counts = countsOf(tail);
  if (COMMAND.test(head) || /^CI\b/.test(head)) {
    return { kind: "command", tool: "run", verb: "Running", subject: head.replace(/^\$ /, ""), code: true, counts: null, output: tail };
  }
  const m = /^([A-Z][a-z]+ing)\s+(.+)$/.exec(head);
  if (m) {
    const subject = m[2]!;
    return { kind: "tool", tool, verb: m[1]!, subject, code: CODEISH.test(subject) && !/\s/.test(subject), counts, output: counts ? "" : tail };
  }
  // No verb the board knows: a thought ("Thinking", "Found it: Close races the read loop"), which has no icon.
  return { kind: "thought", tool, verb: head, subject: "", code: false, counts: null, output: tail };
}

/** The lines a run's finished steps added and removed. */
export function runCounts(steps: readonly Step[]): Counts | null {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const step of steps) {
    const c = stepParts(step).counts;
    if (!c) continue;
    any = true;
    added += c.added;
    removed += c.removed;
  }
  return any ? { added, removed } : null;
}

/**
 * "Searched for usage_events, read 3 files, ran the tests": every step once, in order (WorkRun.tsx summarize). Later
 * steps start lower case, unless they open on an acronym ("CI passed", "API keys rotated"), which keeps its case.
 */
export function summarize(steps: readonly Step[]): string {
  const said = steps.map((s, i) => (i === 0 || /^[A-Z]{2}/.test(s.text) ? s.text : s.text.charAt(0).toLowerCase() + s.text.slice(1)));
  return [...new Set(said)].join(", ");
}

/** The tool a run wears: the pencil when it changed anything, else its first step's (WorkRun.tsx leadIcon). */
export function leadTool(steps: readonly Step[]): Tool | null {
  return steps.find((s) => s.tool === "edit")?.tool ?? steps[0]?.tool ?? null;
}

/** Past these a sent message folds to a few lines until opened (upstream limits). */
export const LONG_CHARS = 600;
export const LONG_LINES = 8;

/**
 * Whether your message folds behind "Show full message". By its words alone: past LONG_CHARS characters or LONG_LINES
 * lines. A measurement can fold a shorter one only when it was taken at a real width (at least 60% of the widest the
 * bubble's words can be), so a layout pass at a passing, too-narrow width never folds a short message into a column.
 */
export function bubbleFolds(text: string, measured: { height: number; width: number } | null, maxWidth: number, foldHeight: number): boolean {
  if (text.length > LONG_CHARS || text.split("\n").length > LONG_LINES) return true;
  if (!measured || maxWidth <= 0 || measured.width < maxWidth * 0.6) return false;
  return measured.height > foldHeight + 4;
}
