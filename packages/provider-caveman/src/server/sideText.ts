/**
 * The Caveman engine's side calls: a model asked once, outside any chat, for the runtime (Record a skill, the Caveman
 * version, commit messages, PR text, titles, a review guide). Each is one turn of a harness session on the general
 * loadout (`app-general`): no built-in tool, the host's tools the whole surface (none here, read-only ones for an
 * investigation), the host's instructions the whole system text. The session lives for that turn only: closed after
 * it, so no cache keep-alive outlives the call.
 *
 * `cavemanSideText` is the runtime's own (Record a skill), on the user's stored key: no key, no call. It returns the
 * text and the turn's usage (absent when the provider reported none) for a spend row.
 *
 * @module provider-caveman/server/sideText
 */
import type * as Harness from "@caveman-ai/harness";
import type { ProviderInstanceId } from "@caveman-app/protocol";
import * as EgressRoute from "@caveman-app/engine-core/server/EgressRoute";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CAVEMAN_AUTO_MODEL, CAVEMAN_GATEWAY_URL, cavemanModelRefusal, modelsThroughScrub, resolveCavemanModel } from "./adapter.ts";
import { sourceOf } from "./connected.ts";
import { cavemanModels, onPlan, readCavemanKeys, storedSignIns, type CavemanKeys } from "./credentials.ts";
import { loadHarness } from "./harness.ts";
import { listPriceUsd } from "./providers.ts";

// ── one turn ──────────────────────────────────────────────────

/** `provider/model` (a key slot's, Caveman credits' `caveman/<vendor>/<model>`) as the model the harness runs. */
export const harnessModelOf = (models: MutableModels, model: string): Harness.HarnessModel | undefined => {
  const source = sourceOf(model);
  return models.getModel(source, model.slice(source.length + 1)) as Harness.HarnessModel | undefined;
};

/** Every request through `models`: their credentials, sign-ins and (routed) base URLs, as a chat's turns stream. */
export const streamThrough =
  (models: MutableModels): Harness.HarnessStreamFn =>
  (model, context, options) =>
    models.streamSimple(model, context, options);

/** Test seam of every side call: a scripted model. Production passes nothing. */
export interface SideCallEngine {
  /** Every model call (pi-ai's `streamSimple` shape). */
  readonly streamFn?: Harness.HarnessStreamFn | undefined;
  /** The model every call runs on, whatever was picked: pi-ai's (a test's faux model) or the harness's view of one. */
  readonly model?: Model<Api> | Harness.HarnessModel | undefined;
}

/** The seam's model, else `model` from `models`. */
export const sideCallModel = (engine: SideCallEngine, models: MutableModels, model: string): Harness.HarnessModel | undefined =>
  (engine.model as Harness.HarnessModel | undefined) ?? harnessModelOf(models, model);

export interface SideTurn {
  readonly model: Harness.HarnessModel;
  readonly stream: Harness.HarnessStreamFn;
  /** The whole system text. */
  readonly instructions: string;
  readonly prompt: string;
  /** Where the turn is about: the env block names it (and an investigation's tools read there). */
  readonly cwd: string;
  /** The turn's only tools. None: a plain answer. */
  readonly tools?: ReadonlyArray<Harness.HarnessTool> | undefined;
  /** How hard the model thinks; none: the model's own default. */
  readonly effort?: Harness.Effort | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * One turn of a fresh harness session on the general loadout, closed after it. The harness's policy holds (transient
 * errors retried with the same request, a loop or a run of empty answers stopped); its usage counts every request.
 */
export async function harnessSideTurn(turn: SideTurn): Promise<Harness.TurnOutcome> {
  const h = await loadHarness();
  const session = new h.HarnessSession({
    model: turn.model,
    stream: turn.stream,
    ...(turn.effort === undefined ? {} : { effort: turn.effort }),
    loadout: h.appLoadouts().general,
    // No tool of the harness's runs here: the env names the directory in the first message, and closes with the session.
    env: new h.LocalEnv({ cwd: turn.cwd }),
    tools: [...(turn.tools ?? [])],
    instructions: turn.instructions,
  });
  try {
    return await session.runTurn(turn.prompt, turn.signal === undefined ? {} : { signal: turn.signal });
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ── usage ─────────────────────────────────────────────────────

/** A turn's usage as a side call reads it (the harness's TurnUsage). */
export type SideUsage = Pick<Harness.TurnUsage, "requests" | "input" | "output" | "cacheRead" | "cacheWrite" | "costUsd">;

/**
 * A side request's usage for Settings -> Spend; undefined when the provider reported none. The user's key paid for it,
 * or, on a provider `keys` has on a plan, their subscription did: tokens only, never a price. A key's call is priced at
 * the harness's list price when it priced every request, else at the catalog's public price for the model.
 */
export const sideCallUsage = (model: string, usage: SideUsage, keys: CavemanKeys) => {
  if (usage.requests === 0 || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return undefined;
  const provider = model.slice(0, Math.max(0, model.indexOf("/")));
  const plan = onPlan(provider, keys[provider]);
  return {
    engine: "caveman" as const,
    model,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
    cost: plan ? null : usage.costUsd !== null ? { usd: usage.costUsd, basis: "list_price" as const } : listedCost(model, usage),
    ...(plan ? { billing: "plan" as const } : {}),
  };
};

/**
 * The harness left the turn unpriced (a model whose catalog entry has no price: Caveman credits' models, an endpoint):
 * the catalog's public price for its tokens, as the session usage rows price a key (labelled list price).
 */
const listedCost = (model: string, usage: SideUsage) => {
  const usd = listPriceUsd(model, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
  return usd === undefined ? null : { usd, basis: "list_price" as const };
};

// ── Record a skill ────────────────────────────────────────────

export const cavemanSideText = Effect.fn("cavemanSideText")(function* (
  input: {
    readonly instanceId: ProviderInstanceId;
    readonly instructions: string;
    readonly prompt: string;
    readonly cwd: string;
  },
  /** Test seam: a scripted model. Production passes nothing. */
  engine: SideCallEngine = {},
) {
  const keys = yield* readCavemanKeys(input.instanceId).pipe(Effect.mapError((cause) => new Error("Could not read the Caveman engine's API keys.", { cause })));
  const model = resolveCavemanModel(CAVEMAN_AUTO_MODEL, keys);
  if (model === null) return yield* Effect.fail(new Error(cavemanModelRefusal(CAVEMAN_AUTO_MODEL)));
  // Titles, commit text and skills carry session content: through the egress scrub. EgressRoute
  // comes with the runtime's secret store (one layer), so a context without it holds no secrets.
  const egress = yield* Effect.serviceOption(EgressRoute.EgressRoute);
  const models = yield* cavemanModels(keys, yield* storedSignIns(input.instanceId));
  if (Option.isSome(egress) && egress.value.route(CAVEMAN_GATEWAY_URL) === undefined) {
    const blocked = yield* egress.value.hasSecrets(input.cwd).pipe(Effect.orElseSucceed(() => true));
    if (blocked) {
      return yield* Effect.fail(
        new Error("This project has secrets, and the Caveman engine cannot run without the egress scrub that keeps them from the model."),
      );
    }
  }
  const routedModels = Option.isSome(egress) ? modelsThroughScrub(models, egress.value.route) : models;
  const harnessModel = sideCallModel(engine, routedModels, model);
  if (harnessModel === undefined) return yield* Effect.fail(new Error(`The Caveman engine has no model ${model}.`));
  const stream = engine.streamFn ?? streamThrough(routedModels);
  const outcome = yield* Effect.tryPromise({
    try: (signal) => harnessSideTurn({ model: harnessModel, stream, instructions: input.instructions, prompt: input.prompt, cwd: input.cwd, signal }),
    catch: (cause) => new Error("The Caveman engine failed.", { cause }),
  });
  if (outcome.status === "error") return yield* Effect.fail(new Error("The Caveman engine failed.", { cause: new Error(outcome.error ?? outcome.stopReason) }));
  return { text: outcome.finalText, usage: sideCallUsage(model, outcome.usage, keys) };
});
