// Model classes (fast, base, frontier): what kind of model a step or an agent file asks for, resolved
// here to a model the engine runs, within the provider family of the engine's own model so a class
// never moves work to another vendor or key. One table for chat subagents and automation steps.
// A family the table doesn't know resolves no class: the caller keeps the engine's default and says so.
import type { ServerProvider } from "@caveman-app/protocol";

export const MODEL_CLASSES = ["fast", "base", "frontier"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const isModelClass = (value: string | undefined): value is ModelClass =>
  value !== undefined && (MODEL_CLASSES as ReadonlyArray<string>).includes(value);

interface Family {
  readonly name: string;
  /** Matches a bare model name (after any `provider/` prefix) of this family. */
  readonly member: RegExp;
  readonly classes: Readonly<Record<ModelClass, RegExp>>;
}

/** Newest models first within a class: providers list newer models first, and the first match wins. */
const FAMILIES: ReadonlyArray<Family> = [
  { name: "Claude", member: /claude|^(haiku|sonnet|opus)\b/i, classes: { fast: /haiku/i, base: /sonnet/i, frontier: /opus/i } },
  { name: "GPT", member: /^gpt-/i, classes: { fast: /luna/i, base: /astra/i, frontier: /sol/i } },
];

const bare = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1);
const prefixOf = (slug: string) => {
  const slash = slug.indexOf("/");
  return slash > 0 ? slug.slice(0, slash + 1) : undefined;
};

/** The family of an engine's model, or undefined when the table has none for it. */
export function familyOf(model: string): string | undefined {
  return FAMILIES.find((f) => f.member.test(bare(model)))?.name;
}

/**
 * The model a class resolves to on this provider, beside `model` (the engine's own model: its default or
 * the parent's). Stays within that model's `provider/` prefix and family; undefined when nothing matches.
 */
export function modelForClass(input: {
  readonly provider: Pick<ServerProvider, "models"> | undefined;
  readonly model: string;
  readonly modelClass: ModelClass;
}): string | undefined {
  const family = FAMILIES.find((f) => f.member.test(bare(input.model)));
  if (input.provider === undefined || family === undefined) return undefined;
  const prefix = prefixOf(input.model);
  const want = family.classes[input.modelClass];
  return input.provider.models.find(
    (m) => (prefix === undefined || m.slug.startsWith(prefix)) && family.member.test(bare(m.slug)) && want.test(bare(m.slug)),
  )?.slug;
}

/** Every class on one engine, for `explain` (EnvSnapshot.classes[engine]). */
export function classTable(input: {
  readonly provider: Pick<ServerProvider, "models"> | undefined;
  readonly model: string;
}): { readonly fast?: string; readonly base?: string; readonly frontier?: string; readonly source: string } {
  const family = familyOf(input.model);
  if (family === undefined) return { source: `no class table for ${input.model}; steps use the engine's model` };
  const out: { fast?: string; base?: string; frontier?: string } = {};
  for (const modelClass of MODEL_CLASSES) {
    const slug = modelForClass({ ...input, modelClass });
    if (slug !== undefined) out[modelClass] = slug;
  }
  return { ...out, source: `${family} class table` };
}
