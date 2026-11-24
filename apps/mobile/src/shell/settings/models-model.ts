// Settings > Models & keys on a phone: every word the page says, from what one of the person's computers lists of
// their agents (Session Protocol's EngineDescriptor, engine.list). One row per agent, by the name its computer gives
// it, with one status in one colour, in the desktop's words for the same case (apps/web routes/settings
// connections-model.ts agentStatus): where it runs (Everywhere, one Mac only), or the one thing wrong with its plan
// or key (used up until a time and what runs meanwhile, expires in days, expired, turned off by an admin), a
// sign-in under way on a Mac, or that it is not signed in.
//
// A phone connects, reconnects and removes nothing, so no row has a button: where the desktop would offer one, the
// page says once where it is done (CONNECT_ON_MAC). Times are said in the person's own clock, never UTC.
// Pure, with only types from the protocol, so models-model.test.ts pins every word and Settings loads none of it.
import type {
  AccountConnection,
  EngineAccount,
  EngineDescriptor,
} from "@caveman-app/session-protocol";

/** What the page reads of an agent: its id, the name its computer gives it, and what it is signed in with. */
export type Agent = Pick<EngineDescriptor, "id" | "label" | "auth">;

/** The computer that answered (live/agents.ts): a Mac by its own name, or Cloud. */
export interface Asked {
  readonly from: string;
  readonly kind: "mac" | "cloud" | null;
}

/** A status's one colour: green where it runs everywhere, grey for a plain fact, amber for a wait, red for an end. */
export type Tone = "ok" | "quiet" | "warn" | "bad";

export interface AgentRow {
  readonly id: string;
  /** "Claude Agent", "Codex", "Caveman": the protocol's own name for it. */
  readonly name: string;
  readonly status: string;
  readonly tone: Tone;
  /** The desktop would offer a button on this row (Sign in, Use everywhere, Reconnect): the phone says where instead. */
  readonly onMac: boolean;
}

/** A list that has not arrived. */
export const LOADING = "Loading…";
/** An agent its computer is still finding out about. */
export const CHECKING = "Checking…";
export const EVERYWHERE = "Everywhere";
/** It runs on a plan or key kept for Cloud alone (the desktop's whereLabel). */
export const CLOUD_ONLY = "Cloud";
export const EXPIRED = "Expired";
export const TURNED_OFF = "Turned off by your admin";
export const NOT_SIGNED_IN = "Not signed in";
/** The agent is not on the computer that answered. */
export const NOT_INSTALLED = "Not installed";
/** Under the rows, once, when any of them is something only a Mac can change. */
export const CONNECT_ON_MAC = "Connect it on your Mac (Settings > Models & keys).";

// ---------------------------------------------------------------- which page

/** What the page is: the script's own, the one sign-in row, or the person's agents as their computers say them. */
export type PageView = "scripted" | "sign-in" | "loading" | "away" | "ready";

/**
 * Someone signed in sees what their computers say and never the script. Signed out on a board that is their own
 * there is only signing in; the scripted page is for someone who never signed in. The store may still say
 * "signed-out" for a moment after a sign-in: that reads as loading.
 */
export function pageView(
  me: { readonly signedIn: boolean; readonly scripted: boolean },
  status: "signed-out" | "loading" | "away" | "ready",
): PageView {
  if (!me.signedIn) return me.scripted ? "scripted" : "sign-in";
  return status === "signed-out" ? "loading" : status;
}

/** No computer of theirs answers: what the list waits for. Nothing here wakes anything. */
export function awayLine(
  mac: { readonly name: string; readonly state: "Asleep" | "Offline" } | null,
): string {
  if (!mac) return "Your agents show when one of your computers is on.";
  return mac.state === "Asleep"
    ? `Your agents show when ${mac.name} wakes.`
    : `Your agents show when ${mac.name} is back online.`;
}

// ---------------------------------------------------------------- times

const DAY_MS = 24 * 3_600_000;

/**
 * A moment in the person's own clock: "11:08 PM" today, "Sat 7:44 AM" in the six days after (a weekday names one day
 * only that far ahead, as live/words.ts untilWords counts it), "Nov 20" beyond. `timeZone` is the device's own
 * unless one is given (a test names one).
 */
export function clock(at: number, now: number, timeZone?: string): string {
  const say = (ms: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), ...options })
      .format(ms)
      .replace(/\s/g, " ");
  const day = (ms: number) => say(ms, { year: "numeric", month: "short", day: "numeric" });
  const time = say(at, { hour: "numeric", minute: "2-digit" });
  if (day(at) === day(now)) return time;
  return at > now && at - now < 6 * DAY_MS
    ? `${say(at, { weekday: "short" })} ${time}`
    : say(at, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------- one agent's status

/** A plan's sign-in asks to be connected again from a week before it ends (the desktop's RECONNECT_BEFORE_MS). */
export const EXPIRES_SOON_MS = 7 * DAY_MS;

/** When a used-up plan serves again, as the desktop says it (its untilText): "11:08 PM", with the day when it is not today. */
function untilText(until: string | undefined, now: number, timeZone?: string): string | undefined {
  const at = until === undefined ? Number.NaN : Date.parse(until);
  if (!Number.isFinite(at) || at <= now) return undefined;
  const say = (ms: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), ...options })
      .format(ms)
      .replace(/\s/g, " ");
  const day = (ms: number) => say(ms, { year: "numeric", month: "short", day: "numeric" });
  const time = say(at, { hour: "numeric", minute: "2-digit" });
  return day(at) === day(now) ? time : `${say(at, { month: "short", day: "numeric" })}, ${time}`;
}

interface Standing {
  readonly is: "off" | "expired" | "used_up" | "expiring" | "ready";
  readonly text: string;
  /** A plan that ends within the week or has ended: the desktop offers Reconnect. A key is replaced where keys are added. */
  readonly reconnect: boolean;
}

const isPlan = (connection: AccountConnection) =>
  connection.kind === "claude_plan" || connection.kind === "chatgpt_plan";

/** Where a plan or key kept by Caveman stands (the desktop's connectionState): turned off wins, then ended, then used up, then ending within the week. */
function standing(connection: AccountConnection, now: number, timeZone?: string): Standing {
  if (connection.off) return { is: "off", text: TURNED_OFF, reconnect: false };
  const plan = isPlan(connection);
  const ends = connection.expires_at === undefined ? Number.NaN : Date.parse(connection.expires_at);
  if (connection.status === "expired" || connection.status === "revoked" || ends <= now)
    return { is: "expired", text: EXPIRED, reconnect: plan };
  const soon = ends - now <= EXPIRES_SOON_MS;
  if (connection.status === "used_up") {
    const until = untilText(connection.used_up_until, now, timeZone);
    return {
      is: "used_up",
      text: until === undefined ? "Used up" : `Used up until ${until}`,
      reconnect: soon && plan,
    };
  }
  if (soon) {
    const days = Math.max(1, Math.ceil((ends - now) / DAY_MS));
    return {
      is: "expiring",
      text: `Expires in ${days} ${days === 1 ? "day" : "days"}`,
      reconnect: plan,
    };
  }
  return { is: "ready", text: "", reconnect: false };
}

/** A plan or key kept by Caveman (EngineAccount.where `everywhere` or `cloud`), not one a computer keeps for itself. */
const kept = (account: EngineAccount) =>
  account.where === "everywhere" || account.where === "cloud";

/** The computer that answered can run the agent now, on a plan or key kept by Caveman or on its own sign-in. */
const runs = (agent: Agent) => agent.auth.state === "signed_in" || agent.auth.state === "api_key";

/** Menus say "Claude Agent", never "Claude Code", whatever a computer calls it. */
const nameOf = (agent: Agent) =>
  agent.id === "claude-agent" ? "Claude Agent" : agent.label.trim() || agent.id;

/** The agents whose plan connects once for every computer, each by its Mac's own sign-in for that plan (the desktop's PLANS). */
const PLAN_OWN: Readonly<Record<string, string>> = {
  "claude-agent": "claudeAgent:default",
  codex: "codex-account-chatgpt",
};

/** Where a plan that ends is connected again, after a status on a page with no Mac app behind it (the desktop's own words). */
const RECONNECT_FROM_MAC = " · reconnect from the Mac app";

/** While a plan is being connected on a Mac, on every device: where the person approves it. */
export const connectingLine = (mac: string) => `Connecting… approve in the browser on ${mac}`;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * One agent's row: the desktop's status for the same agent, word for word (its connections-model.ts agentStatus),
 * with the Mac that answered named where the desktop says "this Mac". A sign-in in progress first, then the plan or
 * key that needs the person (ended, ending within the week, used up, turned off), then where what it runs on works.
 * A Mac lists its own sign-ins; Cloud lists only what Caveman keeps, so an agent signed in on a Mac alone reads "Not
 * signed in" while only Cloud answers.
 *
 * A phone connects nothing: where the desktop's row has a button, `onMac` has the page say once where it is done,
 * unless the status already does ("… from the Mac app").
 */
export function agentRow(agent: Agent, asked: Asked, now: number, timeZone?: string): AgentRow {
  const { auth } = agent;
  const here = asked.kind === "cloud" ? "Cloud" : asked.from || "your Mac";
  const say = (status: string, tone: Tone, onMac = false): AgentRow => ({
    id: agent.id,
    name: nameOf(agent),
    status,
    tone,
    onMac: onMac && !status.endsWith("from the Mac app"),
  });
  if (auth.connecting !== undefined) return say(connectingLine(here), "quiet");
  if (auth.state === "checking") return say(CHECKING, "quiet");

  const canConnect = auth.everywhere === "available";
  const plans = auth.accounts
    .filter(kept)
    .flatMap((account) =>
      account.connection ? [{ account, state: standing(account.connection, now, timeZone) }] : [],
    );
  const running = auth.accounts.find((a) => a.active);
  const onPlan = running !== undefined && kept(running);
  const nowOn =
    running !== undefined && runs(agent)
      ? ` · now on ${onPlan ? `your ${running.label}` : `${here}'s login`}`
      : "";
  const elsewhere =
    !canConnect && (auth.everywhere === "manage" || auth.no_sign_in_here === true)
      ? RECONNECT_FROM_MAC
      : "";

  const ended = plans.find((p) => p.state.is === "expired");
  if (ended)
    return say(
      `${EXPIRED}${(ended.account === running ? "" : nowOn) || (ended.state.reconnect ? elsewhere : "")}`,
      "bad",
      ended.state.reconnect,
    );
  const ending = plans.find((p) => p.state.is === "expiring");
  if (ending)
    return say(
      `${ending.state.text}${ending.state.reconnect ? elsewhere : ""}`,
      "warn",
      ending.state.reconnect,
    );
  const usedUp = plans.find((p) => p.state.is === "used_up");
  if (usedUp)
    return say(
      `${usedUp.state.text}${usedUp.account === running ? "" : nowOn}`,
      "warn",
      usedUp.state.reconnect,
    );
  if (
    (auth.everywhere === "off" || plans.some((p) => p.state.is === "off")) &&
    !plans.some((p) => p.state.is === "ready")
  )
    return say(`${TURNED_OFF}${runs(agent) ? ` · runs on ${here}'s login` : ""}`, "quiet");

  if (runs(agent)) {
    if (onPlan) return say(running.where === "cloud" ? CLOUD_ONLY : EVERYWHERE, "ok");
    // A plan that serves Cloud while the Mac runs on its own sign-in: the agent works everywhere.
    if (plans.some((p) => p.state.is === "ready")) return say(EVERYWHERE, "ok");
    // The Mac's own sign-in or key: it works there alone, and a plan can be made to work everywhere from it.
    return say(
      `${capital(here)} only`,
      "ok",
      canConnect && auth.accounts.some((a) => a.id === PLAN_OWN[agent.id]),
    );
  }
  // Nothing to run on. Cloud takes no sign-in: the status says where one is made.
  if (auth.no_sign_in_here === true)
    return say(`${NOT_SIGNED_IN} · connect from the Mac app`, "quiet");
  if (auth.state === "unavailable") return say(NOT_INSTALLED, "quiet");
  return say(NOT_SIGNED_IN, "quiet", true);
}

/** The page's rows, in the order the computer lists its agents. */
export const agentRows = (
  agents: ReadonlyArray<Agent>,
  asked: Asked,
  now: number,
  timeZone?: string,
): AgentRow[] => agents.map((agent) => agentRow(agent, asked, now, timeZone));

// ---------------------------------------------------------------- the scripted board

/**
 * The scripted world's agents, for someone who never signed in: the same rows from the same shapes a computer sends,
 * so the scripted page reads as the real one does. Never shown to anyone signed in, or on a board that is their own.
 */
export const SCRIPTED_AGENTS: ReadonlyArray<Agent> = [
  {
    id: "caveman",
    label: "Caveman",
    auth: {
      state: "api_key",
      accounts: [
        {
          id: "connection:anthropic",
          label: "Anthropic API key",
          kind: "api_key",
          active: false,
          where: "cloud",
          connection: { kind: "api_key", status: "ready" },
        },
        {
          id: "caveman:anthropic",
          label: "Anthropic API key",
          kind: "api_key",
          active: true,
          where: "this_mac",
        },
      ],
    },
  },
  {
    id: "claude-agent",
    label: "Claude Agent",
    auth: {
      state: "signed_in",
      accounts: [
        {
          id: "connection:claude",
          label: "Claude plan",
          kind: "login",
          active: true,
          where: "everywhere",
          connection: { kind: "claude_plan", status: "ready" },
        },
      ],
      everywhere: "available",
    },
  },
  {
    id: "codex",
    label: "Codex",
    auth: {
      state: "signed_in",
      accounts: [
        {
          id: "codex-account-chatgpt",
          label: "ChatGPT plan",
          kind: "login",
          active: true,
          where: "this_mac",
        },
      ],
      everywhere: "available",
    },
  },
  { id: "cursor", label: "Cursor", auth: { state: "signed_out", accounts: [] } },
  { id: "opencode", label: "OpenCode", auth: { state: "unavailable", accounts: [] } },
];
