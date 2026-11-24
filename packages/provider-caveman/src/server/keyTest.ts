/**
 * The test call made when a key is added (and from "Test" in Models & keys):
 * one tiny request to the provider's cheapest current model, so a wrong key
 * shows on the page instead of as a failed first turn. Nothing of the person's
 * work is sent: the prompt is fixed.
 *
 * @module provider-caveman/server/keyTest
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { cavemanModels, cavemanSecrets, type CavemanCredential, type StoredSignIns } from "./credentials.ts";
import { currentModels, isNewModel } from "./providers.ts";

export type KeyTest =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly kind: "auth" | "limit" | "network" | "other"; readonly message: string };

const TEST_TIMEOUT_MS = 20_000;

/** What a provider's error says, in our four kinds. Quota and rate limits mean the key works. */
export const classifyProviderError = (message: string): "auth" | "limit" | "network" | "other" =>
  /\b429\b|rate.?limit|quota|insufficient_quota|overloaded|too many requests/i.test(message)
    ? "limit"
    : /\b401\b|\b403\b|invalid.{0,20}(api.?)?key|api key|unauthori[sz]ed|authentication|permission/i.test(message)
      ? "auth"
      : /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network|timed out|aborted/i.test(message)
        ? "network"
        : "other";

/**
 * The model a test call uses: the cheapest current one (providers.ts), else the cheapest listed. Never one models.dev
 * added: an account may not have it yet, and a good key would read as failing.
 */
export const testModel = (models: ReadonlyArray<Model<Api>>, provider: string): Model<Api> | undefined => {
  const known = models.filter((model) => !isNewModel(provider, model.id));
  const pool = currentModels(provider, known) ?? known;
  const price = (m: Model<Api>) => (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
  return [...(pool.length > 0 ? pool : models)].sort((a, b) => price(a) - price(b))[0];
};

/** `stored`: the credential is the stored one, so a sign-in the test refreshes is stored back. */
export const testCavemanCredential = (provider: string, credential: CavemanCredential, stored?: StoredSignIns): Effect.Effect<KeyTest> =>
  Effect.gen(function* () {
    const models = yield* cavemanModels({ [provider]: credential }, stored);
    const model = testModel(models.getModels(provider), provider);
    if (model === undefined) return { ok: false, kind: "other", message: "This provider lists no models to test with." } as const;
    const secrets = cavemanSecrets({ [provider]: credential });
    const redact = (text: string) => secrets.reduce((out, s) => out.replaceAll(s, "[redacted]"), text);
    return yield* Effect.promise(async (): Promise<KeyTest> => {
      try {
        const reply = await models.completeSimple(
          model,
          { messages: [{ role: "user", content: "Reply with the word OK.", timestamp: Date.now() }] },
          { maxTokens: 16, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
        );
        if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { ok: true, model: model.id };
        const message = redact(reply.errorMessage ?? "The provider answered with an error.");
        return { ok: false, kind: reply.stopReason === "aborted" ? "network" : classifyProviderError(message), message };
      } catch (cause) {
        const message = redact(cause instanceof Error ? cause.message : String(cause));
        return { ok: false, kind: classifyProviderError(message), message };
      }
    });
  });

/** The test call engine.account.add makes; tests swap in a stub so no key is ever sent anywhere. */
export class CavemanKeyTester extends Context.Reference<(provider: string, credential: CavemanCredential, stored?: StoredSignIns) => Effect.Effect<KeyTest>>(
  "caveman/provider-caveman/CavemanKeyTester",
  { defaultValue: () => testCavemanCredential },
) {}
