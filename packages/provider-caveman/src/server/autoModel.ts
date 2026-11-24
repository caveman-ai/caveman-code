/**
 * The Caveman engine's own `auto`: the model a session runs on when nobody picked one, from the keys it has. No heavy
 * imports, so `caveman-runtime agent exec` resolves it without loading the app's adapter (adapter.ts re-exports it).
 *
 * @module provider-caveman/server/autoModel
 */
import type { CavemanKeys } from "./credentials.ts";
import { CREDITS_PROVIDER } from "./credits.ts";
import { defaultModelId, providerOrder } from "./providers.ts";

/** Model sentinel: the first stored key picks, in the engine's own order. */
export const CAVEMAN_AUTO_MODEL = "auto";
/**
 * Whose key picks first, in this order, then every other one in Models & keys order. Each runs its provider's default
 * (its first family's newest model, providers.ts), so the default moves with new versions; not routing.
 */
export const AUTO_PROVIDERS = ["anthropic", "openai", "google", CREDITS_PROVIDER] as const;
/** What Caveman credits run by default: a model the plan sells (credits.ts). */
export const CREDITS_DEFAULT_MODEL = `${CREDITS_PROVIDER}/anthropic/claude-sonnet-5-5`;

const autoRank = (provider: string) => {
  const at = (AUTO_PROVIDERS as ReadonlyArray<string>).indexOf(provider);
  return at < 0 ? AUTO_PROVIDERS.length : at;
};

export function resolveCavemanModel(model: string, keys: CavemanKeys): string | null {
  if (model === CAVEMAN_AUTO_MODEL || model === "default") {
    for (const provider of Object.keys(keys).sort((a, b) => autoRank(a) - autoRank(b) || providerOrder(a) - providerOrder(b))) {
      if (provider === CREDITS_PROVIDER) return CREDITS_DEFAULT_MODEL;
      const id = defaultModelId(provider, keys[provider]?.endpoint?.models);
      if (id !== undefined) return `${provider}/${id}`;
    }
    return null;
  }
  const slash = model.indexOf("/");
  const stored = (keys as Readonly<Record<string, string | undefined>>)[model.slice(0, slash)];
  return slash > 0 && slash < model.length - 1 && stored !== undefined ? model : null;
}
