// What the phone says outside the app, worded once: the Live Activity, the Dynamic Island and the widget all show
// this, so they never disagree with each other or with the app (it counts with the same selectors, store/select.ts).
// One mood wins, most urgent first: a conversation out loud, then what needs you (the oldest ask), then what is ready
// to try, then what is at work; with none of those it is all done.
import { chiefById, HOME_CHIEF } from "../board/model";
import { askOf, atWork, countsLine, lineTwo, type Row, rows, unseenReady } from "../store/select";
import type { AppState } from "../store/store";
import type { Talk } from "./talk";

export type Mood = "talk" | "needs" | "ready" | "working" | "done";

export interface GlanceRow {
  title: string;
  /** Its own line: the short ask, what's ready, the live sentence. */
  line: string;
  mood: Exclude<Mood, "talk" | "done">;
  link: string;
}

/**
 * A button on the Lock Screen and in the expanded Dynamic Island: what it says and what it does when pressed. One that
 * lets an agent go ahead opens the app (`open`), so a locked phone asks for Face ID first and nobody holding it can
 * approve a command; one that stops or holds things (Deny, Mute, End) acts in place (`target`).
 */
export interface Choice {
  label: string;
  /** What activity.ts does with it in place: "deny:<chat>", "mute", "end". */
  target?: string;
  /** Or the link that opens the app and answers there, behind Undo: caveman://chat/<id>?answer=allow|<option>. */
  open?: string;
  /** An SF Symbol beside the label. */
  icon?: string;
  /** The one strong action is ink (the app's primary); ending a call is red; the rest are quiet. */
  tone: "quiet" | "strong" | "danger";
}

export interface Glance {
  mood: Mood;
  /** Who it is about: a Chief's name, "Voice chat", or "Caveman" for chats of your own. */
  who: string;
  /** That Chief's id, for its face: the home Chief's (the caveman) for chats of your own and for all done. */
  chief: string;
  /** The face's picture, a file in the App Group (system/faces.ts); empty draws the flame. */
  face: string;
  /** The head: "Chief · Dark runs page", "3 working", "Ready to try", "Oona", "All done". */
  title: string;
  /** The one thing said: the ask, the live line, the headline, "Listening". */
  line: string;
  /** Beside the head: "1 of 2", the chat, the workspace. */
  detail: string;
  /** The compact Dynamic Island's number: what needs you, is ready, or is at work. */
  count: number;
  /** Everything at once: "1 needs you · 3 working". */
  tally: string;
  /** Where a tap goes. */
  link: string;
  /**
   * At most two buttons: Deny and Allow for a command, a question's two options, Mute and End on a call; none when the
   * answer needs the app (a question with more options, or words).
   */
  choices: Choice[];
  /** A conversation's start, for its clock (ms since the epoch); 0 otherwise. */
  since: number;
  muted: boolean;
  needs: number;
  working: number;
  ready: number;
  /** The medium widget's list: up to three chats, most urgent first. */
  rows: GlanceRow[];
}

export const chatLink = (id: string) => `caveman://chat/${encodeURIComponent(id)}`;
export const chiefLink = (id: string) => `caveman://chief/${encodeURIComponent(id)}`;
/** Opens a chat and answers its ask there: "allow", or a question's option by its index (activity.ts answerFrom). */
export const answerLink = (id: string, answer: string) => `${chatLink(id)}?answer=${encodeURIComponent(answer)}`;

const nameOf = (chief: string | null) => (chief ? chiefById(chief).name : "Caveman");

/** When a row's ask was made, so the oldest is answered first (DECISIONS.md, the Needs you list). */
const askedAt = (r: Row) => askOf(r.chat).need?.at ?? r.chat.updatedAt ?? r.chat.startedAt;

export function glanceOf(s: AppState, talk: Talk | null): Glance {
  const chats = s.board.chats;
  const all = rows(chats, s.inbox.archived);
  const needs = all.filter((r) => r.phase === "needs").sort((a, b) => askedAt(a) - askedAt(b));
  const ready = all.filter((r) => unseenReady(r, s.inbox));
  const working = all.filter(atWork).sort((a, b) => (b.chat.updatedAt ?? 0) - (a.chat.updatedAt ?? 0));
  const counts = { needs: needs.length, ready: ready.length, working: working.length };
  const tally = countsLine(counts) ?? "Nothing running";
  const base = { face: "", choices: [] as Choice[], since: 0, muted: false, tally, ...counts };

  const listed: GlanceRow[] = [
    ...needs.map((r): GlanceRow => {
      const ask = askOf(r.chat, chats);
      return { title: r.chat.title, line: ask.question, mood: "needs", link: chatLink(ask.asker.id) };
    }),
    ...ready.map((r): GlanceRow => ({ title: r.chat.title, line: "Ready to try", mood: "ready", link: chatLink(r.chat.id) })),
    ...working.map((r): GlanceRow => ({ title: r.chat.title, line: lineTwo(r.chat, r.phase, r.chat.device, chats).said, mood: "working", link: chatLink(r.chat.id) })),
  ].slice(0, 3);

  if (talk) {
    const link = talk.kind === "call" && talk.chief ? chiefLink(talk.chief) : talk.chat ? chatLink(talk.chat) : "caveman://new";
    return {
      ...base,
      mood: "talk",
      who: talk.who,
      chief: talk.chief ?? HOME_CHIEF,
      title: talk.who,
      line: talk.muted ? "Muted" : talk.state,
      detail: tally,
      count: 0,
      link,
      since: talk.since,
      muted: talk.muted,
      choices: [
        { label: talk.muted ? "Unmute" : "Mute", target: "mute", icon: talk.muted ? "mic.fill" : "mic.slash.fill", tone: "quiet" },
        { label: "End", target: "end", icon: "phone.down.fill", tone: "danger" },
      ],
      rows: listed,
    };
  }

  const first = needs[0];
  if (first) {
    const ask = askOf(first.chat, chats);
    const who = nameOf(first.chief);
    return {
      ...base,
      mood: "needs",
      who,
      chief: first.chief ?? HOME_CHIEF,
      title: first.chief ? `${who} · ${first.chat.title}` : first.chat.title,
      line: ask.full,
      detail: needs.length > 1 ? `1 of ${needs.length}` : first.chat.repo,
      count: needs.length,
      link: chatLink(ask.asker.id),
      choices: choicesOf(ask),
      rows: listed,
    };
  }

  const fresh = ready[0];
  if (fresh) {
    return {
      ...base,
      mood: "ready",
      who: nameOf(fresh.chief),
      chief: fresh.chief ?? HOME_CHIEF,
      title: ready.length > 1 ? `${ready.length} ready to try` : "Ready to try",
      line: fresh.chat.moment?.headline ?? fresh.chat.title,
      detail: fresh.chat.repo,
      count: ready.length,
      link: chatLink(fresh.chat.id),
      rows: listed,
    };
  }

  const busy = working[0];
  if (busy) {
    return {
      ...base,
      mood: "working",
      who: nameOf(busy.chief),
      chief: busy.chief ?? HOME_CHIEF,
      title: `${working.length} working`,
      line: lineTwo(busy.chat, busy.phase, busy.chat.device, chats).said,
      detail: busy.chat.title,
      count: working.length,
      link: chatLink(busy.chat.id),
      rows: listed,
    };
  }

  return { ...base, mood: "done", who: "Caveman", chief: HOME_CHIEF, title: "All done", line: "Nothing needs you.", detail: "", count: 0, link: "", rows: listed };
}

/**
 * How an ask can be answered from the Lock Screen: a command with Deny and Allow, a question with one or two options
 * by them (the recommended one strong, at the right under the thumb, where Allow sits). A question with more options,
 * or none, opens the chat.
 */
export function choicesOf(ask: ReturnType<typeof askOf>): Choice[] {
  const id = ask.asker.id;
  const need = ask.need;
  if (need?.kind === "question") {
    if (!need.options.length || need.options.length > 2) return [];
    const strong = Math.max(0, need.options.findIndex((o) => o.recommended));
    const order = need.options.map((o, i) => ({ o, i })).sort((a, b) => Number(a.i === strong) - Number(b.i === strong));
    return order.map(({ o, i }): Choice => ({ label: o.label, open: answerLink(id, String(i)), tone: i === strong && need.options.length > 1 ? "strong" : "quiet" }));
  }
  if (!ask.command) return [];
  return [
    { label: "Deny", target: `deny:${id}`, tone: "quiet" },
    { label: "Allow", open: answerLink(id, "allow"), tone: "strong" },
  ];
}

/** Whether the Live Activity has anything to say: something at work, waiting on you, or a conversation out loud. */
export const isLive = (g: Glance) => g.mood === "talk" || g.needs > 0 || g.working > 0;

/** What changes the widget: the counts and the words, not the clock. */
export const widgetKey = (g: Glance) => JSON.stringify([g.mood, g.chief, g.face, g.count, g.title, g.line, g.tally, g.link, g.rows]);
/** What changes the Live Activity. */
export const activityKey = (g: Glance) => JSON.stringify([g.mood, g.chief, g.face, g.title, g.line, g.detail, g.count, g.choices, g.since, g.muted, g.link]);
