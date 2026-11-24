// Every sentence the phone says about where a chat runs, in the one vocabulary (cloud-computers words): a chat runs on
// a Mac of the person's, by that Mac's own name, or in Cloud. Never a machine's name, size or kind; never a verb for a
// machine (wake, connect, open). A place has one state word (Running, Asleep, Waking…, Paused until <reset> · plan
// used up; a Mac: Online, Asleep, Offline), a wait is one line with its seconds ("Waking Cloud… 8s"), and a refusal is
// one sentence that says what to do and where.
//
// Pure: what Cloud lists and what a connection is doing go in, words come out, so words.test.ts pins every one of
// them. No import from the app; the runtime's tests can read it too.
import type { CloudChat, Computer, QueuedCall } from "./cloud.ts";

/** Cloud, as the one place it is: never one of its computers by name. */
export const CLOUD_NAME = "Cloud";

/** What a row and a chat call the place a chat runs: the Mac's own name, or "Cloud". */
export const whereName = (
  computer: { readonly kind: "laptop" | "cloud"; readonly name: string } | undefined,
): string => (!computer || computer.kind === "cloud" ? CLOUD_NAME : computer.name || "Mac");

/** A row's mark for where its chat runs, in the web's words (its sidebar's awayMark): "In Cloud", "On <Mac's name>". */
export const whereMark = (where: { readonly name: string; readonly cloud: boolean }): string =>
  where.cloud ? "In Cloud" : `On ${where.name || "your Mac"}`;

// ---------------------------------------------------------------- a place's state

/** Where a chat runs, in one state. */
export type Place =
  /** A Mac online, or Cloud running. A row says nothing: it is what a place is unless said otherwise. */
  | { readonly is: "running" }
  | { readonly is: "asleep" }
  /** Cloud on its way up, after a send or a start asked for it. */
  | { readonly is: "waking" }
  /** Cloud asleep because the plan is used up; `until`: when it resets, where Cloud said. */
  | { readonly is: "paused"; readonly until?: string }
  /** A Mac not heard from in a day: off, signed out or gone. */
  | { readonly is: "offline" }
  /** Cloud could not start, and is trying again; `detail`: what held it up, for whoever asks. */
  | { readonly is: "failed"; readonly detail: string };

/** A Mac that is not on line sleeps, for all Caveman can tell, while it was heard from within a day. */
const MAC_ASLEEP_WITHIN_MS = 24 * 3_600_000;
/** What Cloud says of a computer on its way that is only progress; any other reason is what holds it up. */
const PROGRESS =
  /^(booting|waking|stopping|deleting|Pending|Running)$|: (ContainerCreating|PodInitializing|ContainersNotReady|ContainersNotInitialized)$/;

/**
 * A computer's place as Cloud lists it. `held`: Cloud refused to bring it up when last asked (nothing pays for its
 * time), with when the plan resets where it said.
 */
export function placeOf(
  computer: Computer | undefined,
  more: {
    readonly now?: number;
    readonly held?: { readonly resetsAt?: string | undefined } | null;
  } = {},
): Place {
  if (!computer) return { is: "asleep" };
  if (computer.online) return { is: "running" };
  if (computer.kind === "laptop") {
    const seen = Date.parse(computer.last_seen_at);
    return Number.isFinite(seen) &&
      seen > 0 &&
      (more.now ?? Date.now()) - seen < MAC_ASLEEP_WITHIN_MS
      ? { is: "asleep" }
      : { is: "offline" };
  }
  const row = computer.row;
  if (more.held || (row?.desired_state === "suspended" && row.sleep_reason === "usage")) {
    // When the plan serves again: what the refusal said, else what Cloud lists beside the reason (CONTRACT §11.3).
    const until = more.held?.resetsAt ?? row?.resets_at;
    return { is: "paused", ...(until ? { until } : {}) };
  }
  if (!row)
    return computer.state === "starting" || computer.state === "running"
      ? { is: "waking" }
      : { is: "asleep" };
  const reason = row.observed_reason.trim();
  if (row.desired_state === "running") {
    // Asked to run and held up by something it names: it is tried again, never "Waking" for ever with nothing said.
    if (
      row.observed_state === "failed" ||
      (row.observed_state !== "running" && reason !== "" && !PROGRESS.test(reason))
    )
      return { is: "failed", detail: reason };
    return { is: "waking" };
  }
  return { is: "asleep" };
}

/** When something resets, in the person's own clock: "11:08 PM" today, "Monday" this week, "Nov 17" after. */
export function untilWords(
  until: string | undefined,
  now: number,
  timeZone?: string,
): string | undefined {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at) || at <= now) return undefined;
  const zone = timeZone === undefined ? {} : { timeZone };
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", {
      ...zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  if (day(at) === day(now))
    return new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit" })
      .format(at)
      .replace(/\s/g, " ");
  if (at - now < 6 * 24 * 3_600_000)
    return new Intl.DateTimeFormat("en-US", { ...zone, weekday: "long" }).format(at);
  return new Intl.DateTimeFormat("en-US", { ...zone, month: "short", day: "numeric" }).format(at);
}

/**
 * A place's state word, as a row's mark and the open chat's pill say it; null for a place that runs (it says nothing).
 * A wait's seconds are added by whoever draws it.
 */
export function placeWord(place: Place, now = Date.now(), timeZone?: string): string | null {
  switch (place.is) {
    case "running":
      return null;
    case "asleep":
      return "Asleep";
    case "waking":
    // It is being tried again: the row says what it is doing, the chat says what went wrong.
    case "failed":
      return "Waking…";
    case "paused": {
      const until = untilWords(place.until, now, timeZone);
      return until ? `Paused until ${until} · plan used up` : "Paused · plan used up";
    }
    case "offline":
      return "Offline";
  }
}

/** A Mac's own state word in Settings > Computers: Online, Asleep, Offline. */
export const macWord = (place: Place): "Online" | "Asleep" | "Offline" =>
  place.is === "running" ? "Online" : place.is === "offline" ? "Offline" : "Asleep";

/** Cloud's row in Settings > Computers: its one state word, or how many of its chats' places run when not all do. */
export function cloudLine(places: readonly Place[], now = Date.now(), timeZone?: string): string {
  const running = places.filter((p) => p.is === "running").length;
  if (running > 0) return running === places.length ? "Running" : `${running} running`;
  const first =
    places.find((p) => p.is === "paused") ??
    places.find((p) => p.is === "waking" || p.is === "failed") ??
    places[0];
  return (first ? placeWord(first, now, timeZone) : null) ?? "Asleep";
}

/**
 * Cloud's own row in Settings > Computers, in the desktop's words (its computers-model.ts): how many of its places
 * run, else its one state word, and beside a plain state the share of the month's plan Cloud's time took: "2 running ·
 * 12% of this month's plan". A percent only, never an amount.
 */
export function cloudRowLine(
  places: readonly Place[],
  usedPct?: number,
  now = Date.now(),
  timeZone?: string,
): string {
  const running = places.filter((p) => p.is === "running").length;
  const word = running > 0 ? `${running} running` : cloudLine(places, now, timeZone);
  return usedPct === undefined || !Number.isFinite(usedPct) || word.startsWith("Paused")
    ? word
    : `${word} · ${Math.min(100, Math.max(0, Math.floor(usedPct)))}% of this month's plan`;
}

// ---------------------------------------------------------------- why a chat stays where it is

/** The web's sentences for a start, in the same cases (apps/web state/environment.ts, session-protocol capacity.ts). */
export const CLOUD_OFF = "Cloud is off. Ask your admin.";
export const CLOUD_NEEDS_GITHUB = "Cloud needs this project on GitHub.";

/** A plain chat's Mac keeps nothing saved to run in Cloud: its person has not chosen that there. What to do, where. */
export const KEEP_GOING = "Choose Keep chats going in Cloud on your Mac (Settings > Computers).";

/** "Claude" for Claude Agent, "compact" for Codex: the plan an agent runs on, as the desktop names it. */
const PLAN_OF: Readonly<Record<string, string>> = { "claude-agent": "Claude", codex: "ChatGPT" };

/** One reason a chat stays where it is, worded for each place the phone says it. */
interface Stays {
  /** Beside "Run in Cloud" where it cannot be pressed: one sentence, with what to do and where when there is something. */
  readonly menu: string;
  /** The desktop's few words for the same case (Settings > Computers, "When this Mac sleeps"). */
  readonly few: string;
  /** It never runs in Cloud, whatever is chosen or connected; the rest only pause until what they name is fixed. */
  readonly stays?: true;
  /** Nothing a kept message need say: what the chat is, or the Mac's own choice. */
  readonly quiet?: true;
}

const TOO_LARGE: Stays = {
  menu: "Its uncommitted files are too large. Commit and push them on your Mac.",
  few: "uncommitted files too large",
};
const NOT_CHOSEN: Stays = { menu: KEEP_GOING, few: "chats pause on this Mac", quiet: true };
const OTHER: Stays = {
  menu: "This chat can't run in Cloud yet.",
  few: "can't run in Cloud yet",
  quiet: true,
};

/**
 * Every code Cloud gives for a chat that cannot move (CONTRACT §11.1: the runtime's cloudLink/stays.ts, and Cloud's
 * own repo_unverified and cloud_full). No sentence travels, so each is worded here, in the desktop's words for the
 * same case; "here" on that Mac is "on a Mac" from a phone.
 */
const STAYS: Readonly<Record<string, Stays>> = {
  agent: {
    menu: "This agent runs on your Mac only.",
    few: "this agent runs only on a Mac",
    stays: true,
    quiet: true,
  },
  folder: { menu: "This project is a folder on your Mac.", few: "folder project", stays: true },
  several_repositories: {
    menu: "This chat works in several repositories.",
    few: "works in several repositories",
    stays: true,
  },
  kind: {
    menu: "Chiefs and agents stay on your Mac.",
    few: "Chiefs and agents stay on their Mac",
    stays: true,
    quiet: true,
  },
  not_on_github: { menu: CLOUD_NEEDS_GITHUB, few: "repository isn't on GitHub", stays: true },
  not_signed_in: {
    menu: "Sign in to Caveman on your Mac (Settings > Account).",
    few: "not signed in to Caveman",
    quiet: true,
  },
  not_chosen: NOT_CHOSEN,
  lid_off: NOT_CHOSEN,
  cloud_off: { menu: CLOUD_OFF, few: "Cloud turned off by your admin" },
  caveman_not_on_cloud: {
    menu: "Caveman chats don't run in Cloud yet.",
    few: "Caveman agent isn't in Cloud yet",
  },
  unpaid: { menu: "Your plan is used up.", few: "plan used up" },
  not_saved: {
    menu: "Not saved yet. It can run in Cloud after its next turn.",
    few: "saves after its next turn",
  },
  save_failing: {
    menu: "Its last save didn't reach Caveman. Your Mac tries again.",
    few: "its last save didn't reach Caveman",
  },
  changes_not_saved: {
    menu: "Your Mac is saving its changes again.",
    few: "saving its changes again",
  },
  too_big: TOO_LARGE,
  too_many_files: TOO_LARGE,
  repo_unverified: {
    menu: "Caveman can't read this repository. Connect GitHub on your Mac (Settings).",
    few: "Caveman can't read its repository",
  },
  cloud_full: { menu: "Cloud is full.", few: "Cloud is full" },
};

/** The reason behind a code; one this build does not know, and none at all, get the one plain line. */
function staysOf(code: string | undefined, engine?: string): Stays {
  if (code === "no_plan") {
    const plan = engine ? PLAN_OF[engine] : undefined;
    return {
      menu: `Connect ${plan ?? "its plan"} on your Mac (Settings > Models & keys).`,
      few: `${plan ?? "its plan"} isn't connected`,
    };
  }
  return (code !== undefined && Object.hasOwn(STAYS, code) ? STAYS[code] : undefined) ?? OTHER;
}

/**
 * Why a chat cannot run somewhere else, by the code Cloud lists for it, in one sentence for beside the verb that cannot
 * be pressed. `cloud`: the chat is in Cloud, so the verb is "Run on <Mac's name>".
 */
export function staysWords(
  code: string | undefined,
  chat: { readonly engine?: string | undefined; readonly cloud?: boolean } = {},
): string {
  if (!chat.cloud) return staysOf(code, chat.engine).menu;
  if (code === "kind") return "Chiefs and agents stay where they started.";
  return code === "several_repositories"
    ? STAYS.several_repositories!.menu
    : "This chat stays in Cloud.";
}

/**
 * One chat that will not carry on in Cloud when its Mac sleeps, in the desktop's words (its lid-summary.ts): "Pauses"
 * until what it names is fixed, or "Stays on <Mac's name>" for one that never runs in Cloud, and why in a few words.
 */
export function lidWords(
  code: string | undefined,
  engine: string | undefined,
  mac: string,
): { readonly what: string; readonly why: string } {
  const reason = staysOf(code, engine);
  return { what: reason.stays ? `Stays on ${mac || "its Mac"}` : "Pauses", why: reason.few };
}

/** What the desktop says of a Claude Agent or Codex chat once those were set to stay on their Mac when it sleeps. */
export const lidAgentsOff = (agent: string): { readonly what: string; readonly why: string } => ({
  what: "Pauses",
  why: `${agent} chats turned off`,
});

// ---------------------------------------------------------------- a message that waits

/**
 * A wait is one line, "<Doing>… 8s": the ellipsis, a space, the seconds, which whoever draws it adds while it counts
 * (words.md, "One wait, one line"). These are the doing.
 */
export const WAKING_CLOUD = "Waking Cloud…";
/** `to`: "Cloud", or the Mac's own name. */
export const movingWords = (to: string) => `Moving to ${to}…`;
/** A move that is asked and waits for the chat's turn to end: nothing counts until it goes. */
export const MOVES_AFTER_TURN = "Moves when this turn ends.";
/** Whether a line is a wait under way, whose seconds are drawn beside it. */
export const counts = (words: string) => words.endsWith("…");

/**
 * What a message says under it while it has not run yet, by Cloud's word on its call; null once it runs. One line,
 * never a machine's name: Cloud is being woken ("Waking Cloud…", its seconds added by whoever draws it), a sleeping
 * Mac's chat runs in Cloud, or the message is kept until the Mac wakes, with why it did not run in Cloud where Cloud's
 * code says something the person can use ("Folder project. Sends when Studio wakes.").
 */
export function waitingLine(
  call: Pick<QueuedCall, "status" | "waiting" | "error" | "method">,
  where: { readonly name: string; readonly cloud: boolean },
  chat?: { readonly engine?: string | undefined },
): string | null {
  const mac = where.name || "your Mac";
  const answer = call.method === "ask.respond";
  switch (call.status) {
    case "queued":
    case "delivered":
      if (where.cloud) return answer ? "Answer queued · waking Cloud" : WAKING_CLOUD;
      // Its Mac sleeps and Cloud is moving the chat: sending is enough.
      if (call.waiting?.reason === "laptop_asleep") return `${mac} is asleep. Running in Cloud.`;
      if (call.waiting?.reason === "not_movable") {
        const why =
          call.waiting.code === undefined ? OTHER : staysOf(call.waiting.code, chat?.engine);
        return why.quiet
          ? `Sends when ${mac} wakes`
          : `${why.few.charAt(0).toUpperCase()}${why.few.slice(1)}. Sends when ${mac} wakes.`;
      }
      // Cloud has not said it waits on anything: it is on its way (to the Mac, or to Cloud where the chat just moved).
      return answer ? "Answer queued" : "Sending";
    case "expired":
      return "Not sent";
    case "failed":
      return call.error?.code === "invalid_state" && /answered/.test(call.error.message)
        ? "Answered on another device"
        : "Not sent";
    case "done":
      return null;
  }
}

/** What the person answered an ask with: yes or no to an approval, or an answer to a question. */
export type Said = "allow" | "deny" | "answer";

/** An ask answered while its place could not hear it: what its line says until the place has the answer. */
export const queuedAnswer = (
  said: Said,
  where: { readonly name: string; readonly cloud: boolean },
) =>
  `${said === "allow" ? "Allow" : said === "deny" ? "Deny" : "Answer"} queued · ${where.cloud ? "waking Cloud" : `sends when ${where.name || "your Mac"} wakes`}`;

// ---------------------------------------------------------------- the open chat's one line

/** The one line the open chat says over its box about where it runs: a wait with its seconds, a state, or what to do. */
export interface Note {
  readonly words: string;
  /** A wait: its seconds count from here. */
  readonly since?: number;
  /** What a tap on it shows: the detail of something that went wrong. */
  readonly detail?: string;
  /** This phone must be allowed on the Mac first: the code to check on the Mac's dialog. */
  readonly code?: string;
  /** Something the person must do on their Mac before the chat can be read at all: said in the chat's place, in full. */
  readonly block?: true;
}

export interface NoteInput {
  /** Where the chat runs: a Mac by its name, or Cloud. */
  readonly where: { readonly name: string; readonly cloud: boolean };
  readonly place: Place;
  /** When the wait under way began (Cloud waking), where known. */
  readonly since?: number | null;
  /**
   * The chat is on its way to another place, whoever asked (this phone, another device, Cloud for a message): `to` is
   * "Cloud" or the Mac's own name; `waitingTurn`: it goes once the turn under way ends.
   */
  readonly moving?: {
    readonly to: string;
    readonly since: number;
    readonly waitingTurn?: boolean;
  } | null;
  /** The Mac asks its person about this phone ("waiting"), or said no ("refused"); `code` is this phone's own. */
  readonly allow?: { readonly state: "waiting" | "refused"; readonly code: string } | null;
  /** Since when Caveman cannot be reached from this phone; null while it can. */
  readonly offlineSince?: number | null;
  /** A message of this phone's waits for the chat's place, as Cloud last said of it. */
  readonly waiting?: Pick<QueuedCall, "status" | "waiting" | "error" | "method"> | null;
  /** What Cloud lists of the chat. */
  readonly chat?: Pick<CloudChat, "engine"> | undefined;
  /** Why Cloud would not run it in Cloud when this phone last asked, in Cloud's own words. */
  readonly refused?: string | undefined;
  readonly now?: number;
  readonly timeZone?: string;
}

/** After this long with no way to Caveman, the chat says so. */
export const OFFLINE_AFTER_MS = 10_000;

export function noteOf(input: NoteInput): Note | null {
  const { where, place, chat } = input;
  const now = input.now ?? Date.now();
  if (input.moving) return movingNote(input.moving);
  if (input.offlineSince != null && now - input.offlineSince >= OFFLINE_AFTER_MS)
    return { words: input.waiting ? "No network. Sends when you're back online." : "No network." };
  if (input.allow?.state === "waiting")
    return {
      words: `On ${where.name}, choose Allow when it shows this code.`,
      code: input.allow.code,
      block: true,
    };
  if (input.allow?.state === "refused")
    return { words: `Allow this phone on ${where.name} (Settings > General).`, block: true };
  if (input.refused) return { words: "Can't run in Cloud.", detail: input.refused };
  if (where.cloud) {
    switch (place.is) {
      case "running":
        return null;
      case "waking":
        return { words: WAKING_CLOUD, ...(input.since != null ? { since: input.since } : {}) };
      case "failed":
        return { words: "Cloud couldn't start. Trying again.", detail: place.detail };
      case "paused":
      case "asleep":
      case "offline":
        // A message that waits for it is waking it: the one line says so, not that it sleeps.
        if (
          place.is === "asleep" &&
          input.waiting &&
          waitingLine(input.waiting, where, chat) !== null
        )
          return { words: WAKING_CLOUD, ...(input.since != null ? { since: input.since } : {}) };
        return { words: placeWord(place, now, input.timeZone) ?? "Asleep" };
    }
  }
  if (place.is === "running") return null;
  const waits = input.waiting ? waitingLine(input.waiting, where, chat) : null;
  // A message waits for the Mac: what becomes of it is the line. No Run in Cloud beside it: Cloud runs a chat there by
  // itself when it can, and one it just said it cannot take would be refused again. Cloud's own reason is written
  // for a log, so it is never shown.
  if (waits) return { words: waits };
  return { words: placeWord(place, now, input.timeZone) ?? "Asleep" };
}

/** A move under way, in the one line a wait gets: "Moving to Cloud…" with its seconds, or that it waits for the turn. */
export function movingNote(moving: {
  readonly to: string;
  readonly since: number;
  readonly waitingTurn?: boolean;
}): Note {
  return moving.waitingTurn
    ? { words: MOVES_AFTER_TURN }
    : { words: movingWords(moving.to), since: moving.since };
}

/** How long a wait has run, beside its line: "8s", "1m 05s". */
export function waited(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------- a chat that did not start

/** Cloud has no room for another chat right now, and the start is tried again by itself. */
export const CLOUD_BUSY = "Cloud is busy. Trying again.";
/** What the wait says while Cloud could not start and is being tried again (the web's cloud-wait.ts). */
export const CLOUD_FAILED = "Cloud couldn't start. Trying again.";

/** A plan by the name people know it, without the price some carry in their label (the desktop's planName). */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  free: "Free",
  pro: "Pro",
  go: "Pro",
  max: "Max",
  max20: "Max",
  team: "Team",
};
export const planName = (plan: string | undefined): string | undefined =>
  plan ? (PLAN_NAMES[plan] ?? plan) : undefined;

/**
 * Cloud made no room by itself: every Cloud computer the person may run at once is working (its two limits on what
 * runs at once, CONTRACT §6). Nothing to try again by itself, and nothing to pick: the sentence alone.
 */
const FULL = new Set([
  "cave_code_computer_limit_person_running",
  "cave_code_computer_limit_plan_awake",
]);
export const cloudFullOn = (plan?: string): string =>
  plan ? `Cloud is full on ${plan}.` : "Cloud is full.";

/** Cloud turned a start away as full: its own code, or the sentence a Cloud computer's runtime answers with. */
export function cloudFull(error: unknown): boolean {
  const e = error as {
    code?: string;
    message?: string;
    error?: { data?: { cloud_code?: string } };
  } | null;
  return (
    e?.code === "cave_code_computer_full" ||
    e?.error?.data?.cloud_code === "cave_code_computer_full" ||
    e?.message === CLOUD_BUSY
  );
}

/** One of our own sentences: short, on one line, starting like a sentence and carrying no machine's words (the web's start-failure.ts). */
const reads = (text: string) =>
  /^[A-Z][^\n]{0,159}$/.test(text) &&
  !/(\bat \/|\/[\w.-]+\/[\w.-]+\/|Error:|E[A-Z]{4,}\b|[{}[\]]|\b\d{3}\b|https?:\/\/)/.test(text);

/** A clause or a sentence, as a sentence: a capital first, a full stop last. */
const sentence = (said: string) => {
  const raw = said.trim();
  return `${raw.charAt(0).toUpperCase()}${raw.slice(1)}${/[.!?…]$/.test(raw) ? "" : "."}`;
};

/**
 * A chat that did not start, in one line a person can use: "The chat didn't start: <one sentence>" (the web's
 * startFailure), with Try again and Discard beside it.
 */
export const startFailure = (said: string): string => `The chat didn't start: ${sentence(said)}`;

/**
 * What a start that failed says after "The chat didn't start:". Cloud's own refusals and the phone's own sentences
 * are said as they are; what a computer answered may carry what failed underneath (git's words, a path, a status
 * code), which is never the sentence.
 */
export function startWords(
  error: unknown,
  where: { readonly name: string; readonly cloud: boolean },
  plan?: string,
): string {
  const said = problemWords(error, "start", plan);
  const computers = (error as { name?: string } | null)?.name === "SessionProtocolError";
  return computers && !reads(sentence(said))
    ? `${where.cloud ? "Cloud" : where.name || "Your Mac"} couldn't start it.`
    : said;
}

// ---------------------------------------------------------------- something that could not be done

/**
 * What the phone says when Caveman would not or could not do something: Cloud's own sentence where it wrote one for a
 * person, and plain words for what is ours (a code only we know, an answer that made no sense). Never an HTTP status
 * or a mechanism.
 */
export function problemWords(
  error: unknown,
  doing: "sign-in" | "start" | "other" = "other",
  plan?: string,
): string {
  const e = error as {
    name?: string;
    message?: string;
    status?: number;
    code?: string;
    error?: { data?: { cloud_code?: string } };
  } | null;
  if (e?.name === "SignedOut") return "Sign in to Caveman again (Settings > Account).";
  // Cloud's own, or the same code as one of the person's computers passes it on.
  if (FULL.has(e?.code ?? "") || FULL.has(e?.error?.data?.cloud_code ?? ""))
    return cloudFullOn(plan);
  if (e?.name === "CloudError") {
    if (e.code === "cave_device_login_disabled")
      return "Your admin turned off signing in from a phone.";
    // The backstop: Cloud lists why a chat stays before anyone asks (staysWords), so this is one whose Mac said nothing.
    if (e.code === "cave_code_session_not_movable") return OTHER.menu;
    if (e.code === "cave_code_cloud_computers_off") return CLOUD_OFF;
    // Tried again by itself first (start.ts); this is what is left when it still has no room.
    if (e.code === "cave_code_computer_full") return "Cloud is busy.";
    if (e.code === "cave_agent_operation_forbidden")
      return "Cloud chats can't be started from the phone yet. Start it on your Mac.";
    // Ours, not Cloud's: an answer the phone could not read, or one with no sentence in it.
    // Tried again by itself before it comes to this (start.ts), so a start no longer says it is trying.
    if (
      (e.status ?? 0) >= 500 ||
      /^Caveman (answered|minted|sent|did not|made no)/.test(e.message ?? "")
    )
      return doing === "sign-in"
        ? "Couldn't sign in. Try again."
        : doing === "start"
          ? "Cloud couldn't start."
          : "Can't reach Caveman. Trying again.";
    return e.message || "Can't reach Caveman. Trying again.";
  }
  if (doing === "sign-in")
    return e?.message && /^The (code|sign-in)/.test(e.message)
      ? e.message
      : "Couldn't sign in. Try again.";
  if (doing === "start") {
    if (e?.message === CLOUD_BUSY) return "Cloud is busy.";
    // The start itself could not reach Caveman, and was tried again first.
    if (passes(error)) return "Can't reach Caveman.";
  }
  return e?.message || "Can't reach Caveman. Trying again.";
}

/** Whether a failure passes by itself (no network, Caveman busy), so the app tries again and the person is not asked to. */
export function passes(error: unknown): boolean {
  const e = error as { name?: string; status?: number } | null;
  if (e?.name === "SignedOut" || e?.name === "SessionProtocolError") return false;
  if (e?.name === "CloudError")
    return (e.status ?? 0) >= 500 || e.status === 429 || e.status === 408;
  // fetch itself failed: nothing was reached.
  return e?.name === "TypeError" || e?.name === "AbortError" || e?.name === "ConnectionClosed";
}
