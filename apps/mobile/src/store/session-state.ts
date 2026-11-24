// Per-chat session state, the part of a chat that is yours rather than the engine's: what you were typing, what you
// queued behind a running turn, the folds you opened or shut, where you were scrolled, and when you last read it.
// Keyed by scope: a chat's id, "new" for the new chat, and "chief:<id>" for a Chief's box. This file is the pure
// slice; the hooks screens use are in sessions.ts.
import type { SentImage } from "../board/model";
import type { Access } from "../shell/composer/menus";

/** A follow-up waiting for the running turn to end (Session Protocol `QueuedTurn`), with the pictures that go with it. */
export interface Queued {
  id: string;
  text: string;
  at: number;
  images?: readonly SentImage[];
}

export interface Session {
  draft?: string;
  queue?: readonly Queued[];
  /** Folds opened (true) or shut (false) by hand, by row id. A row not here is at its default. */
  folds?: Readonly<Record<string, boolean>>;
  /** The row at the top of the view and how far into it, so reopening lands where you were. */
  anchor?: { row: string; offset: number } | null;
  /** When you last had it open, to the millisecond. */
  lastRead?: number;
  /**
   * A box's Permissions pick, where no chat keeps it yet: what the new chat (or a workspace's) starts with, or what a
   * Chief's chats start with. A started chat keeps its own (Chat.access).
   */
  access?: Access;
  /** When any of this last changed: the newest scopes are kept when there are too many. */
  touched: number;
}

export type SessionsState = Readonly<Record<string, Session>>;

export type SessionAction =
  | { type: "session/draft"; scope: string; text: string }
  | { type: "session/queue"; scope: string; queue: readonly Queued[] }
  | { type: "session/fold"; scope: string; row: string; open: boolean | null }
  | { type: "session/anchor"; scope: string; anchor: Session["anchor"] }
  | { type: "session/read"; scope: string; at: number }
  /** A box's Permissions pick; null puts it back to what it starts with. */
  | { type: "session/access"; scope: string; access: Access | null }
  | { type: "session/forget"; scope: string };

/** The web client's limits (composer-drafts.ts): the newest 50 scopes, a draft up to 100 KB. */
const MAX_SCOPES = 50;
const MAX_DRAFT = 100_000;

function patch(state: SessionsState, scope: string, change: Partial<Session>): SessionsState {
  const was = state[scope];
  const next: Session = { ...was, ...change, touched: Date.now() };
  return { ...state, [scope]: next };
}

export function reduceSessions(state: SessionsState, action: SessionAction | { type: string }): SessionsState {
  const a = action as SessionAction;
  switch (a.type) {
    case "session/draft": {
      const text = a.text.slice(0, MAX_DRAFT);
      if ((state[a.scope]?.draft ?? "") === text) return state;
      return patch(state, a.scope, { draft: text || undefined });
    }
    case "session/queue":
      return patch(state, a.scope, { queue: a.queue.length ? a.queue : undefined });
    case "session/fold": {
      const folds = { ...state[a.scope]?.folds };
      if (a.open === null) delete folds[a.row];
      else folds[a.row] = a.open;
      return patch(state, a.scope, { folds });
    }
    case "session/anchor":
      return patch(state, a.scope, { anchor: a.anchor });
    case "session/read":
      return (state[a.scope]?.lastRead ?? 0) >= a.at ? state : patch(state, a.scope, { lastRead: a.at });
    case "session/access":
      if ((state[a.scope]?.access ?? null) === a.access) return state;
      return patch(state, a.scope, { access: a.access ?? undefined });
    case "session/forget": {
      if (!state[a.scope]) return state;
      const { [a.scope]: _, ...rest } = state;
      return rest;
    }
    default:
      return state;
  }
}

/** What goes to disk: the newest scopes, empty ones left out. A queue is never dropped while it waits to send. */
export function sessionsToDisk(state: SessionsState): SessionsState {
  const kept = Object.entries(state)
    .filter(([, s]) => s.draft || s.queue?.length || (s.folds && Object.keys(s.folds).length) || s.anchor || s.lastRead || s.access)
    .sort(([, a], [, b]) => Number(!!b.queue?.length) - Number(!!a.queue?.length) || b.touched - a.touched)
    .slice(0, MAX_SCOPES);
  return Object.fromEntries(kept);
}

const ACCESS_MODES = new Set<string>(["ask", "auto", "review", "full"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function sessionsFromDisk(data: unknown): SessionsState | null {
  if (!isObject(data)) return null;
  const out: Record<string, Session> = {};
  for (const [scope, v] of Object.entries(data)) {
    if (!isObject(v)) continue;
    const queue = Array.isArray(v.queue) ? (v.queue as unknown[]).filter((q): q is Queued => isObject(q) && typeof q.id === "string" && typeof q.text === "string" && typeof q.at === "number") : undefined;
    const folds = isObject(v.folds) ? (Object.fromEntries(Object.entries(v.folds).filter(([, o]) => typeof o === "boolean")) as Record<string, boolean>) : undefined;
    const anchor = isObject(v.anchor) && typeof v.anchor.row === "string" && typeof v.anchor.offset === "number" ? { row: v.anchor.row, offset: v.anchor.offset } : undefined;
    out[scope] = {
      draft: typeof v.draft === "string" ? v.draft : undefined,
      queue: queue?.length ? queue : undefined,
      folds,
      anchor,
      lastRead: typeof v.lastRead === "number" ? v.lastRead : undefined,
      access: typeof v.access === "string" && ACCESS_MODES.has(v.access) ? (v.access as Access) : undefined,
      touched: typeof v.touched === "number" ? v.touched : 0,
    };
  }
  return out;
}
