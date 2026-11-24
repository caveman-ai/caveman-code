/**
 * message.caveman_version: one assistant message rewritten in caveman speak by
 * the cheapest model the user has a Caveman key for. A side request with no
 * tools (one harness turn, sideText.ts); nothing is written to the session. With
 * no stored key it fails, and the Session Protocol answers engine_unavailable.
 * Keys come only from the runtime's store (Settings), never the environment.
 *
 * @module provider-caveman/server/rewriter
 */
import * as NodePath from "node:path";

import type { ProviderInstanceId } from "@caveman-app/protocol";
import type * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as EgressRoute from "@caveman-app/engine-core/server/EgressRoute";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { MutableModels } from "@earendil-works/pi-ai";

import { modelsThroughScrub } from "./adapter.ts";
import { cavemanModels, readCavemanKeys, storedSignIns, type CavemanKeys } from "./credentials.ts";
import { harnessSideTurn, sideCallModel, sideCallUsage, streamThrough, type SideCallEngine } from "./sideText.ts";

// The usage row of every side request lives with the turn that measures it (sideText.ts).
export { sideCallUsage } from "./sideText.ts";

/**
 * The cheapest catalog chat model per key provider, ordered by catalog price
 * (input + output per MTok): the first keyed one is the cheapest available.
 * ponytail: a fixed table read off pi-ai's catalog; pick from cavemanModels'
 * prices when it churns (a plain min picks free gemma or a classifier today).
 */
const CHEAP_MODEL_BY_PROVIDER = [
  ["openai", "openai/gpt-5-nano"], // $0.05 / $0.40
  ["google", "google/gemini-2.5-flash-lite"], // $0.10 / $0.40
  ["anthropic", "anthropic/claude-haiku-5-5"], // $0.10 / $0.50
  // Caveman credits last: a person's own key pays before their plan does. Haiku through the Cloud gateway (credits.ts).
  ["caveman", "caveman/anthropic/claude-haiku-5-5"],
] as const;

/**
 * The cheapest model the stored keys allow, or undefined with no key. Every side request uses it. With the connected
 * set (connected.ts) and its catalog, a source the table does not name (another provider's key, an endpoint, a linked
 * plan) still gives one: its cheapest listed model, else the first connected one. Never anything not connected.
 */
export const cheapCavemanModel = (keys: CavemanKeys, connected?: ReadonlyArray<string>, models?: MutableModels): string | undefined => {
  const fixed = CHEAP_MODEL_BY_PROVIDER.find(([provider]) => keys[provider] !== undefined)?.[1];
  if (fixed !== undefined && (connected === undefined || connected.includes(fixed))) return fixed;
  if (connected === undefined || connected.length === 0) return undefined;
  const price = (id: string) => {
    const slash = id.indexOf("/");
    const cost = models?.getModel(id.slice(0, slash), id.slice(slash + 1))?.cost;
    return cost === undefined || cost.input + cost.output === 0 ? Number.POSITIVE_INFINITY : cost.input + cost.output;
  };
  return [...connected].sort((a, b) => price(a) - price(b))[0];
};

/**
 * The message goes in <message> tags: the harness opens a thread's first message with its env block, which is not
 * the person's words and must not come back rewritten.
 */
export const CAVEMAN_VERSION_INSTRUCTIONS =
  "Rewrite the message between <message> and </message> in caveman speak: short words, no filler, no pleasantries, " +
  "drop articles and hedges. Keep every fact, number, name, path, command and code block exactly as written. " +
  "Answer with the rewritten message only, without the tags.";

const asMessage = (text: string) => `<message>\n${text}\n</message>`;
/** A model that kept the tags anyway: the text inside them. */
const unwrapped = (text: string) => text.trim().replace(/^<message>\s*/, "").replace(/\s*<\/message>$/, "");

/** The rewrite is about no directory: the env block names the filesystem root, which says nothing about the person. */
const NO_DIRECTORY = NodePath.parse(process.cwd()).root;

export const makeCavemanRewriter = Effect.fn("makeCavemanRewriter")(function* (
  instanceId: ProviderInstanceId,
  /** Test seam: a scripted model. Production passes nothing. */
  engine: SideCallEngine = {},
) {
  const context = yield* Effect.context<ProviderHost.ProviderHost>();
  // Stored message text goes to a model: through the egress scrub when the host has one.
  const egress = yield* Effect.serviceOption(EgressRoute.EgressRoute);
  return {
    rewrite: (text: string): Effect.Effect<{ readonly text: string; readonly usage: ReturnType<typeof sideCallUsage> }, Error> =>
      Effect.gen(function* () {
        const keys = yield* readCavemanKeys(instanceId).pipe(
          Effect.mapError(() => new Error("Could not read the Caveman engine's API keys.")),
        );
        const model = cheapCavemanModel(keys);
        if (model === undefined) {
          return yield* Effect.fail(new Error("The Caveman engine has no key or sign-in. Add one in Settings."));
        }
        const signedIn = yield* cavemanModels(keys, yield* storedSignIns(instanceId));
        const models = Option.isSome(egress) ? modelsThroughScrub(signedIn, egress.value.route) : signedIn;
        const harnessModel = sideCallModel(engine, models, model);
        if (harnessModel === undefined) return yield* Effect.fail(new Error(`The Caveman version failed: the Caveman engine has no model ${model}.`));
        const outcome = yield* Effect.tryPromise({
          try: (signal) =>
            harnessSideTurn({
              model: harnessModel,
              stream: engine.streamFn ?? streamThrough(models),
              instructions: CAVEMAN_VERSION_INSTRUCTIONS,
              prompt: asMessage(text),
              cwd: NO_DIRECTORY,
              signal,
            }),
          catch: (cause) => new Error(`The Caveman version failed: ${cause instanceof Error ? cause.message : String(cause)}`),
        }).pipe(
          // A stalled provider must not hang the RPC: the timeout aborts the turn.
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new Error("The Caveman version timed out.")),
          }),
        );
        if (outcome.status === "error") return yield* Effect.fail(new Error(`The Caveman version failed: ${outcome.error ?? outcome.stopReason}`));
        // The caller records the usage as a runtime-level spend row (never a session event).
        return { text: unwrapped(outcome.finalText), usage: sideCallUsage(model, outcome.usage, keys) };
      }).pipe(Effect.provide(context)),
  };
});
