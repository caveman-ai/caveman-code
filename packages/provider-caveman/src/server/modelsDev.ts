/**
 * models.dev as the Caveman engine reads it (engine-core modelsDev.ts fetches it, for every engine at once): which
 * models their makers deprecated, and the models a pinned family gained since this build's pi-ai catalog. A new version
 * (GPT-6.2 Sol after GPT-6.1 Sol) then shows up as soon as models.dev has it, with no app release: it runs on its
 * family's newest catalog model's wire (API, endpoint, compat, effort levels, output cap) with models.dev's own name,
 * context and prices. A family the catalog has no model of gains nothing; it waits for a pi-ai upgrade.
 *
 * @module provider-caveman/server/modelsDev
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { compareLines, modelLine, newestOfFamilies } from "@caveman-app/engine-core/server/modelLine";
import { MODELS_DEV_PROVIDER_OF_PI_AI, modelsDevFacts, type ModelFacts } from "@caveman-app/engine-core/server/modelsDev";

/** models.dev's facts for a pi-ai provider, or undefined before the first fetch. */
export const factsFor = (provider: string): Readonly<Record<string, ModelFacts>> | undefined =>
  modelsDevFacts()?.[MODELS_DEV_PROVIDER_OF_PI_AI[provider] ?? provider];

/** Whether models.dev calls this model of a pi-ai provider deprecated. */
export const isDeprecated = (provider: string, id: string): boolean => factsFor(provider)?.[id]?.deprecated === true;

/**
 * For each of `families`, every model models.dev lists that is newer than the newest `catalog` has, deprecated ones
 * too (a chat on one keeps running; the picker lists only the newest current one), as a model record: that catalog
 * model's wire and output cap, models.dev's name, context and prices (none known: no price, never a guess).
 */
export function newerModels(
  catalog: ReadonlyArray<Model<Api>>,
  facts: Readonly<Record<string, ModelFacts>> | undefined,
  families: ReadonlyArray<string>,
): Array<Model<Api>> {
  if (facts === undefined) return [];
  const known = new Set(catalog.map((model) => model.id));
  const listed = Object.keys(facts).filter((id) => !known.has(id));
  return families.flatMap((family) => {
    // The template is the family's newest catalog model even when deprecated: its successor still runs on its wire.
    const base = newestOfFamilies(catalog, [family])[0];
    if (base === undefined) return [];
    const line = modelLine(base.id);
    return listed
      .filter((id) => modelLine(id).family === family && compareLines(modelLine(id), line) < 0)
      .map((id) => {
        const fact = facts[id]!;
        return {
          ...base,
          id,
          name: fact.name,
          reasoning: fact.reasoning,
          input: fact.image ? ["text", "image"] : ["text"],
          contextWindow: fact.context ?? base.contextWindow,
          // pi-ai asks for the whole cap on every call; an overstated one from models.dev would fail them all.
          maxTokens: Math.min(fact.output ?? base.maxTokens, base.maxTokens),
          cost: fact.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as Model<Api>;
      });
  });
}

/** `provider` with `extra` models beside its own. */
export const withModels = (provider: Provider, extra: ReadonlyArray<Model<Api>>): Provider =>
  extra.length === 0
    ? provider
    : {
        ...provider,
        getModels: () => [...provider.getModels(), ...extra],
        ...(provider.getAllModels === undefined ? {} : { getAllModels: () => [...provider.getAllModels!(), ...extra] }),
      };
