// Which engine the board's seams reach (board/script.ts start, send, respond, stop): the script, or the person's own
// computers once they have signed in to Caveman on this phone. Small on purpose: the script and the app's first frame
// read it, and nothing here loads the connection (link.ts does, when there is one to make).
//
// One thing is kept across launches (cc/v1/link): whether the board is the person's own. It becomes so when they sign
// in: the script stops, the scripted chats go, and the board holds their chats on every computer, as Caveman lists
// them and as last seen until it is read again. It stays theirs when they sign out (an empty list beside the sign-in
// row, never the scripted world's chats); only Settings > About's Start again puts the scripted morning back.
import { adoptDevices, type Device } from "../board/model";
import { adoptProjects } from "../board/places";
import { KEYS, read, remove, write } from "../store/persist";
import type { LiveReply } from "./transcript";

/** A computer of the person's, as Caveman Cloud lists it. */
export interface Followed {
  /** The runtime it runs as now; "" for a Cloud computer that has none (it sleeps). */
  runtime_id: string;
  computer_id: string;
  kind: "laptop" | "cloud";
  name: string;
}

/** What the person's computers take from the board's seams, for the chats that are theirs. */
export interface Runtime {
  owns(chat: string): boolean;
  send(chat: string, text: string, kind?: "steer" | "followup"): void;
  /** Sends a message that was not sent again (`item`: its id in the chat). */
  resend(chat: string, item: string): void;
  stop(chat: string): void;
  respond(chat: string, reply: LiveReply): Promise<boolean>;
  /**
   * An answer is in hand and not sent yet (the person can still take it back), or was taken back (null). Returns what
   * it reads until the chat's place has it ("Allow queued · waking Cloud") where that place cannot hear it right now;
   * null where it hears it at once.
   */
  holds(chat: string, said: "allow" | "deny" | "answer" | null): string | null;
  /** A pick in the chat's own picker: its next turns run on this agent, model, effort and speed. */
  choose(chat: string, pick: Pick<LiveStart, "engine" | "model" | "effort" | "speed">): void;
}

interface Kept {
  live: boolean;
  /** The Macs that have let this phone in: reaching one again asks its person nothing. */
  reached?: string[];
}

/** As kept now, or by a build that followed one computer at a time (`computer` beside it, which no longer means anything). */
function decode(data: unknown): Kept | null {
  const d = data as { live?: unknown; reached?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  const reached = Array.isArray(d.reached)
    ? d.reached.filter((id): id is string => typeof id === "string")
    : [];
  return { live: d.live === true, ...(reached.length > 0 ? { reached } : {}) };
}

/**
 * The board's id for a computer's chats and for the computer itself (board/model.ts Device). By its computer, not its
 * runtime: a Cloud computer runs as another runtime after every wake, and is the same computer.
 */
export const deviceIdOf = (computer: Pick<Followed, "computer_id">) =>
  `live:${computer.computer_id}`;

/** The computer a board Device stands for; null for one that is no computer of the person's (the scripted ones, Cloud as a pick). */
export const computerIdOf = (device: string): string | null =>
  device.startsWith("live:") && device !== "live:cloud" ? device.slice("live:".length) : null;

/**
 * A computer of the person's as the board's Device. A Mac goes by its own name; a Cloud computer is "Cloud", whichever
 * one it is: which computer a chat gets there is Caveman's to manage, and nobody's to read.
 */
export function deviceOf(
  computer: Followed,
  status: Device["status"],
  lastSeen = Date.now(),
): Device {
  const mac = computer.kind === "laptop";
  const about =
    status === "online"
      ? mac
        ? "Online"
        : "Running"
      : status === "starting"
        ? "Waking…"
        : status === "asleep"
          ? "Asleep"
          : "Offline";
  return {
    id: deviceIdOf(computer),
    name: mac ? computer.name : "Cloud",
    kind: mac ? "mac" : "cloud",
    status,
    lastSeen,
    about,
    ...(mac ? { form: "laptop" as const } : null),
  };
}

let kept: Kept | null = read(KEYS.link, decode);
let runtime: Runtime | null = null;
let close: (() => void) | null = null;
// A board that is the person's own shows nothing of the scripted world's from the first frame: no computer and no
// project of its, until their own are read.
if (kept?.live) {
  adoptDevices([]);
  adoptProjects([]);
}

/** Whether the board is the person's own: the script stays out of it. */
export const isLive = (): boolean => kept?.live === true;

/**
 * What the chats a chat started are called, for `n` of them: on the person's own board they are its agents, one
 * kind, never builders or subagents; the scripted world keeps its own word.
 */
export const kidsWord = (n: number, scripted: "agent" | "subagent" = "agent"): string =>
  `${isLive() ? "agent" : scripted}${n === 1 ? "" : "s"}`;

/** The board is the person's own from now on (they signed in). */
export function goLive() {
  kept = { live: true };
  write(KEYS.link, () => kept);
}

/**
 * Whether this Mac has let this phone in before. Only such a Mac is reached before the person asks for something of
 * it (what it runs, for a new chat's model): one that has not would ask its person about a phone that did nothing.
 */
export const wasReached = (computerId: string): boolean =>
  kept?.reached?.includes(computerId) === true;

/** This Mac answers this phone: it is let in, from now on. */
export function markReached(computerId: string) {
  if (!kept?.live || wasReached(computerId)) return;
  kept = { ...kept, reached: [...(kept.reached ?? []), computerId] };
  write(KEYS.link, () => kept);
}

/** The connections as the seams reach them, and how to end them; null while there are none. */
export function connected(next: { runtime: Runtime | null; close: () => void } | null) {
  runtime = next?.runtime ?? null;
  close = next?.close ?? null;
}

/** A chat to start on the person's own board: its first words, its project by name, the Device picked, who runs it. */
export interface LiveStart {
  text: string;
  repo: string;
  device?: string | undefined;
  engine: "caveman" | "claude" | "codex" | "cursor" | "opencode" | "grok";
  /** The model picked for it, by the id its place lists it under; "" for that place's own default. */
  model: string;
  /** The effort and speed picked with it. */
  effort?: string | undefined;
  speed?: string | undefined;
  /** The person picked the agent themselves (not Settings' default): it is never swapped for another the place has. */
  picked?: boolean | undefined;
}

let starter: ((start: LiveStart) => string) | null = null;

/** How a chat starts on a real computer, handed over by link.ts as it loads. */
export function startsWith(run: ((start: LiveStart) => string) | null) {
  starter = run;
}

/**
 * Starts a chat on the person's own board. Returns the id of the chat to open at once; "" when nothing was started
 * (whoever starts it says why).
 */
export const startLive = (start: LiveStart): string => starter?.(start) ?? "";

/** What reaches `chat`, when it is one of the person's computers'. */
export const runtimeOf = (chat: string): Runtime | null => (runtime?.owns(chat) ? runtime : null);

/**
 * Who a seam reaches for `chat`: the person's computers; null on the scripted board, where the script answers; or
 * "away" on the person's own board for a chat no computer of theirs holds (one still being started, or not read yet
 * since the app started). The script never plays a turn on a real chat.
 */
export const reach = (chat: string): Runtime | "away" | null =>
  runtimeOf(chat) ?? (isLive() ? "away" : null);

/** The scripted world again (Settings > About's Start again): every connection ends, and the seams are the script's. */
export function leave() {
  const end = close;
  kept = null;
  runtime = null;
  close = null;
  remove(KEYS.link);
  adoptDevices(null);
  adoptProjects(null);
  end?.();
}
