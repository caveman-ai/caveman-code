// A Chief's chat as turns, the way a chat folds (DECISIONS.md, "A Chief's chat"): what it said is a flat list of lines,
// and this reads it back as the parts a person sees. An exchange is your note and the line that answered it, with
// whatever it said in between and the chats it started for you. An update is news it brought up on its own ("X is
// ready to try"), a run of lines close together under one head. A call is where a call ended.
//
// The runtime will give each line its turn id; the prototype's lines have none, so the answer to a note is the first
// line after it, unless the screen saw the Chief finish thinking on a different one (`answers`), and a note it is still
// working on has no answer yet (`working`).
import type { Chat, Phase, Said } from "../board/model";
import { phaseOf } from "../store/select";

export type Segment =
  | {
      kind: "exchange";
      key: string;
      note: Said;
      /** The line that answered it, or null while the Chief is still on it. */
      reply: Said | null;
      /** What it said between your note and its answer: folded under "Worked for". */
      between: Said[];
      at: number;
    }
  | { kind: "update"; key: string; lines: Said[]; at: number }
  | { kind: "call"; key: string; line: Said; at: number };

/** News lines this close together share one "Update" head. */
const RUN_MS = 5 * 60_000;

/**
 * The segments of a Chief's chat, oldest first. `answers` maps a note's id to the id of the line the screen saw answer
 * it; `working` is the note the Chief is thinking about right now.
 */
export function segmentsOf(said: readonly Said[], answers: ReadonlyMap<number, number>, working: number | null): Segment[] {
  const out: Segment[] = [];
  let open: Extract<Segment, { kind: "exchange" }> | null = null;
  for (const line of said) {
    if (line.who === "you") {
      open = { kind: "exchange", key: `x${line.id}`, note: line, reply: null, between: [], at: line.at };
      out.push(open);
      continue;
    }
    if (line.who === "call") {
      open = null;
      out.push({ kind: "call", key: `c${line.id}`, line, at: line.at });
      continue;
    }
    if (open && !open.reply) {
      const known = answers.get(open.note.id);
      if (known === line.id || (known === undefined && working !== open.note.id)) {
        open.reply = line;
        continue;
      }
      // Said while it was still working out the answer: news that happened to land then.
      if (known !== undefined && line.id < known) {
        open.between.push(line);
        continue;
      }
    }
    const last = out.at(-1);
    if (last?.kind === "update" && line.at - (last.lines.at(-1)?.at ?? 0) < RUN_MS) last.lines.push(line);
    else out.push({ kind: "update", key: `u${line.id}`, lines: [line], at: line.at });
  }
  return out;
}

/** The chats a line names (its words and its roll calls), in order, once each. */
export function refsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\[\[([\w-]+)\]\]/g)].map((m) => m[1] as string))];
}

/**
 * The chats an exchange started: named in its answer (or on the way to it), on no one's family but their own, and
 * started after your note went. A chat it only mentions (one that was already running) isn't one it started.
 */
export function startedBy(seg: Extract<Segment, { kind: "exchange" }>, chats: readonly Chat[]): Chat[] {
  const ids = [...seg.between, ...(seg.reply ? [seg.reply] : [])].flatMap((line) => refsOf(line.text));
  return ids.map((id) => chats.find((c) => c.id === id)).filter((c): c is Chat => !!c && !c.parent && bornAt(c) >= seg.note.at - 5000);
}

/** When a chat began: its first message ("startedAt" moves to each new turn's start). */
const bornAt = (chat: Chat) => chat.items.find((i) => i.kind === "you")?.at ?? chat.startedAt;

/**
 * Where the visible window starts (Codex's way, and the founder's "zen" for Chiefs): the latest Update or turn and what
 * came after it; everything before goes under "⌃ Earlier", so a newer Update folds the older ones away and the screen
 * holds the latest news and what's open. Your own talk with it never folds out from under you: a turn the Chief is
 * still working on stays, and so does your latest turn while it's the conversation you're in (it ended under half an
 * hour ago), with whatever news landed after it.
 */
export function windowStart(segments: readonly Segment[], working: number | null = null, now = Date.now()): number {
  let from = segments.findLastIndex((s) => s.kind !== "call");
  if (from < 0) return 0;
  const live = segments.findIndex((s) => s.kind === "exchange" && s.note.id === working);
  if (live >= 0 && live < from) from = live;
  const talk = segments.findLastIndex((s) => s.kind === "exchange");
  const last = segments[talk];
  if (last?.kind === "exchange" && talk < from && now - (last.reply?.at ?? last.note.at) < GAP_MS) from = talk;
  return from;
}

/** What "⌃ Earlier" folds, in words: "6 turns" when it's all your notes and its answers, else "3 updates". */
export function earlierLabel(segments: readonly Segment[]): string {
  const n = segments.length;
  const turns = segments.every((s) => s.kind === "exchange");
  return `${n} ${turns ? (n === 1 ? "turn" : "turns") : n === 1 ? "update" : "updates"}`;
}

// ---------------------------------------------------------------- a line, read for the screen

/**
 * A line of the Chief's as the screen draws it: its words, and its roll calls. A line on its own of just a chat
 * ("- [[audit]]") is a roster row, the way a list of links reads in markdown; a run of them is one roster, drawn as the
 * "Started 3 chats" rows are (pill, engine · device, state in a glyph and a word), so a morning's "One needs you,
 * three are running" names its chats in rows rather than in a wall of pills.
 */
export type Block = { kind: "prose"; text: string } | { kind: "roster"; ids: string[] };

const ROSTER_LINE = /^\s*[-•]\s*\[\[([\w-]+)\]\]\s*$/;

export function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split("\n")) {
    const row = ROSTER_LINE.exec(raw);
    const last = out.at(-1);
    if (row) {
      if (last?.kind === "roster") last.ids.push(row[1] as string);
      else out.push({ kind: "roster", ids: [row[1] as string] });
    } else if (raw.trim()) {
      if (last?.kind === "prose") last.text += `\n${raw}`;
      else out.push({ kind: "prose", text: raw });
    }
  }
  return out;
}

/** The chats a line's roll calls name. */
export const rosterIds = (text: string) => blocksOf(text).flatMap((b) => (b.kind === "roster" ? b.ids : []));

/** A sentence ends on a word that closes with a stop. */
const ENDS = /[.!?]["”’)]*$/;

/**
 * Which of the chats a line's words name get the pill, in the order they're named: at most one a sentence, and never a
 * chat already shown on the screen (in a roster, the dock, or earlier). The rest are named plainly, still a tap away.
 * `shown` gains the ones that get a pill.
 */
export function pillsOf(text: string, shown: Set<string>): boolean[] {
  const out: boolean[] = [];
  for (const block of blocksOf(text)) {
    if (block.kind !== "prose") continue;
    let pilled = false;
    for (const part of block.text.split(/(\[\[[\w-]+\]\]|\s+)/)) {
      if (!part) continue;
      const ref = /^\[\[([\w-]+)\]\]$/.exec(part);
      if (ref) {
        const id = ref[1] as string;
        const pill = !pilled && !shown.has(id);
        out.push(pill);
        if (pill) {
          pilled = true;
          shown.add(id);
        }
      } else if (ENDS.test(part)) pilled = false;
    }
  }
  return out;
}

/** "[[x]] is ready to try. Take a look.": news a roll call above it already shows in its row's state. */
export function echoOf(text: string): string | null {
  return /^\[\[([\w-]+)\]\] is ready to try\.(?: Take a look\.)?$/.exec(text.trim())?.[1] ?? null;
}

const NUMBER = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/**
 * A roll call counted in one plain sentence, from where each of its chats stands now (the one status every count
 * reads, so it never disagrees with its rows or the capsule): "One needs you, three are running, one is ready to try."
 */
export function tallyOf(ids: readonly string[], chats: readonly Chat[]): string {
  const phases = ids.flatMap((id) => {
    const chat = chats.find((ch) => ch.id === id);
    return chat ? [phaseOf(chat, chats)] : [];
  });
  const n = (p: Phase) => phases.filter((x) => x === p).length;
  const word = (count: number, first: boolean) => {
    const w = NUMBER[count] ?? String(count);
    return first ? w : w.toLowerCase();
  };
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count) parts.push(`${word(count, !parts.length)} ${count === 1 ? one : many}`);
  };
  add(n("needs"), "needs you", "need you");
  add(n("working"), "is running", "are running");
  add(n("ready"), "is ready to try", "are ready to try");
  add(n("done"), "is done", "are done");
  return parts.length ? `${parts.join(", ")}.` : "Nothing to report.";
}

/** A line as it's spoken or copied: its words with the chats by name, each roll call by its count. */
export const spoken = (text: string, chats: readonly Chat[]) =>
  blocksOf(text)
    .map((b) => (b.kind === "prose" ? b.text : tallyOf(b.ids, chats)))
    .join(" ")
    .replace(/\[\[([\w-]+)\]\]/g, (_, id: string) => chats.find((ch) => ch.id === id)?.title ?? "a chat");

/** Two lines more than this far apart get a date line between them. */
export const GAP_MS = 30 * 60_000;

/** The desktop's turn clock (transcript/rows.ts duration): "2s", "1m 4s". */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

const dayOf = (at: number) => new Date(at).toDateString();
/** The time as the thread says it (TurnEnd.tsx): the locale's own clock, "2:53 PM" or "14:53". */
export const clockOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A date line: "Today 09:12", "Yesterday 21:20", "Wed 4 Nov 15:00". */
export function dateLine(at: number, now = Date.now()): string {
  const name = dayOf(at) === dayOf(now) ? "Today" : dayOf(at) === dayOf(now - 86_400_000) ? "Yesterday" : new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${name} ${clockOf(at)}`;
}
