// The board: every chat with its transcript, each Chief's lines and thoughts, and what floats up (the toast, the
// moment). It was a reducer inside a hook (board/useBoard.ts); now it is a slice of the app's one store, so it outlives
// any screen and is written to disk (cc/v1/board). The scripted engine that drives it is board/script.ts.
//
// Actions are named for what happened, as the runtime will report it: a chat added or patched, items appended, steps
// joining the open run, an ask answered, a turn stopped, a line said. The reducer keeps whatever an action didn't
// touch, so one chat changing leaves every other chat (and its row on screen) as it was.
import { adoptChiefs, type Chat, type Chief, chiefForRepo, type Item, itemId, type Plan, type Said, type Step, type Toast } from "../board/model";

export interface BoardState {
  chats: readonly Chat[];
  said: readonly Said[];
  toast: Toast | null;
  /** The chat whose moment is floating up, if any. */
  momentId: string | null;
  /** What each Chief is doing right now, in a few words (its thought bubble); absent when it's quiet. */
  thinking: Readonly<Record<string, string>>;
  /** What a Chief brought up on a call, in the middle of its screen. */
  showing: { chief: string; id: string } | null;
  /** The next Chief line's or toast's number. */
  seq: number;
  /** The next pull request the script opens. */
  pr: number;
  /** The morning's greetings have been said (so a relaunch doesn't say them again). */
  greeted: boolean;
  /** The Chiefs made on the phone (New Chief), after the seeded ones, in the order they were made. */
  chiefs: readonly Chief[];
}

export type BoardAction =
  | { type: "advance" }
  /** `clear` drops fields, since a plan on disk can't carry `undefined` (JSON leaves it out). */
  | { type: "update"; id: string; patch: Partial<Chat>; clear?: readonly (keyof Chat)[] }
  /** A computer's chat as its words arrive (live/source.ts): its transcript and live line, never worth a write to disk by itself. */
  | { type: "live"; id: string; patch: Partial<Chat> }
  | { type: "add"; chat: Chat }
  | { type: "remove"; id: string }
  | { type: "append"; id: string; items: Item[] }
  /** Steps join the chat's open work group; `close` ends it. With no group open (or `open`), a new one starts. */
  | { type: "work"; id: string; steps: Step[]; close?: boolean; open?: boolean }
  | { type: "answer"; id: string; answer: "allowed" | "denied" }
  /** A message you sent reached the engine: "Sending" under it goes. */
  | { type: "ack"; id: string; item: string }
  /** You stopped the turn: its run closes, a stop line lands, the chat rests. */
  | { type: "stop"; id: string }
  /** The scripted turn a chat plays out, or how far it got. */
  | { type: "plan"; id: string; plan: Plan | undefined }
  /** A line in a Chief's chat; a chat of your own (no Chief) has nobody to say it, so it is dropped. */
  | { type: "say"; chief: string | null; who: Said["who"]; text: string; images?: Said["images"] }
  | { type: "think"; chief: string; text: string | null }
  | { type: "show"; showing: BoardState["showing"] }
  | { type: "toast"; text: string; tone: Toast["tone"]; chief?: string | null; chat?: string }
  | { type: "moment"; id: string | null }
  | { type: "greeted" }
  /** A Chief made with New Chief: it joins the end of the list, above New Chief. */
  | { type: "chief/add"; chief: Chief }
  | { type: "pr" };

/** Each Chief keeps its own last lines; a busy one never pushes another's out. */
const LINES_PER_CHIEF = 80;

export function boardOf(chats: readonly Chat[], said: readonly Said[] = [], chiefs: readonly Chief[] = []): BoardState {
  // The model's one list of Chiefs follows the board's (board/model.ts adoptChiefs).
  adoptChiefs(chiefs);
  return { chats, said, toast: null, momentId: null, thinking: {}, showing: null, seq: said.reduce((n, l) => Math.max(n, l.id + 1), 1), pr: 482, greeted: false, chiefs };
}

function touched(chat: Chat, items: readonly Item[], now = Date.now()): Chat {
  return { ...chat, items, updatedAt: now };
}

function reduceChat(chat: Chat, action: BoardAction): Chat {
  const now = Date.now();
  switch (action.type) {
    case "update": {
      // A new phase is news (lists sort by it); a new live line or plan step is not.
      const moved = action.patch.phase !== undefined && action.patch.phase !== chat.phase;
      const next: Chat = { ...chat, ...action.patch, ...(moved ? { updatedAt: now } : null) };
      for (const key of action.clear ?? []) delete next[key];
      // The agent uses its browser or desktop only during a turn: once it stops working, it has let go of them.
      if (moved && next.phase !== "working") delete next.using;
      return next;
    }
    case "live":
      return { ...chat, ...action.patch };
    case "append":
      return touched(chat, [...chat.items, ...action.items], now);
    case "work": {
      const open = chat.items.findLastIndex((item) => item.kind === "work" && !item.endedAt);
      if (open < 0 || action.open) {
        const fresh: Item = { kind: "work", id: itemId(), steps: action.steps, startedAt: now, endedAt: action.close ? now : undefined };
        return touched(chat, [...chat.items, fresh], now);
      }
      return touched(
        chat,
        chat.items.map((item, i) => (i === open && item.kind === "work" ? { ...item, steps: [...item.steps, ...action.steps], endedAt: action.close ? now : undefined } : item)),
        now,
      );
    }
    case "answer":
      return touched(
        chat,
        chat.items.map((item) => (item.kind === "ask" && !item.answer ? { ...item, answer: action.answer } : item)),
        now,
      );
    case "ack":
      return { ...chat, items: chat.items.map((item) => (item.id === action.item && item.kind === "you" ? { ...item, state: "sent" } : item)) };
    case "stop": {
      // Its open run ends where it was, and an ask it was waiting on is answered no.
      const items = chat.items.map((item) =>
        item.kind === "work" && !item.endedAt ? { ...item, endedAt: now } : item.kind === "ask" && !item.answer ? { ...item, answer: "denied" as const } : item,
      );
      return { ...touched(chat, [...items, { kind: "stop", id: itemId(), at: now }], now), phase: "done", line: "Stopped", script: undefined, step: undefined, plan: undefined, ask: undefined, using: undefined };
    }
    case "plan":
      return { ...chat, plan: action.plan };
    default:
      return chat;
  }
}

export function reduceBoard(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case "advance": {
      let moved = false;
      const chats = state.chats.map((chat) => {
        if (chat.phase !== "working" || !chat.script?.length) return chat;
        moved = true;
        const step = ((chat.step ?? -1) + 1) % chat.script.length;
        return { ...chat, step, line: chat.script[step] ?? chat.line };
      });
      return moved ? { ...state, chats } : state;
    }
    case "add":
      return { ...state, chats: [action.chat, ...state.chats] };
    case "remove":
      return state.chats.some((c) => c.id === action.id)
        ? {
            ...state,
            chats: state.chats.filter((c) => c.id !== action.id),
            momentId: state.momentId === action.id ? null : state.momentId,
            showing: state.showing?.id === action.id ? null : state.showing,
          }
        : state;
    case "say": {
      if (!action.chief) return state;
      const chief = action.chief;
      const line: Said = { id: state.seq, chief, who: action.who, text: action.text, at: Date.now(), ...(action.images?.length ? { images: action.images } : null) };
      // A Chief that says again what it already said (a chat ready a second time) moves that line to now, so the chat
      // never reads "is ready to try" twice in a row.
      const again = action.who === "chief" ? state.said.find((l) => l.chief === chief && l.who === "chief" && l.text === action.text) : undefined;
      const kept = again ? state.said.filter((l) => l !== again) : state.said;
      const mine = kept.filter((l) => l.chief === chief);
      const said = mine.length >= LINES_PER_CHIEF ? kept.filter((l) => l !== mine[0]) : kept;
      return { ...state, seq: state.seq + 1, said: [...said, line] };
    }
    case "think": {
      if ((state.thinking[action.chief] ?? null) === action.text) return state;
      const { [action.chief]: _, ...rest } = state.thinking;
      return { ...state, thinking: action.text ? { ...rest, [action.chief]: action.text } : rest };
    }
    case "show":
      return { ...state, showing: action.showing };
    case "toast":
      return { ...state, seq: state.seq + 1, toast: { id: state.seq, text: action.text, tone: action.tone, chief: action.chief ?? undefined, chat: action.chat } };
    case "moment":
      return state.momentId === action.id ? state : { ...state, momentId: action.id };
    case "greeted":
      return state.greeted ? state : { ...state, greeted: true };
    case "chief/add": {
      if (state.chiefs.some((c) => c.id === action.chief.id)) return state;
      const chiefs = [...state.chiefs, action.chief];
      adoptChiefs(chiefs);
      return { ...state, chiefs };
    }
    case "pr":
      return { ...state, pr: state.pr + 1 };
    case "update":
    case "live":
    case "append":
    case "work":
    case "answer":
    case "ack":
    case "stop":
    case "plan": {
      const i = state.chats.findIndex((c) => c.id === action.id);
      const chat = state.chats[i];
      if (!chat) return state;
      const next = reduceChat(chat, action);
      if (next === chat) return state;
      const chats = state.chats.slice();
      chats[i] = next;
      return { ...state, chats };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------- on disk

/** What goes to disk: the chats and lines and the script's counters, never what is only floating up right now. */
export function boardToDisk(state: BoardState) {
  return { chats: state.chats, said: state.said, seq: state.seq, pr: state.pr, greeted: state.greeted, chiefs: state.chiefs };
}

const PHASES = new Set(["needs", "ready", "working", "done"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A chat read back from disk, or null when it isn't one (then only that chat is dropped). */
function chatFromDisk(v: unknown): Chat | null {
  if (!isObject(v)) return null;
  if (typeof v.id !== "string" || typeof v.title !== "string" || typeof v.repo !== "string" || typeof v.engine !== "string" || typeof v.model !== "string") return null;
  if (typeof v.phase !== "string" || !PHASES.has(v.phase) || !Array.isArray(v.items) || typeof v.startedAt !== "number") return null;
  const items = (v.items as unknown[]).filter((item): item is Item => isObject(item) && typeof item.id === "string" && typeof item.kind === "string");
  const chat = v as unknown as Chat;
  // A chat saved before chats knew their Chief is on the one that watches its workspace, as it was then.
  const chief = typeof v.chief === "string" || v.chief === null ? (v.chief as string | null) : chiefForRepo(chat.repo);
  return { ...chat, chief, items, line: typeof v.line === "string" ? v.line : "", device: typeof v.device === "string" ? v.device : "mbp", updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : chat.startedAt };
}

export function boardFromDisk(data: unknown): BoardState | null {
  if (!isObject(data) || !Array.isArray(data.chats)) return null;
  const chats = data.chats.map(chatFromDisk).filter((c): c is Chat => c !== null);
  const said = Array.isArray(data.said)
    ? (data.said as unknown[]).filter((l): l is Said => isObject(l) && typeof l.id === "number" && typeof l.chief === "string" && typeof l.text === "string" && typeof l.at === "number")
    : [];
  const chiefs = Array.isArray(data.chiefs)
    ? (data.chiefs as unknown[]).filter((c): c is Chief => isObject(c) && typeof c.id === "string" && typeof c.name === "string" && typeof c.character === "string" && typeof c.tone === "string" && (c.projects === null || Array.isArray(c.projects)))
    : [];
  const state = boardOf(chats, said, chiefs);
  return {
    ...state,
    seq: typeof data.seq === "number" ? Math.max(data.seq, state.seq) : state.seq,
    pr: typeof data.pr === "number" ? data.pr : state.pr,
    greeted: data.greeted === true,
  };
}
