// How the transcript's items become rows, so a chat never buries what the
// person needs to read under what the engine did to get there. Like upstream
// work log (apps/web/src/components/chat/MessagesTimeline.logic.ts): thoughts
// and tool calls in a row are one work run. As in T3, a finished turn in a chat
// reads as the person's message, one "Worked for 1m 12s" line and the answer:
// the line holds the steps, the thoughts and the replies on the way. The Chief's
// turns fold only their work, never what it says: a Chief that answers, then
// updates its items, then signs off showed only the sign-off.
// What stays out of a fold: the answer, what the person said, asks, notices,
// what memory saved, the turn's subagents, a finished grill, the caller's own
// tool cards and its chats' moments (the Chief's). A reply withdrawn as
// empty (a steer cut it off; the engine answers again) shows nothing.
// Subagents started with only work between them are one
// group (upstream subagent group), at the first one's place. Notes memory recalled for the agent fold with its work.
// As in Codex, a thought shows only while it streams: once settled it is gone,
// unless tool calls sit beside it (then it opens with them).
import type { ToolItem, TranscriptItem } from "../../state/transcript-model.ts";
import { detailKey } from "./work-disclosures.ts";

export type Thought = Extract<TranscriptItem, { kind: "reasoning" }>;
export type WorkItem = Thought | ToolItem;
export type SubagentItem = Extract<TranscriptItem, { kind: "subagent" }>;

export type Row =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly item: TranscriptItem;
      readonly speaker: boolean;
    }
  /** Thoughts and tool calls in a row. */
  | {
      readonly kind: "work";
      readonly id: string;
      readonly items: WorkItem[];
      readonly speaker: boolean;
    }
  /** Subagents started with nothing but work between them: native and delegated alike, never folded. */
  | {
      readonly kind: "agents";
      readonly id: string;
      readonly items: SubagentItem[];
      readonly speaker: boolean;
    }
  /** A finished turn's work between the things that stay in view; `ms` from the turn's start (or the fold's first step) to what follows it. */
  | {
      readonly kind: "fold";
      readonly id: string;
      readonly rows: ReadonlyArray<Row>;
      readonly ms: number | null;
      readonly speaker: boolean;
    };

/** A work run's tool calls the caller shows as its own cards; those runs stay in view. */
export type Claims = (tools: ReadonlyArray<ToolItem>) => boolean;
/** What the reader opened by hand, by its disclosure key: a run by its row id, an item's details by detailKey(its id). */
export type Opened = (key: string) => boolean;

export const workTools = (items: ReadonlyArray<WorkItem>): ToolItem[] =>
  items.filter((i): i is ToolItem => i.kind === "tool");

/**
 * The speaker mark opens each engine turn; thoughts and tool calls in a row are one run; a finished turn's work folds.
 * `foldAll` (the Chief's): a finished turn shows what it said and what its caller keeps; its information lines (a
 * wake's "1 chat changed") fold with its work, a turn that says nothing draws nothing, and a note steered into a turn
 * is a message of its own (foldTurns). Single work rows fold in ordinary chats too.
 */
export function rows(
  items: ReadonlyArray<TranscriptItem>,
  claims?: Claims,
  foldAll = false,
  opened?: Opened,
): Row[] {
  const out: Row[] = [];
  let turnOpen = false;
  // The group a subagent joins: open until something other than work (or a blank reply) comes between.
  let group: Extract<Row, { kind: "agents" }> | null = null;
  for (const item of withoutLoneThoughts(items, opened)) {
    // A reaction is a badge on the person's bubble (SessionView.reactions); never a card or blank row of its own.
    if (item.kind === "moment" && item.moment.kind === "reaction") continue;
    // Finished with nothing said: a reply withdrawn (ClaudeAdapterV2 withdrawCutAnswers), never a row.
    if (
      item.kind === "assistant" &&
      !item.streaming &&
      item.text.trim() === "" &&
      !item.attachments?.length
    )
      continue;
    const engineSide =
      item.kind !== "user" &&
      item.kind !== "turn_end" &&
      item.kind !== "notice" &&
      item.kind !== "moment" &&
      item.kind !== "memory" &&
      item.kind !== "ask" &&
      item.kind !== "restored" &&
      item.kind !== "switch" &&
      item.kind !== "grill_finished";
    const speaker = engineSide && !turnOpen;
    if (item.kind === "user" || item.kind === "turn_end" || item.kind === "restored")
      turnOpen = false;
    else if (engineSide) turnOpen = true;
    const last = out[out.length - 1];
    if (item.kind === "tool" || item.kind === "reasoning") {
      if (last?.kind === "work") last.items.push(item);
      else out.push({ kind: "work", id: item.id, items: [item], speaker });
    } else if (item.kind === "subagent") {
      if (group) group.items.push(item);
      else out.push((group = { kind: "agents", id: item.id, items: [item], speaker }));
    } else {
      if (!(item.kind === "assistant" && item.text.trim() === "")) group = null;
      out.push({ kind: "item", id: item.id, item, speaker });
    }
  }
  return foldTurns(out, claims, foldAll, opened);
}

/** Drops settled lone thoughts unless explicitly kept open by the reader. */
function withoutLoneThoughts(
  items: ReadonlyArray<TranscriptItem>,
  opened?: Opened,
): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    if (
      run.some(
        (i) =>
          i.kind === "tool" ||
          (i.kind === "reasoning" && (i.streaming || opened?.(detailKey(i.id)))),
      )
    )
      out.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "reasoning") run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/** Where the open turn's rows start (after the person's last message), or -1 when the last turn has ended. */
export function openTurn(all: ReadonlyArray<Row>): number {
  for (let i = all.length - 1; i >= 0; i--) {
    const row = all[i]!;
    if (row.kind !== "item") continue;
    const item = row.item;
    if (item.kind === "turn_end") return -1;
    if (item.kind === "restored" || (item.kind === "user" && item.delivery !== "steer"))
      return i + 1 < all.length ? i + 1 : -1;
  }
  return all.length ? 0 : -1;
}

/**
 * The latest turn's rows that the person starts watching: a run at work (`working`), any other row of the open turn
 * (`live`), and the fold a turn they watched makes when it ends (one holding a row they watched). What they watched
 * stays as they saw it until it has left the view, and only then folds (Transcript's `release`). A run already
 * settled when the chat opened, and every turn that ended before, stay folded.
 */
export function joinWatched(
  all: ReadonlyArray<Row>,
  watching: ReadonlySet<string>,
  working: (row: Extract<Row, { kind: "work" }>) => boolean,
  live: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const row = all[i]!;
    if (
      row.kind === "item" &&
      (row.item.kind === "restored" || (row.item.kind === "user" && row.item.delivery !== "steer"))
    )
      break;
    if (watching.has(row.id)) continue;
    if (
      row.kind === "work"
        ? working(row)
        : row.kind === "fold"
          ? row.rows.some((r) => watching.has(r.id))
          : live.has(row.id)
    )
      out.push(row.id);
  }
  return out;
}

/** A fold laid back out as its rows: the fold's id and its rows' ids, first to last. */
export interface HeldFold {
  readonly id: string;
  readonly rows: ReadonlyArray<string>;
}

/**
 * The rows with each fold that `holds` laid back out as the rows it holds, as the live turn showed them (the first
 * takes back the fold's speaker mark). A turn the person watched end stays the very rows they watched, so nothing on
 * screen remounts or moves; its fold forms once those rows have left the view.
 */
export function expandHeld(
  all: ReadonlyArray<Row>,
  holds: (fold: Extract<Row, { kind: "fold" }>) => boolean,
): { rows: ReadonlyArray<Row>; held: ReadonlyArray<HeldFold> } {
  const held: HeldFold[] = [];
  const out: Row[] = [];
  for (const row of all) {
    if (row.kind !== "fold" || !holds(row)) {
      out.push(row);
      continue;
    }
    held.push({ id: row.id, rows: row.rows.map((r) => r.id) });
    row.rows.forEach((r, i) => out.push(i === 0 && row.speaker ? { ...r, speaker: true } : r));
  }
  return held.length ? { rows: out, held } : { rows: all, held };
}

/**
 * Splits rows into turns (after a message of the person's, up to its turn_end) and folds each finished one.
 * A message steered into a running turn is part of that turn: it stays in view and the work around it folds. In the
 * Chief's transcript (`foldAll`) it is a message of its own instead (the turn still heard it then): what the turn did
 * before it is done, and the rest is its turn. There a turn that says nothing draws nothing (quietTurn).
 */
function foldTurns(
  all: ReadonlyArray<Row>,
  claims: Claims | undefined,
  foldAll: boolean,
  opened: Opened | undefined,
): Row[] {
  const out: Row[] = [];
  // The row that began the turn (a message, a restore), and the turn's rows after it.
  let opener: Row | undefined;
  let turn: Row[] = [];
  const close = (finished: boolean) => {
    const startedAt =
      opener?.kind === "item" && opener.item.kind === "user" ? opener.item.at : null;
    const shown = finished ? foldTurn(turn, startedAt, claims, foldAll) : turn;
    // A wake right after a result's card narrates it, whatever other chats' cards came between. A Chief's wake is the
    // runtime's notification, so its turn has no opener and the card is in it; older history began it with a generated
    // message, after the cards.
    const narrates =
      foldAll && (opener === undefined ? turn.some(isResult) : isWake(opener) && resultBefore(out));
    out.push(
      ...(foldAll
        ? quietTurn(opener, shown, finished, claims, opened, narrates)
        : opener
          ? [opener, ...shown]
          : shown),
    );
    opener = undefined;
    turn = [];
  };
  for (const row of all) {
    const kind = row.kind === "item" ? row.item.kind : null;
    const steer = row.kind === "item" && row.item.kind === "user" && row.item.delivery === "steer";
    if (steer && foldAll) {
      close(true);
      opener = asMessage(row);
    } else if ((kind === "user" && !(steer && turn.length > 0)) || kind === "restored") {
      close(false);
      opener = row;
    } else {
      turn.push(row);
      if (kind === "turn_end") close(true);
    }
  }
  // The live turn (no turn_end yet) stays as it is.
  close(false);
  return out;
}

/**
 * The Chief's turn as it shows (in one evening 46 of 102 turns said nothing, and each drew a
 * "Worked" row). One that says nothing and holds nothing for the person (a question, chats to start, a failure)
 * draws nothing of its own: no "Worked" line, no steps, and the line of the wake that began it goes too. The person's
 * own message stays, and so does every moment in it (the runtime's, never the Chief's words). Running, the person's
 * turn keeps its "Working" line; a wake's shows once it says something. What the reader opened by hand in it (a step,
 * a thought) stays, with the turn around it (STYLE.md section 0, rule 7). A wake right after a result's card
 * (`narrates`) is that result's lines and diagram: only what it says shows, under the card, with no wake line or
 * "Worked" line between.
 */
function quietTurn(
  opener: Row | undefined,
  shown: ReadonlyArray<Row>,
  finished: boolean,
  claims: Claims | undefined,
  opened: Opened | undefined,
  narrates = false,
): Row[] {
  const lead = opener ? [opener] : [];
  if (opened !== undefined && shown.some((row) => openedIn(row, opened)))
    return [...lead, ...shown];
  if (shown.some((row) => says(row, claims)))
    return narrates
      ? shown.filter(
          (row) =>
            isMoment(row) ||
            says(row, claims) ||
            (row.kind === "item" && row.item.kind === "turn_end"),
        )
      : [...lead, ...shown];
  const moments = shown.filter(isMoment);
  if (!opener || isWake(opener)) return moments;
  return finished ? [...lead, ...moments] : [...lead, ...shown];
}

/** Whether the reader opened something in a row by hand: the row itself, a run in its fold, or a step's details. */
function openedIn(row: Row, opened: Opened): boolean {
  if (opened(row.id)) return true;
  if (row.kind === "fold") return row.rows.some((r) => openedIn(r, opened));
  return row.kind === "work" && row.items.some((i) => opened(detailKey(i.id)));
}

/** A chat's moment on the Chief's board: always in view, never folded, never the Chief's words. */
const isMoment = (row: Row): boolean => row.kind === "item" && row.item.kind === "moment";
/** A chat's result card, which the wake after it narrates. */
const isResult = (row: Row | undefined): boolean =>
  row?.kind === "item" && row.item.kind === "moment" && row.item.moment.kind === "result";
/** Whether the cards the rows end with hold a result's. */
const resultBefore = (rows: ReadonlyArray<Row>): boolean => {
  for (let i = rows.length - 1; i >= 0 && isMoment(rows[i]!); i--)
    if (isResult(rows[i])) return true;
  return false;
};
/** A turn the runtime began for the Chief (a wake), not the person. */
const isWake = (row: Row | undefined): boolean =>
  row?.kind === "item" && row.item.kind === "user" && Boolean(row.item.generated);

/** Whether a row of the Chief's turn says something to the person: words, an ask, a kept card, a failed or stopped end. */
function says(row: Row, claims: Claims | undefined): boolean {
  if (row.kind === "fold") return false;
  if (row.kind === "item") {
    const item = row.item;
    if (item.kind === "moment") return false;
    if (item.kind === "turn_end") return item.outcome !== "completed";
    if (item.kind === "assistant")
      return item.text.trim() !== "" || Boolean(item.attachments?.length);
  }
  return !foldable(row, claims, true);
}

type UserItem = Extract<TranscriptItem, { kind: "user" }>;
// One copy per steer, so its row keeps the same item while the rest of the turn streams.
const messages = new WeakMap<UserItem, UserItem>();
/** A steered note as the message it is in the Chief's transcript: its own bubble, and the turn after it its own. */
function asMessage(row: Row): Row {
  if (row.kind !== "item" || row.item.kind !== "user") return row;
  let item = messages.get(row.item);
  if (!item) messages.set(row.item, (item = { ...row.item, delivery: "message" }));
  return { ...row, item };
}

function foldTurn(
  turn: ReadonlyArray<Row>,
  startedAt: string | null,
  claims: Claims | undefined,
  foldAll: boolean,
): Row[] {
  if (!foldAll) return foldToAnswers(turn, startedAt, claims);
  const out: Row[] = [];
  let run: Row[] = [];
  const close = (next: Row | undefined) => {
    // Progress belongs under the completed turn's work summary, even one update or tool.
    if (run.length === 0) return;
    // The turn's first fold counts from the person's message; one after the engine said something, from its first step.
    const atStart = out.every(
      (r) => r.kind === "item" && (r.item.kind === "user" || r.item.kind === "moment"),
    );
    const from = atStart ? (startedAt ?? earliest(run)) : earliest(run);
    const to =
      next &&
      next.kind === "item" &&
      (next.item.kind === "assistant" || next.item.kind === "turn_end")
        ? next.item.at
        : latest(run);
    const ms = from && to ? Date.parse(to) - Date.parse(from) : NaN;
    out.push({
      kind: "fold",
      id: `fold:${run[0]!.id}`,
      rows: run.map(quiet),
      ms: Number.isFinite(ms) && ms >= 0 ? ms : null,
      speaker: run[0]!.speaker,
    });
    run = [];
  };
  turn.forEach((row) => {
    if (foldable(row, claims, foldAll)) return void run.push(row);
    // A moment the runtime wrote while the Chief worked sits before that work's fold rather than splitting it in two.
    if (foldAll && isMoment(row)) return void out.push(row);
    close(row);
    out.push(row);
  });
  close(undefined);
  return out;
}

/**
 * An ordinary chat's finished turn 
 * agent is done"): the person's message, one "Worked for" line, the answer. Each part of the turn (a steer starts the
 * next) folds everything but its answer and what stays in view (foldable) into one fold just before that answer: its
 * steps, its thoughts and the replies on the way there, the work after the answer too. What it showed (screenshots,
 * pages, a reply's pictures) stays under the fold's line. The first part's clock runs from the person's message,
 * a later one's from its first step, each to its answer (or the turn's end) or its last step, whichever is later.
 */
function foldToAnswers(
  turn: ReadonlyArray<Row>,
  startedAt: string | null,
  claims: Claims | undefined,
): Row[] {
  const kept = answers(turn);
  const folds = (row: Row) => !kept.has(row.id) && (foldable(row, claims, false) || isReply(row));
  const out: Row[] = [];
  let part: Row[] = [];
  const close = () => {
    const run = part.filter(folds);
    if (run.length === 0) return void out.push(...part);
    const answer = part.findIndex((r) => kept.has(r.id));
    const at = Math.min(part.findIndex(folds), answer < 0 ? part.length : answer);
    const ending =
      answer >= 0
        ? part[answer]
        : part.find((r) => r.kind === "item" && r.item.kind === "turn_end");
    const from = out.length === 0 ? (startedAt ?? earliest(run)) : earliest(run);
    const to = later(ending?.kind === "item" ? itemAt(ending.item) : null, latest(run));
    const ms = from && to ? Date.parse(to) - Date.parse(from) : NaN;
    // The fold heads what follows it: the turn's speaker mark moves to it when the turn spoke first at or after it.
    const speaker = part.slice(at).some((r) => r.speaker);
    out.push(...part.slice(0, at), {
      kind: "fold",
      id: `fold:${run[0]!.id}`,
      rows: run.map(quiet),
      ms: Number.isFinite(ms) && ms >= 0 ? ms : null,
      speaker,
    });
    for (const row of part.slice(at)) if (!folds(row)) out.push(speaker ? quiet(row) : row);
  };
  for (const row of turn) {
    if (isSteer(row)) {
      close();
      out.push(row);
      part = [];
    } else part.push(row);
  }
  close();
  return out;
}

/** A reply that says something: words, or files it attached. */
const isReply = (row: Row): boolean =>
  row.kind === "item" &&
  row.item.kind === "assistant" &&
  (row.item.text.trim() !== "" || Boolean(row.item.attachments?.length));
const isSteer = (row: Row): boolean =>
  row.kind === "item" && row.item.kind === "user" && row.item.delivery === "steer";

/** Each part of a turn's last reply (a steer starts the next part): what the part answered, never folded. */
function answers(turn: ReadonlyArray<Row>): Set<string> {
  const out = new Set<string>();
  let last: string | null = null;
  for (const row of turn) {
    if (isSteer(row)) {
      if (last !== null) out.add(last);
      last = null;
    } else if (isReply(row)) last = row.id;
  }
  if (last !== null) out.add(last);
  return out;
}

/**
 * The open turn's rows that stay behind its "Working for" line while its steps are hidden: what will fold when it
 * ends (foldTurn), less its latest words, so the line, those words and what needs the person are the turn as it
 * runs, and the turn ending moves nothing. In an ordinary chat the replies before the latest one are steps too. A
 * retry or a compaction is how the turn stands: it stays in view.
 */
export function liveSteps(turn: ReadonlyArray<Row>, claims?: Claims, foldAll = false): Set<string> {
  const kept = foldAll ? null : answers(turn);
  const out = new Set<string>();
  for (const row of turn) {
    if (row.kind === "item" && (row.item.kind === "retry" || row.item.kind === "compaction"))
      continue;
    if (foldable(row, claims, foldAll) || (kept !== null && isReply(row) && !kept.has(row.id)))
      out.add(row.id);
  }
  return out;
}

function foldable(row: Row, claims: Claims | undefined, foldAll: boolean): boolean {
  if (row.kind === "work") return !claims?.(workTools(row.items));
  // The turn's subagents stay in view once it ends: what each did, and a way into it.
  if (row.kind !== "item") return false;
  const item = row.item;
  switch (item.kind) {
    // What the engine says is what the person reads: never folded, first reply or last.
    case "plan":
    case "route":
    case "retry":
    case "compaction":
      return true;
    case "memory":
      return item.action === "recalled";
    case "notice":
      return foldAll && item.tone === "info" && !item.action;
    default:
      return false;
  }
}

/** Inside a fold the fold carries the speaker mark. */
const quiet = (row: Row): Row => (row.speaker ? { ...row, speaker: false } : row);

function stamps(row: Row): { start: string[]; end: string[] } {
  const start: string[] = [];
  const end: string[] = [];
  const add = (item: TranscriptItem) => {
    if (item.kind === "tool") {
      start.push(item.startedAt);
      if (item.finishedAt) end.push(item.finishedAt);
    } else if (item.kind === "subagent") {
      start.push(item.startedAt);
      if (item.finishedAt) end.push(item.finishedAt);
    } else if (
      item.kind === "assistant" ||
      item.kind === "route" ||
      item.kind === "compaction" ||
      item.kind === "memory"
    ) {
      if (item.at) (start.push(item.at), end.push(item.at));
    }
  };
  if (row.kind === "work" || row.kind === "agents") row.items.forEach(add);
  else if (row.kind === "item") add(row.item);
  return { start, end };
}

const pick = (
  run: ReadonlyArray<Row>,
  side: "start" | "end",
  better: (a: number, b: number) => boolean,
): string | null => {
  let best: string | null = null;
  for (const row of run)
    for (const at of stamps(row)[side])
      if (
        Number.isFinite(Date.parse(at)) &&
        (best === null || better(Date.parse(at), Date.parse(best)))
      )
        best = at;
  return best;
};
const earliest = (run: ReadonlyArray<Row>) => pick(run, "start", (a, b) => a < b);
const latest = (run: ReadonlyArray<Row>) => pick(run, "end", (a, b) => a > b);
const later = (a: string | null, b: string | null): string | null =>
  a === null || !Number.isFinite(Date.parse(a))
    ? b
    : b === null || Date.parse(a) >= Date.parse(b)
      ? a
      : b;
const itemAt = (item: TranscriptItem): string | null =>
  "at" in item && typeof item.at === "string" ? item.at : null;

/** "Worked for 42s", "Worked for 3m 12s", "Worked for 1h 4m"; "Worked" with no clock. The open turn says "Working for". */
export function workedFor(ms: number | null, verb = "Worked"): string {
  return ms === null ? verb : `${verb} for ${duration(ms)}`;
}

/** "42s", "3m 12s", "1h 4m". */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** Who ran a turn and for how long: what its line says ("Grok 4.7 worked for 43s"). */
export interface TurnHead {
  /** From the person's message to the turn's end; null when either has no usable time. */
  readonly ms: number | null;
  readonly engine: string | undefined;
  /** The model the turn ran on: the router's last pick where it moved the engine, else the one the turn started on. */
  readonly model: string | undefined;
  /** Some of its work folded after it first spoke: each fold then says its own time, and a quiet head says none. */
  readonly folds: boolean;
}

/** A row's items, a fold's included: what a turn's head reads its engine and model from. */
export function rowItems(row: Row): TranscriptItem[] {
  if (row.kind === "item") return [row.item];
  if (row.kind === "fold") return row.rows.flatMap(rowItems);
  return [...row.items];
}

/** The model a turn's items ran on: the router's last move (a route item) over the model attributed at turn.started. */
export function turnModel(items: ReadonlyArray<TranscriptItem>): {
  engine: string | undefined;
  model: string | undefined;
} {
  let engine: string | undefined;
  let model: string | undefined;
  let routed: string | undefined;
  for (const item of items) {
    engine ??= item.engine;
    model ??= item.turnModel;
    if (item.kind === "route") routed = item.model;
  }
  return { engine, model: routed ?? model };
}

/**
 * Each finished turn's head, by the id of the row it heads (the first row that speaks for the engine, a fold
 * included): the whole turn's time and its model, so its line reads the same as the live one that ticked
 * ("Grok 4.7 working for 43s" settles into "Grok 4.7 worked for 43s").
 */
export function turnHeads(all: ReadonlyArray<Row>): Map<string, TurnHead> {
  const heads = new Map<string, TurnHead>();
  let since: string | null = null;
  let head: string | null = null;
  let seen: TranscriptItem[] = [];
  let folds = false;
  for (const row of all) {
    const item = row.kind === "item" ? row.item : null;
    if (item?.kind === "restored" || (item?.kind === "user" && item.delivery !== "steer")) {
      since = item.kind === "user" ? item.at : null;
      head = null;
      seen = [];
      folds = false;
      continue;
    }
    if (row.speaker && head === null) head = row.id;
    if (row.kind === "fold" && head !== null && row.id !== head) folds = true;
    seen.push(...rowItems(row));
    if (item?.kind === "turn_end") {
      if (head !== null) {
        const ms = since ? Date.parse(item.at) - Date.parse(since) : NaN;
        heads.set(head, {
          ms: Number.isFinite(ms) && ms >= 0 ? ms : null,
          ...turnModel(seen),
          folds,
        });
      }
      since = null;
      head = null;
      seen = [];
      folds = false;
    }
  }
  return heads;
}

/** A turn's line: "Grok 4.7 worked for 43s" ("working" while it runs), "Worked for 43s" with nobody to name. */
export function turnLine(who: string, ms: number | null, live = false): string {
  if (!who) return workedFor(ms, live ? "Working" : "Worked");
  const verb = live ? "working" : "worked";
  return ms === null ? `${who} ${verb}` : `${who} ${workedFor(ms, verb)}`;
}

/**
 * What an open turn stopped on, when the engine waits on the person (an ask with no answer yet): "waiting for your
 * approval", compact "Waiting for approval". It says no time: nothing is working while it waits.
 */
export function waitLine(kind: "question" | "approval" | "secret" | "tool"): string {
  return kind === "approval"
    ? "waiting for your approval"
    : kind === "question"
      ? "waiting for your answer"
      : "waiting for you";
}

/**
 * A long command an approval waits on, folded in its middle: its first lines (what it sets up) and its last (what
 * runs at the end, often the point: `… EOF` then `node --test`), with how many lines sit between. Short ones stay
 * whole (null).
 */
export function foldLines(
  text: string,
  head = 4,
  tail = 3,
): { readonly head: string; readonly hidden: number; readonly tail: string } | null {
  const lines = text.split("\n");
  if (lines.length <= head + tail + 1) return null;
  return {
    head: lines.slice(0, head).join("\n"),
    hidden: lines.length - head - tail,
    tail: lines.slice(-tail).join("\n"),
  };
}
