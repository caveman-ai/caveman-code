// When you were last away from the app, kept in the store and on disk (cc/v1/away), so Home can say what happened
// while you were gone (home/Briefing.tsx, screens/Briefing.tsx). Leaving notes the time (the app going to the
// background, the web tab hiding); coming back after AWAY_MS or more opens a briefing over that stretch of time, and
// reading it (opening it, or acting on Home) closes it. What the briefing holds is never stored: it is read from the
// chats' own last changes and the read marks (store/briefing.ts), so it can't disagree with the rest of the app.

/** How long you must have been gone for Home to brief you on it. */
export const AWAY_MS = 30 * 60_000;

export interface AwayState {
  /** When the app last went out of sight; null while it is in front. */
  leftAt: number | null;
  /** The stretch you were away for, from leaving to coming back, until you have read what happened in it. */
  briefing: { from: number; to: number } | null;
}

export const EMPTY_AWAY: AwayState = { leftAt: null, briefing: null };

export type AwayAction =
  | { type: "away/leave"; at: number }
  | { type: "away/back"; at: number }
  /** The briefing was read: Home's title comes back. */
  | { type: "away/read" }
  /** Development and the scripted world: as if you had been away from `from` until now. */
  | { type: "away/brief"; from: number; to: number };

export function reduceAway(state: AwayState, action: AwayAction | { type: string }): AwayState {
  const a = action as AwayAction;
  switch (a.type) {
    case "away/leave":
      return state.leftAt === null ? { ...state, leftAt: a.at } : state;
    case "away/back": {
      if (state.leftAt === null) return state;
      const gone = a.at - state.leftAt;
      const was = state.briefing;
      // Long enough to brief: from when you left, or from the start of a briefing still unread, so a second absence
      // adds to the first instead of hiding it.
      if (gone >= AWAY_MS) return { leftAt: null, briefing: { from: was ? Math.min(was.from, state.leftAt) : state.leftAt, to: a.at } };
      // A short look away: an unread briefing reaches to now, so what landed meanwhile is in it too.
      return { leftAt: null, briefing: was ? { ...was, to: a.at } : null };
    }
    case "away/read":
      return state.briefing ? { ...state, briefing: null } : state;
    case "away/brief":
      return { leftAt: null, briefing: { from: a.from, to: a.to } };
    default:
      return state;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function awayFromDisk(data: unknown): AwayState | null {
  if (!isObject(data)) return null;
  const leftAt = typeof data.leftAt === "number" ? data.leftAt : null;
  const b = data.briefing;
  const briefing = isObject(b) && typeof b.from === "number" && typeof b.to === "number" && b.from <= b.to ? { from: b.from, to: b.to } : null;
  return { leftAt, briefing };
}
