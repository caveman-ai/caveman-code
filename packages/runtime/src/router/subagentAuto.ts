// Auto for delegate_task (orchestrator v2 lane C2; Caveman Cloud the spec). When the lead names no
// harness or model and the person pinned none for the role, Caveman Cloud's /v1/route picks the
// child's harness account and model from what is connected: every ready instance × its models, a
// login whose usage limit is spent left out. The policy stays in Cloud; the app sends the pool, the
// role and the brief, and maps the answer's pool id back to an instance and model.
//
// It never blocks a delegation: no credential, an error, a 3 s timeout or a paused org runs the
// lead's selection and says why (`pick.fallback`). The credential is the runtime's shared paid
// routing key (credits first, else a paid-plan router:write key); the Code sign-in
// and the link token carry no router scope, and v4's own login is never read. When the child ends,
// its outcome goes back once against the answer's outcome token, to the gateway that issued it.
import { CREDITS_GATEWAY_URL, cavemanModels, connectedModels, isCustomProvider, readCavemanKeys, slotProvider, type CavemanKeys } from "@caveman-app/provider-caveman/server";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import type { RoutingCredentialSource } from "@caveman-app/engine-core/server/ProviderHost";
import { ProviderInstanceId, type ServerProvider, type ServerProviderModel, type ServerProviderUsageWindow } from "@caveman-app/protocol";
import type { SubagentRole, SubagentRunner, TaskKind } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { engineIdForInstance } from "../session-protocol/projector.ts";
import { isRouterModel } from "./cavemanRouter.ts";
import { effortDescriptorOf, effortValueOf } from "../provider/effortOption.ts";
import { routingCredential } from "./routerKey.ts";

export type Fallback = NonNullable<SubagentRunner["pick"]["fallback"]>;
export type PickBy = SubagentRunner["pick"]["by"];
export type Billing = "subscription" | "credits" | "api_key";

/** One connected instance × model, as /v1/route's pool takes it. */
export interface PoolEntry {
  readonly id: string;
  readonly model: string;
  readonly host: string;
  readonly via: "local";
  readonly harness: string;
  readonly billing?: Billing;
}

/** What a pool id runs on: the instance and its own model slug. */
export interface PoolTarget {
  readonly instanceId: string;
  readonly model: string;
}

/** Cloud's pool cap (routedecide routePoolMax): a longer pool is a 400. */
const POOL_MAX = 64;
/** All of a brief Cloud reads (routedecide MaxTextBytes); the escaped body stays far under its 256 KiB limit. */
const BRIEF_MAX_BYTES = 32 * 1024;
const AGENT_MAX_BYTES = 128;
export const ROUTE_TIMEOUT_MS = 3_000;

// ------------------------------------------------------------------- order

/**
 * Who picks a child's runner, first that applies: the person's pin marked always, the lead (a target harness or
 * model), the person (an agent type's own model, or the pin personPin found), Auto (Settings default, Cloud linked
 * or not: unlinked is a recorded fallback), else the lead's selection.
 */
export function pickOrder(input: {
  readonly leadPinned: boolean;
  readonly agentTypeModel: boolean;
  readonly pinned: boolean;
  readonly pinAlways?: boolean | undefined;
  readonly defaultModel: "auto" | "auto-by-role" | "inherit";
}): PickBy {
  if (input.pinned && input.pinAlways === true) return "user";
  if (input.leadPinned) return "lead";
  if (input.agentTypeModel || input.pinned) return "user";
  return input.defaultModel === "auto" ? "auto" : "default";
}

/**
 * The person's pin for a delegation (Settings > Subagents), first that is set: the role the lead named (general
 * aside), the task kind the classifier reads the brief as, then general's; `task` is that kind when its pin decided.
 * `classify` runs only when a task kind is pinned and no named role's pin decides, so a person who pins no kind never
 * loads the classifier.
 */
export async function personPin<P>(input: {
  readonly role: SubagentRole;
  readonly rolePins: Readonly<Partial<Record<SubagentRole, P | null>>>;
  readonly taskPins: Readonly<Partial<Record<TaskKind, P | null>>>;
  readonly classify: () => Promise<TaskKind | undefined>;
}): Promise<{ readonly pin: P | undefined; readonly task: TaskKind | undefined }> {
  const named = input.role === "general" ? undefined : (input.rolePins[input.role] ?? undefined);
  if (named !== undefined) return { pin: named, task: undefined };
  const task = Object.values(input.taskPins).some((pin) => pin != null) ? await input.classify() : undefined;
  const kind = task === undefined ? undefined : (input.taskPins[task] ?? undefined);
  if (kind !== undefined) return { pin: kind, task };
  return { pin: input.role === "general" ? (input.rolePins.general ?? undefined) : undefined, task: undefined };
}

// -------------------------------------------------------------------- pool

/** Ready to run a child now: on, installed, probed, known to be signed in and not in error. */
export const providerReady = (p: ServerProvider): boolean =>
  p.enabled &&
  p.installed &&
  p.availability !== "unavailable" &&
  p.probePending !== true &&
  p.status !== "error" &&
  p.status !== "disabled" &&
  p.auth.status === "authenticated";

/** The words of a model or a scope, compared without case or punctuation (`claude-opus-5-5`: claude opus 5 5). */
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Extra usage bought on top of a plan, which stops nothing while the plan's own windows have room: Claude's spend
 * budget (claudeUsageLimits `monthly_spend`) and Codex's credit limit (codexUsageLimits `individual`). Codex Free and
 * Go's monthly allowance is the plan itself (`primary`), and does stop.
 */
const EXTRA_USAGE_WINDOWS: ReadonlySet<string> = new Set(["monthly_spend", "individual"]);

/**
 * Whether a full window stops `slug`. An account-wide window stops every model; a model-scoped weekly (Claude's
 * `seven_day_<model>`, claudeUsageLimits scopedWindow) stops only the model it names, so a login out of its weekly
 * Opus still runs Sonnet. A scope that names no model here (an unnamed overage bucket) stops nothing: a real
 * used-up answer still ends the turn.
 */
const windowStops = (window: Pick<ServerProviderUsageWindow, "id">, slug: string): boolean => {
  if (EXTRA_USAGE_WINDOWS.has(window.id)) return false;
  const scope = /^seven_day_(.+)$/.exec(window.id)?.[1];
  if (scope === undefined) return true;
  const want = words(scope);
  const have = words(catalogModel(slug));
  return have.some((_, start) => want.every((word, n) => have[start + n] === word));
};

/**
 * A login whose quota for `slug` is spent until a reset still ahead (windowStops). Without a slug, any window that
 * stops every model.
 */
export const limitsExhausted = (p: Pick<ServerProvider, "usageLimits">, now: number, slug = ""): boolean =>
  p.usageLimits !== undefined &&
  p.usageLimits.onCredits !== true &&
  p.usageLimits.windows.some(
    (w) => w.usedPercent >= 100 && (w.resetsAt === undefined || Date.parse(w.resetsAt) > now) && windowStops(w, slug),
  );

/** The catalog id Cloud prices: a slug's last segment (`caveman/anthropic/x`, `openai/x`), without Claude's `[1m]`. */
export const catalogModel = (slug: string): string => variantOf(slug).replace(/\[1m\]$/, "");

/** A slug's model with its context variant (`claude-opus-5-5[1m]`): the same on every engine and account that runs it. */
export const variantOf = (slug: string): string => slug.slice(slug.lastIndexOf("/") + 1);

/** The harness Cloud knows an engine as: its id, `acp` for any registry agent. */
export const harnessOf = (instanceId: string): string => {
  const engine = engineIdForInstance(instanceId);
  return engine.startsWith("acp:") ? "acp" : engine;
};

/** Whose service a harness's models run on, when the slug does not say (`provider/model`). */
const HARNESS_HOSTS: Readonly<Record<string, string>> = {
  "claude-agent": "anthropic",
  codex: "openai",
  cursor: "cursor",
  grok: "xai",
  antigravity: "google",
  muse: "meta",
};

/** The provider an entry runs on (Cloud's pool host): the slug's source (credits `caveman`, a key's provider), else the harness's vendor. */
export const hostOf = (harness: string, slug: string): string => {
  const slash = slug.indexOf("/");
  const raw = slash > 0 ? slug.slice(0, slash) : (HARNESS_HOSTS[harness] ?? harness);
  return raw.replace(/~\d+$/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64) || harness;
};

/**
 * Login types known to be a plan, compared without case, spaces, `_` or `-`: Claude's subscription types in
 * every spelling the CLI reports (`max`, `max20`, `maxplan`, `claude_max_20x_subscription`; ClaudeProvider's
 * claudeSubscriptionLabel), a Claude plan login that names no tier (ClaudeProvider's claudePlanLogin), native
 * browser sign-in, Grok's cached login, a compact login.
 */
const PLAN_AUTH = /^(claude)?(pro|max(5|20)?x?|maxplan|team|enterprise)(subscription)?$|^(browser|cachedtoken|chatgpt|subscription)$/;
/** Per-token logins: an API key (Claude's own spellings too), Bedrock (Codex says amazonBedrock), Vertex. */
const KEY_AUTH = /^(apikey|anthropicapikey|anthropicauthtoken|bedrock|amazonbedrock|vertex)$/;
const authKind = (type: string) => type.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * How a login pays, only where it is positively known: a plan's subscription, Caveman credits, or a
 * per-token key (a Caveman key, a Claude API key, Bedrock or Vertex). A local or custom endpoint, a login
 * that says nothing (OpenCode, Pi) and registry agents are unknown: Cloud then ranks them last.
 */
export const billingOf = (p: ServerProvider, harness: string, slug: string, chatGptLogin: boolean): Billing | undefined => {
  if (harness === "caveman") {
    const source = slotProvider(slug.slice(0, Math.max(0, slug.indexOf("/"))));
    if (source === "caveman") return "credits";
    if (source === "chatgpt") return "subscription";
    return source === "" || source === "ollama" || source === "lmstudio" || isCustomProvider(source) ? undefined : "api_key";
  }
  if (harness === "acp") return undefined;
  if (harness === "codex" && chatGptLogin) return "subscription";
  const type = authKind(p.auth.type ?? "");
  return KEY_AUTH.test(type) ? "api_key" : PLAN_AUTH.test(type) ? "subscription" : undefined;
};

/** Cloud's harness tie-break among the entries of one model: the first billing here wins. */
const BILLING_RANK: ReadonlyArray<Billing | undefined> = ["subscription", "credits", "api_key", undefined];

/** What decides a pool entry or a plan: the person's provider list and the orchestrator's constraints. */
export interface PoolInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Can run a delegated child (the orchestrator's own constraints). */
  readonly capable: (provider: ServerProvider) => boolean;
  readonly hidden?: (instanceId: string, slug: string) => boolean;
  /** The Caveman engine's connected models (connected.ts); absent lists its advertised ones. */
  readonly cavemanConnected?: ReadonlyArray<string> | undefined;
  readonly chatGptLogin?: (instanceId: string) => boolean;
  readonly now: number;
}

/**
 * Every instance × model that can run a child now, in provider order then each provider's model order: ready,
 * able to run a child, its quota for that model not spent (limitsExhausted); models the person hid stay out,
 * and the Caveman engine's are its connected set (the resolver its own Auto routes with).
 */
function candidates(input: PoolInput): ReadonlyArray<ReadonlyArray<{ readonly entry: PoolEntry; readonly target: PoolTarget }>> {
  const lanes: Array<Array<{ readonly entry: PoolEntry; readonly target: PoolTarget }>> = [];
  const seen = new Set<string>();
  for (const p of input.providers) {
    if (!providerReady(p) || !input.capable(p)) continue;
    const harness = harnessOf(p.instanceId);
    const lane: Array<{ readonly entry: PoolEntry; readonly target: PoolTarget }> = [];
    for (const { slug } of p.models) {
      if (isRouterModel(slug) || (harness === "caveman" && slug === "auto") || catalogModel(slug) === "") continue;
      if (input.hidden?.(p.instanceId, slug) === true || limitsExhausted(p, input.now, slug)) continue;
      if (harness === "caveman" && input.cavemanConnected !== undefined && !input.cavemanConnected.includes(slug)) continue;
      const id = `${p.instanceId}/${slug}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const billing = billingOf(p, harness, slug, input.chatGptLogin?.(p.instanceId) === true);
      lane.push({
        entry: { id, model: catalogModel(slug), host: hostOf(harness, slug), via: "local", harness, ...(billing ? { billing } : {}) },
        target: { instanceId: p.instanceId, model: slug },
      });
    }
    if (lane.length > 0) lanes.push(lane);
  }
  return lanes;
}

/**
 * A plan of the person's that runs `slug`'s model and context variant now, outside the Caveman engine: a Claude or compact plan, a
 * Cursor or Grok sign-in. The lead names credits Opus while a Claude plan serves Opus: the child runs on the plan,
 * and orchestrator_capabilities folds the credits duplicate away. Credits are what pays last.
 */
export function planServing(input: PoolInput, slug: string): PoolTarget | undefined {
  const variant = variantOf(slug);
  for (const lane of candidates(input)) {
    const found = lane.find(({ entry, target }) => entry.harness !== "caveman" && entry.billing === "subscription" && variantOf(target.model) === variant);
    if (found !== undefined) return found.target;
  }
  return undefined;
}

/** Every model variant (variantOf) a plan of the person's runs now, outside the Caveman engine (planServing). */
export function planModels(input: PoolInput): ReadonlySet<string> {
  const models = new Set<string>();
  for (const lane of candidates(input)) {
    for (const { entry, target } of lane) if (entry.harness !== "caveman" && entry.billing === "subscription") models.add(variantOf(target.model));
  }
  return models;
}

/** Whether `slug` on `provider` runs on Caveman credits (the `caveman` key slot, credits.ts). */
export const onCredits = (provider: Pick<ServerProvider, "instanceId">, slug: string): boolean =>
  harnessOf(provider.instanceId) === "caveman" && slotProvider(slug.slice(0, Math.max(0, slug.indexOf("/")))) === "caveman";

/**
 * The pool Cloud picks from: one entry per harness × model, the instance that model's best billing is on
 * (BILLING_RANK, then provider order). Cloud never sees accounts; with two Claude logins it sees one Claude Agent
 * Opus, and the 64-entry cap is not spent on duplicates. Ids are `<instance>/<model>`, mapped back by `targets`.
 */
export function routePool(input: PoolInput): { readonly pool: ReadonlyArray<PoolEntry>; readonly targets: ReadonlyMap<string, PoolTarget> } {
  const all = candidates(input);
  const best = new Map<string, PoolEntry>();
  const billingRank = (entry: PoolEntry) => BILLING_RANK.indexOf(entry.billing);
  // The same variant on two accounts is one entry; a model and its `[1m]` variant on one login stay two, as Cloud
  // has always been sent them (catalogModel strips the suffix, the slug's last segment keeps it).
  const keyOf = ({ entry, target }: { readonly entry: PoolEntry; readonly target: PoolTarget }) =>
    `${entry.harness} ${variantOf(target.model)}`;
  for (const lane of all) {
    for (const candidate of lane) {
      const key = keyOf(candidate);
      const held = best.get(key);
      if (held === undefined || billingRank(candidate.entry) < billingRank(held)) best.set(key, candidate.entry);
    }
  }
  const lanes = all
    .map((lane) => lane.filter((candidate) => best.get(keyOf(candidate)) === candidate.entry))
    .filter((lane) => lane.length > 0);
  // Round-robin across instances up to Cloud's cap, so one big catalog never crowds out another login.
  const pool: Array<PoolEntry> = [];
  const targets = new Map<string, PoolTarget>();
  for (let rank = 0; pool.length < POOL_MAX && lanes.some((lane) => rank < lane.length); rank++) {
    for (const lane of lanes) {
      const next = lane[rank];
      if (next === undefined || pool.length >= POOL_MAX) continue;
      pool.push(next.entry);
      targets.set(next.entry.id, next.target);
    }
  }
  return { pool, targets };
}

/** A model's effort option, under its engine's own name (provider/effortOption.ts), set to `effort` when the model offers that level. */
export function effortOptions(model: Pick<ServerProviderModel, "capabilities"> | undefined, effort: string | undefined) {
  if (effort === undefined) return undefined;
  const descriptor = effortDescriptorOf(model?.capabilities?.optionDescriptors);
  if (descriptor === undefined || !(descriptor as { readonly options: ReadonlyArray<{ readonly id: string }> }).options.some((o) => o.id === effort)) return undefined;
  return [{ id: descriptor.id, value: effort }];
}

/** The effort a selection runs at, if it names one. */
export const effortOf = (options: unknown): string | undefined => effortValueOf(options);

// ------------------------------------------------------------------- Cloud

export interface RouteLink {
  /** The gateway /v1/route lives on. */
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly credential?: RoutingCredentialSource;
}

export interface RouteTask {
  readonly kind: SubagentRole;
  readonly agent?: string | undefined;
  readonly brief?: string | undefined;
}

/** Where a child's outcome goes: the answer's outcome token and the gateway that issued it, the only one that takes it. */
export interface RouteOutcome {
  readonly token: string;
  readonly url: string;
}

export type RouteAnswer =
  | { readonly kind: "pick"; readonly target: PoolTarget; readonly effort?: string; readonly outcome?: RouteOutcome }
  /** Cloud found nothing better in the pool (`no_alternative`): the caller's own default. */
  | { readonly kind: "default"; readonly outcome?: RouteOutcome }
  | { readonly kind: "fallback"; readonly reason: Fallback };

const PAUSED = new Set(["allowance", "billing_limit"]);

const headBytes = (text: string, max: number): string => {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= max ? text : bytes.subarray(0, max).toString("utf8").replace(/�+$/, "");
};

/** The task body: `models`, `task` and `pool`, nothing else. */
export const routeBody = (fallbackModel: string, task: RouteTask, pool: ReadonlyArray<PoolEntry>) => ({
  models: [catalogModel(fallbackModel)],
  task: {
    kind: task.kind,
    ...(task.agent ? { agent: headBytes(task.agent, AGENT_MAX_BYTES) } : {}),
    ...(task.brief ? { brief: headBytes(task.brief, BRIEF_MAX_BYTES) } : {}),
  },
  pool,
});

/** `promise`'s value, or undefined once `deadline` has passed first; the work itself runs on. */
const beforeDeadline = <A>(deadline: AbortSignal, promise: Promise<A>): Promise<A | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => (deadline.aborted ? resolve(undefined) : deadline.addEventListener("abort", () => resolve(undefined), { once: true })))]);

/**
 * One /v1/route call, time-boxed as a whole: a refused key's re-mint and the one retry share the box. Every failure
 * is an answer: a fallback with its reason.
 */
export async function askRoute(
  link: RouteLink,
  key: string,
  body: ReturnType<typeof routeBody>,
  targets: ReadonlyMap<string, PoolTarget>,
  retried = false,
  deadline = AbortSignal.timeout(link.timeoutMs),
): Promise<RouteAnswer> {
  let value: Record<string, unknown>;
  try {
    const response = await link.fetch(`${link.url}/v1/route`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: deadline,
    });
    // A refused key (revoked, its project gone) is no link; anything else Cloud can't answer is an error.
    if ([401, 402, 403].includes(response.status)) {
      await response.body?.cancel();
      // A re-mint that outlasts the box goes on for the next delegation; this one falls back.
      const next = await beforeDeadline(deadline, (async () => {
        await link.credential?.rejected(key, response.status, !retried);
        return retried || response.status === 402 ? undefined : link.credential?.get();
      })());
      if (next && next.key !== key) return askRoute({ ...link, url: next.url }, next.key, body, targets, true, deadline);
      return { kind: "fallback", reason: response.status === 402 ? "not_paying" : "cloud_unlinked" };
    }
    if (!response.ok) { await response.body?.cancel(); return { kind: "fallback", reason: "cloud_error" }; }
    const parsed: unknown = await response.json();
    // A body that is not an object (null, a list) is no answer.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "fallback", reason: "cloud_error" };
    value = parsed as Record<string, unknown>;
  } catch {
    return { kind: "fallback", reason: "cloud_error" };
  }
  if (typeof value.reason === "string" && PAUSED.has(value.reason)) return { kind: "fallback", reason: "quota" };
  const outcome = typeof value.outcome_token === "string" && value.outcome_token !== "" ? { outcome: { token: value.outcome_token, url: link.url } } : {};
  const id = typeof value.pool_id === "string" ? value.pool_id : undefined;
  if (id === undefined) return { kind: "default", ...outcome };
  const target = targets.get(id);
  // A pool id we never sent is not a decision.
  if (target === undefined) return { kind: "fallback", reason: "cloud_error" };
  const effort = typeof value.effort === "string" && value.effort !== "" ? value.effort : undefined;
  return { kind: "pick", target, ...(effort ? { effort } : {}), ...outcome };
}

export type OutcomeKind = "completed" | "failed" | "interrupted" | "accepted" | "rejected";

/** Posts one outcome; true when Cloud took it. Never throws. */
export async function postOutcome(link: RouteLink, key: string, token: string, kind: OutcomeKind): Promise<boolean> {
  try {
    const response = await link.fetch(`${link.url}/v1/route/outcomes`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ outcome_token: token, outcome_kind: kind }),
      signal: AbortSignal.timeout(link.timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- service

/** Where Auto asks (the credits gateway) and, for tests, a key and fetch of their own. */
export class SubagentRouteLink extends Context.Reference<RouteLink & { readonly key?: string | undefined }>("caveman/router/SubagentRouteLink", {
  defaultValue: () => ({ url: CREDITS_GATEWAY_URL, fetch: globalThis.fetch, timeoutMs: ROUTE_TIMEOUT_MS }),
}) {}

export class SubagentAuto extends Context.Service<
  SubagentAuto,
  {
    /** The route key (undefined: Cloud not linked) and the Caveman engine's connected models. */
    readonly connected: Effect.Effect<{ readonly key: string | undefined; readonly caveman: ReadonlyArray<string> | undefined }>;
    readonly ask: (key: string, body: ReturnType<typeof routeBody>, targets: ReadonlyMap<string, PoolTarget>) => Effect.Effect<RouteAnswer>;
    /** Kept by the delegation's command id until the projector adopts its child thread. */
    readonly remember: (commandId: string, runner: SubagentRunner, outcome: RouteOutcome | undefined) => Effect.Effect<void>;
    /** The runner the command that created `childThreadId` recorded, now bound to that thread. */
    readonly adopt: (commandId: string, childThreadId: string) => Effect.Effect<SubagentRunner | undefined>;
    /** The child ended: its outcome goes to Cloud once, when Cloud gave a token. Never fails. */
    readonly finish: (childThreadId: string, kind: "completed" | "failed" | "interrupted") => Effect.Effect<void>;
  }
>()("caveman/router/SubagentAuto") {}

const CAVEMAN = ProviderInstanceId.make("caveman");

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const link = yield* SubagentRouteLink;
  const host = yield* Effect.serviceOption(ProviderHost.ProviderHost);
  yield* sql`CREATE TABLE IF NOT EXISTS caveman_subagent_runners (
    command_id TEXT PRIMARY KEY,
    runner TEXT NOT NULL,
    outcome_token TEXT,
    child_thread_id TEXT,
    outcome_sent INTEGER NOT NULL DEFAULT 0)`.pipe(Effect.orDie);
  yield* sql`CREATE INDEX IF NOT EXISTS caveman_subagent_runners_child ON caveman_subagent_runners (child_thread_id)`.pipe(Effect.orDie);
  // Runners kept before the gateway was.
  if (!(yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('caveman_subagent_runners')`.pipe(Effect.orDie)).some((c) => c.name === "outcome_url")) {
    yield* sql`ALTER TABLE caveman_subagent_runners ADD COLUMN outcome_url TEXT`.pipe(Effect.orDie);
  }

  const connected = Effect.gen(function* () {
    const key = link.key ?? (yield* Effect.promise(() => routingCredential.get()))?.key;
    if (Option.isNone(host)) return { key, caveman: undefined };
    const keys = yield* readCavemanKeys(CAVEMAN).pipe(Effect.provideService(ProviderHost.ProviderHost, host.value), Effect.orElseSucceed((): CavemanKeys => ({})));
    const caveman = connectedModels(keys, yield* cavemanModels(keys));
    return { key, caveman };
  });

  return SubagentAuto.of({
    connected,
    ask: (key, body, targets) => Effect.promise(async (): Promise<RouteAnswer> => {
      if (link.key) return askRoute(link, key, body, targets);
      // The key goes only to its own credential's gateway: refused, signed out or another Cloud's since `connected`
      // read it, it is no longer this delegation's link.
      const credential = await routingCredential.get();
      if (credential?.key !== key) return { kind: "fallback", reason: "cloud_unlinked" };
      return askRoute({ ...link, credential: routingCredential, url: credential.url }, key, body, targets);
    }),
    // A failed write loses only the badge and the outcome, never the delegation.
    remember: (commandId, runner, outcome) =>
      sql`INSERT OR IGNORE INTO caveman_subagent_runners (command_id, runner, outcome_token, outcome_url)
        VALUES (${commandId}, ${JSON.stringify(runner)}, ${outcome?.token ?? null}, ${outcome?.url ?? null})`.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning("subagent auto: runner not kept", { cause })),
      ),
    adopt: (commandId, childThreadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ runner: string }>`SELECT runner FROM caveman_subagent_runners WHERE command_id = ${commandId}`;
        if (rows[0] === undefined) return undefined;
        yield* sql`UPDATE caveman_subagent_runners SET child_thread_id = ${childThreadId} WHERE command_id = ${commandId}`;
        return JSON.parse(rows[0].runner) as SubagentRunner;
      }).pipe(Effect.orDie),
    finish: (childThreadId, kind) =>
      Effect.gen(function* () {
        // Claimed before the call: a second terminal (a restart replay) never posts again. At most once per
        // child; when a reviewer's accepted/rejected arrives, outcome_sent becomes a claim per kind.
        const claimed = yield* sql<{ outcome_token: string; outcome_url: string | null }>`UPDATE caveman_subagent_runners SET outcome_sent = 1
          WHERE child_thread_id = ${childThreadId} AND outcome_sent = 0 AND outcome_token IS NOT NULL RETURNING outcome_token, outcome_url`;
        const row = claimed[0];
        if (row === undefined) return;
        const credential = link.key ? { key: link.key, url: link.url } : yield* Effect.promise(() => routingCredential.get());
        // Only the gateway that issued the token takes it, with its own Cloud's key: signed in to another Cloud since,
        // neither leaves. A runner kept before its gateway was goes where the credential's does.
        const url = row.outcome_url ?? credential?.url;
        if (credential === undefined || credential.url !== url) return;
        const sent = yield* Effect.promise(() => postOutcome({ ...link, url }, credential.key, row.outcome_token, kind));
        if (!sent) yield* Effect.logDebug("subagent auto: outcome not taken", { kind });
      }).pipe(Effect.catchCause(() => Effect.void)),
  });
});

export const layer = Layer.effect(SubagentAuto, make);
