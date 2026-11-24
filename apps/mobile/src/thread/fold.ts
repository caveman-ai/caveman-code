// How a chat reads, as data: the transcript cut into turns, and each turn planned the way Codex leaves it once it is
// done (DECISIONS.md "Thread, exactly"). A finished turn is your words, one quiet "Worked for 2m 38s ›" line and the
// final answer, then what it changed; everything the agent did on the way (its commentary, its runs, the approvals you
// answered, the subagents it started once they are all done) is under that line. A steer splits the work: each part
// before it gets its own line, the steer stays in view with when it was sent. What never folds: your words, a turn
// that didn't finish cleanly (stopped, failed, still waiting on you, still running), an answer that was already final.
// Inside an open turn the work reads as parts, one grey sentence each ("Explored 3 files, edited lines.ts +18 −2"),
// and a failure breaks a part so it is never buried. Pure, so it can be read and tested without React Native; the
// components in components/Transcript.tsx draw what this says.
import type { Chat, Item, Moment, Step, Tool } from "../board/model";
import { type Counts, duration, stepParts } from "../components/transcript/lines";

export type You = Extract<Item, { kind: "you" }>;
export type TextItem = Extract<Item, { kind: "text" }>;
export type Work = Extract<Item, { kind: "work" }>;
export type Ask = Extract<Item, { kind: "ask" }>;
export type Agents = Extract<Item, { kind: "agents" }>;
export type Stop = Extract<Item, { kind: "stop" }>;

/** One turn: your message and everything after it until your next one; a steer sent while it worked stays inside. */
export interface Turn {
  key: string;
  you: You | null;
  items: readonly Item[];
}

/**
 * The transcript in turns. A message sent while a run was still open, or marked a steer when it was sent, steered the
 * turn it landed in (the desktop's "Steered"), so the turn keeps one answer and one fold.
 */
export function turnsOf(items: readonly Item[]): Turn[] {
  const turns: { key: string; you: You | null; items: Item[] }[] = [];
  let running = false;
  for (const item of items) {
    if (item.kind === "you" && !running && !(item.steer && turns.length)) {
      turns.push({ key: item.id, you: item, items: [] });
      continue;
    }
    if (!turns.length) turns.push({ key: item.id, you: null, items: [] });
    turns.at(-1)!.items.push(item);
    if (item.kind === "work") running = !item.endedAt;
  }
  return turns;
}

/** When an item last moved: a message or words when they were sent, a run when it ended (or began, while it runs). */
export function timeOf(item: Item): number | null {
  switch (item.kind) {
    case "you":
    case "text":
    case "stop":
      return item.at || null;
    case "work":
      return item.endedAt ?? item.startedAt;
    default:
      return null;
  }
}

const firstTime = (items: readonly Item[]) => {
  for (const item of items) {
    const at = item.kind === "work" ? item.startedAt : timeOf(item);
    if (at) return at;
  }
  return null;
};
const lastTime = (items: readonly Item[]) => items.reduce<number | null>((latest, item) => {
  const at = timeOf(item);
  return at && (latest === null || at > latest) ? at : latest;
}, null);

// ---------------------------------------------------------------- the answer

/** The words that end a turn: its last final text, or without phases, its last text that isn't commentary. */
export function answerOf(items: readonly Item[]): TextItem | null {
  const texts = items.filter((i): i is TextItem => i.kind === "text" && i.text.trim() !== "");
  return texts.findLast((i) => i.phase === "final") ?? texts.findLast((i) => i.phase !== "commentary") ?? null;
}

// ---------------------------------------------------------------- failures

/** How many a step says failed ("3 of 50 failed", "exit 1"), or 0. */
export function failedOf(step: Step): number {
  const words = `${step.text} ${step.detail ?? ""}`;
  const counted = /(\d+)(?:\s+of\s+\d+)?\s+failed/i.exec(words);
  if (counted) return Number(counted[1]);
  if (/\bfailed\b|\bexit [1-9]\d*\b|\berror\b/i.test(words) && !/\b0 failed\b/i.test(words)) return 1;
  return 0;
}

// ---------------------------------------------------------------- parts: one sentence each

/** A clause of a part's sentence: the verb (muted), what it measures (subtle; mono when it names code), counts. */
export interface Clause {
  verb: string;
  measure: string;
  code: boolean;
  counts: Counts | null;
}

export interface Sentence {
  clauses: Clause[];
  /** How many failed: " · 3 failed" in the destructive red, breaking the line. */
  failed: number;
  /** The glyph the line wears: the pencil when it changed anything, else its first step's tool. */
  lead: Tool;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Read 3 files" reads 3; "Read lines.ts" reads 1. */
const fileCount = (step: Step) => Number(/\b(\d+)\s+(files|reports|examples)\b/.exec(step.text)?.[1] ?? 1);

/** One step as a clause: "Read" lines.ts, "Searched for" usage_events, "Ran" the rollup tests. */
function stepClause(step: Step): Clause {
  const parts = stepParts(step);
  return { verb: parts.verb, measure: parts.subject, code: parts.code, counts: parts.counts };
}

const sumCounts = (steps: readonly Step[]): Counts | null => {
  let any = false;
  const total = { added: 0, removed: 0 };
  for (const step of steps) {
    const counts = stepParts(step).counts;
    if (!counts) continue;
    any = true;
    total.added += counts.added;
    total.removed += counts.removed;
  }
  return any ? total : null;
};

/**
 * A run of steps as one sentence, by what kind of work it was, in the order it happened: "Explored 3 files, 2
 * searches, edited 2 files +38 −12, ran the transcript tests". A kind done once says what it was done to.
 */
export function sentenceOf(steps: readonly Step[]): Sentence {
  const order: Tool[] = [];
  const by = new Map<Tool, Step[]>();
  for (const step of steps) {
    // Searching and reading are one kind of work, exploring, as Codex and Cursor say it.
    const kind: Tool = step.tool === "search" ? "read" : step.tool;
    if (!by.has(kind)) {
      by.set(kind, []);
      order.push(kind);
    }
    by.get(kind)!.push(step);
  }
  const clauses: Clause[] = [];
  for (const kind of order) {
    const group = by.get(kind)!;
    if (group.length === 1) {
      clauses.push(stepClause(group[0]!));
      continue;
    }
    if (kind === "read") {
      const reads = group.filter((s) => s.tool === "read");
      const searches = group.length - reads.length;
      const files = reads.reduce((n, s) => n + fileCount(s), 0);
      const measure = [files ? plural(files, "file") : "", searches ? plural(searches, "search", "searches") : ""].filter(Boolean).join(", ");
      clauses.push({ verb: "Explored", measure, code: false, counts: null });
    } else if (kind === "edit") {
      const files = group.reduce((n, s) => n + fileCount(s), 0);
      clauses.push({ verb: "Edited", measure: plural(files, "file"), code: false, counts: sumCounts(group) });
    } else {
      clauses.push({ verb: "Ran", measure: plural(group.length, "command"), code: false, counts: null });
    }
  }
  return {
    clauses,
    failed: steps.reduce((n, s) => n + failedOf(s), 0),
    lead: steps.find((s) => s.tool === "edit")?.tool ?? steps[0]?.tool ?? "run",
  };
}

/** A clause's verb after the first one starts lower case, unless it opens on an acronym ("CI passed"). */
export const lower = (verb: string) => (/^[A-Z]{2}/.test(verb) ? verb : verb.charAt(0).toLowerCase() + verb.slice(1));

/** A run cut into parts: a failure ends the part it is in, so what comes after starts a line of its own. */
export function partsOf(steps: readonly Step[]): Step[][] {
  const parts: Step[][] = [];
  let current: Step[] = [];
  for (const step of steps) {
    current.push(step);
    if (failedOf(step)) {
      parts.push(current);
      current = [];
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

/** How many of a run's parts are closed: each ends on a failure, so only the steps after the last one are still open. */
function closedParts(steps: readonly Step[]): number {
  const parts = partsOf(steps);
  const last = parts.at(-1)?.at(-1);
  return last && failedOf(last) > 0 ? parts.length : Math.max(0, parts.length - 1);
}

/** The steps the live row still says: those after the last failure in the running run. */
export function liveSteps(run: Work | null): readonly Step[] {
  if (!run) return [];
  return partsOf(run.steps).slice(closedParts(run.steps)).flat();
}

// ---------------------------------------------------------------- a turn's body

/** What an open turn (or an opened fold) shows, in order. */
export type Body =
  | { kind: "text"; key: string; item: TextItem }
  | { kind: "part"; key: string; steps: Step[] }
  | { kind: "ask"; key: string; item: Ask }
  | { kind: "agents"; key: string; item: Agents }
  | { kind: "stop"; key: string; item: Stop; after: number | null };

/**
 * Items as the lines an open turn draws. `liveRun` is the run still going, which the live row says instead, so it is
 * left out here; changes and your steers are drawn by the turn itself.
 */
export function bodyOf(items: readonly Item[], start: number | null, liveRun: Work | null): Body[] {
  const out: Body[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "text":
        if (item.text.trim()) out.push({ kind: "text", key: item.id, item });
        break;
      case "work": {
        // The run still going is the live row's, but a failure in it breaks the line: what led up to the failure
        // stands as a part of its own above the row.
        const parts = partsOf(item.steps);
        const shown = item === liveRun ? parts.slice(0, closedParts(item.steps)) : parts;
        shown.forEach((steps, n) => out.push({ kind: "part", key: `${item.id}:${n}`, steps }));
        break;
      }
      case "ask":
        out.push({ kind: "ask", key: item.id, item });
        break;
      case "agents":
        out.push({ kind: "agents", key: item.id, item });
        break;
      case "stop":
        out.push({ kind: "stop", key: item.id, item, after: start && item.at ? item.at - start : null });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the plan

export type TurnState = "live" | "waiting" | "finished" | "stopped" | "failed" | "open";

/**
 * What stays out of a folded segment, under its line: the answer (or words already final), and a roster whose children
 * are still out. Nothing else: the commentary that led up to a short answer is under the line with the rest, so the
 * answer never arrives with its own paraphrase above it.
 */
export type Kept = { kind: "text"; key: string; item: TextItem } | { kind: "agents"; key: string; item: Agents };

/** The work between your message and a steer, or between two steers, or from the last one to the end. */
export interface Segment {
  key: string;
  /** The steer that opened it; null for the first. */
  steer: You | null;
  /** When the steer was sent, from the turn's start ("Steered at 1m 30s"). */
  steerAfter: number | null;
  /** Everything in it, in order (the steer itself left out). */
  items: readonly Item[];
  /** What the fold holds once the turn is finished. Empty: no "Worked for" line. */
  folded: readonly Item[];
  /** What stays out of the fold, after it, in order. */
  kept: readonly Kept[];
  /** How long it worked, for its "Worked for" line. */
  ms: number | null;
}

export interface TurnPlan {
  key: string;
  you: You | null;
  state: TurnState;
  /** Finished turns fold: each segment under its "Worked for" line. */
  folds: boolean;
  segments: Segment[];
  /** The run still going, which the live row says. */
  liveRun: Work | null;
  answer: TextItem | null;
  /** What this turn changed: its pill stays with it, whatever the chat does next. */
  changes: Moment | null;
  start: number | null;
  end: number | null;
  latest: boolean;
  /** A centred date line above it: the chat's first turn, or one sent more than 30 minutes after the turn before. */
  date: number | null;
}

/** Two messages more than this apart get a date line between them. */
export const DATE_GAP = 30 * 60_000;

/** Children of an agents item that are all finished let the roster fold; one still out keeps it in view. */
export type ChildPhase = (id: string) => Chat["phase"] | null;

/** A turn's state, from its own items and whether the chat is still on it. */
export function stateOf(turn: Turn, latest: boolean, chat: Pick<Chat, "phase">): TurnState {
  const items = turn.items;
  if (items.some((i) => i.kind === "ask" && !i.answer && !i.pending)) return "waiting";
  if (latest && chat.phase === "working") return "live";
  if (items.some((i) => i.kind === "stop")) return "stopped";
  const answer = answerOf(items);
  const lastRun = items.findLast((i): i is Work => i.kind === "work");
  const answerIndex = answer ? items.indexOf(answer) : -1;
  if (lastRun && lastRun.steps.some((s) => failedOf(s) > 0) && items.indexOf(lastRun) > answerIndex) return "failed";
  return answer ? "finished" : "open";
}

/**
 * One turn, planned. `childPhase` says where each subagent stands, so a roster stays in view until every child it
 * names is done.
 */
export function planTurn(turn: Turn, opts: { latest: boolean; chat: Pick<Chat, "phase">; childPhase?: ChildPhase; before: number | null }): TurnPlan {
  const { items } = turn;
  const state = stateOf(turn, opts.latest, opts.chat);
  const folds = state === "finished";
  const start = turn.you?.at ?? firstTime(items);
  const end = lastTime(items);
  const answer = answerOf(items);
  const liveRun = state === "live" ? (items.findLast((i): i is Work => i.kind === "work" && !i.endedAt) ?? null) : null;
  const changes = items.findLast((i): i is Extract<Item, { kind: "changes" }> => i.kind === "changes")?.moment ?? null;

  // Cut at each steer.
  const cuts: { steer: You | null; items: Item[] }[] = [{ steer: null, items: [] }];
  for (const item of items) {
    if (item.kind === "you") cuts.push({ steer: item, items: [] });
    else if (item.kind !== "changes") cuts.at(-1)!.items.push(item);
  }

  const done = (id: string) => {
    const phase = opts.childPhase?.(id);
    return phase === "done" || phase === "ready" || phase === null || phase === undefined;
  };
  const segments: Segment[] = cuts.map((cut, n) => {
    const kept: Kept[] = [];
    if (folds) {
      for (const item of cut.items) {
        // An answer already final stays final; the turn's own answer always shows.
        if (item.kind === "text" && (item.phase === "final" || item === answer)) kept.push({ kind: "text", key: item.id, item });
        // A roster outlives the fold until every child it names is done.
        if (item.kind === "agents" && !item.children.every(done)) kept.push({ kind: "agents", key: item.id, item });
      }
    }
    const keptIds = new Set(kept.map((k) => k.item.id));
    // Each item is in exactly one place: under the line, or kept after it.
    const folded = folds ? cut.items.filter((i) => !keptIds.has(i.id)) : [];
    const from = cut.steer?.at ?? start;
    const to = lastTime(cut.items);
    return {
      key: `${turn.key}:${n}`,
      steer: cut.steer,
      steerAfter: cut.steer && start ? cut.steer.at - start : null,
      items: cut.items,
      folded,
      kept,
      ms: from && to && to > from ? to - from : null,
    };
  });

  return {
    key: turn.key,
    you: turn.you,
    state,
    folds,
    // The work before a steer sent the moment the turn began has nothing to say.
    segments: segments.filter((s) => s.steer !== null || s.items.length > 0),
    liveRun,
    answer,
    changes,
    start,
    end,
    latest: opts.latest,
    date: start !== null && (opts.before === null || start - opts.before > DATE_GAP) ? start : null,
  };
}

/** Every turn of a chat, planned, oldest first. */
export function planChat(chat: Pick<Chat, "items" | "phase">, childPhase?: ChildPhase): TurnPlan[] {
  const turns = turnsOf(chat.items);
  let before: number | null = null;
  return turns.map((turn, i) => {
    const plan = planTurn(turn, { latest: i === turns.length - 1, chat, childPhase, before });
    before = plan.end ?? plan.start ?? before;
    return plan;
  });
}

/**
 * Where an item stands in a planned chat, for a search hit that lands on it: the turn it is in, and the folds to open
 * so it shows (the segment whose fold holds it). Null when no turn has it.
 */
export function locate(plans: readonly TurnPlan[], id: string): { index: number; key: string; folds: string[] } | null {
  for (let index = plans.length - 1; index >= 0; index--) {
    const plan = plans[index]!;
    if (plan.you?.id === id) return { index, key: plan.key, folds: [] };
    for (const seg of plan.segments) {
      if (seg.steer?.id === id) return { index, key: plan.key, folds: [] };
      if (seg.folded.some((i) => i.id === id)) return { index, key: plan.key, folds: [seg.key] };
      if (seg.items.some((i) => i.id === id)) return { index, key: plan.key, folds: [] };
    }
  }
  return null;
}

// ---------------------------------------------------------------- words

/** "Worked for 2m 38s". */
export const workedFor = (ms: number | null) => (ms && ms >= 1000 ? `Worked for ${duration(ms)}` : "Worked");

/** "Steered at 1m 30s": when, from the turn's start. */
export const steeredAt = (ms: number | null) => (ms !== null && ms >= 1000 ? `Steered at ${duration(ms)}` : "Steered");

/** "You stopped after 41s"; `unowned`: nobody is known to have stopped it, so "Stopped after 41s". */
export const stoppedAfter = (ms: number | null, unowned = false) =>
  ms !== null && ms >= 1000 ? `${unowned ? "Stopped" : "You stopped"} after ${duration(ms)}` : unowned ? "Stopped" : "You stopped it";

/** The capsule's clock: "1m 48s", "42s". */
export const clockOf = (ms: number) => duration(Math.max(1000, ms));

const timeOfDay = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A date line: "Today 2:12 PM", "Yesterday 9:20 PM", "Tuesday 2:02 PM", "29 Oct at 6:24 PM". */
export function dateLine(at: number, now = Date.now()): string {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return `Today ${timeOfDay(at)}`;
  if (days === 1) return `Yesterday ${timeOfDay(at)}`;
  if (days < 7) return `${day.toLocaleDateString(undefined, { weekday: "long" })} ${timeOfDay(at)}`;
  return `${day.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${timeOfDay(at)}`;
}
