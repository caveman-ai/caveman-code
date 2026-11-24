// Settings > Models & keys, "sign in once": how an engine's accounts read once some of them are connections the
// person made once (Session Protocol README, "Sign in once"). Where each works, the state a connection is in, what
// can be done about it, and every sentence the page says about them. Pure, so connections-model.test.ts pins it.
import type {
  AccountConnection,
  EngineAccount,
  EngineDescriptor,
} from "@caveman-app/session-protocol";
import { isConnection } from "../../state/accounts.ts";
import type { CloudConnection, CloudConnectionList } from "../../state/sync/model-connections.ts";
import { THIS_COMPUTER, thisComputer } from "../../lib/platform.ts";

/** The engines whose plan connects once for every computer, and what each plan is called. */
export const PLANS = {
  "claude-agent": {
    kind: "claude_plan",
    name: "Claude plan",
    plural: "Claude plans",
    own: "claudeAgent:default",
  },
  codex: {
    kind: "chatgpt_plan",
    name: "ChatGPT plan",
    plural: "ChatGPT plans",
    own: "codex-account-chatgpt",
  },
} as const;
export type PlanEngine = keyof typeof PLANS;
export const planOf = (engine: string): (typeof PLANS)[PlanEngine] | undefined =>
  engine in PLANS ? PLANS[engine as PlanEngine] : undefined;

/** Where a plan or key works, as its row says it: everywhere, in Cloud alone, or on this computer alone. */
export function whereLabel(
  where: EngineAccount["where"],
  here: string = THIS_COMPUTER,
): string | undefined {
  return where === "everywhere"
    ? "Everywhere"
    : where === "cloud"
      ? "Cloud"
      : where === "this_mac"
        ? `${here} only`
        : undefined;
}

/** A Claude plan's sign-in lasts a year: the page asks to reconnect from a week before it ends, no sooner. */
export const RECONNECT_BEFORE_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** When a used-up plan serves again, in the person's own clock: "11:08 PM", with the day when it is not today. */
export function untilText(
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
  const time = new Intl.DateTimeFormat("en-US", { ...zone, hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/\s/g, " ");
  return day(at) === day(now)
    ? time
    : `${new Intl.DateTimeFormat("en-US", { ...zone, month: "short", day: "numeric" }).format(at)}, ${time}`;
}

export interface ConnectionState {
  readonly is: "off" | "expired" | "used_up" | "expiring" | "ready";
  /** The state in a few words: "Used up until 11:08 PM", "Expires in 5 days", "Expired"; nothing to say of one that is fine. */
  readonly text: string;
  readonly tone: "ok" | "warn" | "bad" | "quiet";
  /** A plan that ends within the week or has ended: Reconnect is offered. A key is replaced where keys are added. */
  readonly reconnect: boolean;
}

const isPlan = (connection: AccountConnection) =>
  connection.kind === "claude_plan" || connection.kind === "chatgpt_plan";

/**
 * A plan's or key's state, one word or short line. Turned off by the admin wins, then ended (Cloud said so, its time
 * has passed, or the provider no longer accepts it: all three read "Expired"), then used up, then ending within the week.
 */
export function connectionState(
  connection: AccountConnection,
  now: number,
  timeZone?: string,
): ConnectionState {
  if (connection.off)
    return { is: "off", text: "Turned off by your admin", tone: "quiet", reconnect: false };
  const plan = isPlan(connection);
  const ends = connection.expires_at === undefined ? Number.NaN : Date.parse(connection.expires_at);
  if (connection.status === "expired" || connection.status === "revoked" || ends <= now)
    return { is: "expired", text: "Expired", tone: "bad", reconnect: plan };
  const soon = ends - now <= RECONNECT_BEFORE_MS;
  if (connection.status === "used_up") {
    const until = untilText(connection.used_up_until, now, timeZone);
    return {
      is: "used_up",
      text: until === undefined ? "Used up" : `Used up until ${until}`,
      tone: "warn",
      reconnect: soon && plan,
    };
  }
  if (soon) {
    const days = Math.ceil((ends - now) / DAY_MS);
    return {
      is: "expiring",
      text: `Expires in ${days} ${days === 1 ? "day" : "days"}`,
      tone: "warn",
      reconnect: plan,
    };
  }
  return { is: "ready", text: "", tone: "ok", reconnect: false };
}

/** The engine's connections, in the order they are tried (the runtime lists them first, in the person's order). */
export const connectionsOf = (accounts: ReadonlyArray<EngineAccount>): EngineAccount[] =>
  accounts.filter(isConnection);

/** Whether a plan or key can be moved to the top of the order: any but the first, while its kind is on. */
export const canUseFirst = (
  accounts: ReadonlyArray<EngineAccount>,
  account: EngineAccount,
): boolean =>
  isConnection(account) &&
  account.connection?.off !== true &&
  connectionsOf(accounts)[0]?.id !== account.id;

/** Whether the engine's plan is already a connection, in any state: its own row then carries what there is to do. */
export const planConnected = (engine: Pick<EngineDescriptor, "id" | "auth">): boolean => {
  const plan = planOf(engine.id);
  return (
    plan !== undefined &&
    engine.auth.accounts.some((a) => isConnection(a) && a.connection?.kind === plan.kind)
  );
};

/**
 * What the page offers for an engine's plan, from where it stands (EngineDescriptor.auth.everywhere):
 * - `use_everywhere`: this computer has the plan's own login and it is not connected yet: that row offers it;
 * - `connect`: no login of its own here and none connected: a row of its own offers it;
 * - `off`: the admin turned the kind off;
 * - `manage`: a Cloud computer, which takes no sign-in;
 * - undefined: nothing to offer (not signed in to Caveman, another engine, or already connected).
 */
export function planOffer(
  engine: Pick<EngineDescriptor, "id" | "auth">,
): "use_everywhere" | "connect" | "off" | "manage" | undefined {
  const plan = planOf(engine.id);
  const stands = engine.auth.everywhere;
  if (plan === undefined || stands === undefined) return undefined;
  if (stands === "off" || stands === "manage") return stands;
  if (planConnected(engine)) return undefined;
  return engine.auth.accounts.some((a) => a.id === plan.own) ? "use_everywhere" : "connect";
}

/** What an agent's one button does. */
export type AgentAction = "use_everywhere" | "connect" | "reconnect" | "sign_in" | "set_up";

export interface AgentStatus {
  /** The agent's one status: words.md's states for a plan or key, with what runs now where that is news. */
  readonly text: string;
  readonly tone: "ok" | "busy" | "warn" | "bad" | "idle";
  /** The one button on its row; absent: nothing to do, and the row only opens. */
  readonly action?: AgentAction;
  /** The plan Reconnect replaces. */
  readonly account?: EngineAccount;
}

const ready = (e: Pick<EngineDescriptor, "auth">) =>
  e.auth.state === "signed_in" || e.auth.state === "api_key";
/** "your Anthropic key", "your compact plan": what an agent runs on now, as its status says it. */
const yours = (account: EngineAccount) => `your ${account.label}`;

/** After a status on a page with no desktop app behind it: where a plan that ends is connected again. */
const RECONNECT_FROM_MAC = " · reconnect from the desktop app";

/** While a plan is being connected, on every window of the computer: where the person approves it. */
export const connectingLine = (here: string = thisComputer) =>
  `Connecting… approve in the browser on ${here}`;

/**
 * An agent's status and its one button, from what the computer reports (EngineDescriptor.auth): a sign-in in
 * progress first, then the plan or key that needs the person (ended, ending within the week, used up, turned off),
 * then where what it runs on works. `canConnect`: this window can start a plan's sign-in (the Mac's own, signed in to
 * Caveman); where it cannot, no button that would be refused is offered.
 */
export function agentStatus(
  engine: Pick<EngineDescriptor, "id" | "auth">,
  now: number,
  options: { readonly here?: string; readonly timeZone?: string } = {},
): AgentStatus {
  const { auth } = engine;
  const here = options.here ?? thisComputer;
  if (auth.connecting !== undefined) return { text: connectingLine(here), tone: "busy" };
  if (auth.state === "checking") return { text: "Checking…", tone: "busy" };
  const plan = planOf(engine.id);
  const canConnect = auth.everywhere === "available";
  const connections = connectionsOf(auth.accounts).flatMap((account) =>
    account.connection
      ? [{ account, state: connectionState(account.connection, now, options.timeZone) }]
      : [],
  );
  const running = auth.accounts.find((a) => a.active);
  const onConnection = running !== undefined && isConnection(running);
  const now_on =
    running !== undefined && ready(engine)
      ? ` · now on ${onConnection ? yours(running) : `${here}'s login`}`
      : "";
  const reconnect = (account: EngineAccount) =>
    canConnect ? { action: "reconnect" as const, account } : {};
  // A page with no desktop app behind it has no Reconnect to press: its status says where that is done.
  const elsewhere =
    !canConnect && (auth.everywhere === "manage" || auth.no_sign_in_here === true)
      ? RECONNECT_FROM_MAC
      : "";

  const ended = connections.find((c) => c.state.is === "expired");
  if (ended) {
    const carries = ended.account === running ? "" : now_on;
    return {
      text: `Expired${carries || (ended.state.reconnect ? elsewhere : "")}`,
      tone: "bad",
      ...(ended.state.reconnect ? reconnect(ended.account) : {}),
    };
  }
  const ending = connections.find((c) => c.state.is === "expiring");
  if (ending)
    return {
      text: `${ending.state.text}${ending.state.reconnect ? elsewhere : ""}`,
      tone: "warn",
      ...(ending.state.reconnect ? reconnect(ending.account) : {}),
    };
  const usedUp = connections.find((c) => c.state.is === "used_up");
  if (usedUp)
    return {
      text: `${usedUp.state.text}${now_on}`,
      tone: "warn",
      ...(usedUp.state.reconnect ? reconnect(usedUp.account) : {}),
    };
  if (auth.everywhere === "off" || connections.some((c) => c.state.is === "off")) {
    const others = connections.some((c) => c.state.is === "ready");
    if (!others)
      return {
        text: `Turned off by your admin${ready(engine) ? ` · runs on ${here}'s login` : ""}`,
        tone: "idle",
      };
  }

  if (ready(engine)) {
    if (onConnection) return { text: whereLabel(running.where) ?? "Everywhere", tone: "ok" };
    // A plan that serves Cloud while this computer runs on its own login: the agent works everywhere.
    if (connections.some((c) => c.state.is === "ready")) return { text: "Everywhere", tone: "ok" };
    // This computer's own login or key: it works here alone, and a plan can be made to work everywhere from it.
    const offer = planOffer(engine);
    return {
      text: whereLabel("this_mac", capital(here))!,
      tone: "ok",
      ...(offer === "use_everywhere" ? { action: "use_everywhere" as const } : {}),
    };
  }
  // Nothing to run on. A Cloud computer takes no sign-in: the status says where one is made, and offers none here.
  if (auth.no_sign_in_here === true)
    return { text: "Not signed in · connect from the desktop app", tone: "idle" };
  if (auth.state === "unavailable")
    return { text: "Not installed", tone: "idle", action: "set_up" };
  if (plan !== undefined && canConnect)
    return { text: "Not signed in", tone: "idle", action: "connect" };
  return { text: "Not signed in", tone: "idle", action: "sign_in" };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** On a Cloud computer's page: whether a Claude plan's token is asked for (none connected, or the one there ends). */
export const asksClaudeToken = (
  connections: ReadonlyArray<EngineAccount>,
  now: number,
): boolean => {
  const plans = connections.filter((a) => a.connection?.kind === "claude_plan");
  return plans.length === 0 || plans.some((a) => connectionState(a.connection!, now).reconnect);
};

/** Each agent's sign-in by the name on its button: "Connect Claude", "Connect compact". */
export const connectLabel = (engine: PlanEngine) =>
  engine === "claude-agent" ? "Connect Claude" : "Connect ChatGPT";

/** With Codex's device code. */
export const enterCode = (code: string) => `Enter ${code} on the sign-in page.`;
/** The provider's page as a link, for a browser that did not open by itself. */
export const SIGN_IN_PAGE = "Open the sign-in page";
/** Claude's page shows a code when it cannot hand the sign-in back to this computer (the linked page always does). */
export const PASTE_CODE = "Page shows a code? Paste it here";
export const PASTE_CODE_LABEL = "Code from the sign-in page";
/** A pasted code claude neither took nor gave a reason for. */
export const CODE_NOT_TAKEN =
  "Claude didn't take that code. Copy it again from the page you just signed in on.";

/** Whether an agent's status already says where its plan is connected: its opened row then does not say it again. */
export const saysFromMac = (status: Pick<AgentStatus, "text">): boolean =>
  status.text.endsWith("from the desktop app");

/** A page with no desktop app behind it (the web, a Cloud computer): where a plan is connected, and the one way without a Mac. */
export const MANAGE = {
  /** The lead: the desktop app signs in with one click. */
  fromMac: "Connect from the desktop app",
  /** The same, for a plan that is there and ended. */
  againFromMac: "Reconnect from the desktop app",
  /** Under "No Mac?": a Claude plan is added by the line its own CLI prints. */
  noMac: "No Mac?",
  claudeToken: "Run `claude setup-token` on any computer and paste the token here.",
} as const;

/** Removing a plan or key reaches every place it runs: the confirm says so. */
export const removeEverywhere = (label: string, here: string = thisComputer) => ({
  title: `Remove ${label} everywhere?`,
  description: `It stops running chats on ${here} and in Cloud.`,
  confirm: "Remove everywhere",
});

/**
 * Cloud's list as one engine's connection accounts, in order: what a page on a Cloud computer shows straight after its
 * own write to Cloud, until the computer's runtime has read the list again. `known`: the accounts the runtime listed,
 * whose names stay; a connection it has not listed yet (the plan just added) takes Cloud's label, else its plan's name.
 */
export function accountsFromCloud(
  list: CloudConnectionList,
  engine: string,
  known: ReadonlyArray<EngineAccount> = [],
): EngineAccount[] {
  const serving = [...list.connections]
    .sort((a, b) => a.position - b.position)
    .filter((c) => c.serves.includes(engine));
  const usable = (c: CloudConnection) => c.status === "ready" && list.kinds?.[c.kind]?.on !== false;
  const active = serving.find(usable)?.id;
  const name = (c: CloudConnection) =>
    known.find((a) => a.id === `connection:${c.id}`)?.label ??
    (c.label || (Object.values(PLANS).find((p) => p.kind === c.kind)?.name ?? c.provider));
  return serving.map((c) => ({
    id: `connection:${c.id}`,
    label: name(c),
    kind: c.kind === "api_key" || c.kind === "gateway" ? "api_key" : "login",
    active: c.id === active,
    where: "everywhere",
    connection: {
      kind: c.kind,
      status: c.status,
      ...(c.used_up_until ? { used_up_until: c.used_up_until } : {}),
      ...(c.expires_at ? { expires_at: c.expires_at } : {}),
      ...(list.kinds?.[c.kind]?.on === false ? { off: true as const } : {}),
    },
  }));
}

/** No chat runs from a page with no computer behind it: its agents say only what Cloud holds for them. */
const RUNS_NOTHING = {
  structured: false,
  fork: false,
  steer: false,
  interrupt: false,
  tool_hooks: false,
  resume_across_machines: false,
  approvals: false,
  plans: false,
  subagents: false,
  images: false,
  mcp: false,
} as const;

/**
 * The agents a browser window with no computer behind it lists, from Cloud's list alone: the two a plan connects for,
 * each with the plans and keys Cloud holds for it, as a Cloud computer's runtime would list them. Nothing signs in
 * from such a page (`no_sign_in_here`), and what it changes it changes in Cloud (`everywhere: "manage"`).
 */
export function agentsFromCloud(list: CloudConnectionList): EngineDescriptor[] {
  return (["claude-agent", "codex"] as const).map((id) => {
    const accounts = accountsFromCloud(list, id);
    return {
      id,
      label: id === "codex" ? "Codex" : "Claude Agent",
      capabilities: RUNS_NOTHING,
      models: [],
      auth: {
        state: accounts.some((a) => a.active) ? "signed_in" : "signed_out",
        accounts,
        no_sign_in_here: true,
        everywhere: "manage",
      },
    };
  });
}

/** A connection account's id in Cloud. */
export const cloudIdOf = (accountId: string): string => accountId.replace(/^connection:/, "");
