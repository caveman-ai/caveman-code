// A step's intent, written ahead of its effect (docs/ SPEC §7.3, finding R11;
// formal/NothingLost.tla's Intent with WriteAhead, and its NoSilentRerun). Before a command or an outside tool runs in
// a chat another computer may carry on from Cloud's copy, the gate (engine-core ToolGate, session-protocol/handlers.ts)
// puts the step's intent into that copy: one line saying what was about to run. The copy keeps it until it also holds
// the step's result. A chat that lands from a copy holding an intent and no result for it is told so, step by step:
// "this may or may not have finished: check before doing it again".
//
// This file is the bookkeeping, with no I/O: what an intent is, when it closes, what a copy's head says of them and
// what the computer a chat lands on makes of that.
import type { SessionEvent } from "@caveman-app/session-protocol";

/** One step about to run, as the copy carries it. */
export interface ToolIntent {
  /** The turn items the step shows as: its result in the journal is a tool.done of one of them. */
  readonly items: ReadonlyArray<string>;
  /** What was about to run, in one line (the command, the tool and its target), secrets cut. */
  readonly title: string;
  /** When the gate let it through (ISO). */
  readonly at: string;
}

/** An intent as the computer running the step holds it. */
export interface OpenIntent extends ToolIntent {
  /**
   * The cursor from which the journal says how it ended: its tool.done, or the end of its turn. A copy through that
   * cursor holds its result and names the intent no more.
   */
  readonly closed?: number;
  /** A segment whose head named it reached Cloud's copy. */
  readonly copied?: boolean;
}

/** A copy's head names at most this many (a turn rarely holds more than a few open at once; the latest win). */
export const INTENTS_MAX = 32;
const TITLE_MAX = 300;

export const intentTitle = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/**
 * The switch a test turns off to show the findings (NothingLost.tla's WriteAhead = FALSE): with CAVEMAN_TOOL_GATE=off
 * the gate answers nothing, so no intent is written ahead and no tool is held, as before it. Read when the runtime starts.
 */
export const toolGateOn = (env: NodeJS.ProcessEnv = process.env) => env.CAVEMAN_TOOL_GATE !== "off";

/**
 * The intents after `event` reached the journal: a tool.done closes its step's; a turn that ended by itself closes all
 * of its own (every step of it ended); a turn that was stopped leaves them open, for wherever it carries on; the next
 * turn's start closes what is left (that turn was told). An event older than an intent never closes it: the journal
 * can run behind the gate.
 */
export function intentsAfter(
  intents: ReadonlyArray<OpenIntent>,
  event: SessionEvent,
): ReadonlyArray<OpenIntent> {
  if (intents.length === 0) return intents;
  const before = (intent: OpenIntent) => Date.parse(intent.at) <= Date.parse(event.at);
  if (event.type === "tool.done" && event.item_id !== undefined) {
    const id = event.item_id;
    return intents.map((intent) =>
      intent.closed === undefined && intent.items.includes(id)
        ? { ...intent, closed: event.cursor }
        : intent,
    );
  }
  if (
    event.type === "turn.started" ||
    (event.type === "turn.done" && event.payload.status !== "interrupted")
  )
    return intents.map((intent) =>
      intent.closed === undefined && before(intent) ? { ...intent, closed: event.cursor } : intent,
    );
  return intents;
}

/** What a segment that carries the journal through `through` says of them: each whose result it does not hold. */
export function intentsFor(
  intents: ReadonlyArray<OpenIntent>,
  through: number,
): ReadonlyArray<ToolIntent> {
  return intents
    .filter((intent) => intent.closed === undefined || intent.closed > through)
    .slice(-INTENTS_MAX)
    .map(({ items, title, at }) => ({ items, title, at }));
}

/** The intents a copy through `cursor` no longer needs to name: it holds how each ended. */
export const intentsKept = (
  intents: ReadonlyArray<OpenIntent>,
  cursor: number,
): ReadonlyArray<OpenIntent> =>
  intents.filter((intent) => intent.closed === undefined || intent.closed > cursor);

/** A copy's intents as it carries them (a copy from before them: none), ignoring anything that is not one. */
export function readIntents(raw: unknown): ReadonlyArray<ToolIntent> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const intent = item as { items?: unknown; title?: unknown; at?: unknown } | null;
    if (
      intent === null ||
      typeof intent !== "object" ||
      typeof intent.title !== "string" ||
      !Array.isArray(intent.items)
    )
      return [];
    return [
      {
        items: intent.items.filter((id): id is string => typeof id === "string"),
        title: intent.title,
        at: typeof intent.at === "string" ? intent.at : "",
      },
    ];
  });
}

/**
 * The steps a copy says were about to run and holds no result for: none of the step's items has a tool.done among the
 * copy's events. These may have run to their end, run in part, or never started.
 */
export function unresolvedIntents(
  intents: ReadonlyArray<ToolIntent>,
  events: ReadonlyArray<SessionEvent>,
): ReadonlyArray<ToolIntent> {
  if (intents.length === 0) return [];
  const done = new Set(
    events.flatMap((event) =>
      event.type === "tool.done" && event.item_id !== undefined ? [event.item_id] : [],
    ),
  );
  return intents.filter((intent) => !intent.items.some((id) => done.has(id)));
}

/** What an agent is told of a step with an intent and no result. */
export const MAY_HAVE_RUN = "this may or may not have finished: check before doing it again";

/** The paragraph that names them, for the note a chat carries on with; undefined when there are none. */
export function intentsParagraph(intents: ReadonlyArray<ToolIntent>): string | undefined {
  if (intents.length === 0) return undefined;
  return [
    "These steps were started, and this chat's copy holds no result for them. For each, this may or may not have finished: check before doing it again.",
    ...intents.map((intent) => `- ${intentTitle(intent.title).slice(0, 160)}`),
  ].join("\n");
}
