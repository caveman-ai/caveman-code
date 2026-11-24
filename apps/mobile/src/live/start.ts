// A chat started from the phone: a project, a place (one of the person's Macs, or Cloud), and its first message.
//
//   on a Mac    workspace.create on that Mac's runtime, through the device connection: in the project's folder there,
//               or cloned from GitHub when the Mac has no checkout of it.
//   in Cloud    POST /code/workspaces first, as the web does: Cloud picks the project's Cloud computer (waking it) or
//               makes one, and says which. The phone then follows that computer by its id to whichever runtime it
//               wakes as, and starts the chat there with workspace.create.
//
// The chat is on the board from the tap: your message in it, and under it the one line that says what it waits for
// ("Waking Cloud…", its seconds counted by whoever draws it), so the wait never looks stuck and nothing says "Working"
// before anything works. Once its place answers, the chat starts on what that place runs (`settle`): the agent and
// model picked where it has them, never one it lacks. Once its place has made the chat, the real one takes its place
// and its transcript streams.
//
// If it cannot start, your message stays where it is, marked as not sent, with one line under it, the web's: "The
// chat didn't start: <one sentence>", and Try again and Discard at the foot (Discard puts the message back in the
// New chat box). A start Caveman could not be reached for, or that Cloud had no room for ("Cloud is busy. Trying
// again."), is tried again by itself first, a bounded number of times.
//
// No import from the app, so its tests run it as it is; link.ts hands it Cloud, the board and the connection.
import type { Board, LiveChat, LiveSource, StartInput } from "./source.ts";
import {
  CLOUD_BUSY,
  CLOUD_FAILED,
  CLOUD_NEEDS_GITHUB,
  cloudFull,
  passes,
  startFailure,
  WAKING_CLOUD,
} from "./words.ts";

/**
 * What a chat being started is called on the board until its computer has made it: never a workspace's id, so no
 * computer's list takes it off the board and nothing is sent to it.
 */
export const STARTING = "starting:";
export const isStarting = (chatId: string) => chatId.startsWith(STARTING);

export interface StartRequest {
  readonly text: string;
  readonly title: string;
  /** The project: its name as chats know it, its repository on GitHub (owner/name) and its folder on the Mac, whichever it has. */
  readonly project: {
    readonly name: string;
    readonly github?: string | undefined;
    readonly path?: string | undefined;
  };
  readonly engine: LiveChat["engine"];
  /** The model picked, by its engine's id for it; "" for the computer's default (source.ts StartInput.model). */
  readonly model: string;
  /** The effort and speed picked with it; each is the chat's where the model offers it. */
  readonly effort?: string | undefined;
  readonly speed?: string | undefined;
  /** The person picked this agent themselves: it is never swapped for another the place has (`settle`). */
  readonly picked?: boolean | undefined;
  /** Where it runs: one of the person's Macs, or Cloud (which computer is Cloud's choice). */
  readonly on:
    | { readonly kind: "mac"; readonly computer_id: string; readonly name: string }
    | { readonly kind: "cloud" };
}

export interface StartWith {
  readonly board: Board;
  /** The board's id for a computer's chats; null: Cloud, before Cloud has said which computer. */
  readonly device: (computerId: string | null) => string;
  /** POST /code/workspaces (cloud.ts startInCloud). */
  readonly startInCloud: (input: {
    readonly title: string;
    readonly repo: string;
    readonly engine: string;
  }) => Promise<{ readonly computer_id: string }>;
  /**
   * The computer's chats once this phone is connected to it and it answers. `said` is told what the wait is for, as it
   * changes. Rejects with why when the computer will not come (asleep, held, not allowed).
   */
  readonly reach: (
    computerId: string,
    said: (line: string) => void,
  ) => Promise<Pick<LiveSource, "start">>;
  /**
   * The pick as the place takes it, asked once the place answers: the agent and model the chat starts on there.
   * Rejects with why when the place has nothing to run it on. Absent: as picked.
   */
  readonly settle?: (
    computerId: string,
    pick: Pick<StartRequest, "engine" | "model" | "picked">,
  ) => Promise<Pick<StartRequest, "engine" | "model">>;
  /** The computer made the chat: `real` is its id there, and takes `placeholder`'s place. */
  readonly onStarted: (placeholder: string, real: string) => void;
  /**
   * It did not start: `placeholder` keeps the message, marked as not sent, with `why` under it. `again`: trying
   * again can work (false for what no second try changes: a project its place cannot take).
   */
  readonly onFailed: (placeholder: string, text: string, why: string, again: boolean) => void;
  /** What a failure says to the person (words.ts startWords); default: its own message. */
  readonly words?: (
    error: unknown,
    where: { readonly name: string; readonly cloud: boolean },
  ) => string;
  /** Whether a second try of the same start can work; default: it can. */
  readonly retries?: (error: unknown) => boolean;
  /** How long to wait before a start Caveman could not be reached for is tried again (tests wait less). */
  readonly again?: number;
  readonly now?: () => number;
}

/** How often a start that Caveman could not be reached for is tried again before the chat says it did not start. */
const TRIES = 3;
/**
 * How often a start Cloud had no room for is tried in all before the chat says so. Cloud's own client will try
 * again by itself; until it does, the phone does, this many times and no more.
 */
const BUSY_TRIES = 6;

/** The board's engines as Session Protocol names them. */
export const ENGINE_ID: Record<LiveChat["engine"], StartInput["engine"]> = {
  caveman: "caveman",
  claude: "claude-agent",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
};

/** Why this chat cannot start there, known before anyone is asked; null when it can be tried. */
export function cannotStart(request: Pick<StartRequest, "project" | "on">): string | null {
  const { project, on } = request;
  if (on.kind === "cloud") return project.github ? null : CLOUD_NEEDS_GITHUB;
  return project.path || project.github
    ? null
    : `${on.name} doesn't have ${project.name}. Add it there first.`;
}

/** A chat that did not start: still the placeholder, at rest, with why under its message. */
export const didNotStart = (chat: { readonly id: string; readonly phase: string }) =>
  isStarting(chat.id) && chat.phase === "done";

/** Starts the chat. Returns the placeholder's id at once, for the screen to open. */
export function startChat(request: StartRequest, a: StartWith): string {
  const now = a.now ?? Date.now;
  const { project, on } = request;
  const id = `${STARTING}${globalThis.crypto.randomUUID()}`;
  const at = now();
  const chat: LiveChat = {
    id,
    title: request.title,
    repo: project.name,
    device: a.device(on.kind === "mac" ? on.computer_id : null),
    chief: null,
    engine: request.engine,
    model: request.model,
    phase: "working",
    line: on.kind === "mac" ? "Sending" : WAKING_CLOUD,
    // Nothing runs yet: the message's own line says what it waits for.
    wait: { words: on.kind === "mac" ? "Sending" : WAKING_CLOUD, since: at },
    items: [{ kind: "you", id: `${id}:first`, text: request.text, at, state: "sending" }],
    startedAt: at,
    updatedAt: at,
  };
  a.board.dispatch({ type: "add", chat });
  const here = () => a.board.chats().some((c) => c.id === id);
  const where = { name: on.kind === "mac" ? on.name : "Cloud", cloud: on.kind === "cloud" };
  const fail = (said: string, again: boolean) => {
    // Let go of meanwhile: there is nothing to say it under, and nobody waiting to hear why.
    if (!here()) return;
    // One line, the web's: what did not happen, and why in one sentence.
    const why = startFailure(said);
    // What was typed stays, marked as not sent: only its person takes it back. So does anything typed under it
    // while it was being started.
    const held = (a.board.chats().find((c) => c.id === id)?.items ?? []) as LiveChat["items"];
    const under = held.flatMap((item) =>
      item.kind === "you" && item.id !== `${id}:first`
        ? [{ ...item, state: "failed" as const }]
        : [],
    );
    const items: LiveChat["items"] = [
      { kind: "you", id: `${id}:first`, text: request.text, at, state: "failed" },
      ...under,
      { kind: "text", id: `${id}:why`, text: why, at: now() },
    ];
    a.board.dispatch({
      type: "update",
      id,
      patch: { phase: "done", line: "Not sent", items, updatedAt: now() },
      clear: ["wait"],
    });
    a.onFailed(id, request.text, why, again);
  };
  const refused = cannotStart(request);
  if (refused) {
    // No second try changes what the project is: only Discard is offered.
    fail(refused, false);
    return id;
  }
  const said = (line: string) =>
    void (
      here() &&
      a.board.dispatch({ type: "update", id, patch: { line, wait: { words: line, since: at } } })
    );
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const url = project.github ? `https://github.com/${project.github}` : undefined;

  void (async () => {
    let unreached = 0;
    let full = 0;
    for (;;) {
      try {
        let computerId: string;
        let repo: StartInput["repo"];
        if (on.kind === "mac") {
          computerId = on.computer_id;
          // Its own checkout where the Mac has one; else the Mac clones it.
          repo = project.path ? { path: project.path } : { url: url! };
        } else {
          const made = await a.startInCloud({
            title: request.title,
            repo: project.github!,
            engine: ENGINE_ID[request.engine],
          });
          // Let go of while Cloud answered: no computer is woken for a chat nobody waits for.
          if (!here()) return;
          computerId = made.computer_id;
          repo = { url: url! };
        }
        const source = await a.reach(computerId, said);
        // Archived while it waited: nothing is started for a chat its person let go.
        if (!here()) return;
        // The place answers: the chat starts on what it runs, and says so from now on.
        const pick = a.settle
          ? await a.settle(computerId, {
              engine: request.engine,
              model: request.model,
              picked: request.picked,
            })
          : request;
        if (!here()) return;
        if (pick.engine !== request.engine || pick.model !== request.model)
          a.board.dispatch({
            type: "update",
            id,
            patch: { engine: pick.engine, model: pick.model },
          });
        const real = await source.start({
          repo,
          engine: ENGINE_ID[pick.engine],
          text: request.text,
          title: request.title,
          ...(pick.model
            ? {
                model: pick.model,
                ...(request.effort ? { effort: request.effort } : {}),
                ...(request.speed ? { speed: request.speed } : {}),
              }
            : {}),
        });
        return a.onStarted(id, real);
      } catch (error) {
        if (!here()) return;
        // Cloud has no room for it right now: tried again by itself, and the wait says so.
        if (cloudFull(error) && ++full < BUSY_TRIES) {
          said(CLOUD_BUSY);
          await sleep(a.again ?? 5_000);
          if (!here()) return;
          continue;
        }
        // Caveman could not be reached, or could not start Cloud: tried again by itself, and the wait says so.
        if (passes(error) && ++unreached < TRIES) {
          said(on.kind === "mac" ? "No network. Sends when you're back online." : CLOUD_FAILED);
          await sleep((a.again ?? 3_000) * unreached);
          if (!here()) return;
          continue;
        }
        return fail(
          a.words ? a.words(error, where) : error instanceof Error ? error.message : String(error),
          a.retries?.(error) ?? true,
        );
      }
    }
  })();
  return id;
}
