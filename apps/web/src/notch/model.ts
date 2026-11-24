// What the notch shows (docs/): the island at the top of the screen that marks the chats at work
// and opens by itself when one needs the person. The main window works this out from the chats it already has and hands
// it to the desktop shell (state/notch.ts), which shows it in the notch's own page (notch/Notch.tsx). Everything here
// is plain data: it crosses two process boundaries.

import { inboxSection } from "../state/inbox-state.ts";
import {
  CHAT_STATUS_ORDER,
  hasWorkToLand,
  type ChatStatus,
  type ChatStatusId,
  type WorkspaceView,
} from "../state/model.ts";
import type { MascotSheet } from "@caveman-app/ui/mascot/sprites";
import type { SessionView, TranscriptItem } from "../state/transcript-model.ts";

/** A chat the notch marks: the right ear's mark and count are drawn from these. */
export interface NotchAgent {
  readonly id: string;
  readonly title: string;
  readonly status: ChatStatus;
}

/** A card's key: `lit` is its one white key. */
export interface NotchKey {
  readonly id: string;
  readonly label: string;
  readonly tone: "lit" | "card";
}

/** The chat that waits on the person, with what they need to decide: what it asks or said, what it built, the keys. */
export interface NotchCard {
  readonly id: string;
  readonly title: string;
  readonly status: ChatStatus;
  /** What it asks, or the first line of what it said when it finished. */
  readonly line: string | null;
  /** An approval: what Allow lets run, exactly as it would run. */
  readonly command: string | null;
  /** What it built, as a picture the notch can draw itself: a data: or https: address. */
  readonly image: string | null;
  readonly keys: ReadonlyArray<NotchKey>;
  /**
   * The ask it shows, as its token (askToken), null when it shows none: a card the person paged to keeps taking a
   * press while this stays the same, and rearms when another ask takes its place.
   */
  readonly ask: string | null;
  /**
   * The last press on this chat did not go through: what went wrong, said on the card until the next press. `n` counts
   * the failures, so the same failure twice is two: each brings the card back.
   */
  readonly trouble: { readonly text: string; readonly n: number } | null;
  /** Its place among the chats that wait, and its neighbours there: the card's arrows show them. */
  readonly index: number;
  readonly count: number;
  readonly prev: string | null;
  readonly next: string | null;
}

export interface NotchState {
  readonly agents: ReadonlyArray<NotchAgent>;
  readonly card: NotchCard | null;
  /**
   * The waits the person is not already looking at, each as its waitKey, the newest first: the notch opens when one
   * appears that was not here before, never because another went.
   */
  readonly unseen: ReadonlyArray<string>;
  /**
   * The companion the person made, when that is their pick: its drawing, which only the main window can read (the
   * runtime's companions folder). The notch's page knows the pick itself; without this it would draw nobody.
   */
  readonly made?: {
    readonly id: string;
    readonly body: Readonly<Record<string, MascotSheet>>;
  } | null;
}

const ASKS: ReadonlySet<ChatStatusId> = new Set(["approve", "secret", "answer"]);
/**
 * It waits on the person: it asks, a plan waits to be built, or its turn ended (or failed) and nobody has looked. Not a
 * turn that was stopped: whoever stopped it knows.
 */
const WAITS: ReadonlySet<ChatStatusId> = new Set([
  "approve",
  "secret",
  "answer",
  "ready",
  "failed",
  "done",
]);
/** At work, or on its way to it. */
const WORKS: ReadonlySet<ChatStatusId> = new Set(["working", "agents", "queued", "waking"]);
/**
 * How long a turn that ended (finished, stopped, failed, or a plan to build) stays on the notch: past this it is old
 * news and only the queue keeps it. An ask stays while it waits: its agent is held until the person answers.
 */
export const NOTCH_FRESH_MS = 2 * 3_600_000;

export interface NotchChat {
  readonly workspace: WorkspaceView;
  readonly status: ChatStatus;
}

export interface NotchChats {
  /** Every chat the notch marks: those that wait first, then those at work, each in a steady order. */
  readonly marked: ReadonlyArray<NotchChat>;
  /** Those that wait on the person, in the order the card's arrows go: asks first, then each kind newest first. */
  readonly waiting: ReadonlyArray<NotchChat>;
}

/**
 * When it came to wait: an ask when it came (its status change moved updated_at), anything else when its turn ended.
 * Not updated_at for those: a rename moves it. A chat that ended before the runtime stamped the end has only that.
 */
export const waitedSince = (c: NotchChat): string =>
  (!ASKS.has(c.status.id) && c.workspace.activity?.turnEndedAt) || c.workspace.updatedAt;

/** A chat's key while it waits: it changes when the chat comes to wait again, and only then. */
export const waitKey = (c: NotchChat): string => `${c.workspace.id}:${waitedSince(c)}`;

/**
 * The chats the notch marks, by the queue's rules (state/inbox-state.ts queueSections): never an archived, snoozed
 * or done one, or an automation's step. An agent's agent (a lead's delegate, a chat an outside agent started) reports
 * to the agent that started it, not to the person: it is marked only while it asks the person something, whether or
 * not its lead is listed here. A failed turn counts until somebody has looked at it. A turn that ended counts for
 * NOTCH_FRESH_MS after it did.
 */
export function notchChats(
  workspaces: ReadonlyArray<WorkspaceView>,
  statuses: ReadonlyMap<string, ChatStatus | null>,
  now = Date.now(),
): NotchChats {
  const live = workspaces.filter((w) => w.state !== "archived" && w.automationStep !== true);
  const marked: NotchChat[] = [];
  for (const w of live) {
    const status = statuses.get(w.id) ?? null;
    if (!status) continue;
    if ((w.parentId !== null || w.startedBy !== undefined) && !ASKS.has(status.id)) continue;
    const section = inboxSection(w, now);
    if (section === "snoozed" || section === "done") continue;
    const chat = { workspace: w, status };
    const fresh = ASKS.has(status.id) || now - Date.parse(waitedSince(chat)) < NOTCH_FRESH_MS;
    const waits = WAITS.has(status.id) && fresh && (status.id !== "failed" || w.unread);
    if (waits || WORKS.has(status.id)) marked.push(chat);
  }
  const rank = (c: NotchChat) => CHAT_STATUS_ORDER.indexOf(c.status.id);
  // A working chat keeps its place from the turn's start, so marks never reshuffle as events land.
  const since = (c: NotchChat) =>
    WORKS.has(c.status.id)
      ? (c.workspace.activity?.turnStartedAt ?? c.workspace.createdAt)
      : waitedSince(c);
  marked.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      since(a).localeCompare(since(b)) ||
      a.workspace.id.localeCompare(b.workspace.id),
  );
  const waiting = marked
    .filter((c) => WAITS.has(c.status.id))
    .sort(
      (a, b) =>
        Number(ASKS.has(b.status.id)) - Number(ASKS.has(a.status.id)) ||
        waitedSince(b).localeCompare(waitedSince(a)) ||
        a.workspace.id.localeCompare(b.workspace.id),
    );
  return { marked, waiting };
}

/**
 * The waits the person has not been looking at, the one that came last first: `seen` holds the keys (waitKey) of the
 * waits that were on screen in the app, in front.
 */
export function unseenWaits(
  waiting: ReadonlyArray<NotchChat>,
  seen: ReadonlySet<string>,
): string[] {
  return waiting
    .filter((c) => !seen.has(waitKey(c)))
    .sort(
      (a, b) =>
        waitedSince(b).localeCompare(waitedSince(a)) ||
        a.workspace.id.localeCompare(b.workspace.id),
    )
    .map(waitKey);
}

/**
 * A wait counts as come only once it has held this long: a turn that ends as a queued message starts, or a status that
 * flickers while the runtime catches up, never opens the notch or takes its card.
 */
export const SETTLE_MS = 3_000;

/** When each wait was first seen (`since`), with those that went forgotten. The same map when nothing changed. */
export function sightings(
  since: ReadonlyMap<string, number>,
  keys: ReadonlyArray<string>,
  now: number,
): ReadonlyMap<string, number> {
  const next = new Map(keys.map((key) => [key, since.get(key) ?? now]));
  return next.size === since.size && keys.every((key) => since.has(key)) ? since : next;
}

/** The waits that have held SETTLE_MS by `now`, in their order. */
export const settledWaits = (
  keys: ReadonlyArray<string>,
  since: ReadonlyMap<string, number>,
  now: number,
): string[] => keys.filter((key) => now - (since.get(key) ?? now) >= SETTLE_MS);

/**
 * The chats as the notch shows them while some waits have not held yet (`unsettled`, their waitKeys). Such a chat stays
 * what it just was, at work (a wait comes when a turn ends, or as an ask in the middle of one): it takes no card and
 * its mark does not change until the wait has held, so a status that flickers moves nothing.
 */
export function heldChats(chats: NotchChats, unsettled: ReadonlySet<string>): NotchChats {
  if (unsettled.size === 0) return chats;
  const pending = (c: NotchChat) => WAITS.has(c.status.id) && unsettled.has(waitKey(c));
  const rank = (c: NotchChat) => CHAT_STATUS_ORDER.indexOf(c.status.id);
  const marked = chats.marked
    .map((c) =>
      pending(c)
        ? {
            ...c,
            status: { ...c.status, id: "working" as const, label: "Working", action: false },
          }
        : c,
    )
    .sort((a, b) => rank(a) - rank(b));
  return { marked, waiting: chats.waiting.filter((c) => !pending(c)) };
}

/**
 * The chat the card shows, with its place among those that wait: `pick` while it still waits (the chat the notch last
 * opened for, or the one the person paged to with the card's arrows), else the first. Null when none waits.
 */
export function cardChat(
  waiting: ReadonlyArray<NotchChat>,
  pick: string | null,
): {
  readonly chat: NotchChat;
  readonly index: number;
  readonly prev: string | null;
  readonly next: string | null;
} | null {
  if (waiting.length === 0) return null;
  const index = Math.max(
    0,
    waiting.findIndex((c) => c.workspace.id === pick),
  );
  return {
    chat: waiting[index]!,
    index,
    prev: waiting[index - 1]?.workspace.id ?? null,
    next: waiting[index + 1]?.workspace.id ?? null,
  };
}

/**
 * The waits the person has had in front of them: `seen`, less those that no longer wait, plus those on screen now
 * (`onScreen`: the chats open in the app while it is in front; null while it is not). The same set when nothing changed.
 */
export function seenWaits(
  seen: ReadonlySet<string>,
  waiting: ReadonlyArray<NotchChat>,
  onScreen: ReadonlyArray<string> | null,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const c of waiting)
    if (seen.has(waitKey(c)) || onScreen?.includes(c.workspace.id)) next.add(waitKey(c));
  return next.size === seen.size && [...next].every((k) => seen.has(k)) ? seen : next;
}

type Ask = NonNullable<SessionView["pendingAsk"]>;

export const OPEN_KEY = "open";
export const SHIP_KEY = "ship";
export const SEEN_KEY = "seen";
export const LATER_KEY = "later";
/** Later snoozes the chat this long: off the notch and the queue, back after. */
export const LATER_MS = 3_600_000;
const ASK_KEY = "ask";
/** The message Ship it sends: the chat lands its own work, by a pull request. */
export const SHIP_TEXT = "Ship it.";
/** An approval's own options, as many as fit one row. */
const MAX_KEYS = 3;

/**
 * An ask's id as a key carries it: a short token, since an engine's ask id runs to hundreds of characters (Claude
 * Agent's names its whole turn) and a key crosses the desktop shell, which takes short strings only. The app answers a
 * press only while the ask it shows still has this token, so a key never answers the ask that came after.
 */
const TOKEN = /^[0-9a-z]{1,8}$/;

export function askToken(askId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < askId.length; i++) h = Math.imul(h ^ askId.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * What a pressed key does: answer the ask (an approval or a question, named by its token) with one of its options
 * (named by its own token: an engine's option id may be long or hold any character, and a key crosses the desktop
 * shell as a short string), tell the chat to ship, mark it read, snooze it, or open it.
 */
export type NotchPress =
  | { readonly do: "answer"; readonly ask: string; readonly option: string }
  | { readonly do: "ship" }
  | { readonly do: "seen" }
  | { readonly do: "later" }
  | { readonly do: "open" };

export function pressOf(key: string): NotchPress {
  if (key === SHIP_KEY) return { do: "ship" };
  if (key === SEEN_KEY) return { do: "seen" };
  if (key === LATER_KEY) return { do: "later" };
  // Tokens never hold a tab.
  const [kind, ask, option, ...rest] = key.split("\t");
  if (kind === ASK_KEY && ask && option && TOKEN.test(option) && rest.length === 0)
    return { do: "answer", ask, option };
  return { do: "open" };
}

/**
 * Each chat's latest press. `press(chat)` numbers a press and returns whether it is still that chat's latest: a
 * failure that comes back for a press the person has since pressed again (a retry in flight, or done) is no news.
 * Presses on other chats do not make it stale.
 */
export function pressLedger(): { press(chat: string): () => boolean } {
  let count = 0;
  const latest = new Map<string, number>();
  return {
    press(chat) {
      count += 1;
      const mine = count;
      latest.set(chat, mine);
      return () => latest.get(chat) === mine;
    },
  };
}

/** What ask.respond carries for a key the notch drew. */
export type NotchAnswer =
  | { readonly kind: "approval"; readonly option_id: string }
  | {
      readonly kind: "question";
      readonly answers: ReadonlyArray<{
        readonly question_id: string;
        readonly option_ids: ReadonlyArray<string>;
      }>;
    };

/**
 * The answer a pressed key gives `ask`: the very option the key showed, by its own id exactly as the engine gave it
 * (wherever it stands in the list now), as the chat's own card would send it (Transcript.tsx `reply`). Null when the
 * key was drawn for another ask (it changed, or was answered elsewhere), names no single option of it, or the notch
 * does not answer this kind of ask.
 */
export function answerOf(
  ask: Ask,
  press: { readonly ask: string; readonly option: string },
): NotchAnswer | null {
  if (askToken(ask.id) !== press.ask) return null;
  const named = ask.options.filter((o) => askToken(o.id) === press.option);
  const option = named.length === 1 ? named[0] : undefined;
  if (!option) return null;
  if (ask.askKind === "approval")
    return ask.options.length <= MAX_KEYS ? { kind: "approval", option_id: option.id } : null;
  const question = pickQuestion(ask);
  return question
    ? {
        kind: "question",
        answers: [
          { question_id: question.questions[0]?.id ?? question.id, option_ids: [option.id] },
        ],
      }
    : null;
}

/**
 * A question the notch can answer in place: one question, one pick from at most three options, not a grill round.
 * Anything wider (several questions, several picks, free text only, a round) is answered in the chat.
 */
export function pickQuestion(ask: Ask | null): Ask | null {
  if (ask?.askKind !== "question" || ask.round !== null) return null;
  const [question, ...more] = ask.questions;
  if (more.length > 0 || question?.multiSelect) return null;
  return ask.options.length > 0 && ask.options.length <= MAX_KEYS ? ask : null;
}

/**
 * A card's keys: the white one does the likeliest thing in place, and opens the chat only when the answer can only be
 * given there (the card itself always opens it). An approval offers its own options, the first that allows in white;
 * a question with a few options offers them, the engine's recommended one (else the first) in white. A finished turn
 * with work that is not on its base yet offers Ship it; with nothing to land, or a failed turn, Done (it is read).
 * Either way Later snoozes it for an hour. Everything else (a missing key, a wider ask, a plan to build) is answered
 * in the chat: one key opens it.
 */
export function cardKeys(w: WorkspaceView, status: ChatStatus, ask: Ask | null): NotchKey[] {
  const answer = (a: Ask, lit: string | undefined): NotchKey[] =>
    a.options.map((o) => ({
      id: `${ASK_KEY}\t${askToken(a.id)}\t${askToken(o.id)}`,
      label: o.label,
      tone: o.id === lit ? "lit" : "card",
    }));
  if (
    status.id === "approve" &&
    ask?.askKind === "approval" &&
    ask.options.length > 0 &&
    ask.options.length <= MAX_KEYS
  )
    return answer(ask, ask.options.find((o) => o.decision === "allow")?.id);
  const question = status.id === "answer" ? pickQuestion(ask) : null;
  if (question) {
    const recommended = question.questions[0]?.recommended;
    const lit = question.options.some((o) => o.id === recommended)
      ? recommended!
      : question.options[0]!.id;
    return answer(question, lit);
  }
  if (status.id === "done" || status.id === "failed") {
    const later: NotchKey = { id: LATER_KEY, label: "Later", tone: "card" };
    return status.id === "done" && hasWorkToLand(w)
      ? [{ id: SHIP_KEY, label: "Ship it", tone: "lit" }, later]
      : [{ id: SEEN_KEY, label: "Done", tone: "lit" }, later];
  }
  const label =
    status.id === "answer"
      ? "Answer"
      : status.id === "secret"
        ? "Add key"
        : status.id === "approve"
          ? "Review"
          : "Open";
  return [{ id: OPEN_KEY, label, tone: "lit" }];
}

type ImageItem = { readonly src: string; readonly itemId: string };

/**
 * What the chat built, to look at: the last picture of its latest turn (the proof screenshot an agent ends UI work
 * with, or what its browser showed). Null when that turn showed none.
 */
export function previewOf(view: Pick<SessionView, "items" | "artifacts"> | null): ImageItem | null {
  if (!view) return null;
  const from = view.items.findLastIndex((it) => it.kind === "user");
  const inTurn = new Set<string>();
  const walk = (items: ReadonlyArray<TranscriptItem>) => {
    for (const it of items) {
      inTurn.add(it.id);
      if (it.kind === "subagent") walk(it.items);
    }
  };
  walk(view.items.slice(from + 1));
  for (let i = view.artifacts.length - 1; i >= 0; i--) {
    const a = view.artifacts[i]!;
    if ((a.kind === "image" || a.kind === "browser") && inTurn.has(a.itemId))
      return { src: a.src, itemId: a.itemId };
  }
  return null;
}

/** The state as one comparable string: the feed sends only when it changes. */
export const sameState = (a: NotchState | null, b: NotchState | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
