/**
 * Caveman credits: the Caveman engine's provider whose models run on
 * Caveman's own provider keys through the hosted Cloud gateway, paid from the
 * organization's Code plan and credits. The credential is a
 * credits key Cloud mints for the signed-in person (`keys.caveman`); every
 * request carries `x-caveman-client: caveman-code/<version>`, without which
 * the broker refuses plan usage.
 *
 * Models are pi-ai's own definitions of the models the plan catalog sells,
 * each re-homed on a `caveman-<provider>` provider at the gateway's route for
 * that provider, so a person's own provider key and the credits key never
 * share a credential slot. The picker shows them as `caveman/<provider>/<id>`.
 *
 * @module provider-caveman/server/credits
 */
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { compareLines, modelLine, newestOfFamilies } from "@caveman-app/engine-core/server/modelLine";

/** The key slot and picker prefix of Caveman credits. */
export const CREDITS_PROVIDER = "caveman";

/**
 * The key slot and picker prefix of a compact plan linked through Caveman
 * Cloud (Sign in with compact, the spec): a key Cloud mints on the person's
 * link, served by the gateway's OpenAI Responses route only. Dormant until
 * OpenAI issues Caveman a client id; nothing in the app stores one before.
 * A compact login is never taken from Codex or any other tool.
 */
export const CHATGPT_PLAN_PROVIDER = "chatgpt";

/** Caveman's hosted gateway, where the hosted Cloud's credits keys run. */
export const HOSTED_GATEWAY_URL = "https://gateway.caveman.so";

/** CAVEMAN_CREDITS_GATEWAY_URL points a dev build or a test at a gateway of its own, whichever Cloud minted the key. */
export const CREDITS_GATEWAY_OVERRIDE = process.env.CAVEMAN_CREDITS_GATEWAY_URL?.replace(/\/+$/, "") || undefined;

/** The hosted gateway, or the override. */
export const CREDITS_GATEWAY_URL = CREDITS_GATEWAY_OVERRIDE ?? HOSTED_GATEWAY_URL;

/**
 * Where a credits or plan key runs: the override, else the gateway of the
 * Cloud that minted it (kept with the key), else the hosted one. A key stored
 * without a gateway was minted by the hosted Cloud: builds before keys kept
 * their gateway only ever sent credits there.
 */
export const gatewayOf = (credential: { readonly gateway?: string | undefined } | undefined): string =>
  CREDITS_GATEWAY_OVERRIDE ?? credential?.gateway ?? HOSTED_GATEWAY_URL;

/** How pi-ai reaches the gateway's route for one provider: its own provider id there, the route's prefix and wire. */
interface Route {
  readonly pi: string;
  readonly path: string;
  readonly api: keyof typeof API;
}

/**
 * Each provider credits sell from, by Cloud's catalog provider id (`moonshot/kimi-k3`), on the gateway's route for it.
 * Which models are sold is Cloud's to say (`setCreditsModels`); this changes only when Cloud sells from a new provider.
 */
const ROUTES: Readonly<Record<string, Route>> = {
  anthropic: { pi: "anthropic", path: "", api: "anthropic-messages" },
  openai: { pi: "openai", path: "/v1", api: "openai-responses" },
  moonshot: { pi: "moonshotai", path: "/moonshot/v1", api: "openai-completions" },
  "z-ai": { pi: "zai", path: "/z-ai/v1", api: "openai-completions" },
  deepseek: { pi: "deepseek", path: "/deepseek/v1", api: "openai-completions" },
};

/**
 * What credits sell until Cloud has said (offline, before the first answer): plan catalog v14's nine models. GLM 5.3 is
 * at rate 3000 and goes three times as far against a plan; GLM 5.3 Flash and DeepSeek Flash are at 2000 and go twice as
 * far; Claude, GPT and Kimi K3 draw at list price (1000).
 */
const BUNDLED_CREDITS_MODELS: ReadonlyArray<string> = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "moonshot/kimi-k3",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-flash",
];

/** A sold model as Cloud names it: catalog provider, then the model id. Anything else from the network is dropped. */
const CREDITS_MODEL = /^([a-z0-9][a-z0-9_-]*)\/([\w.:@~+-]{1,200})$/;
const MAX_CREDITS_MODELS = 500;
const CREDITS_CACHE_FILE = "caveman-credits-models.json";

/** Cloud's answer to GET /api/v1/code/credits/models, as the models it sells; undefined when it is not that answer. */
export function parseCreditsModels(json: unknown): ReadonlyArray<string> | undefined {
  const models = recordOf(json)?.models;
  if (!Array.isArray(models)) return undefined;
  return [
    ...new Set(
      models.flatMap((entry) => {
        const model = recordOf(entry)?.model;
        return typeof model === "string" && CREDITS_MODEL.test(model) ? [model] : [];
      }),
    ),
  ].slice(0, MAX_CREDITS_MODELS);
}

let cloudCredits: ReadonlyArray<string> | undefined;
let creditsDiskLoad: Promise<void> | undefined;

/** What credits sell here: Cloud's last answer, else the bundled list. */
export const creditsModels = (): ReadonlyArray<string> => cloudCredits ?? BUNDLED_CREDITS_MODELS;

/** Takes the list Cloud sent before this process started, once. */
export const loadCreditsModels = (stateDir: string): Promise<void> =>
  (creditsDiskLoad ??= NodeFS.promises
    .readFile(NodePath.join(stateDir, CREDITS_CACHE_FILE), "utf8")
    .then((raw) => {
      cloudCredits ??= parseCreditsModels(JSON.parse(raw));
    })
    .catch(() => undefined));

/**
 * Keeps what Cloud sells (`parseCreditsModels`), here and on disk, so a model Cloud starts selling runs with no app
 * release; undefined forgets it (another Cloud signed in). The next provider check lists the change.
 */
export async function setCreditsModels(stateDir: string, models: ReadonlyArray<string> | undefined): Promise<void> {
  cloudCredits = models;
  creditsDiskLoad = Promise.resolve();
  const cachePath = NodePath.join(stateDir, CREDITS_CACHE_FILE);
  await (models === undefined
    ? NodeFS.promises.rm(cachePath, { force: true })
    : NodeFS.promises.writeFile(`${cachePath}.tmp`, JSON.stringify({ models: models.map((model) => ({ model })) })).then(() => NodeFS.promises.rename(`${cachePath}.tmp`, cachePath))
  ).catch(() => undefined);
}

/** `models` (Cloud's ids) on their routes; a provider without a route waits for an app release. */
function soldOf(models: ReadonlyArray<string>): Sold {
  const sold = new Map<string, { route: Route; ids: Array<string> }>();
  for (const model of models) {
    const [, provider, id] = CREDITS_MODEL.exec(model) ?? [];
    const route = provider === undefined ? undefined : ROUTES[provider];
    if (route === undefined || id === undefined) continue;
    const group = sold.get(route.pi) ?? { route, ids: [] };
    group.ids.push(id);
    sold.set(route.pi, group);
  }
  return [...sold.values()].map(({ route, ids }) => ({ ...route, ids }));
}

/**
 * pi-ai's definition of a sold model, or, for a newer version than this build's catalog has, its family's newest
 * model's wire under the new id: no name or price is guessed (models.dev adds them where it lists the model).
 */
function soldModel(models: MutableModels, pi: string, id: string, api: keyof typeof API): Model<Api> | undefined {
  const known = models.getModel(pi, id);
  if (known !== undefined) return known.api === api ? known : undefined;
  const line = modelLine(id);
  const base = newestOfFamilies(models.getModels(pi).filter((model) => model.api === api), [line.family])[0];
  if (base === undefined || compareLines(line, modelLine(base.id)) >= 0) return undefined;
  return { ...base, id, name: id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
}

/** What a linked compact plan runs: OpenAI's Codex-plan models, on the gateway's Responses route. */
const PLAN = [{ pi: "openai", ids: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], path: "/v1", api: "openai-responses" }] as const;

const API = { "anthropic-messages": anthropicMessagesApi, "openai-responses": openAIResponsesApi, "openai-completions": openAICompletionsApi } as const;

type Sold = ReadonlyArray<Route & { readonly ids: ReadonlyArray<string> }>;

/** A Cloud computer's credits key as its runtime holds it now, and where it runs. */
type LiveCredit = () => Promise<{ readonly key: string; readonly gateway?: string } | undefined>;

/**
 * Adds the credits providers to `models` (a catalog built from pi-ai's
 * builtins) and answers `caveman/<provider>/<id>` lookups. `key` is the
 * credits key; `client` the x-caveman-client value. `live`, a Cloud
 * computer's: the key its runtime holds now and its gateway, read at every
 * request, and nothing else (`key` is never sent in its place). A request
 * with none fails.
 */
export const withCredits = (models: MutableModels, key: string, client: string, gatewayUrl = CREDITS_GATEWAY_URL, live?: LiveCredit): MutableModels =>
  withAccount(models, CREDITS_PROVIDER, "Caveman credits", soldOf(creditsModels()), key, client, gatewayUrl, live);

/** A linked compact plan's models (`compact/<provider>/<id>`) on the plan key Cloud minted. */
export const withChatGptPlan = (models: MutableModels, key: string, client: string, gatewayUrl = CREDITS_GATEWAY_URL): MutableModels =>
  withAccount(models, CHATGPT_PLAN_PROVIDER, "ChatGPT plan", PLAN, key, client, gatewayUrl);

/** Models one account slot (credits, a plan) sells, re-homed on `<slot>-<provider>` at the gateway's route for each. */
function withAccount(models: MutableModels, slot: string, label: string, sells: Sold, key: string, client: string, gatewayUrl: string, live?: LiveCredit): MutableModels {
  /** The request's key and base URL: the account's own, or a Cloud computer's key held now, on its gateway. */
  const auth = async (path: string): Promise<{ apiKey: string; baseUrl?: string }> => {
    if (live === undefined) return { apiKey: key };
    const now = await live().catch(() => undefined);
    if (now === undefined) throw new Error("Caveman credits can't pay for this on this Cloud computer right now: Cloud gave it no credits key. Try again in a moment.");
    return { apiKey: now.key, baseUrl: `${gatewayOf(now)}${path}` };
  };
  const local: Array<readonly [string, string]> = [];
  for (const sold of sells) {
    const id = `${slot}-${sold.pi}`;
    const picked = sold.ids.flatMap((modelId) => {
      const model = soldModel(models, sold.pi, modelId, sold.api);
      return model ? [{ ...model, provider: id, baseUrl: `${gatewayUrl}${sold.path}`, headers: { ...model.headers, "x-caveman-client": client } } as Model<Api>] : [];
    });
    if (picked.length === 0) continue;
    models.setProvider(
      createProvider({
        id,
        name: label,
        baseUrl: `${gatewayUrl}${sold.path}`,
        auth: { apiKey: { name: `${label} key`, resolve: async () => ({ auth: await auth(sold.path), source: "Caveman account" }) } },
        models: picked,
        api: API[sold.api](),
      }),
    );
    for (const model of picked) local.push([sold.pi, model.id]);
  }
  const lookup = (id: string) => {
    const slash = id.indexOf("/");
    return slash > 0 ? models.getModel(`${slot}-${id.slice(0, slash)}`, id.slice(slash + 1)) : undefined;
  };
  const sold = () => local.flatMap(([pi, id]) => models.getModels(`${slot}-${pi}`).filter((m) => m.id === id));
  return new Proxy(models, {
    get(target, property) {
      if (property === "getModel") return (provider: string, id: string) => (provider === slot ? lookup(id) : target.getModel(provider, id));
      if (property === "getModels") return (provider: string) => (provider === slot ? sold() : target.getModels(provider));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `<slot>/<provider>/<id>` for an account slot's model (credits, a plan); the picker's slug. */
export const accountSlug = (slot: string, model: Model<Api>) => `${slot}/${model.provider.slice(slot.length + 1)}/${model.id}`;

/** `caveman/<provider>/<id>` for a credits model; the picker's slug. */
export const creditsSlug = (model: Model<Api>) => accountSlug(CREDITS_PROVIDER, model);

/**
 * Cloud's gateway refuses a credits request it cannot pay for with 402 and
 * `{ error: { type: "cave_gateway_error", code: "cave_code_credits_exhausted",
 * message, details: { reason, resets_at } } }` (gateway-managed broker.go,
 * reasons from internal/broker). pi-ai puts that body, or its `error` object,
 * into the model's error text. The failure keeps the code, so the chat can
 * lead to Settings > Account.
 */
export const CREDITS_LIMIT_CODE = "cave_code_credits_exhausted";
/** Pay as you go adding credits right now: the gateway's 429 with Retry-After (gateway-managed broker.go), reason `auto_topup_pending`. */
const TOPPING_UP_CODE = "cave_code_rate_limited";

/**
 * Each refusal reason in the app's own words, and how it lifts. `reset`: by
 * itself at `resets_at` (the plan's windows and month, the platform's monthly
 * ceiling, Pay as you go's monthly limit on the 1st, and the free lane's daily
 * limit at the next UTC midnight; Cloud's ledger.go sends all of them).
 * `retry`: in seconds, once Pay as you go's charge lands (the gateway answers
 * 429 with Retry-After, which the model call honours before it gives up).
 * `never`: only credits, another plan or a fix in Settings > Plan lift it.
 * The gateway's own message is never shown.
 */
const REFUSALS = new Map<string, { readonly message: string; readonly lifts: "reset" | "retry" | "never" }>([
  ["window_5h", { message: "Your Caveman plan's 5-hour usage window is used up.", lifts: "reset" }],
  ["window_week", { message: "Your Caveman plan's weekly usage window is used up.", lifts: "reset" }],
  ["month", { message: "Your Caveman plan's usage for this month is used up.", lifts: "reset" }],
  ["platform", { message: "Included Caveman plan usage is paused for everyone until the month ends.", lifts: "reset" }],
  ["no_credits", { message: "No Caveman plan usage or credits are left for this model. Top up or change plan to continue.", lifts: "never" }],
  ["free_daily_limit", { message: "Today's free requests on this model are used up. Top up or choose a plan to continue.", lifts: "reset" }],
  ["auto_topup_pending", { message: "Pay as you go is adding credits from your card. Try again in a few seconds.", lifts: "retry" }],
  ["auto_topup_paused", { message: "Credits ran out, and Pay as you go is paused or has no card. Fix it in Settings > Plan to continue.", lifts: "never" }],
  ["auto_topup_limit", { message: "Credits ran out, and Pay as you go reached this month's limit. Raise it in Settings > Plan to continue now.", lifts: "reset" }],
]);

/** Longer than any error text pi-ai builds (it caps a body at 4,000 characters); anything longer is not read. */
const MAX_REFUSAL_TEXT = 16_384;
/** No plan window or month resets further out than this; a later time is not believed. */
const MAX_RESET_MS = 40 * 24 * 60 * 60 * 1000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface CreditsRefusal {
  readonly reason: string;
  readonly message: string;
  /** When the plan admits again (ISO 8601, in the future); null when only credits or another plan help, or the time did not parse. */
  readonly resetAt: string | null;
  /** It lifts by itself: at `resetAt`, or in seconds while Pay as you go's charge lands (`auto_topup_pending`). */
  readonly retryable: boolean;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The gateway's credits refusal in a model error's text, or undefined. The
 * body is untrusted: anything but the exact shape is not a refusal, the
 * message is the app's own, and a reset time that does not parse, is past or
 * is too far out is dropped.
 */
export function creditsRefusal(text: string, now = Date.now()): CreditsRefusal | undefined {
  if (text.length > MAX_REFUSAL_TEXT || !(text.includes(CREDITS_LIMIT_CODE) || text.includes(TOPPING_UP_CODE))) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const body = recordOf(parsed);
  // The whole envelope (Anthropic's SDK), or its error object (OpenAI's SDK unwraps it).
  const error = recordOf(body?.error) ?? body;
  if (error?.type !== "cave_gateway_error" || (error.code !== CREDITS_LIMIT_CODE && error.code !== TOPPING_UP_CODE)) return undefined;
  const details = recordOf(error.details);
  const reason = typeof details?.reason === "string" ? details.reason : undefined;
  // The gateway sends a top-up in flight as a 429 rate limit (Retry-After), so SDKs wait it out; only that reason counts under that code.
  if (error.code === TOPPING_UP_CODE && reason !== "auto_topup_pending") return undefined;
  const known = reason === undefined ? undefined : REFUSALS.get(reason);
  if (reason === undefined || known === undefined) return undefined;
  const resetAt = known.lifts === "reset" ? resetOf(details?.resets_at, now) : null;
  return { reason, message: known.message, resetAt, retryable: known.lifts === "retry" || resetAt !== null };
}

function resetOf(value: unknown, now: number): string | null {
  if (typeof value !== "string" || value.length > 40 || !RFC3339.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now && at - now <= MAX_RESET_MS ? new Date(at).toISOString() : null;
}
