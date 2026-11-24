// The scripted engine: the prototype's stand-in for a runtime, out of React. It plays each chat's turn (`Chat.plan`,
// board/plans.ts) a step at a time, loops the live lines of chats that run for good, greets you on the first morning,
// answers what you tell a Chief, and sends a queued follow-up when the turn in front of it ends. It runs once for the
// app, whatever is on screen, and picks up after a relaunch: a turn restored from disk carries on from its next step,
// and a chat left working with nothing to play gets a turn to finish.
//
// `start`, `send`, `tellChief`, `respond` (and its `allow`, `deny`, `answer`) and `stop` are the seams where a Session
// Protocol client goes (`workspace.create` + `turn.submit`, `chief.send`, `ask.respond`, `turn.interrupt`): a runtime
// source dispatches the same store actions from what the engines report. An answer shows on the board the moment it is
// given and reaches the engine only after `hold` (src/asks/decide.ts holds it for Undo); `takeBack` inside that time
// puts the ask back as it was.
//
// Once someone has signed in to Caveman (src/live/seams.ts), the seams reach their own computers for their chats:
// `send`, `respond` and `stop` go to the one a chat runs on, and the script plays nothing on a board that is theirs.
import type { BoardAction } from "../store/board";
import { dispatch, resetStore, store } from "../store/store";
import { needOf, phaseOf } from "../store/select";
import { chiefScope, getDraft, NEW_CHAT, queueOf, sessionOf, setDraft, shiftQueue } from "../store/sessions";
import type { Access } from "../shell/composer/menus";
import { settledNow } from "../thread/settle";
import { isLive, leave, reach, runtimeOf, startLive } from "../live/seams";
import { didNotStart, isStarting } from "../live/start";
import {
  type AskOption,
  type Chat,
  type Chief,
  CHIEFS,
  chatId,
  chiefById,
  chiefOf,
  DARKER_MOMENT,
  type Effort,
  ENGINE_NAME,
  type Engine,
  intentOf,
  type Item,
  itemId,
  type Moment,
  momentFor,
  type Said,
  type SentImage,
  THIS_MAC,
  titleFrom,
  type Toast,
} from "./model";
import { allowedPlan, deniedPlan, directedPlan, gatherPlan, shipPlan, taskPlan, tweakPlan } from "./plans";
import { AUDIT_MOMENT, PREVIEWS } from "./world";
import { prNumberFor } from "../screens/pages/review-model";

export interface Start {
  engine: Engine;
  model: string;
  effort: Effort;
  speed?: string;
  repo: string;
  /** The device it runs on (a Device id); this Mac when absent. */
  device?: string;
  /** The Chief starting it; absent or null, it's one you started yourself (Home's bar, a workspace, a device). */
  chief?: string | null;
  /** What it may do without asking, as its box picked it; absent, Settings' for new chats. */
  access?: Access;
  /** The person picked the model themselves (not Settings' default): on a real computer its agent is never swapped for another. */
  picked?: boolean;
}

const board = () => store.get().board;
const chatOf = (id: string) => board().chats.find((c) => c.id === id);
const go = (action: BoardAction) => dispatch(action);

// ---------------------------------------------------------------- timers

/** Each chat's next plan step, and the loose beats (a Chief's reply, an acknowledgement). */
const stepTimers = new Map<string, ReturnType<typeof setTimeout>>();
const beats = new Set<ReturnType<typeof setTimeout>>();
/** Answers to a computer's chats, each held until its Undo has passed (respond's `hold`). */
const unheard = new Map<string, ReturnType<typeof setTimeout>>();
let ticker: ReturnType<typeof setInterval> | null = null;
let unwatch: (() => void) | null = null;

function later(ms: number, run: () => void) {
  const timer = setTimeout(() => {
    beats.delete(timer);
    run();
  }, ms);
  beats.add(timer);
}

/** Stops the script where it is: every turn it was playing, its live lines, its beats. */
export function stopScript() {
  stopAll();
}

function stopAll() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  for (const timer of stepTimers.values()) clearTimeout(timer);
  stepTimers.clear();
  for (const timer of beats) clearTimeout(timer);
  beats.clear();
  for (const timer of unheard.values()) clearTimeout(timer);
  unheard.clear();
  unwatch?.();
  unwatch = null;
}

// ---------------------------------------------------------------- plans

/** A planned action as it lands: words and messages are stamped now, so they stream in now. */
function stamp(action: BoardAction): BoardAction {
  if (action.type !== "append") return action;
  const now = Date.now();
  return { ...action, items: action.items.map((item) => (item.kind === "text" || item.kind === "you" || item.kind === "stop" ? { ...item, at: now } : item)) };
}

/** Schedules a chat's next plan step, if it has one. */
function resume(id: string) {
  const waiting = stepTimers.get(id);
  if (waiting) clearTimeout(waiting);
  stepTimers.delete(id);
  const plan = chatOf(id)?.plan;
  const next = plan?.steps[plan.next];
  if (!plan || !next) return;
  stepTimers.set(
    id,
    setTimeout(() => {
      stepTimers.delete(id);
      land(id);
    }, next.ms),
  );
}

function land(id: string) {
  const plan = chatOf(id)?.plan;
  const step = plan?.steps[plan.next];
  if (!plan || !step) return;
  const last = plan.next + 1 >= plan.steps.length;
  // How far it got goes first, so a relaunch in the middle never plays a step twice.
  go({ type: "plan", id, plan: last ? undefined : { ...plan, next: plan.next + 1 } });
  for (const action of step.actions) go(stamp(action));
  if (!last) resume(id);
}

/** Plays a turn on a chat, from its first step. */
function play(id: string, plan: NonNullable<Chat["plan"]>) {
  go({ type: "plan", id, plan });
  resume(id);
}

/** Forgets a chat's turn: its next step won't land. */
function cancel(id: string) {
  const waiting = stepTimers.get(id);
  if (waiting) clearTimeout(waiting);
  stepTimers.delete(id);
  if (chatOf(id)?.plan) go({ type: "plan", id, plan: undefined });
}

// ---------------------------------------------------------------- what the board says

const say = (chief: string | null, who: Said["who"], text: string, images?: Said["images"]) => go({ type: "say", chief, who, text, images });
const think = (chief: string, text: string | null) => go({ type: "think", chief, text });
const update = (id: string, patch: Partial<Chat>) => go({ type: "update", id, patch });
const words = (id: string, text: string, phase?: "commentary" | "final") => go({ type: "append", id, items: [{ kind: "text", id: itemId(), text, at: Date.now(), phase }] });
/** The Chief that started a chat: it's the one that tells you about it (none for one of your own). */
const chiefFor = (id: string) => {
  const chat = chatOf(id);
  return chat ? chiefOf(chat) : null;
};

export function notify(text: string, tone: Toast["tone"] = "info", chief?: string, chat?: string) {
  go({ type: "toast", text, tone, chief, chat });
}

/**
 * A real chat that nothing can reach right now: none of the person's computers holds it (it was let go somewhere
 * else, or the list has not been read yet). Nothing is sent, and nothing is made up in its place: the words go back
 * to the chat's box, so what was typed is never lost.
 */
const away = (id: string, text?: string) => {
  if (text && !getDraft(id).trim()) setDraft(id, text);
  notify("Not sent. Your words are back in the box.");
};

/** The pictures a message carries, when it carries any: nothing is written for none, so a chat's JSON stays as it was. */
const withImages = (images?: readonly SentImage[]) =>
  images?.length ? { images: images.map(({ uri, width, height, shot }): SentImage => ({ uri, ...(width ? { width } : null), ...(height ? { height } : null), ...(shot ? { shot } : null) })) } : null;

/** A chat started with pictures and no words is named for them. */
const pictured = (images: readonly SentImage[]) => (images.length > 1 ? `${images.length} photos` : "A photo");

/** Your message lands at once, "Sending" until the engine has it. */
function yourMessage(id: string, text: string, steer: boolean, images?: readonly SentImage[]): string {
  const item: Item = { kind: "you", id: itemId(), text, at: Date.now(), state: "sending", ...(steer ? { steer: true } : null), ...withImages(images) };
  go({ type: "append", id, items: [item] });
  later(150, () => go({ type: "ack", id, item: item.id }));
  return item.id;
}

// ---------------------------------------------------------------- the seams

/** A new chat from the phone, with the pictures that went with its first words. Returns its id so the screen can open it. */
export function start(ask: string, with_: Start, images?: readonly SentImage[]): string {
  // On a computer's own board the chat starts for real: on the Mac picked, or in Cloud (live/link.ts, live/start.ts).
  if (isLive()) {
    if (images?.length) notify(ask.trim() ? "Your words were sent. Photos don't reach your computer from the phone yet." : "Photos don't reach your computer from the phone yet.");
    return ask.trim() ? startLive({ text: ask, repo: with_.repo, device: with_.device, engine: with_.engine, model: with_.model, effort: with_.effort, speed: with_.speed, picked: with_.picked }) : "";
  }
  const id = chatId();
  const title = !ask.trim() && images?.length ? pictured(images) : titleFrom(ask);
  const now = Date.now();
  const sent: Item = { kind: "you", id: itemId(), text: ask, at: now, state: "sending", ...withImages(images) };
  go({
    type: "add",
    chat: {
      id,
      title,
      repo: with_.repo,
      chief: with_.chief ?? null,
      device: with_.device ?? THIS_MAC,
      engine: with_.engine,
      model: with_.model,
      effort: with_.effort,
      speed: with_.speed,
      ...(with_.access ? { access: with_.access } : null),
      phase: "working",
      line: "Thinking",
      startedAt: now,
      updatedAt: now,
      items: [sent, { kind: "work", id: itemId(), steps: [], startedAt: now }],
    },
  });
  later(150, () => go({ type: "ack", id, item: sent.id }));
  play(id, taskPlan({ id, repo: with_.repo, title, chief: with_.chief ?? null }, ask));
  return id;
}

/** A new turn on a chat that was resting (or the next queued follow-up). */
function followUp(chat: Chat, text: string, images?: readonly SentImage[]) {
  yourMessage(chat.id, text, false, images);
  go({ type: "moment", id: null });
  update(chat.id, { phase: "working", line: "Thinking", startedAt: Date.now() });
  go({ type: "work", id: chat.id, steps: [], open: true });
  play(chat.id, taskPlan(chat, text));
}

/**
 * A message about a chat, from its thread or from the moment in front of you. A busy chat takes it as steering; a
 * finished one picks back up; a ready one reads it as a verdict (ship it, change it, later). `followup` always starts
 * a new turn, as a queued message does when its turn comes. `fix`: you tried what it built and it isn't right (Ready to
 * try's Not right), so whatever the words say, it goes back to work on them and brings it back to try again. `images`:
 * the pictures that went with the words; on a ready chat pictures read as something to change, never a ship, unless the
 * words say ship.
 */
export function send(id: string, text: string, kind?: "steer" | "followup" | "fix", images?: readonly SentImage[]) {
  const runtime = reach(id);
  if (runtime === "away") return away(id, text);
  if (runtime) {
    if (images?.length) notify(text.trim() ? "Your words were sent. Photos don't reach your computer from the phone yet." : "Photos don't reach your computer from the phone yet.");
    if (text.trim()) runtime.send(id, text, kind === "fix" ? "followup" : kind);
    return;
  }
  const chat = chatOf(id);
  if (!chat) return;
  if (kind === "followup" || chat.phase === "done") return followUp(chat, text, images);
  yourMessage(id, text, chat.phase === "working", images);
  go({ type: "moment", id: null });

  if (chat.phase === "working" || chat.phase === "needs") {
    // Just after a no, the no's own "Okay, I won't run it" is the one acknowledgement; a steer then gets no second.
    if (Date.now() - (deniedAt.get(id) ?? 0) < DENY_ACK_MS) return;
    later(700, () => words(id, "Got it. I'll fold that in before I come back to you.", "commentary"));
    return;
  }
  // Pictures show what to change: with them, only words that say so ship it or leave it for later.
  const said = intentOf(text);
  const intent = kind === "fix" ? "tweak" : images?.length && said === "ship" && !/\b(ship|merge|lgtm|looks good)\b/i.test(text) ? "tweak" : said;
  if (intent === "later") {
    later(500, () => words(id, "Okay. It waits for you on the board."));
    return;
  }
  if (intent === "tweak") {
    go({ type: "work", id, steps: [{ tool: "read", text: "Read your note" }], open: true });
    const runs = chat.moment?.preview === "runs";
    // A page it has open in its browser gets checked there again.
    update(id, { phase: "working", line: "Reading your note", script: runs ? ["Darkening the page", "vitest runs  8/8 passed", "Taking screenshots"] : ["Fixing what you said", "Running the tests", "Taking screenshots"], step: -1, ...(chat.screens?.browser ? { using: "browser" as const } : null) });
    say(chiefOf(chat), "chief", `Back on [[${id}]]. I'll bring it back when it's done.`);
    // Something to try comes back as something to try again, the same preview on the fixed build (a board from before
    // moments carried one has the scripted world's, by branch).
    const preview = chat.moment ? (chat.moment.preview ?? PREVIEWS[chat.moment.branch]) : undefined;
    const next: Moment = runs
      ? DARKER_MOMENT
      : chat.moment && preview
        ? { ...chat.moment, preview, headline: `${chat.title} is ready to try again`, summary: "Fixed what you said, and the tests still pass. Try it again." }
        : { ...momentFor(chat.title), ...(chat.moment ? { branch: chat.moment.branch } : null), summary: "Changed it the way you said. The tests still pass." };
    play(id, tweakPlan(chat, next));
    return;
  }
  // The number its pull request already has (Review's), so "Merged #491" names the pull request the guide showed.
  const number = prNumberFor(chat) ?? board().pr;
  go({ type: "pr" });
  // Its pull request is open already (Review shows it): shipping merges it, never opens another.
  go({ type: "work", id, steps: [{ tool: "run", text: `Queued #${number} to merge`, detail: `${chat.moment?.branch ?? "branch"} → main` }], open: true });
  update(id, { phase: "working", line: `Merging #${number}`, script: ["CI  2 of 5 checks", "CI  4 of 5 checks", "CI  5 of 5 green"], step: -1 });
  say(chiefOf(chat), "chief", `[[${id}]] is shipping. I'll tell you when CI is green.`);
  play(id, shipPlan(chat, number));
}

/** What you answered an ask with: Allow, Deny (and what to do instead), one of its options, or words of your own. */
export type Reply = { kind: "allow" } | { kind: "deny"; instead?: string } | { kind: "option"; option: AskOption } | { kind: "told"; text: string };

/** When each chat last heard a no, and how long a steer after it shares the no's acknowledgement. */
const deniedAt = new Map<string, number>();
const DENY_ACK_MS = 10_000;

/** A plan whose first step waits `hold` and lands `first`, then plays `then`'s steps. */
const after = (hold: number, first: BoardAction[], then: NonNullable<Chat["plan"]>): NonNullable<Chat["plan"]> => ({ next: 0, steps: [{ ms: Math.max(0, hold), actions: first }, ...then.steps] });

/**
 * An answer to what a chat asks (Session Protocol `ask.respond`). It shows on the board at once: the ask is answered
 * (an approval keeps "Allowed …" in the transcript; a question's answer lands as your message), and the chat is at work
 * again, so it leaves every list of asks, the deck and the dock in the same moment. The engine hears it `hold` ms later
 * (the Chief remarks on it then, and the turn goes on), so `takeBack` inside that time leaves no trace. Returns the chat
 * as it was when it asked, for `takeBack`, or null when it doesn't ask (answered elsewhere already).
 *
 * An approval hears Allow or Deny, and words of your own as a no with what to do instead; a question hears one of its
 * options or your words, and Allow takes the one it recommends.
 */
export function respond(id: string, reply: Reply, hold = 0): Chat | null {
  const asked = chatOf(id);
  const need = asked ? needOf(asked) : null;
  if (!asked || !need) return null;
  // A computer's chat: the board shows the answer now, as below, and its runtime hears it once `hold` has passed. What
  // the engine does with it then comes from its own events, not from a plan.
  const runtime = reach(id);
  // Nothing holds it right now: the ask stays as it is, to answer once it is back.
  if (runtime === "away") return null;
  cancel(id);
  const then = (plan: NonNullable<Chat["plan"]>) => {
    if (!runtime) return play(id, plan);
    unheard.set(
      id,
      setTimeout(() => {
        unheard.delete(id);
        void runtime.respond(id, reply);
      }, Math.max(0, hold)),
    );
  };
  const chief = chiefOf(asked);
  const engine = ENGINE_NAME[asked.engine];
  // Its place cannot hear it right now (it sleeps, and Caveman keeps the answer for it): the ask says the answer
  // waits, never that it was given, and nothing reads as at work.
  const queued = runtime ? runtime.holds(id, need.kind === "approval" ? (reply.kind === "allow" ? "allow" : "deny") : "answer") : null;
  const waiting = queued ? { phase: "working" as const, line: queued, wait: { words: queued, since: Date.now() } } : null;
  if (need.kind === "approval" && waiting) {
    const items = asked.items.map((i) => (i.kind === "ask" && !i.answer ? { ...i, pending: waiting.line } : i));
    go({ type: "update", id, patch: { items, ...waiting }, clear: ["ask", "need", "script", "step"] });
    then({ next: 0, steps: [] });
    return asked;
  }
  if (need.kind === "approval") {
    const yes = reply.kind === "allow";
    const instead = reply.kind === "deny" ? reply.instead : reply.kind === "told" ? reply.text : reply.kind === "option" ? reply.option.label : undefined;
    const command = need.command;
    go({ type: "answer", id, answer: yes ? "allowed" : "denied" });
    if (instead) go({ type: "append", id, items: [{ kind: "you", id: itemId(), text: instead, at: Date.now(), steer: true, state: "sent" }] });
    go({ type: "work", id, steps: [], open: true });
    go({ type: "update", id, patch: { phase: "working", line: yes ? command : "Looking for another way" }, clear: ["ask", "need", "script", "step"] });
    if (yes) {
      const lines = id === "migration" ? ["Applying 0042_usage_daily", "Backfilling 3 tables", "Checking row counts"] : [command, "Reading the output", "Picking up where it left off"];
      then(after(hold, [{ type: "update", id, patch: { script: lines, step: -1 } }, { type: "say", chief, who: "chief", text: id === "migration" ? "Allowed. The migration is running on staging." : `Allowed. [[${id}]] is running it.` }], allowedPlan(asked, command)));
    } else {
      deniedAt.set(id, Date.now());
      then(after(hold, [{ type: "update", id, patch: { script: ["Reading the plan again", "Looking for another way"], step: -1 } }, { type: "say", chief, who: "chief", text: `Denied. ${engine} will look for a way without it.` }], deniedPlan(asked, !!instead)));
    }
    return asked;
  }
  // Direction: the option taken, or your own words; a bare yes takes the way it would go itself, a bare no says leave it.
  const recommended = need.options.find((o) => o.recommended) ?? need.options[0];
  const told =
    reply.kind === "option" ? reply.option.label : reply.kind === "told" ? reply.text : reply.kind === "deny" ? (reply.instead ?? "Neither. Leave it as it is for now.") : (recommended?.label ?? "Go ahead");
  // The question gives way to your answer, said as your message: it asked, you answered, and the work goes on from
  // there as a turn of its own, so its question stays in view above it.
  const items = asked.items.filter((i) => !(i.kind === "ask" && !i.answer));
  go({ type: "update", id, patch: { items: [...items, { kind: "you", id: itemId(), text: told, at: Date.now(), state: "sent" }], phase: "working", line: "Reading your answer", startedAt: Date.now(), ...waiting }, clear: ["ask", "need", "script", "step"] });
  if (!waiting) go({ type: "work", id, steps: [], open: true });
  const picked = need.options.some((o) => o.label === told);
  const remark = picked ? `[[${id}]] is going with “${told}”.` : `Passed your note to [[${id}]]. It's on it.`;
  then(after(hold, [{ type: "say", chief, who: "chief", text: remark }], directedPlan(asked, need.options, told)));
  return asked;
}

/**
 * An answer taken back before the engine heard it: what it was going to do won't happen, and the chat is as it was
 * when it asked (its ask, its transcript, its line), so it is back in every list in its old place.
 */
export function takeBack(asked: Chat) {
  const now = chatOf(asked.id);
  if (!now) return;
  cancel(asked.id);
  // A computer's runtime had not heard it yet, and now never does.
  clearTimeout(unheard.get(asked.id));
  unheard.delete(asked.id);
  runtimeOf(asked.id)?.holds(asked.id, null);
  deniedAt.delete(asked.id);
  const clear = (Object.keys(now) as (keyof Chat)[]).filter((key) => !(key in asked));
  go({ type: "update", id: asked.id, patch: asked, clear });
}

/** Yes to what a chat asks, heard at once. */
export const allow = (id: string) => void respond(id, { kind: "allow" });

/**
 * No to what a chat asked. `instead`: what you told it to do in its place ("Tell it what to do instead"), which lands as
 * your steer under the no and gets the one answer, not a second "Got it" after the first. A question hears it as your
 * answer.
 */
export const deny = (id: string, instead?: string) => void respond(id, { kind: "deny", instead });

/** Direction for a chat that asked for it: one of its options, or words of your own. It goes on that way. */
export function answer(id: string, with_: AskOption | string, hold = 0) {
  return respond(id, typeof with_ === "string" ? { kind: "told", text: with_ } : { kind: "option", option: with_ }, hold);
}

/**
 * Sends a message that was not sent again (Session Protocol: the same `turn.submit`, anew), in the place it stands in
 * the chat. Only a real computer's chat has one: the script never refuses a message.
 */
export function resend(id: string, item: string) {
  const runtime = reach(id);
  if (runtime && runtime !== "away") runtime.resend(id, item);
}

/** You stopped the turn: what it was about to do won't happen, and the chat rests with a stop line. */
export function stop(id: string) {
  const chat = chatOf(id);
  if (!chat || (chat.phase !== "working" && chat.phase !== "needs")) return;
  const runtime = reach(id);
  if (runtime === "away") {
    // Still being started: Stop takes it back before its computer has made it, and its words go back to the box.
    if (isStarting(id) && !didNotStart(chat)) {
      const first = chat.items[0];
      if (first?.kind === "you" && !getDraft(NEW_CHAT).trim()) setDraft(NEW_CHAT, first.text);
      go({ type: "remove", id });
    }
    return;
  }
  if (runtime) return runtime.stop(id);
  cancel(id);
  go({ type: "stop", id });
  if (board().momentId === id) go({ type: "moment", id: null });
}

/**
 * A Chief's board as a roll call, one chat a line ("- [[id]]"): what needs you, what's running, what's ready, in that
 * order. The Chief's screen counts it in one plain sentence over the rows ("One needs you, three are running."), from
 * the same status every count reads (chief/turns.ts tallyOf), instead of a paragraph of chat names.
 */
function rollCall(chiefId: string): string[] {
  const chats = board().chats;
  const archived = store.get().inbox.archived;
  const mine = chats.filter((c) => !c.parent && !archived[c.id] && chiefOf(c) === chiefId);
  return (["needs", "working", "ready"] as const).flatMap((p) => mine.filter((c) => phaseOf(c, chats) === p).map((c) => `- [[${c.id}]]`));
}

/**
 * A note to a Chief. It answers what it can from its board, brings up what you ask to see (on a call), ships what
 * it's showing when you say so, and starts a chat for anything that's work. While it works its thought bubble says
 * what it's doing.
 */
export function tellChief(chiefId: string, text: string, with_: Start, images?: readonly SentImage[]) {
  const chief = chiefById(chiefId);
  const mine = () => board().chats.filter((c) => !c.parent && chiefOf(c) === chief.id);
  say(chief.id, "you", text, images);
  later(250, () => think(chief.id, "Reading the board"));

  if (/\b(what needs me|needs me|status|how's|how is|what's left|sum up|summary)\b/i.test(text)) {
    later(1500, () => {
      think(chief.id, null);
      const rows = rollCall(chief.id);
      say(chief.id, "chief", rows.length ? rows.join("\n") : "Nothing needs you. All quiet.");
    });
    return;
  }
  if (/\b(show me|let me see|see it|pull it up)\b/i.test(text)) {
    later(1300, () => {
      think(chief.id, null);
      // Something you can play with beats a list of changes.
      const ready = mine()
        .filter((c) => c.phase === "ready")
        .sort((a, b) => Number(!!b.moment?.preview) - Number(!!a.moment?.preview))[0];
      if (!ready) {
        say(chief.id, "chief", "Nothing's ready to look at yet. I'll bring it up when it is.");
        return;
      }
      go({ type: "show", showing: { chief: chief.id, id: ready.id } });
      say(chief.id, "chief", `Here's [[${ready.id}]]. ${ready.moment?.changes[0] ?? "Have a look"}.`);
    });
    return;
  }
  if (/\b(ship it|merge it|send it|looks great)\b/i.test(text)) {
    const showing = board().showing;
    const target = showing?.chief === chief.id ? showing.id : mine().find((c) => c.phase === "ready")?.id;
    later(900, () => {
      think(chief.id, null);
      go({ type: "show", showing: null });
      // A ship it said again while it thought may have shipped the chat already; a busy chat would take this as steering.
      const now = target ? chatOf(target) : undefined;
      if (!target) say(chief.id, "chief", "There's nothing ready to ship yet.");
      else if (now?.phase === "ready") send(target, text);
      else if (now?.phase === "working") say(chief.id, "chief", `[[${target}]] is already under way.`);
    });
    return;
  }
  const repo = chief.projects && !chief.projects.includes(with_.repo) ? (chief.projects[0] ?? with_.repo) : with_.repo;
  // Pictures with no words start a chat about them, the pictures going with it.
  const about = text || (images?.length ? (images.length === 1 ? "A photo" : `${images.length} photos`) : "");
  later(1200, () => think(chief.id, `Starting “${titleFrom(about)}” on ${ENGINE_NAME[with_.engine]}`));
  later(2600, () => {
    // Its chats start on the Permissions its box picked, else what new chats get.
    const id = start(text, { ...with_, repo, chief: chief.id, access: sessionOf(chiefScope(chief.id))?.access ?? with_.access }, images);
    think(chief.id, null);
    say(chief.id, "chief", `On it. [[${id}]] is going on ${ENGINE_NAME[with_.engine]}. I'll grab you if it needs anything.`);
  });
}

/**
 * A Chief made with New Chief: it joins the board after the others and opens with one line saying what it watches and
 * what waits on you there, from the same status every count reads. Returns its id.
 */
export function addChief(made: { name: string; character: Chief["character"]; tone: Chief["tone"]; projects: readonly string[] | null }): string {
  const base = made.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chief";
  const taken = new Set(CHIEFS.map((c) => c.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  go({ type: "chief/add", chief: { id, name: made.name.trim(), character: made.character, tone: made.tone, projects: made.projects } });
  // A new Chief has started nothing yet: what waits on you is what waits in the workspaces it watches.
  const chats = board().chats;
  const archived = store.get().inbox.archived;
  const watched = (c: Chat) => !c.parent && !archived[c.id] && (made.projects === null || made.projects.includes(c.repo));
  const asking = chats.filter((c) => watched(c) && phaseOf(c, chats) === "needs").length;
  const where = made.projects === null ? "every workspace" : made.projects.length === 1 ? made.projects[0]! : `${made.projects.slice(0, -1).join(", ")} and ${made.projects.at(-1)}`;
  say(id, "chief", `I'm watching ${where}. ${asking ? `${asking === 1 ? "One thing waits" : `${asking} things wait`} on you there.` : "Nothing needs you."}`);
  return id;
}

/** Where a call ended, as a quiet line in the Chief's chat. */
export function endCall(chiefId: string, seconds: number) {
  go({ type: "show", showing: null });
  think(chiefId, null);
  say(chiefId, "call", `Call · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
}

export const pin = (id: string, pinned: boolean) => update(id, { pinned });
/** A pick in a chat's own composer settings: what it may do without asking, from its next turn. */
export const setAccess = (id: string, access: Access) => update(id, { access });
/** The board lets a chat go (after Archive's Undo is out of reach). */
export function archive(id: string) {
  cancel(id);
  go({ type: "remove", id });
}
/**
 * A pick in a chat's own picker: its next turn's harness, model, effort and speed together. A real computer's chat
 * takes it with its next message (live/source.ts choose).
 */
export function setModel(id: string, next: { engine: Engine; model: string; effort: Effort; speed?: string }) {
  update(id, next);
  runtimeOf(id)?.choose(id, next);
}
export const dismissMoment = () => go({ type: "moment", id: null });
export const showMoment = (id: string) => go({ type: "moment", id });

// ---------------------------------------------------------------- running it

/** A greeting that fits the clock ("Morning." before noon), or none at all after the evening's begun. */
function hello(at = new Date()): string | null {
  const h = at.getHours();
  return h >= 5 && h < 12 ? "Morning." : h >= 12 && h < 18 ? "Afternoon." : null;
}

/** The first launch's greetings, once. */
function greet() {
  if (board().greeted) return;
  // A roll call each: one counting sentence and its chats as rows, never a paragraph of names. The greeting is the
  // clock's ("Morning." at 9, "Afternoon." at 4:46 PM, none in the evening), never a morning at teatime.
  const morning = (chief: string) => [hello(), ...rollCall(chief)].filter(Boolean).join("\n");
  later(700, () => say("home", "chief", morning("home")));
  later(1100, () => say("oona", "chief", morning("oona")));
  later(1500, () => {
    say("grug", "chief", morning("grug"));
    go({ type: "greeted" });
  });
}

const settled = (c: Chat) => c.phase === "ready" || c.phase === "done";
/** A queued follow-up goes this long after the answer before it settled: the fold (240), the beat and fade of what closes the turn (120 + 200), then 600. */
const QUEUE_AFTER_SETTLE_MS = 240 + 120 + 200 + 600;

/** What follows a turn ending: the next queued follow-up goes, and a parent whose subagents have all finished gathers. */
function onChange(next: readonly Chat[], prev: readonly Chat[]) {
  const was = new Map(prev.map((c) => [c.id, c.phase]));
  for (const chat of next) {
    const before = was.get(chat.id);
    // Only a turn ending counts: working or asking before, ready or done now.
    if (before === undefined || before === "ready" || before === "done" || !settled(chat)) continue;
    // A turn you stopped keeps its queue: you stopped it for a reason.
    if (queueOf(chat.id).length && chat.items.at(-1)?.kind !== "stop") {
      // Not while its answer is still pacing in: once it has settled on screen, folded (240ms), and its Changes pill
      // and action row have come in, and a beat after that (thread/settle.ts), so nothing arrives under the answer
      // you are reading.
      const sendNext = () => {
        const now = chatOf(chat.id);
        if (!now || !settled(now)) return;
        if (!settledNow(now, QUEUE_AFTER_SETTLE_MS)) return later(100, sendNext);
        const queued = shiftQueue(chat.id);
        if (queued) followUp(now, queued.text, queued.images);
      };
      later(800, sendNext);
    }
    if (chat.parent) gatherIfDone(chat.parent);
  }
}

/** A parent waiting on subagents brings their work together once every one of them has finished. */
function gatherIfDone(parentId: string) {
  const chats = board().chats;
  const parent = chats.find((c) => c.id === parentId);
  if (!parent || parent.phase !== "working" || parent.plan) return;
  const spawned = parent.items.flatMap((i) => (i.kind === "agents" ? i.children : []));
  const children = chats.filter((c) => spawned.includes(c.id));
  if (!children.length || !children.every(settled)) return;
  later(600, () => play(parentId, gatherPlan(parent, children.length, parentId === "audit" ? AUDIT_MOMENT : momentFor(parent.title))));
}

/** Starts the script, once for the app: the live lines, the morning, every turn in flight. Calling it again does nothing. */
export function ensureScript() {
  // A board that is a computer's own is that computer's to change.
  if (ticker || isLive()) return;
  ticker = setInterval(() => go({ type: "advance" }), 2400);
  unwatch = store.watch((next, prev) => {
    if (next.board.chats !== prev.board.chats) onChange(next.board.chats, prev.board.chats);
  });
  greet();
  for (const chat of board().chats) {
    if (chat.plan) resume(chat.id);
    // Left working with nothing to play and no live line to loop (its turn's timers died with the last launch): give
    // it a turn to finish. A parent waiting on its subagents waits on.
    else if (chat.phase === "working" && !chat.script?.length) play(chat.id, taskPlan(chat, chat.items.findLast((i): i is Extract<Item, { kind: "you" }> => i.kind === "you")?.text ?? chat.title));
  }
  // A parent whose subagents all finished while the app was closed gathers now.
  for (const chat of board().chats) if (chat.items.some((i) => i.kind === "agents")) gatherIfDone(chat.id);
  // A queued follow-up whose turn ended while the app was closed goes now.
  for (const chat of board().chats) {
    if (settled(chat) && queueOf(chat.id).length && chat.items.at(-1)?.kind !== "stop") {
      later(1200, () => {
        const queued = shiftQueue(chat.id);
        const now = chatOf(chat.id);
        if (queued && now) followUp(now, queued.text, queued.images);
      });
    }
  }
}

/** Starts the demo morning again: everything on disk forgotten, the scripted world back, the script from the top. */
export function resetDemo() {
  stopAll();
  // A board that was the person's own is let go first: its connections end, and it goes with everything else on disk.
  leave();
  resetStore();
  ensureScript();
}

// A hot reload of this file would leave the old ticker running beside the new one.
const g = globalThis as { __ccScriptStop?: () => void };
g.__ccScriptStop?.();
g.__ccScriptStop = stopAll;
