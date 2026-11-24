// What a Cloud computer runs its engines on when a person's credentials stay outside it (credentialRule.ts,
// cloud-computers CONTRACT §3 and §4, SPEC §4.4). The person connects Claude, compact or a key once; Cloud keeps the
// ordered list and the secrets. This computer reads the list only (`GET runtime/model-connections`: names, order and
// state, never a secret) and launches each engine on a stand-in that stands for one connection. The engine's model
// requests go through the egress scrub (secrets/EgressScrub.ts), which sends a request carrying a stand-in to Cloud's
// data plane with the runtime's own token and the connection's id; the data plane attaches the real credential
// outside the computer. Nothing here ever holds one.
//
// The data plane's answers come back through the scrub and are kept here: a connection that is used up, or whose kind
// is switched off, is passed over for the next one in the person's order until it serves again, and the chat hears of
// it once (`onAnswer`, session-protocol/connectionNotes.ts). When nothing is left to serve an engine the chat hears
// why (`NothingServes`), in one note that says what happens next, and carries on by itself once something serves it.
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import type { ConnectionKeySource } from "@caveman-app/engine-core/server/ProviderHost";
import * as Effect from "effect/Effect";

import { proxySession, ROUTER_SESSION_HEADER } from "../router/cavemanRouter.ts";
import { call } from "./computers.ts";
import { CONNECT_WHERE, ruleOf } from "./credentialRule.ts";
import {
  parseCodexAuth,
  STAND_IN_MARK,
  standInJwt,
  toolsLoginFiles,
  type LoginFiles,
} from "./engineLogins.ts";
import { CloudError, readIdentity, type Identity } from "./identity.ts";
import { credentialRule } from "./credentialsOutside.ts";
import { CloudComputer, CloudLinkState, type CloudComputerInfo, type LinkState } from "./index.ts";
import { toolsSocket } from "./tools.ts";

export type ConnectionKind =
  | "claude_plan"
  | "chatgpt_plan"
  | "copilot"
  | "supergrok"
  | "api_key"
  | "gateway";
/** The engines a connection may serve, by the app's engine id. */
export type ServedEngine = "claude-agent" | "codex" | "caveman";

/** One of the person's connections as Cloud lists it (CONTRACT §4): never a secret. */
export interface ModelConnection {
  readonly id: string;
  readonly kind: ConnectionKind;
  readonly provider: string;
  readonly label: string;
  /** Position 0 is tried first. */
  readonly position: number;
  readonly status: "ready" | "used_up" | "expired" | "revoked";
  readonly used_up_until?: string | null;
  readonly expires_at?: string | null;
  readonly serves: ReadonlyArray<ServedEngine>;
}

export interface ModelConnectionList {
  readonly connections: ReadonlyArray<ModelConnection>;
  /** A kind whose switch is off is skipped (CONTRACT §4); a kind left out is on. */
  readonly kinds: Partial<Record<ConnectionKind, { readonly on: boolean }>>;
}

/** The read-only list (a hosted runtime may only read it). */
export const listModelConnections = (
  identity: Identity,
  link: LinkState,
  fetchImpl?: typeof fetch,
): Promise<ModelConnectionList> =>
  call<
    | { connections?: ReadonlyArray<ModelConnection>; kinds?: ModelConnectionList["kinds"] }
    | undefined
  >(identity, link, "GET", "model-connections", undefined, fetchImpl).then((out) => ({
    connections: [...(out?.connections ?? [])].sort((a, b) => a.position - b.position),
    kinds: out?.kinds ?? {},
  }));

/** A compact sign-in as the official `codex login` leaves it on the person's own machine (CONTRACT §4). */
export interface ChatGptCredential {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly id_token?: string;
  readonly expires_at?: string;
}

/** What a laptop's runtime reads of one of its person's connections, for its own egress (CONTRACT §4 `access`). */
export interface ConnectionAccess {
  readonly token?: string;
  readonly access_token?: string;
  readonly account_id?: string;
  readonly key?: string;
  readonly base_url?: string;
  readonly expires_at?: string | null;
}

/** Cloud has no route for model connections: a Cloud from before them (CONTRACT §4), which can neither list nor keep one. */
export const lacksConnections = (error: unknown): boolean =>
  error instanceof CloudError && error.status === 404 && error.code === "cave_not_found";
/** What connecting a plan says on such a Cloud, in place of its "No route matches this path." */
export const CLOUD_LACKS_CONNECTIONS =
  "Your Caveman Cloud needs an update before it can connect plans.";

/**
 * The routes a laptop's runtime has as its enroller (CONTRACT §4): it adds a plan the person connected here, orders,
 * removes, and reads a credential for its own egress. A Cloud computer's runtime is refused each of them by Cloud.
 * Nothing these send or answer is logged.
 */
export const addModelConnection = (
  identity: Identity,
  link: LinkState,
  input:
    | { readonly kind: "claude_plan"; readonly token: string }
    | { readonly kind: "chatgpt_plan"; readonly credential: ChatGptCredential },
  fetchImpl?: typeof fetch,
) =>
  call<ModelConnection>(identity, link, "POST", "model-connections", input, fetchImpl).catch(
    (error: unknown) => {
      throw lacksConnections(error)
        ? new CloudError(404, CLOUD_LACKS_CONNECTIONS, "cave_not_found")
        : error;
    },
  );

export const orderModelConnections = (
  identity: Identity,
  link: LinkState,
  ids: ReadonlyArray<string>,
  fetchImpl?: typeof fetch,
) =>
  call<unknown>(identity, link, "PATCH", "model-connections/order", { ids }, fetchImpl).then(
    () => undefined,
  );

export const removeModelConnection = (
  identity: Identity,
  link: LinkState,
  id: string,
  fetchImpl?: typeof fetch,
) =>
  call<unknown>(
    identity,
    link,
    "DELETE",
    `model-connections/${encodeURIComponent(id)}`,
    undefined,
    fetchImpl,
  ).then(() => undefined);

export const accessModelConnection = (
  identity: Identity,
  link: LinkState,
  id: string,
  fetchImpl?: typeof fetch,
) =>
  call<ConnectionAccess>(
    identity,
    link,
    "POST",
    `model-connections/${encodeURIComponent(id)}/access`,
    {},
    fetchImpl,
  );

/** The plan an engine runs on, as a connection kind: what a person connects once for it. */
export const PLAN_KIND = { "claude-agent": "claude_plan", codex: "chatgpt_plan" } as const;

/** The data plane's lane for an engine's requests (CONTRACT §3): `claude`, `codex`, or `key/{provider}`. */
export const laneOf = (engine: ServedEngine, provider: string) =>
  engine === "claude-agent"
    ? "claude"
    : engine === "codex"
      ? "codex"
      : `key/${encodeURIComponent(provider)}`;

/**
 * Whether `connection` can stand behind a launch of `engine` here: Claude Agent on a Claude plan or an Anthropic key,
 * Codex on a compact plan or an OpenAI key, the Caveman engine on a provider's key (`provider`: that provider's
 * only). Kinds the data plane has no lane for from this engine are passed over.
 */
export const fits = (
  connection: ModelConnection,
  engine: ServedEngine,
  provider?: string,
): boolean => {
  if (!connection.serves.includes(engine)) return false;
  if (engine === "claude-agent")
    return (
      connection.kind === "claude_plan" ||
      (connection.kind === "api_key" && connection.provider === "anthropic")
    );
  if (engine === "codex")
    return (
      connection.kind === "chatgpt_plan" ||
      (connection.kind === "api_key" && connection.provider === "openai")
    );
  return (
    connection.kind === "api_key" && (provider === undefined || connection.provider === provider)
  );
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  openrouter: "OpenRouter",
  google: "Google",
  github: "GitHub",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  groq: "Groq",
};
const providerName = (provider: string) =>
  PROVIDER_NAMES[provider] ??
  (provider === "" ? "provider" : provider.charAt(0).toUpperCase() + provider.slice(1));

/** What a person calls a connection: "Claude plan", "Anthropic key". */
export const connectionName = (
  connection: Pick<ModelConnection, "kind" | "provider" | "label">,
): string => {
  switch (connection.kind) {
    case "claude_plan":
      return "Claude plan";
    case "chatgpt_plan":
      return "ChatGPT plan";
    case "copilot":
      return "GitHub Copilot plan";
    case "supergrok":
      return "SuperGrok plan";
    case "api_key":
      return `${providerName(connection.provider)} key`;
    case "gateway":
      return `${connection.label || providerName(connection.provider)} gateway`;
  }
};

const KIND_PLURAL: Record<ConnectionKind, string> = {
  claude_plan: "Claude plans",
  chatgpt_plan: "ChatGPT plans",
  copilot: "GitHub Copilot plans",
  supergrok: "SuperGrok plans",
  api_key: "API keys",
  gateway: "gateways",
};

/** Two connections a person would call the same thing are told apart by their labels. */
const named = (connection: ModelConnection, other?: ModelConnection) =>
  other !== undefined &&
  connectionName(other) === connectionName(connection) &&
  connection.label !== ""
    ? `${connectionName(connection)} (${connection.label})`
    : connectionName(connection);

/**
 * When a used-up connection serves again, as a clock time: "11:08 PM", with the day when it is not today. A computer
 * whose clock is UTC (every Cloud computer) says so: the time is not the person's own. The builders' note reads it
 * (session-protocol/builders.ts); a chat's own notes say `whenText`, which never names a zone.
 */
export const untilText = (
  until: string | null | undefined,
  now: number,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | undefined => {
  const at = typeof until === "string" ? Date.parse(until) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return undefined;
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/\s/g, " ");
  const date =
    day(at) === day(now)
      ? ""
      : `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at)}, `;
  return `${date}${time}${timeZone === "UTC" || timeZone === "Etc/UTC" ? " UTC" : ""}`;
};

/** Whether `timeZone` is UTC under any of its names: the clock of a Cloud computer, which is not the person's. */
const utcClock = (timeZone: string) =>
  /^(?:Etc\/)?(?:UTC|UCT|GMT(?:[+-]?0)?|Zulu|Universal|Greenwich)$/.test(timeZone);

/**
 * When a used-up connection serves again, for a chat's note. On a computer whose clock is the person's (a Mac) it is
 * a clock time: `{ at: "11:08 PM" }`, with the day when it is not today. A Cloud computer's clock is UTC, not
 * theirs, and a note is plain text no client formats again, so there it is how long from now, never a zone:
 * `{ for: "3 hours" }` (minutes under an hour, hours up to 48, then days). Undefined with no time, or one that passed.
 */
export const whenText = (
  until: string | null | undefined,
  now: number,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { readonly at: string } | { readonly for: string } | undefined => {
  const at = typeof until === "string" ? Date.parse(until) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return undefined;
  if (!utcClock(timeZone)) return { at: untilText(until, now, timeZone)! };
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 60) return { for: count(minutes, "minute") };
  const hours = Math.round((at - now) / 3_600_000);
  return hours <= 48
    ? { for: count(hours, "hour") }
    : { for: count(Math.round((at - now) / 86_400_000), "day") };
};

/** Where a chat runs, for the words of a refusal: in Cloud a plan is connected from the person's Mac, on a Mac right there. */
export type Place = "cloud" | "mac";

/**
 * Why nothing serves an engine now, from the person's list and what was heard since (`OutsideConnections.nothingServes`):
 * - `used_up`: a connection that would serve it ran out, until `until` when a time is known. It comes back by itself;
 * - `kind_off`: their admin switched its kind off (`keys`: whether an API key would still serve);
 * - `expired`: its plan's sign-in expired or was revoked;
 * - `none`: nothing is connected for it.
 */
export type NothingServes =
  | { readonly reason: "none" }
  | {
      readonly reason: "used_up";
      readonly connection: ModelConnection;
      readonly until: string | undefined;
    }
  | { readonly reason: "kind_off"; readonly connection: ModelConnection; readonly keys: boolean }
  | { readonly reason: "expired"; readonly connection: ModelConnection };

/** What the data plane said about a request, for the chat it came from. Never an amount: spend stays out of a session. */
export type DataPlaneAnswer =
  /**
   * A connection ran out and the engine carries on with `next`. `own`: with none left, the chat was started on this
   * computer's own sign-in of the engine instead (a Mac, macConnections.ts), and `next` is undefined.
   */
  | {
      readonly type: "used_up";
      readonly session: string | undefined;
      readonly engine: ServedEngine;
      readonly connection: ModelConnection;
      readonly until: string | undefined;
      readonly next: ModelConnection | undefined;
      readonly own?: true;
    }
  /** A connection's kind is switched off by the person's admin, and the engine carries on with `next`. */
  | {
      readonly type: "kind_off";
      readonly session: string | undefined;
      readonly engine: ServedEngine;
      readonly connection: ModelConnection;
      readonly next: ModelConnection | undefined;
    }
  /** Nothing the person connected serves this engine now, and `why`: the request was refused. */
  | {
      readonly type: "no_connection";
      readonly session: string | undefined;
      readonly engine: ServedEngine;
      readonly provider: string | undefined;
      readonly why: NothingServes;
    };

/** What a chat started on a Mac's own sign-in of an engine, with every connection used up, says it runs on. */
export const OWN_LOGIN = "this Mac's login";

/** "Claude plan used up until 11:08 PM." On a Cloud computer, whose clock is not the person's: "Claude plan used up for 3 hours." */
const usedUpFirst = (name: string, when: ReturnType<typeof whenText>) =>
  `${name} used up${when === undefined ? "" : "at" in when ? ` until ${when.at}` : ` for ${when.for}`}.`;

/**
 * A used-up connection with nothing else to serve the chat. `carriesOn`: the chat waits on a Mac and runs again by
 * itself when it resets (connectionNotes.ts), "Claude plan used up. Carries on at 11:08 PM."; else only until when.
 */
const usedUpAlone = (name: string, when: ReturnType<typeof whenText>, carriesOn: boolean) =>
  carriesOn
    ? `${name} used up. Carries on ${when === undefined ? "when it resets" : "at" in when ? `at ${when.at}` : `in ${when.for}`}.`
    : usedUpFirst(name, when);

/**
 * "Claude plan used up until 11:08 PM. Running on your Anthropic key." (SPEC §4.1); on a Mac with nothing left,
 * "Running on this Mac's login."
 */
export const usedUpNote = (
  answer: Extract<DataPlaneAnswer, { type: "used_up" }>,
  now: number,
  timeZone?: string,
): string => {
  const when = whenText(answer.until, now, timeZone);
  const name = named(answer.connection, answer.next);
  if (answer.next !== undefined)
    return `${usedUpFirst(name, when)} Running on your ${named(answer.next, answer.connection)}.`;
  return answer.own === true
    ? `${usedUpFirst(name, when)} Running on ${OWN_LOGIN}.`
    : usedUpFirst(name, when);
};

/** "Your admin turned Claude plans off. Running on your Anthropic key." */
export const kindOffNote = (answer: Extract<DataPlaneAnswer, { type: "kind_off" }>): string => {
  const first = `Your admin turned ${KIND_PLURAL[answer.connection.kind]} off.`;
  return answer.next === undefined
    ? first
    : `${first} Running on your ${named(answer.next, answer.connection)}.`;
};

/** What is not connected, as its sentence starts: an engine's plan by its provider's name, a Caveman agent model's key. */
const NOT_CONNECTED = (engine: ServedEngine, provider: string | undefined) =>
  engine === "claude-agent"
    ? "Claude isn't connected"
    : engine === "codex"
      ? "ChatGPT isn't connected"
      : provider === undefined || provider === ""
        ? "This model has no key connected"
        : `Your ${providerName(provider)} key isn't connected`;

/**
 * The chat's words when nothing is connected for an engine: what is missing, and where to connect it. In Cloud a
 * plan or key is connected from the person's Mac and then works there too; on a Mac, in its own Settings.
 */
export const noConnectionNote = (
  engine: ServedEngine,
  provider?: string,
  place: Place = "cloud",
) =>
  place === "cloud"
    ? {
        title: `${NOT_CONNECTED(engine, provider)} for Cloud.`,
        body: `Connect it on your Mac (${CONNECT_WHERE}). It then works in Cloud too.`,
      }
    : { title: `${NOT_CONNECTED(engine, provider)}.`, body: `Connect it in ${CONNECT_WHERE}.` };

/** The same in one line: what an engine's CLI reads as its request's error where nothing is connected for it (`OutsideConnections.noConnection`). */
export const noConnectionMessage = (
  engine: ServedEngine,
  provider?: string,
  place: Place = "cloud",
) => {
  const note = noConnectionNote(engine, provider, place);
  return `${note.title} ${note.body}`;
};

/** The sign-in a plan stands on, as a person names it. */
const SIGN_IN: Partial<Record<ConnectionKind, string>> = {
  claude_plan: "Claude",
  chatgpt_plan: "ChatGPT",
  copilot: "GitHub Copilot",
  supergrok: "SuperGrok",
};
/** The key that serves an engine beside its plan: "an Anthropic key". */
const KEY_BESIDE: Partial<Record<ServedEngine, string>> = {
  "claude-agent": "an Anthropic key",
  codex: "an OpenAI key",
};

/**
 * The one note of a chat that nothing serves (a refused request, or a launch), by why: each says what to do, or what
 * happens next. `carriesOn`: the chat waits and runs again by itself once something serves it (connectionNotes.ts),
 * so a used-up plan says when it carries on; else it only says until when.
 */
export const nothingServesNote = (
  answer: Pick<Extract<DataPlaneAnswer, { type: "no_connection" }>, "engine" | "provider" | "why">,
  now: number,
  options: {
    readonly place?: Place;
    readonly carriesOn?: boolean;
    readonly timeZone?: string;
  } = {},
): { readonly title: string; readonly body?: string } => {
  const { why } = answer;
  const place = options.place ?? "cloud";
  if (why.reason === "used_up")
    return {
      title: usedUpAlone(
        named(why.connection),
        whenText(why.until, now, options.timeZone),
        options.carriesOn === true,
      ),
    };
  if (why.reason === "kind_off") {
    const key =
      why.keys && (why.connection.kind === "claude_plan" || why.connection.kind === "chatgpt_plan")
        ? KEY_BESIDE[answer.engine]
        : undefined;
    const title = `Your admin turned ${KIND_PLURAL[why.connection.kind]} off.`;
    if (place === "cloud")
      return {
        title,
        body:
          key === undefined
            ? "Run this chat on your Mac."
            : `Add ${key}, or run this chat on your Mac.`,
      };
    return key === undefined ? { title } : { title, body: `Add ${key} in ${CONNECT_WHERE}.` };
  }
  if (why.reason === "expired") {
    return {
      title: `Your ${SIGN_IN[why.connection.kind] ?? providerName(why.connection.provider)} sign-in expired.`,
      body:
        place === "cloud"
          ? `Reconnect it on your Mac (${CONNECT_WHERE}).`
          : `Reconnect it in ${CONNECT_WHERE}.`,
    };
  }
  return noConnectionNote(answer.engine, answer.provider, place);
};

/** What an engine reads when Cloud paces this computer's requests (429 `cave_code_engine_rate`): its client tries again by itself. */
export const RATE_MESSAGE = "Too many requests right now. It tries again by itself.";
/** What an engine reads when the provider could not be reached through Cloud (502 `cave_code_upstream`). */
export const UPSTREAM_MESSAGE = "Can't reach the model provider. Try again in a moment.";
/** Why Codex's launch on a connection did not start: its home or its stand-in sign-in could not be made. Nothing tries it again by itself. */
export const CODEX_NOT_STARTED = "Codex couldn't start in Cloud. Send your message again.";

/** How long one read of the list serves launches and requests made close together. */
export const LIST_REUSE_MS = 5_000;
/** compact account id as codex's stand-in login names it: the data plane sets the real one. */
const STAND_IN_ACCOUNT = "caveman-stand-in";

/** What a stand-in stands for: the engine it was launched for and the connection it named. */
export interface Issued {
  readonly engine: ServedEngine;
  readonly connectionId: string;
  readonly provider: string;
}

/** A launch under the rule: the engine's environment with stand-ins, or why nothing can run it. */
export type OutsideLaunch =
  | { readonly env: Record<string, string | undefined> }
  | { readonly unavailable: string };

/**
 * One runtime's connections under the rule: the list as Cloud last gave it, the stand-ins this run issued, and what
 * the data plane said since (used up, switched off). Memory only, and nothing in it is a secret.
 */
export class OutsideConnections {
  readonly #fetchList: () => Promise<ModelConnectionList>;
  readonly #now: () => number;
  readonly #mark = `${STAND_IN_MARK}-${randomBytes(24).toString("hex")}`;
  readonly #pattern = new RegExp(`${this.#mark}-(\\d+)`);
  readonly #issued: Array<Issued> = [];
  readonly #listeners = new Set<(answer: DataPlaneAnswer) => void>();
  /** Connections the data plane said are used up, and until when (it names no time: until the list says ready again). */
  readonly #usedUp = new Map<string, number>();
  /** Kinds the data plane refused as switched off, until the list is read again. */
  readonly #off = new Set<ConnectionKind>();
  #list: { readonly at: number; readonly value: Promise<ModelConnectionList> } | undefined;
  /** How long a connection said to be used up, with no time named, is passed over. */
  readonly #usedUpUnnamedMs: number;

  constructor(input: {
    readonly list: () => Promise<ModelConnectionList>;
    readonly now?: () => number;
    /**
     * How long a used-up connection is passed over when no reset was named. On a Cloud computer Cloud's list says
     * so from then on, so a moment is enough; a Mac heard it from the provider itself and nobody else will say.
     */
    readonly usedUpUnnamedMs?: number;
  }) {
    this.#fetchList = input.list;
    this.#now = input.now ?? Date.now;
    this.#usedUpUnnamedMs = input.usedUpUnnamedMs ?? LIST_REUSE_MS;
  }

  /** The person's list, read again once it is older than `maxAgeMs`; callers at once share one read. */
  list(maxAgeMs = LIST_REUSE_MS): Promise<ModelConnectionList> {
    const held = this.#list;
    if (held !== undefined && this.#now() - held.at < maxAgeMs) return held.value;
    const value = this.#fetchList();
    const next = { at: this.#now(), value };
    this.#list = next;
    void value.then(
      // A fresh list is Cloud's word on which kinds are on.
      () => this.#list === next && this.#off.clear(),
      () => this.#list === next && (this.#list = undefined),
    );
    return value;
  }

  /** The list is read again at the next ask: it changed (a connection made or removed here, or one a provider called over). */
  forget() {
    this.#list = undefined;
  }

  /** The connections that can serve `engine` now, first to try first. */
  async serving(
    engine: ServedEngine,
    provider?: string,
    maxAgeMs?: number,
  ): Promise<ReadonlyArray<ModelConnection>> {
    const list = await this.list(maxAgeMs);
    const now = this.#now();
    return list.connections.filter((c) => {
      if (!fits(c, engine, provider) || list.kinds[c.kind]?.on === false || this.#off.has(c.kind))
        return false;
      if ((this.#usedUp.get(c.id) ?? 0) > now) return false;
      if (c.status === "ready") return true;
      // Cloud's own mark, until its time has passed.
      return (
        c.status === "used_up" &&
        typeof c.used_up_until === "string" &&
        Date.parse(c.used_up_until) <= now
      );
    });
  }

  /** The stand-in for `connection` behind a launch of `engine`: the same one for the whole run. */
  #standIn(engine: ServedEngine, connection: ModelConnection): string {
    let n = this.#issued.findIndex((i) => i.engine === engine && i.connectionId === connection.id);
    if (n < 0)
      n =
        this.#issued.push({ engine, connectionId: connection.id, provider: connection.provider }) -
        1;
    return `${this.#mark}-${n}`;
  }

  /** What a request's headers stand for, when one of them carries a stand-in this run issued; and which headers do. */
  issuedIn(
    headers: Readonly<Record<string, unknown>>,
  ): { readonly issued: Issued; readonly names: ReadonlyArray<string> } | undefined {
    let issued: Issued | undefined;
    const names: Array<string> = [];
    for (const [name, value] of Object.entries(headers)) {
      const found = (Array.isArray(value) ? value : [value])
        .map((v) => (typeof v === "string" ? this.#pattern.exec(v) : null))
        .find((m) => m !== null);
      if (found === undefined || found === null) continue;
      issued ??= this.#issued[Number(found[1])];
      names.push(name);
    }
    return issued === undefined ? undefined : { issued, names };
  }

  /**
   * The connection a request made on `issued` goes out on: the one it was launched for while that serves, else the
   * next in the person's order; undefined when nothing serves the engine (the data plane then says so itself).
   */
  async routeFor(issued: Issued): Promise<ModelConnection | undefined> {
    const serving = await this.serving(
      issued.engine,
      issued.engine === "caveman" ? issued.provider : undefined,
    ).catch(() => [] as ReadonlyArray<ModelConnection>);
    return serving.find((c) => c.id === issued.connectionId) ?? serving[0];
  }

  #connection = async (id: string) =>
    (await this.list().catch(() => undefined))?.connections.find((c) => c.id === id);

  /**
   * The data plane said `connectionId` is used up (`x-caveman-used-up`): it is passed over until `until` (no time
   * named: until Cloud's list says it is ready again). With another connection to carry on with, the chat hears
   * which, once; with none it hears that nothing serves it and why, in one answer. Answers the connection the engine
   * carries on with, for a request to be sent again on it.
   */
  async usedUp(
    issued: Issued,
    connectionId: string,
    until: string | undefined,
    session: string | undefined,
  ): Promise<ModelConnection | undefined> {
    const connection = await this.#connection(connectionId);
    const at = until === undefined ? Number.NaN : Date.parse(until);
    const already = (this.#usedUp.get(connectionId) ?? 0) > this.#now();
    this.#usedUp.set(connectionId, Number.isFinite(at) ? at : this.#now() + this.#usedUpUnnamedMs);
    // Cloud's list now says so too: read it again for what is next.
    this.#list = undefined;
    const next = await this.routeFor(issued);
    if (next === undefined) await this.#refused(issued, session);
    else if (connection !== undefined && !already)
      this.#emit({
        type: "used_up",
        session,
        engine: issued.engine,
        connection,
        until: Number.isFinite(at) ? until : undefined,
        next,
      });
    return next;
  }

  /**
   * The data plane refused `connectionId`'s kind as switched off (403 `cave_code_connection_kind_off`): the chat
   * hears what the engine carries on with, once, or with nothing left that nothing serves it and why, in one answer.
   */
  async kindOff(
    issued: Issued,
    connectionId: string | undefined,
    session: string | undefined,
  ): Promise<ModelConnection | undefined> {
    const connection =
      connectionId === undefined ? undefined : await this.#connection(connectionId);
    const already = connection === undefined || this.#off.has(connection.kind);
    if (connection !== undefined) this.#off.add(connection.kind);
    const next = await this.routeFor(issued);
    if (next === undefined) await this.#refused(issued, session);
    else if (connection !== undefined && !already)
      this.#emit({ type: "kind_off", session, engine: issued.engine, connection, next });
    return next;
  }

  /**
   * The data plane found nothing ready for the lane (402 `cave_code_no_connection`), or on a Mac nothing connected
   * can pay for a request: `session`'s chat hears it, and why. Answers the same in one line, for the engine's CLI to
   * read as its request's error.
   */
  async noConnection(
    issued: Pick<Issued, "engine" | "provider">,
    session: string | undefined,
    place: Place = "cloud",
  ): Promise<string> {
    this.#list = undefined;
    return this.#inOneLine(issued, await this.#refused(issued, session), place);
  }

  /** Why nothing serves a request that `usedUp` or `kindOff` already told its chat of, in the one line its engine's CLI reads. */
  async refusalText(
    issued: Pick<Issued, "engine" | "provider">,
    place: Place = "cloud",
  ): Promise<string> {
    const why = await this.nothingServes(
      issued.engine,
      issued.engine === "caveman" ? issued.provider : undefined,
    ).catch((): NothingServes => ({ reason: "none" }));
    return this.#inOneLine(issued, why, place);
  }

  /**
   * The chat's note for `why` in one line: what an engine's CLI reads as its request's error, a launch's refusal, and
   * what an engine's probe shows. It says what is so (a used-up plan: until when), never that a chat carries on: only
   * the chat's own note knows whether it waits.
   */
  #inOneLine(
    issued: Pick<Issued, "engine" | "provider">,
    why: NothingServes,
    place: Place,
  ): string {
    const note = nothingServesNote(
      {
        engine: issued.engine,
        provider: issued.engine === "caveman" ? issued.provider : undefined,
        why,
      },
      this.#now(),
      { place },
    );
    return note.body === undefined ? note.title : `${note.title} ${note.body}`;
  }

  /** Until when `c` is used up, as heard here or as Cloud marks it (no time named: no end known); undefined when it serves now. */
  #usedUpUntil(c: ModelConnection, now: number): number | undefined {
    const heard = this.#usedUp.get(c.id) ?? 0;
    if (heard > now) return heard;
    if (c.status !== "used_up") return undefined;
    const marked = typeof c.used_up_until === "string" ? Date.parse(c.used_up_until) : Number.NaN;
    // Cloud's mark with no time: used up until its list says otherwise.
    return Number.isFinite(marked) ? (marked > now ? marked : undefined) : Number.POSITIVE_INFINITY;
  }

  /**
   * Why nothing serves `engine` now, from the person's list and what was heard since, for the chat's one note. A
   * connection that is used up comes back by itself, so that is said first (the one that resets soonest); then a plan
   * whose kind their admin switched off; then a plan whose sign-in expired or was revoked; then keys switched off;
   * else nothing is connected for it.
   */
  async nothingServes(engine: ServedEngine, provider?: string): Promise<NothingServes> {
    const list = await this.list().catch(() => undefined);
    if (list === undefined) return { reason: "none" };
    const now = this.#now();
    const off = (c: ModelConnection) => list.kinds[c.kind]?.on === false || this.#off.has(c.kind);
    const could = list.connections.filter((c) => fits(c, engine, provider));
    let soonest: { readonly connection: ModelConnection; readonly until: number } | undefined;
    for (const c of could) {
      if (off(c) || (c.status !== "ready" && c.status !== "used_up")) continue;
      const until = this.#usedUpUntil(c, now);
      if (until !== undefined && (soonest === undefined || until < soonest.until))
        soonest = { connection: c, until };
    }
    if (soonest !== undefined)
      return {
        reason: "used_up",
        connection: soonest.connection,
        until: Number.isFinite(soonest.until) ? new Date(soonest.until).toISOString() : undefined,
      };
    const plan = (c: ModelConnection) => c.kind === "claude_plan" || c.kind === "chatgpt_plan";
    const keys = list.kinds.api_key?.on !== false && !this.#off.has("api_key");
    // A plan whose kind is off is said before one that expired (connecting it again would not help), and that before keys switched off.
    const planOff = could.find((c) => plan(c) && off(c));
    if (planOff !== undefined) return { reason: "kind_off", connection: planOff, keys };
    const over = could.find((c) => plan(c) && (c.status === "expired" || c.status === "revoked"));
    if (over !== undefined) return { reason: "expired", connection: over };
    const switchedOff = could.find(off);
    return switchedOff === undefined
      ? { reason: "none" }
      : { reason: "kind_off", connection: switchedOff, keys };
  }

  /** A request or a launch was refused with nothing to serve its engine: `session`'s chat hears it, and why. Answers why. */
  async #refused(
    issued: Pick<Issued, "engine" | "provider">,
    session: string | undefined,
  ): Promise<NothingServes> {
    const provider = issued.engine === "caveman" ? issued.provider : undefined;
    const why = await this.nothingServes(issued.engine, provider).catch((): NothingServes => ({
      reason: "none",
    }));
    this.#emit({ type: "no_connection", session, engine: issued.engine, provider, why });
    return why;
  }

  /**
   * A launch of `engine` goes on this computer's own login of it (a Mac, macConnections.ts). When that is because
   * every connection that serves the engine is used up, `session`'s chat hears which ran out, until when, and what it
   * runs on instead; answers whether it did. Nothing is said when connections are not what stands in the way: none
   * that could serve it, or one that is ready and whose credential cannot be had now.
   */
  async ownLogin(engine: ServedEngine, session: string | undefined): Promise<boolean> {
    const list = await this.list();
    const now = this.#now();
    const could = list.connections.filter(
      (c) =>
        fits(c, engine) &&
        list.kinds[c.kind]?.on !== false &&
        !this.#off.has(c.kind) &&
        (c.status === "ready" || c.status === "used_up"),
    );
    const first = could[0];
    if (first === undefined || could.some((c) => this.#usedUpUntil(c, now) === undefined))
      return false;
    const until = this.#usedUpUntil(first, now)!;
    this.#emit({
      type: "used_up",
      session,
      engine,
      connection: first,
      until: Number.isFinite(until) ? new Date(until).toISOString() : undefined,
      next: undefined,
      own: true,
    });
    return true;
  }

  /** Hears what the data plane said about a chat's requests. */
  onAnswer(listener: (answer: DataPlaneAnswer) => void) {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #emit(answer: DataPlaneAnswer) {
    for (const listener of this.#listeners) {
      try {
        listener(answer);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

 /** Codex's compact login as stand-ins: nothing in it is worth anything outside this runtime's scrub. */
  #codexAuth(standIn: string) {
    const claims = { "https://api.openai.com/auth": { chatgpt_account_id: STAND_IN_ACCOUNT } };
    const nonce = standIn.slice(STAND_IN_MARK.length + 1);
    return {
      id_token: standInJwt(claims, nonce, this.#now()),
      access_token: standInJwt(claims, nonce, this.#now()),
      refresh_token: `rt_${standIn}`,
    };
  }

  /**
   * Codex's own refresh (its CODEX_REFRESH_TOKEN_URL_OVERRIDE), answered with the same stand-ins and never
   * forwarded: Cloud is the only refresher. A refresh token that is not a stand-in of this run is refused.
   */
  answerCodexRefresh(body: unknown): {
    readonly status: number;
    readonly body: Record<string, unknown>;
  } {
    const given =
      body !== null && typeof body === "object"
        ? (body as { refresh_token?: unknown }).refresh_token
        : undefined;
    const found = typeof given === "string" ? this.#pattern.exec(given) : null;
    if (found === null || this.#issued[Number(found[1])]?.engine !== "codex")
      return {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: `Connect ChatGPT on your Mac (${CONNECT_WHERE}).`,
        },
      };
    return { status: 200, body: this.#codexAuth(found[0]) };
  }

  /**
   * A launch of Claude Agent or Codex on the first connection that serves it: the engine's environment with that
   * connection's stand-in, shaped as the CLI expects its kind (a plan's token, an API key, codex's auth.json), and no
   * credential `env` carried. With nothing to run on it says why, and `session`'s chat hears it.
   */
  async launch(
    engine: "claude-agent" | "codex",
    env: Record<string, string | undefined> | undefined,
    options: {
      readonly session?: string | undefined;
      readonly files?: LoginFiles;
      readonly codexHome?: (() => Promise<string>) | undefined;
      readonly codexRefreshUrl?: string | undefined;
    } = {},
  ): Promise<OutsideLaunch> {
    let serving = await this.serving(engine);
    if (serving.length === 0) {
      // Before a chat is told nothing is connected: the person may have connected one a moment ago, on another device.
      this.forget();
      serving = await this.serving(engine);
    }
    const connection = serving[0];
    if (connection === undefined) {
      const why = await this.#refused({ engine, provider: "" }, options.session);
      // The list is read again at the next ask.
      this.#list = undefined;
      return { unavailable: this.#inOneLine({ engine, provider: "" }, why, "cloud") };
    }
    const standIn = this.#standIn(engine, connection);
    const {
      ANTHROPIC_API_KEY: _a,
      ANTHROPIC_AUTH_TOKEN: _t,
      CLAUDE_CODE_OAUTH_TOKEN: _o,
      OPENAI_API_KEY: _k,
      CODEX_API_KEY: _c,
      ...rest
    } = env ?? {};
    if (engine === "claude-agent") {
      return {
        env:
          connection.kind === "claude_plan"
            ? { ...rest, CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${standIn}` }
            : { ...rest, ANTHROPIC_API_KEY: `sk-ant-api03-${standIn}` },
      };
    }
    const files = options.files ?? toolsLoginFiles(toolsSocket());
    try {
      const home = env?.CODEX_HOME ?? (await options.codexHome?.());
      if (home === undefined) return { unavailable: CODEX_NOT_STARTED };
      const file = path.join(home, "auth.json");
      if (connection.kind === "api_key") {
        // A home still holding a sign-in's stand-ins would win over the key.
        await files.removeStandIn(file).catch(() => undefined);
        return {
          env: { ...rest, OPENAI_API_KEY: `sk-${standIn}`, CODEX_API_KEY: `sk-${standIn}` },
        };
      }
      const now = await files.read(file);
      const held = now === undefined ? undefined : parseCodexAuth(now)?.credential.access_token;
      if (held === undefined || this.#pattern.exec(held)?.[0] !== standIn) {
        await files.write(
          file,
          JSON.stringify(
            {
              auth_mode: "chatgpt",
              OPENAI_API_KEY: null,
              tokens: { ...this.#codexAuth(standIn), account_id: STAND_IN_ACCOUNT },
              last_refresh: new Date(this.#now()).toISOString(),
            },
            null,
            2,
          ),
        );
      }
    } catch {
      return { unavailable: CODEX_NOT_STARTED };
    }
    return {
      env: {
        ...rest,
        ...(options.codexRefreshUrl
          ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: options.codexRefreshUrl }
          : {}),
      },
    };
  }

  /**
   * The Caveman engine's own-key slots: one per provider the person connected a key for, its key a stand-in. The
   * engine sends it as that provider's key; the scrub sends the request to the data plane's key lane instead.
   */
  async keys(): Promise<ReadonlyArray<{ readonly provider: string; readonly key: string }>> {
    const out = new Map<string, string>();
    for (const connection of await this.serving("caveman"))
      if (!out.has(connection.provider))
        out.set(connection.provider, `sk-${this.#standIn("caveman", connection)}`);
    return [...out].map(([provider, key]) => ({ provider, key }));
  }
}

const byLink = new WeakMap<LinkState, OutsideConnections>();
const listeners = new WeakMap<LinkState, Set<(answer: DataPlaneAnswer) => void>>();

/**
 * Hears what the data plane says about the requests of the runtime whose link `link` is, from before its connections
 * exist (they are made at the first launch under the rule). Answers how to stop hearing.
 */
export const onDataPlaneAnswer = (link: LinkState, listener: (answer: DataPlaneAnswer) => void) => {
  let heard = listeners.get(link);
  if (heard === undefined) listeners.set(link, (heard = new Set()));
  heard.add(listener);
  return () => void heard.delete(listener);
};

/** What `connections` hears from now on reaches whoever listens for the runtime whose link `link` is (onDataPlaneAnswer). */
export const hearAnswers = (link: LinkState, connections: OutsideConnections) =>
  connections.onAnswer((answer) => {
    for (const listener of listeners.get(link) ?? []) listener(answer);
  });

/** The connections of the runtime whose link `link` is, once it is a Cloud computer under the rule (`connectionsFor`). */
export const connectionsOf = (link: LinkState): OutsideConnections | undefined => byLink.get(link);

/**
 * A Cloud computer's connections when its person's credentials stay outside it; undefined while the rule does not
 * cover it (everything works as before). Rejects when Cloud cannot say whether it does. The rule is the one joined
 * for `link` (credentialsOutside.ts).
 */
export async function connectionsFor(
  computer: CloudComputerInfo,
  link: LinkState,
): Promise<OutsideConnections | undefined> {
  if (!(await ruleOf(link).outside())) return undefined;
  let connections = byLink.get(link);
  if (connections === undefined) {
    connections = new OutsideConnections({
      list: () => {
        const identity = readIdentity(computer.linkDir);
        return identity === undefined
          ? Promise.reject(new CloudError(503, "This computer has no Cloud identity yet"))
          : listModelConnections(identity, link);
      },
    });
    byLink.set(link, connections);
    hearAnswers(link, connections);
  }
  return connections;
}

/**
 * A Cloud computer's key connections as the Caveman engine reads them (ProviderHost.connections): its own-key slots
 * are stand-ins while the rule applies, and its requests carry the chat's name to the scrub. Undefined off a Cloud
 * computer, where the engine's stored keys are the person's own.
 */
export const computerKeySource = Effect.gen(function* () {
  const computer = yield* CloudComputer;
  if (computer === undefined) return undefined;
  const link = yield* CloudLinkState;
  // Joined here too: the engine may be the first to ask.
  yield* credentialRule;
  const source: ConnectionKeySource = {
    keys: async () => (await connectionsFor(computer, link))?.keys(),
    headers: (threadId) => ({ [ROUTER_SESSION_HEADER]: proxySession(threadId) }),
  };
  return source;
});
