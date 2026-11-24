// The runtime as the board's data source: the connected computer's chats in the phone's chat list, the open chat's
// transcript as it streams, and what you do in a chat sent to the runtime that runs it. It is what the scripted engine
// (board/script.ts) stands in for: the same board actions (a chat added, patched, let go), from what the runtime
// reports instead of from a script.
//
//   workspace.list, then workspace.changed    every chat, and each change of its title or status
//   session.attach                            the open chat's events, from the cursor already held, across reconnects
//   turn.submit, turn.interrupt, ask.respond  your message (a steer while it works), Stop, Allow or Deny or an answer
//   workspace.create                          a chat started from the phone, its first message as its first turn
//
// While the computer does not answer (a Mac asleep, a Cloud computer that sleeps or is waking) the same seams go
// through Caveman Cloud, as the web's do (away.ts): its chats are Cloud's list of them, a message, a Stop or an answer
// is queued there for the computer (Cloud wakes a Cloud computer for it, and moves a sleeping Mac's chat to one), and
// Run in Cloud is Cloud's own move. With no runtime at all to connect to (`client` absent) only that is left. The
// runtime is bound when there is one to reach and let go when it sleeps (`bind`), so one source holds a computer's
// chats, and what the person sent to them, across every wake.
//
// Nothing the person typed is ever dropped: a message that waits says what for in one line (`wait`), one that Caveman
// cannot be reached for is sent again by itself, and one that was refused stays in the thread, marked as not sent,
// until it is sent again (`resend`).
//
// A chat is followed only while it matters: the one on screen, and any that asks (its ask must be known to answer it).
// The rest cost a row. Like transcript.ts this has no import from the app, so the runtime's tests run it as it is
// against a real runtime; link.ts hands it the app's store.
import type { Client, Subscription } from "@caveman-app/session-protocol/client";
import type { Params, SessionEvent, Workspace } from "@caveman-app/session-protocol";

import { queuedLine, waits, type Away } from "./away.ts";
import { builderWords } from "./builders.ts";
import type { CloudChat, MoveTo, QueuedCall, SavedPage } from "./cloud.ts";
import { isStarting } from "./start.ts";
import {
  answerFor,
  LiveTranscript,
  type LiveItem,
  type LiveNeed,
  type LiveReply,
} from "./transcript.ts";
import { OFFLINE_AFTER_MS, passes, type Said } from "./words.ts";

/** A chat as the board holds it (board/model.ts Chat), the fields a runtime's chat has. */
export interface LiveChat {
  id: string;
  title: string;
  repo: string;
  device: string;
  parent?: string;
  /** Null: one of the person's own, not a Chief's. */
  chief: null;
  engine: "caveman" | "claude" | "codex" | "cursor" | "opencode" | "grok";
  model: string;
  phase: "needs" | "working" | "done";
  line: string;
  need?: LiveNeed;
  ask?: string;
  items: readonly LiveItem[];
  pinned?: boolean;
  /**
   * Nothing runs yet: what it waits for, in one line (its place waking, its Mac, the network), and since when. The
   * chat's own message says it, and nothing else on screen says "Working" meanwhile.
   */
  wait?: { words: string; since: number };
  /** A builder: what became of it, as the computer its lead runs on says, in its row's words ("Left out: conflicts in a.ts") and that state's one colour. */
  fate?: { words: string; tone: "quiet" | "warn" | "bad" };
  startedAt: number;
  updatedAt: number;
}

/** What the source does to the board: the board's own actions (store/board.ts BoardAction). */
export type BoardChange =
  | { type: "add"; chat: LiveChat }
  | { type: "update"; id: string; patch: Partial<LiveChat>; clear?: readonly (keyof LiveChat)[] }
  /** A word arrived, or the live line moved: never worth a write to disk by itself. */
  | { type: "live"; id: string; patch: Partial<LiveChat> }
  | { type: "remove"; id: string };

export interface Board {
  /** The chats the board holds now, each with the transcript it shows (the board's own items, handed back as they are). */
  chats(): readonly { readonly id: string; readonly items?: readonly unknown[] }[];
  dispatch(change: BoardChange): void;
}

/** A chat to start: where its code is (a folder on the computer, or a repository it clones), who runs it, and its first message. */
export interface StartInput {
  readonly repo: { readonly path: string } | { readonly url: string };
  readonly engine: NonNullable<Params<"workspace.create">["engine"]>;
  readonly text: string;
  readonly title?: string;
  /** The model, effort and speed picked for its first turn; absent, the computer's defaults. */
  readonly options?: Params<"workspace.create">["options"];
  /**
   * The model picked on the phone, by the id its engine gives it. It is the chat's where this computer lists it for
   * the engine; where it does not (another version of the engine, a login without it), the chat starts on the
   * computer's own default for a new chat, as one started there would.
   */
  readonly model?: string;
  /** The effort and speed picked with `model`: each goes with it where the computer lists it for that model. */
  readonly effort?: string;
  readonly speed?: string;
}

/** What a chat's next turns run on, as its person picked in the chat's own picker: the agent, and its model, effort and speed. */
export type Chosen = Pick<
  NonNullable<Params<"turn.submit">["options"]>,
  "engine" | "model" | "effort" | "speed"
>;

export interface LiveSource {
  /**
   * Reads the computer's chats again: as the connection opens, and after every reconnect (what was pushed meanwhile is
   * gone). From the runtime while it answers; else from Cloud's list of the person's chats, where there is one.
   */
  sync(): Promise<void>;
  /** Cloud's list of the person's chats, as last read: what Cloud says of this computer's chats, and which it lists that the phone has not seen. */
  seed(chats: ReadonlyArray<CloudChat>): void;
  /** Whether `chatId` is one of this computer's. */
  owns(chatId: string): boolean;
  /** Follows a chat's transcript: the one on screen. */
  open(chatId: string): void;
  /** Your message: a steer while the chat works or asks, else a new turn (`followup` always is one). */
  send(chatId: string, text: string, kind?: "steer" | "followup"): void;
  /** Sends a message that was not sent again, in the place it stands (`itemId`: the transcript's id for it). */
  resend(chatId: string, itemId: string): void;
  stop(chatId: string): void;
  /** Answers what the chat asks. False when the phone cannot (only the Mac can answer it, or it no longer asks). */
  respond(chatId: string, reply: LiveReply): Promise<boolean>;
  /**
   * An answer is in hand and not sent yet (`said`), or was taken back (null): the chat keeps showing it as given
   * meanwhile. Returns what the answer reads while its computer cannot hear it; null where it hears it at once.
   */
  hold(chatId: string, said: Said | null): string | null;
  /**
   * The chat's next turns run on this (its own picker's pick): sent with each message from here on, and shown as the
   * chat's own until its computer says what it runs on.
   */
  choose(chatId: string, chosen: Chosen): void;
  /** Starts a chat on this computer with its first message, and follows it. Resolves with its id once the computer has made it. */
  start(input: StartInput): Promise<string>;
  /**
   * Runs the chat in Cloud: Cloud's own move to a Cloud computer, as the same chat (one place holds it at a time).
   * Resolves with the computer it is on now, once Cloud says it is there; rejects with why it cannot move.
   */
  runInCloud(
    chatId: string,
  ): Promise<{ readonly computer_id: string; readonly session_id: string }>;
  /** Runs the chat on one of the person's Macs, by that Mac's computer id: the same move, the other way. */
  runOn(
    chatId: string,
    computerId: string,
  ): Promise<{ readonly computer_id: string; readonly session_id: string }>;
  /** The chat's session, as the runtime or Cloud named it. */
  sessionOf(chatId: string): string | undefined;
  /** The chat here that is `sessionId`. */
  chatOf(sessionId: string): string | undefined;
  /** Whether a message of this phone's still waits in Cloud for the chat's computer. */
  waiting(chatId: string): boolean;
  /** That call, as Cloud last said of it. */
  queued(chatId: string): QueuedCall | undefined;
  /** Shows every chat again: what names their projects (`project`) was read anew. */
  refresh(): void;
  /**
   * The computer's runtime to reach from now on, or none (it sleeps): what was followed on the one before is let go,
   * and nothing the chats hold (a message that waits, one not sent) goes with it.
   */
  bind(client: Client | undefined): void;
  /**
   * Lets go of a chat that runs somewhere else now, leaving it on the board for whoever holds it there. Returns what
   * this phone has under way for it (a message Cloud keeps, one not sent, an answer), to hand to who holds it next.
   */
  release(chatId: string): Carried | undefined;
  /** Takes what this phone had under way for a chat another computer held until now. */
  carry(chatId: string, carried: Carried): void;
  /** The chats this computer holds. */
  chats(): readonly string[];
  close(): void;
}

const ENGINES: Record<string, LiveChat["engine"]> = {
  "claude-agent": "claude",
  codex: "codex",
  caveman: "caveman",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
};

/** The repository's or folder's name, as the board names a chat's project. */
const repoName = (repo: Workspace["repo"]): string => {
  const whole = "path" in repo ? repo.path : repo.url;
  return (
    whole
      .replace(/\.git$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? whole
  );
};

const phaseOf = (status: Workspace["status"]): LiveChat["phase"] =>
  status === "needs_input"
    ? "needs"
    : status === "working" || status === "starting" || status === "waiting"
      ? "working"
      : "done";

/** A saved event as the computer's own: Cloud keeps each whole, by its place in the chat. */
function savedEvent(sessionId: string, raw: SavedPage["events"][number]): SessionEvent {
  const whole = raw.event as Partial<SessionEvent> | null;
  if (whole && typeof whole === "object" && typeof whole.type === "string" && "payload" in whole)
    return {
      ...whole,
      session_id: sessionId,
      cursor: raw.cursor,
      at: whole.at ?? raw.at,
    } as SessionEvent;
  return {
    session_id: sessionId,
    cursor: raw.cursor,
    at: raw.at,
    type: raw.type,
    payload: raw.event,
  } as SessionEvent;
}

/** The runtime's id for the message a turn.submit sends (runtime store.ts submittedMessageId): its event takes the echo's place. */
async function submittedMessageId(sessionId: string, requestId: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${sessionId}\0${requestId}`),
    ),
  );
  return `sp-msg:${Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24)}`;
}

interface Held {
  workspace: Workspace;
  transcript: LiveTranscript;
  /** Its attachment, or the attach under way; undefined while it is not followed. */
  following: Promise<Subscription | undefined> | undefined;
  /**
   * When a message sent from here put the chat to work on the phone ahead of the runtime's word (0: none). It holds
   * until the runtime says the chat works or asks, the turn ends, or the send fails; never by comparing the two clocks.
   */
  sentAt: number;
  /** The call of this phone's that waits in Cloud for the chat's computer, as Cloud last said of it. */
  queued?: QueuedCall | undefined;
  /** The message that call sends, by its id in the transcript. */
  queuedMessage?: string | undefined;
  /** Since when a message of this phone's has waited (in Cloud's queue, or for a way to Caveman); 0: none does. */
  waitSince: number;
  /** Since when Caveman could not be reached for a message of this phone's, which is sent again by itself; 0: it can. */
  unreached: number;
  /** How many messages of this phone's nobody has taken yet (neither the chat's computer nor Cloud's queue). */
  handing: number;
  /** An answer of this phone's that waits in Cloud for the chat's computer: the ask it answers, and yes or no. */
  answering?: { readonly ask: string; readonly said: Said } | undefined;
  /** An answer in hand that has not been sent yet (the person can still take it back): the chat shows it as given meanwhile. */
  holding?: { readonly ask: string | undefined; readonly said: Said } | undefined;
  /** What the person picked for the chat's next turns in its own picker; absent: as its computer runs it. */
  chosen?: Chosen | undefined;
  /** What Cloud lists of the chat, as last read. */
  summary?: CloudChat | undefined;
  /** What Cloud saved of the chat is being read into its transcript. */
  reading?: boolean;
  /** Known only by Cloud's list so far: the runtime has not said of it (its workspace is made from Cloud's summary). */
  listed?: true;
  /**
   * What the board showed of the chat when this phone first put a message of its own under it, the transcript not yet
   * read from its runtime (its computer is away, or it was not opened yet): your message goes under that, as last
   * seen, until the runtime's own events take the place of both.
   */
  under?: readonly LiveItem[] | undefined;
  /** `under` with the transcript's items after it, kept while the transcript's are the same ones. */
  shown?: { readonly of: readonly LiveItem[]; readonly items: readonly LiveItem[] } | undefined;
  /** The items with the ask being answered marked as waiting, kept while they are the same ones. */
  pended?:
    | {
        readonly of: readonly LiveItem[];
        readonly words: string;
        readonly items: readonly LiveItem[];
      }
    | undefined;
}

/** What the person is told when an answer of theirs never reached the chat (its computer slept with the ask open). */
const UNHEARD = "Your answer didn't arrive. It asks again when it carries on.";
/** How often Cloud is asked what became of a call that waits, and of a move its computer must first let go of. */
const WATCH_EVERY_MS = 2_000;
/** How soon a message Caveman could not be reached for is sent again. */
const RESEND_EVERY_MS = 3_000;
/** How long a call waits for a link that is on its way up before it goes through Cloud's queue instead. */
const SETTLE_MS = 4_000;
/** How long Run in Cloud waits for a Mac that holds the chat mid-turn to let it go (Cloud's lease lapses in 90 s). */
const MOVE_WAIT_MS = 150_000;

/**
 * A chat's workspace as much as Cloud's list says of it, for a chat the runtime has not listed (its computer is away).
 * Cloud names its repository only where it is on GitHub: `project` is what the board last called its project, for one
 * in a plain folder or on another host, and "Folder" for one the phone never saw.
 */
const workspaceOf = (c: CloudChat, project: string | undefined): Workspace =>
  ({
    id: c.workspace_id,
    session_id: c.session_id,
    title: c.title,
    repo: { url: c.repo ?? (project || "Folder") },
    engine: c.engine,
    status:
      c.status === "working"
        ? "working"
        : c.status === "needs_you"
          ? "needs_input"
          : c.status === "error"
            ? "failed"
            : "idle",
    ...(c.model ? { runner: { model: c.model } } : {}),
    created_at: c.last_activity_at,
    updated_at: c.last_activity_at,
  }) as unknown as Workspace;

/** The words of a message that waits, as the app says them (words.ts); the default keeps a computer's own name. */
/** What this phone has under way for a chat: it goes with the chat when another computer takes it. */
export interface Carried {
  readonly unsaid: ReturnType<LiveTranscript["unsaid"]>;
  readonly queued: QueuedCall | undefined;
  /** The message the queued call sends, by its id in the transcript. */
  readonly message: string | undefined;
  readonly waitSince: number;
  readonly sentAt: number;
  readonly answering: Held["answering"];
}

export interface SourceWords {
  /** What a call that waits in Cloud says under the chat; null once it ran. */
  waiting(
    call: QueuedCall,
    where: { readonly name: string; readonly cloud: boolean },
    chat: CloudChat | undefined,
  ): string | null;
  /** What an answer that waits in Cloud says in the ask's place. */
  answer(said: Said, where: { readonly name: string; readonly cloud: boolean }): string;
  /** What a message says while Caveman cannot be reached for it. */
  readonly unreached: string;
}

const NAMED: SourceWords = {
  waiting: (call, where) => queuedLine(call, where),
  answer: (said, where) =>
    `${said === "allow" ? "Allow" : said === "deny" ? "Deny" : "Answer"} queued · ${where.name || "its computer"}`,
  unreached: "No network. Sends when you're back online.",
};

export function liveSource(options: {
  /** The computer's runtime; absent while it has none to connect to (a Cloud computer that sleeps): its chats are then Cloud's list of them. */
  readonly client?: Client;
  readonly board: Board;
  /** The board's id for the computer these chats run on. */
  readonly device: string;
  /** The computer these chats run on, as Cloud names it: which of the person's chats in Cloud's list are its own, and the words of a message that waits for it. */
  readonly computer?: {
    readonly computer_id: string;
    readonly name: string;
    readonly kind: "laptop" | "cloud";
  };
  /** Whether the runtime answers now (the link is open). Default: it does whenever there is a client. */
  readonly reachable?: () => boolean;
  /**
   * The link to the runtime is on its way up (it was just opened): resolves once it answers or has settled into not
   * answering. A call made meanwhile waits for it this long, so it goes straight to a Mac that is there after all.
   */
  readonly settled?: () => Promise<unknown>;
  /** The words of a message that waits. Default: the ones that name the computer. */
  readonly words?: SourceWords;
  /** Cloud's routes for a chat whose computer does not answer; without them such a chat's message waits in the client for the link. */
  readonly away?: Away;
  /**
   * What the app calls the project a workspace was made in (its repository's name, as the pickers list it), where it
   * knows; else the chat is named for its folder or repository itself.
   */
  readonly project?: (workspace: Workspace) => string | undefined;
  /** Something the person did could not be done, in plain words (a send the runtime refused). */
  readonly onError?: (message: string) => void;
  readonly now?: () => number;
}): LiveSource {
  const { board, device, away } = options;
  let client = options.client;
  const say = options.words ?? NAMED;
  const now = options.now ?? Date.now;
  const held = new Map<string, Held>();
  let closed = false;
  const requestId = () => globalThis.crypto.randomUUID();
  const told = (error: unknown, what: string) =>
    options.onError?.(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  const reachable = () => client !== undefined && (options.reachable?.() ?? true);
  const where = { name: options.computer?.name ?? "", cloud: options.computer?.kind === "cloud" };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A workspace the chat list shows: a chat, or a builder under one. Chiefs, setup chats and automation runs have their own places. */
  const listed = (w: Workspace) =>
    w.kind === undefined && w.automation === undefined && w.status !== "archived";

  /** The transcript as the board shows it: the runtime's events once they were read, else what the board kept with this phone's own messages under it. */
  const itemsOf = (h: Held): readonly LiveItem[] => {
    const items = h.transcript.items();
    if (h.under === undefined || h.transcript.cursor > 0) return items;
    if (h.shown?.of !== items) h.shown = { of: items, items: [...h.under, ...items] };
    return h.shown.items;
  };

  /** The transcript with the ask an answer from here waits on saying so, in the ask's own place. */
  const answeringItems = (h: Held, words: string, ask: string | undefined): readonly LiveItem[] => {
    const items = itemsOf(h);
    if (h.pended?.of === items && h.pended.words === words) return h.pended.items;
    h.pended = {
      of: items,
      words,
      items: items.map((item) =>
        item.kind === "ask" && item.id === ask ? { ...item, pending: words } : item,
      ),
    };
    return h.pended.items;
  };

  /** The chat as the board holds it, from what the runtime said of its workspace and what its transcript knows. */
  const chatOf = (h: Held): LiveChat => {
    const w = h.workspace;
    const t = h.transcript;
    // A send from here shows as working at once, until the runtime's own word on it comes.
    // So does an answer given from here that its computer has not heard yet: the chat no longer asks the person.
    const answer = h.answering ?? h.holding;
    // A builder's row is what the computer its lead runs on says became of it, and nothing else (Workspace.builder):
    // at work or not by that word, whatever its own turn is doing. One that asks the person still asks.
    const fate = w.builder ? builderWords(w.builder, now()) : undefined;
    const stands =
      fate && phaseOf(w.status) !== "needs"
        ? fate.working
          ? "working"
          : "done"
        : phaseOf(w.status);
    const phase =
      (h.sentAt > 0 && stands === "done") || (answer !== undefined && stands === "needs")
        ? "working"
        : stands;
    const asks = phase === "needs" ? w.activity?.ask : undefined;
    const need: LiveNeed | undefined =
      phase !== "needs"
        ? undefined
        : t.ask
          ? (t.ask.need ?? undefined)
          : asks?.kind === "approval"
            ? { kind: "approval", command: asks.prompt, summary: "", at: Date.parse(w.updated_at) }
            : asks?.kind === "question"
              ? {
                  kind: "question",
                  question: asks.prompt,
                  options: [],
                  summary: "",
                  at: Date.parse(w.updated_at),
                }
              : undefined;
    const ended =
      fate && !fate.working
        ? fate.words
        : w.status === "failed" || w.activity?.last_outcome === "failed"
          ? "Failed"
          : w.activity?.last_outcome === "interrupted"
            ? "Stopped"
            : "Done";
    // A message of this phone's that waits in Cloud says where it waits, until the computer's own word on the turn
    // comes. A turn the phone last saw running says nothing while its computer does not answer: that word is old.
    const quiet = !t.running || !reachable();
    const waitingLine =
      h.unreached > 0 && now() - h.unreached >= OFFLINE_AFTER_MS
        ? say.unreached
        : answer && quiet
          ? say.answer(answer.said, where)
          : h.queued && quiet
            ? say.waiting(h.queued, where, h.summary)
            : // Nobody has the message yet and its computer does not answer: it is being sent, and nothing works.
              h.handing > 0 && !reachable()
              ? "Sending"
              : null;
    const line =
      waitingLine ??
      (phase === "working"
        ? t.running
          ? t.line
          : "Working"
        : phase === "needs"
          ? (t.ask?.line ?? asks?.prompt ?? h.summary?.needs_you?.summary ?? "Needs you")
          : ended);
    const parent =
      w.parent_workspace_id !== undefined && held.has(w.parent_workspace_id)
        ? w.parent_workspace_id
        : undefined;
    return {
      id: w.id,
      title: w.title,
      repo: options.project?.(w) ?? repoName(w.repo),
      device,
      ...(parent ? { parent } : {}),
      chief: null,
      // A pick made here shows as the chat's own until its computer runs on it: then the computer's word says it.
      engine: ENGINES[h.chosen?.engine ?? w.engine] ?? "caveman",
      model:
        h.chosen?.model ??
        (h.chosen?.engine !== undefined && h.chosen.engine !== w.engine
          ? ""
          : (t.model ?? w.runner?.model ?? "")),
      phase,
      line,
      ...(need ? { need, ...(need.kind === "approval" ? { ask: need.command } : {}) } : {}),
      items:
        answer && quiet
          ? answeringItems(h, say.answer(answer.said, where), answer.ask)
          : itemsOf(h),
      ...(w.inbox?.pinned_at ? { pinned: true } : {}),
      ...(waitingLine !== null
        ? { wait: { words: waitingLine, since: h.waitSince || h.sentAt || now() } }
        : {}),
      ...(fate ? { fate: { words: fate.words, tone: fate.tone } } : {}),
      // Never ahead of the phone's clock (a Mac's a little fast): lists sort by these, and words stream in from them.
      startedAt: Math.min(
        now(),
        h.sentAt || Date.parse(w.activity?.turn_started_at ?? w.created_at),
      ),
      updatedAt: Math.min(now(), Math.max(h.sentAt, Date.parse(w.updated_at))),
    };
  };

  /** Puts a chat on the board as it is now. `stream`: only its words or live line moved. */
  const show = (h: Held, stream = false) => {
    // Let go of meanwhile (it runs somewhere else now): whoever holds it there says what it shows.
    if (closed || held.get(h.workspace.id) !== h) return;
    // An answer in hand for a computer that hears: the board shows it as given until it is sent or taken back.
    if (h.holding && reachable()) return;
    const chat = chatOf(h);
    if (!board.chats().some((c) => c.id === chat.id)) return board.dispatch({ type: "add", chat });
    const { id, items, ...rest } = chat;
    // Until its transcript is read (a chat nobody has opened since the app started), what the board kept of it stays;
    // a message of this phone's own goes under that (`under`), and shows gone again when it was taken back.
    const patch =
      h.transcript.cursor > 0 || items.length > 0 || h.under !== undefined
        ? { ...rest, items }
        : rest;
    if (stream)
      return board.dispatch({
        type: "live",
        id,
        patch: { ...("items" in patch ? { items } : {}), line: patch.line, model: patch.model },
      });
    board.dispatch({
      type: "update",
      id,
      patch,
      clear: (["need", "ask", "parent", "pinned", "wait", "fate"] as const).filter(
        (key) => !(key in patch),
      ),
    });
  };

  // A burst of events is one change to the board: the client hands a batch over in one go, and this runs after it.
  // `whole`: more than words moved (an ask came or went, a turn began or ended), so the row and the dock change too.
  const dirty = new Map<Held, boolean>();
  const flush = () => {
    const all = [...dirty];
    dirty.clear();
    for (const [h, whole] of all) show(h, !whole);
  };
  const touch = (h: Held, whole = false) => {
    if (dirty.size === 0) queueMicrotask(flush);
    dirty.set(h, whole || dirty.get(h) === true);
  };

  const follow = (h: Held): Promise<Subscription | undefined> =>
    client === undefined
      ? Promise.resolve(undefined)
      : (h.following ??= client
          .attach(
            h.workspace.session_id,
            h.transcript.cursor,
            (event) => {
              const before = h.transcript.ask;
              h.transcript.apply(event, now());
              if (event.type === "turn.done") h.sentAt = 0;
              // The computer has the turn: nothing of it waits in Cloud any more.
              if (event.type === "turn.started" || event.type === "turn.done") {
                h.queued = undefined;
                h.waitSince = 0;
              }
              // The computer has said what became of the ask: an answer from here no longer waits to be heard. One that
              // ended with no answer (its computer went to sleep, or restarted, with the ask open) never heard this one:
              // the person is told so, once, rather than shown a yes that was not taken.
              const answered = event.type === "ask.resolved" && h.answering?.ask === event.item_id;
              if (answered && event.payload.outcome !== "answered") options.onError?.(UNHEARD);
              if (answered || event.type === "turn.done") h.answering = undefined;
              touch(
                h,
                before !== h.transcript.ask ||
                  answered ||
                  event.type === "turn.done" ||
                  event.type === "turn.started",
              );
            },
            {
              onReset: () => {
                h.transcript.reset();
                // The runtime's journal from its start follows: nothing the board kept stands under it.
                h.under = undefined;
                h.shown = undefined;
                touch(h, true);
              },
              // Ended for good (the chat moved away, was archived): the next open follows it again.
              onError: () => (h.following = undefined),
            },
          )
          .catch(() => {
            h.following = undefined;
            return undefined;
          }));

  /**
   * What Cloud saved of a chat, read into its transcript while its computer cannot be reached: the chat reads in
   * full, with what it asks, and nothing is woken for it. The computer's own events go on from there once it answers.
   */
  const readSaved = async (h: Held) => {
    const first = h.summary?.epoch;
    if (!away?.saved || first === undefined || h.reading || reachable() || closed) return;
    h.reading = true;
    try {
      let epoch = first;
      for (let pages = 0; pages < 100; pages++) {
        const page = await away.saved(h.workspace.session_id, epoch, h.transcript.cursor);
        if (closed || reachable()) return;
        if (page.reset) {
          // Cloud holds another writing of it: what was read of the old one goes.
          if (page.epoch === epoch) break;
          epoch = page.epoch;
          h.transcript.reset();
          continue;
        }
        const before = h.transcript.cursor;
        for (const raw of page.events)
          h.transcript.apply(savedEvent(h.workspace.session_id, raw), now());
        // The chat from its start: nothing the board kept stands under it.
        if (h.transcript.cursor > before) {
          h.under = undefined;
          h.shown = undefined;
        }
        if (!page.more || page.events.length === 0) break;
      }
      touch(h, true);
    } catch {
      // No way to Caveman right now: what the phone holds of the chat stays.
    } finally {
      h.reading = false;
    }
  };

  const take = (w: Workspace) => {
    if (closed) return;
    const known = held.get(w.id);
    if (!listed(w)) {
      if (!known) return;
      held.delete(w.id);
      void known.following?.then((sub) => sub?.detach().catch(() => undefined));
      return board.dispatch({ type: "remove", id: w.id });
    }
    const h = known ?? fresh(w);
    h.workspace = w;
    // The runtime's own word on it now, whatever Cloud's list said before.
    delete h.listed;
    if (phaseOf(w.status) !== "done") h.sentAt = 0;
    held.set(w.id, h);
    show(h);
    // What it asks is in its transcript: followed, so the answer can name it.
    if (w.status === "needs_input") void follow(h);
  };
  let off = client?.on("workspace.changed", take);

  /**
   * A chat held for the first time. What the board kept of a message that was not sent stays with it: the person
   * typed it, and only they take it back.
   */
  function fresh(workspace: Workspace, more: Partial<Held> = {}): Held {
    const transcript = new LiveTranscript();
    const kept = (board.chats().find((c) => c.id === workspace.id)?.items ??
      []) as readonly LiveItem[];
    for (const item of kept) {
      if (item.kind !== "you" || item.state !== "failed") continue;
      transcript.echo(item.id, item.text, item.steer === true, item.at);
      transcript.fail(item.id);
    }
    return {
      workspace,
      transcript,
      following: undefined,
      sentAt: 0,
      waitSince: 0,
      unreached: 0,
      handing: 0,
      ...more,
    };
  }

  /**
   * Cloud's list of the person's chats. One of this computer's the runtime has not listed (it is away, or has not
   * been read yet) goes on the board as Cloud last heard of it, so it can be read about, sent to and run in Cloud
   * while its computer sleeps. The runtime's own list takes its place when it comes.
   */
  const seed = (chats: ReadonlyArray<CloudChat>) => {
    if (closed || options.computer === undefined) return;
    for (const c of chats) {
      if (
        c.computer_id !== options.computer.computer_id ||
        (c.kind !== "chat" && c.kind !== "builder")
      )
        continue;
      const known = held.get(c.workspace_id);
      if (known) known.summary = c;
      if (known && !known.listed) continue;
      const project = (
        board.chats().find((chat) => chat.id === c.workspace_id) as { repo?: string } | undefined
      )?.repo;
      const h: Held = known ?? fresh(workspaceOf(c, project), { listed: true, summary: c });
      h.workspace = workspaceOf(c, project);
      held.set(c.workspace_id, h);
      show(h);
    }
    // What Cloud lists elsewhere now (it moved), or no longer lists, is not this computer's any more, while only
    // Cloud's list says of it: it leaves the board, as a chat its runtime no longer has does.
    for (const [id, h] of held) {
      if (
        !h.listed ||
        chats.some((c) => c.workspace_id === id && c.computer_id === options.computer!.computer_id)
      )
        continue;
      held.delete(id);
      board.dispatch({ type: "remove", id });
    }
  };

  const sync = async () => {
    if (!reachable()) {
      // The computer does not answer: Cloud's list of its chats, where Cloud can be asked.
      if (away) seed(await away.chats());
      return;
    }
    const { workspaces } = await client!.call("workspace.list", {});
    if (closed) return;
    const there = new Set(workspaces.filter(listed).map((w) => w.id));
    // Parents first, so a builder finds the chat it hangs under.
    for (const w of [...workspaces].sort(
      (a, b) =>
        Number(a.parent_workspace_id !== undefined) - Number(b.parent_workspace_id !== undefined),
    ))
      take(w);
    // What the computer no longer has (archived or deleted while the phone was away) leaves the board.
    // Only what is this computer's own: the board holds every computer's chats, each said for by its own source.
    for (const chat of board.chats()) {
      const on = (chat as { device?: string }).device;
      if (
        there.has(chat.id) ||
        isStarting(chat.id) ||
        (on !== undefined && on !== device && !held.has(chat.id))
      )
        continue;
      held.delete(chat.id);
      board.dispatch({ type: "remove", id: chat.id });
    }
  };

  /** The runtime's word on one chat again, after something from here may have left the board ahead of or behind it. */
  const reread = async (h: Held) => {
    h.sentAt = 0;
    h.queued = undefined;
    h.waitSince = 0;
    h.unreached = 0;
    h.answering = undefined;
    if (!reachable()) return show(h);
    await client!.call("workspace.get", { workspace_id: h.workspace.id }).then(
      (w) => take(w),
      () => show(h),
    );
  };

  /**
   * Watches a call that waits in Cloud: what Cloud says of it (it waits for a Mac, a Cloud computer is being woken, it
   * was delivered) is the chat's line until the computer has the turn. A call Cloud gave up on is said, and the chat
   * is at rest again.
   */
  const watch = (h: Held, call: QueuedCall, message?: string) => {
    h.queued = call;
    h.queuedMessage = message;
    h.waitSince ||= now();
    const again = () => {
      if (closed || h.queued?.request_id !== call.request_id || !away) return;
      away.queued(h.workspace.session_id, call.request_id).then(
        (state) => {
          if (closed || h.queued?.request_id !== call.request_id) return;
          if (state === null || state.status === "done") {
            h.queued = undefined;
            h.waitSince = 0;
            return touch(h, true);
          }
          if (!waits(state)) {
            // A message Cloud gave up on stays in the thread, marked as not sent. An answer that did not arrive is
            // said so: answered on another device where the computer said it was, else it never heard this one (it
            // went to sleep first, and asks again once it carries on).
            if (message !== undefined) h.transcript.fail(message);
            else if (call.method === "ask.respond" && h.answering)
              options.onError?.(
                h.transcript.outcomeOf(h.answering.ask) === "answered"
                  ? "Answered on another device"
                  : UNHEARD,
              );
            else options.onError?.(say.waiting(state, where, h.summary) ?? "Not sent");
            return void reread(h);
          }
          h.queued = state;
          touch(h, true);
          setTimeout(again, WATCH_EVERY_MS);
        },
        () => void setTimeout(again, WATCH_EVERY_MS),
      );
    };
    setTimeout(again, WATCH_EVERY_MS);
  };

  /**
   * A call for a chat: to its runtime while that answers, else queued in Cloud for it, signed by this phone (a Mac
   * runs only what its devices signed). Cloud wakes a Cloud computer for it, and moves a sleeping Mac's chat to one.
   */
  const call = async (
    h: Held,
    method: "turn.submit" | "turn.interrupt" | "ask.respond",
    params: Record<string, unknown> & { request_id: string; session_id: string },
    message?: string,
  ): Promise<"heard" | "waits"> => {
    // A link opened a moment ago is given that moment: a Mac that is there after all hears it directly.
    if (!reachable() && client && options.settled)
      await Promise.race([options.settled(), sleep(SETTLE_MS)]);
    if (reachable()) {
      await client!.call(method, params as never);
      return "heard";
    }
    if (!away) {
      // No way to Cloud's queue: it waits in the client for the link, as before.
      if (client) {
        await client.call(method, params as never);
        return "heard";
      }
      throw new Error(`${where.name || "Its computer"} is not connected.`);
    }
    const device = await away
      .sign({ session_id: params.session_id, request_id: params.request_id, method, params })
      .catch(() => undefined);
    const queued = await away.queue(params.session_id, {
      request_id: params.request_id,
      method,
      params,
      ...(device ? { device } : {}),
    });
    if (!waits(queued) && queued.status !== "done")
      throw new Error(say.waiting(queued, where, h.summary) ?? "Not sent");
    if (!waits(queued)) return "heard";
    watch(h, queued, message);
    return "waits";
  };

  /**
   * Hands a message over until someone has it. While Caveman cannot be reached at all it is tried again by itself,
   * the message saying so once that has lasted; a refusal leaves it in the thread, marked as not sent.
   */
  const deliver = async (
    h: Held,
    id: string,
    params: {
      request_id: string;
      session_id: string;
      kind: "steer" | "followup";
      input: { text: string };
      options?: Chosen;
    },
  ) => {
    for (;;) {
      try {
        await call(h, "turn.submit", params, id);
        h.unreached = 0;
        h.transcript.sent(id);
        return touch(h, true);
      } catch (error) {
        if (closed) return;
        if (passes(error)) {
          h.unreached ||= now();
          show(h);
          await sleep(RESEND_EVERY_MS);
          // Taken back meanwhile (the chat was let go): nothing is sent for it.
          if (closed || !held.has(h.workspace.id)) return;
          continue;
        }
        h.transcript.fail(id);
        return void (await reread(h));
      }
    }
  };

  /**
   * Cloud's own move of a chat, as the same chat, to Cloud or to one of the person's Macs: asked for signed by this
   * phone, and waited for until Cloud lists the chat there (its own computer lets it go at its turn's end).
   */
  const move = async (chatId: string, to: MoveTo) => {
    const h = held.get(chatId);
    if (!h || closed || !away)
      throw new Error("Not saved to Cloud yet. It can run there after its next turn.");
    const session_id = h.workspace.session_id;
    const request_id = requestId();
    const device = await away
      .sign({ session_id, request_id, method: "session.move", params: { to } })
      .catch(() => undefined);
    const moved = await away.move(session_id, { request_id, to, ...(device ? { device } : {}) });
    const there = (c: CloudChat) =>
      to === "cloud"
        ? c.where.kind === "cloud" && c.computer_id !== options.computer?.computer_id
        : c.computer_id === to.computer_id;
    if (!moved.pending && moved.computer_id) return { computer_id: moved.computer_id, session_id };
    // Its own computer holds it still (it answers after all, or is mid-turn) and was asked to let it go: it is there
    // once Cloud's list says so.
    for (let waited = 0; waited < MOVE_WAIT_MS && !closed; waited += WATCH_EVERY_MS) {
      await sleep(WATCH_EVERY_MS);
      const now = (await away.chats().catch(() => [])).find((c) => c.session_id === session_id);
      if (now && there(now)) return { computer_id: now.computer_id, session_id };
    }
    throw new Error(
      `Still running on ${where.cloud ? "Cloud" : where.name || "its Mac"}. It moves when its turn ends.`,
    );
  };

  const send = (chatId: string, text: string, kind?: "steer" | "followup") => {
    const h = held.get(chatId);
    if (!h || closed) return;
    const session_id = h.workspace.session_id;
    // While a turn runs, by the chat's status or by its own events (which come first): words steer it. Not while its
    // computer does not answer: what the phone last saw running is not known to run still, so the words wait in Cloud
    // as a message of their own.
    const steer =
      kind !== "followup" &&
      reachable() &&
      (phaseOf(h.workspace.status) !== "done" || h.transcript.running);
    const request_id = requestId();
    void follow(h);
    void (async () => {
      const id = await submittedMessageId(session_id, request_id);
      // On screen at once, "Sending" under it, and the chat at work, before the runtime has heard. Under what the board
      // kept of the chat, while its transcript has not been read here.
      if (h.under === undefined && h.transcript.cursor === 0 && h.transcript.items().length === 0)
        h.under = (board.chats().find((c) => c.id === chatId)?.items ?? []) as readonly LiveItem[];
      h.transcript.echo(id, text, steer, now());
      if (!steer) h.sentAt = now();
      h.handing += 1;
      show(h);
      // A new turn runs on what was picked in the chat's picker; a steer joins the turn that runs, as it runs.
      await deliver(h, id, {
        request_id,
        session_id,
        kind: steer ? "steer" : "followup",
        input: { text },
        ...(h.chosen && !steer ? { options: h.chosen } : {}),
      }).finally(() => {
        h.handing -= 1;
      });
      show(h);
    })();
  };

  return {
    sync,
    seed,
    owns: (chatId) => held.has(chatId),
    open(chatId) {
      const h = held.get(chatId);
      if (!h) return;
      void follow(h);
      void readSaved(h);
    },
    send,
    resend(chatId, itemId) {
      const h = held.get(chatId);
      const item = h?.transcript.failed(itemId);
      if (!h || !item || closed) return;
      h.transcript.unecho(itemId);
      send(chatId, item.text);
    },
    stop(chatId) {
      const h = held.get(chatId);
      if (!h || closed) return;
      call(h, "turn.interrupt", {
        request_id: requestId(),
        session_id: h.workspace.session_id,
      }).catch((error: unknown) => told(error, "It did not stop"));
    },
    hold(chatId, said) {
      const h = held.get(chatId);
      if (!h || closed) return null;
      h.holding = said ? { ask: h.transcript.ask?.id, said } : undefined;
      // Taken back, or given to a computer that cannot hear it: the chat says so itself.
      if (!said || !reachable()) show(h);
      return said && !reachable() ? say.answer(said, where) : null;
    },
    choose(chatId, chosen) {
      const h = held.get(chatId);
      if (!h || closed) return;
      h.chosen = chosen;
      show(h);
    },
    async respond(chatId, reply) {
      const h = held.get(chatId);
      if (!h || closed) return false;
      // Its ask is in its transcript: wait for the attach that brings it, if the answer came first.
      await follow(h);
      for (
        let waited = 0;
        !h.transcript.ask && reachable() && waited < 5_000 && !closed;
        waited += 50
      )
        await sleep(50);
      // Its computer sleeps and the phone has not read the ask: Cloud's saved copy names it.
      if (!h.transcript.ask) await readSaved(h);
      const ask = h.transcript.ask;
      const response = ask ? answerFor(ask, reply) : null;
      if (!ask || !response) {
        // Nothing to answer that the phone knows of: the chat is as its computer last said, and the person is told.
        const held = h.holding !== undefined;
        h.holding = undefined;
        if (held) {
          options.onError?.(UNHEARD);
          show(h);
        }
        return false;
      }
      const words =
        reply.kind === "told" ? reply.text : reply.kind === "deny" ? reply.instead : undefined;
      try {
        // Not heard yet (its computer sleeps, and Cloud keeps the answer for it): the chat says the answer waits,
        // never that it was given.
        const heard = await call(h, "ask.respond", {
          request_id: requestId(),
          session_id: h.workspace.session_id,
          ask_id: ask.id,
          response,
        });
        h.holding = undefined;
        if (heard === "waits") {
          h.answering = {
            ask: ask.id,
            said:
              response.kind === "approval" ? (reply.kind === "allow" ? "allow" : "deny") : "answer",
          };
          show(h);
        }
      } catch (error) {
        h.holding = undefined;
        told(error, "Your answer did not reach it");
        await reread(h);
        return false;
      }
      // A no that came with what to do instead, where the engine takes no note with a no: said as a steer under it.
      if (
        words &&
        ask.payload.kind === "approval" &&
        response.kind === "approval" &&
        response.feedback === undefined
      )
        send(chatId, words, "steer");
      return true;
    },
    async start(input) {
      if (closed || !reachable())
        throw new Error(`${where.name || "That computer"} is not connected.`);
      let options = input.options;
      if (!options && input.model) {
        const engines = await client!.call("engine.list", {}).then(
          (r) => r.engines,
          () => [],
        );
        const model = engines
          .find((e) => e.id === input.engine)
          ?.models.find((m) => m.id === input.model);
        if (model)
          options = {
            model: model.id,
            ...(input.effort && model.efforts.includes(input.effort)
              ? { effort: input.effort }
              : {}),
            ...(input.speed && model.speeds?.includes(input.speed) ? { speed: input.speed } : {}),
          };
      }
      const w = await client!.call("workspace.create", {
        request_id: requestId(),
        repo: input.repo,
        engine: input.engine,
        ...(input.title ? { title: input.title } : {}),
        task: { text: input.text },
        ...(options ? { options } : {}),
      });
      take(w);
      const h = held.get(w.id);
      if (h) {
        // Its first message is its first turn: at work on the phone until the runtime's own word on it comes.
        if (phaseOf(w.status) === "done") h.sentAt = now();
        show(h);
        void follow(h);
      }
      return w.id;
    },
    runInCloud: (chatId) => move(chatId, "cloud"),
    runOn: (chatId, computerId) => move(chatId, { computer_id: computerId }),
    sessionOf: (chatId) => held.get(chatId)?.workspace.session_id,
    chatOf: (sessionId) =>
      [...held.values()].find((h) => h.workspace.session_id === sessionId)?.workspace.id,
    waiting: (chatId) => held.get(chatId)?.queued !== undefined,
    queued: (chatId) => held.get(chatId)?.queued,
    refresh() {
      for (const h of held.values()) show(h);
    },
    bind(next) {
      if (closed || next === client) return;
      off?.();
      // What was followed on the runtime before is over with it: the next open follows again, on this one.
      for (const h of held.values()) {
        void h.following?.then((sub) => sub?.detach().catch(() => undefined));
        h.following = undefined;
      }
      client = next;
      off = client?.on("workspace.changed", take);
    },
    release(chatId) {
      const h = held.get(chatId);
      if (!h) return undefined;
      held.delete(chatId);
      void h.following?.then((sub) => sub?.detach().catch(() => undefined));
      const unsaid = h.transcript.unsaid();
      const queued = h.queued && waits(h.queued) ? h.queued : undefined;
      // Whoever holds it next watches the call from here on.
      h.queued = undefined;
      if (unsaid.length === 0 && !queued && !h.answering) return undefined;
      return {
        unsaid,
        queued,
        message: h.queuedMessage,
        waitSince: h.waitSince,
        sentAt: h.sentAt,
        answering: h.answering,
      };
    },
    carry(chatId, carried) {
      const h = held.get(chatId);
      if (!h || closed) return;
      h.transcript.take(carried.unsaid);
      h.sentAt = carried.sentAt;
      h.waitSince = carried.waitSince;
      h.answering = carried.answering;
      if (carried.queued) watch(h, carried.queued, carried.message);
      show(h);
    },
    chats: () => [...held.keys()],
    close() {
      if (closed) return;
      closed = true;
      off?.();
      for (const h of held.values())
        void h.following?.then((sub) => sub?.detach().catch(() => undefined));
      held.clear();
    },
  };
}
