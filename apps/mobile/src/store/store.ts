// The app's one durable store: the board (chats, transcripts, Chief lines), the inbox (read, done, snoozed, renamed,
// archived) and each chat's session (draft, queue, folds, scroll, last read), read from disk before the first frame
// and written back a moment after each change. Beside them, when you were last away and whether you've read what
// happened meanwhile (store/away.ts). Screens read it with `useStore(pick)`; the scripted engine
// (board/script.ts) and, later, the runtime source dispatch into it. Nothing here waits: a first launch builds the
// scripted world, every launch after reads what was left.
import { AWAY_SEED_MS, withBriefingSeed } from "../board/briefing-seed";
import { world } from "../board/world";
import { type AwayAction, type AwayState, awayFromDisk, EMPTY_AWAY, reduceAway } from "./away";
import { type BoardAction, type BoardState, boardFromDisk, boardOf, boardToDisk, reduceBoard } from "./board";
import { createStore, useSelector } from "./core";
import { EMPTY_INBOX, type InboxAction, type InboxState, inboxFromDisk, reduceInbox, trackSince } from "./inbox";
import { clearPersisted, KEYS, read, write } from "./persist";
import { reduceSessions, type SessionAction, type SessionsState, sessionsFromDisk, sessionsToDisk } from "./session-state";

export interface AppState {
  board: BoardState;
  inbox: InboxState;
  sessions: SessionsState;
  away: AwayState;
}

export type AppAction = BoardAction | InboxAction | SessionAction | AwayAction;

function reduce(state: AppState, action: AppAction): AppState {
  let board = reduceBoard(state.board, action as BoardAction);
  let inbox = reduceInbox(state.inbox, action);
  let sessions = reduceSessions(state.sessions, action);
  const away = reduceAway(state.away, action);
  if (board.chats !== state.board.chats) inbox = trackSince(inbox, state.board.chats, board.chats);
  // Pinning promotes a chat, as the desktop's inbox does: it leaves the Done and Snoozed shelves for Pinned. Mark done
  // takes the pin off, as the runtime's settle clears pinnedAt (Orchestrator thread.settle, inbox-state.ts applyInbox).
  if (action.type === "update" && action.patch.pinned === true && board !== state.board) {
    inbox = reduceInbox(reduceInbox(inbox, { type: "inbox/wake", id: action.id }), { type: "inbox/reopen", id: action.id, phase: board.chats.find((c) => c.id === action.id)?.phase ?? "working" });
  }
  if (action.type === "inbox/done" && inbox !== state.inbox && board.chats.some((c) => c.id === action.id && c.pinned)) {
    board = reduceBoard(board, { type: "update", id: action.id, patch: { pinned: false } });
  }
  // A chat the board let go takes its marks and its draft with it.
  if (action.type === "remove" && board !== state.board) {
    inbox = reduceInbox(inbox, { type: "inbox/forget", id: action.id });
    sessions = reduceSessions(sessions, { type: "session/forget", scope: action.id });
  }
  if (board === state.board && inbox === state.inbox && sessions === state.sessions && away === state.away) return state;
  return { board, inbox, sessions, away };
}

/** The scripted world as it is on a first launch, around `now`. */
export function freshState(now = Date.now()): AppState {
  const w = world(now);
  const sessions: SessionsState = Object.fromEntries(Object.entries(w.queues).map(([scope, queue]) => [scope, { queue, touched: now }]));
  // The scripted morning comes back to a briefing: you left a while ago and things happened meanwhile, a merge and what
  // the Chiefs decided on their own among them (board/briefing-seed.ts).
  const { chats, said } = withBriefingSeed(w.chats, w.said, now);
  return { board: boardOf(chats, said), inbox: EMPTY_INBOX, sessions, away: { leftAt: null, briefing: { from: now - AWAY_SEED_MS, to: now } } };
}

/** This launch built the scripted world, or settled what it read (an archive made final): write it back at once. */
let unsaved = false;

/** What was left on disk, or the scripted world when there is nothing (or nothing readable) there. */
function restore(): AppState {
  const board = read(KEYS.board, boardFromDisk);
  // Without a board, marks and drafts would point at chats that aren't there: the whole world starts fresh.
  if (!board) {
    unsaved = true;
    return freshState();
  }
  let state: AppState = {
    board,
    inbox: read(KEYS.inbox, inboxFromDisk) ?? EMPTY_INBOX,
    sessions: read(KEYS.sessions, sessionsFromDisk) ?? {},
    // Opening the app is coming back to it: a long enough absence since it last went out of sight is a briefing.
    away: reduceAway(read(KEYS.away, awayFromDisk) ?? EMPTY_AWAY, { type: "away/back", at: Date.now() }),
  };
  // An archive still waiting on its Undo when the app closed is final now.
  const archived = Object.keys(state.inbox.archived);
  if (!archived.length) return state;
  unsaved = true;
  for (const id of archived) state = reduce(state, { type: "remove", id });
  return { ...state, inbox: { ...state.inbox, archived: {} } };
}

export const store = createStore<AppState, AppAction>(restore(), reduce);

/** A slice of the store, re-rendered only when it changes (see core.ts `useSelector`; pass `shallow` for lists). */
export function useStore<T>(pick: (state: AppState) => T, equal?: (a: T, b: T) => boolean): T {
  return useSelector(store, pick, equal);
}

export const dispatch = (action: AppAction) => store.dispatch(action);

// What only floats up for a moment (a toast, the moment card, a Chief's thought) or a live line moving on is never
// worth a write; everything else is, a moment later, together.
const PASSING = new Set<AppAction["type"]>(["advance", "live", "toast", "moment", "show", "think"]);

store.watch((next, prev, action) => {
  if (action && PASSING.has(action.type)) return;
  if (next.board !== prev.board) write(KEYS.board, () => boardToDisk(store.get().board));
  if (next.inbox !== prev.inbox) write(KEYS.inbox, () => store.get().inbox);
  if (next.sessions !== prev.sessions) write(KEYS.sessions, () => sessionsToDisk(store.get().sessions));
  if (next.away !== prev.away) write(KEYS.away, () => store.get().away);
});

// A first launch writes its world at once, so a reload in the first seconds doesn't build a different one.
if (unsaved) {
  write(KEYS.board, () => boardToDisk(store.get().board));
  write(KEYS.inbox, () => store.get().inbox);
  write(KEYS.sessions, () => sessionsToDisk(store.get().sessions));
}
// Opening the app settled when you were away (a briefing opened, or the time you left cleared): kept at once, so a
// reload in the next moment doesn't count the same absence again.
write(KEYS.away, () => store.get().away);

/**
 * An empty board in place of the scripted world, for a computer's own chats (live/link.ts fills it from the runtime):
 * the scripted chats go, with their marks and drafts. Leaving that computer puts the scripted world back (resetDemo).
 */
export function clearForLive() {
  store.replace({ board: boardOf([]), inbox: EMPTY_INBOX, sessions: {}, away: EMPTY_AWAY });
}

/** Forgets everything on disk and puts the scripted world back. The script restarts it (board/script.ts resetDemo). */
export function resetStore(now = Date.now()) {
  clearPersisted();
  store.replace(freshState(now));
}
