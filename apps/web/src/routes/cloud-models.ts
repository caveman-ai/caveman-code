// The model picker of a chat started in Cloud from a browser window (routes/NewChat.tsx). The window has no computer
// to list models for it, so it lists what Cloud itself says: the models the Caveman plan serves (GET
// /api/v1/code/credits/models), and Claude Agent and Codex, which run in Cloud on a plan or key connected once. What
// the person cannot pick yet is still listed, greyed, with the way to it (a plan, a sign-in, their Mac): founder
// 2026-11-12, "im subscribed but i cant even use the caveman model picker in the cloud chats", "connect your claude or
// connect your codex just like greyed out options". When the window is on a Cloud computer, that computer's own list
// (names, efforts, speeds) is used as it is.
import type {
  PickerEngine,
  PickerLock,
  PickerModel,
} from "@caveman-app/ui/components/model-picker";
import { CLOUD_AGENTS } from "./cloud-need.ts";

/** The Caveman engine's pick of its own (provider-caveman autoModel.ts): on a plan, a model the plan serves. */
export const AUTO_MODEL = "auto";
/** Claude Agent's or Codex's own model, where no computer has listed theirs: the chat's box picks from there. */
export const AGENT_DEFAULT = "default";

const AUTO: PickerModel = {
  id: AUTO_MODEL,
  label: "Auto",
  efforts: [],
  description: "Caveman picks a model your plan serves.",
};
const DEFAULT: PickerModel = {
  id: AGENT_DEFAULT,
  label: "Default model",
  efforts: [],
  description: "Pick another in the chat once it starts.",
};

/**
 * Cloud's catalog provider (`moonshot/kimi-k3`) as the Caveman engine names it in a model id
 * (`caveman/moonshotai/kimi-k3`): provider-caveman server/credits.ts ROUTES, which decides what runs. A provider that
 * is not here yet is not listed; the engine could not run it either.
 */
const ENGINE_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  moonshot: "moonshotai",
  "z-ai": "zai",
  deepseek: "deepseek",
};
const SOLD = /^([a-z0-9][a-z0-9_-]*)\/([\w.:@~+-]{1,200})$/;
const WORDS: Readonly<Record<string, string>> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek" };

/**
 * A model's name read off its id ("claude-opus-5-5": Claude Opus 5.5), for a window with no computer to ask. Cloud
 * sends ids only; a Cloud computer's own list carries the real names and takes this one's place.
 */
export function modelName(id: string): string {
  const parts = id.split("-");
  const out: string[] = [];
  parts.forEach((part, i) => {
    const last = out.length - 1;
    // "5-5" is 5.5: two short numbers in a row are one version.
    if (/^\d{1,2}$/.test(part) && i > 0 && /^\d{1,2}$/.test(parts[i - 1]!))
      return void (out[last] = `${out[last]}.${part}`);
    // GPT-6.1: its number rides the name.
    if (/^\d/.test(part) && out[last] === "GPT") return void (out[last] = `GPT-${part}`);
    out.push(
      WORDS[part] ??
        (/^[a-z]\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
    );
  });
  return out.join(" ");
}

/** Cloud's answer to GET /api/v1/code/credits/models as the Caveman engine's models, in Cloud's order. */
export function planModels(json: unknown): PickerModel[] {
  const models =
    typeof json === "object" && json !== null ? (json as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  return models.flatMap((entry): PickerModel[] => {
    const name =
      typeof entry === "object" && entry !== null
        ? (entry as { model?: unknown }).model
        : undefined;
    const [, provider, id] = typeof name === "string" ? (SOLD.exec(name) ?? []) : [];
    const engine = provider === undefined ? undefined : ENGINE_PROVIDER[provider];
    if (engine === undefined || id === undefined || seen.has(`${engine}/${id}`)) return [];
    seen.add(`${engine}/${id}`);
    return [
      {
        id: `caveman/${engine}/${id}`,
        label: modelName(id),
        efforts: [],
        source: { id: "caveman", label: "Caveman plan" },
      },
    ];
  });
}

/** An agent as a Cloud computer lists it: its models, and the one its chat starts on when none is named. */
export type LiveEngine = PickerEngine & { readonly default_model?: string | undefined };

/**
 * The picker's engines: the three agents Cloud runs, each with its models. `live`: a Cloud computer's own list of
 * them, when the window is on one; else `plan` (Cloud's own, null until it answers) under Caveman's Auto, and each
 * other agent's default. `locks`: by agent id, why its models are greyed and the way to them.
 */
export function cloudPickerEngines(input: {
  readonly live: ReadonlyArray<LiveEngine>;
  readonly plan: ReadonlyArray<PickerModel> | null;
  readonly locks: Readonly<Record<string, PickerLock | undefined>>;
}): PickerEngine[] {
  return CLOUD_AGENTS.map(({ id, label }): PickerEngine => {
    const there = input.live.find((e) => e.id === id);
    const models =
      there && there.models.length > 0
        ? there.models
        : id === "caveman"
          ? [AUTO, ...(input.plan ?? [])]
          : [DEFAULT];
    const lock = input.locks[id];
    return { id, label, models, ...(lock ? { locked: lock } : {}) };
  });
}

/**
 * The model the picker shows for an agent while the person has picked none: what its chat will start on, as far as
 * the window knows. A Cloud computer's own default where it lists one (`live`), else the agent's first model
 * (Caveman's Auto, an agent's own). Shown only: nothing the person did not pick is sent (startModel).
 */
export function shownModel(
  engines: ReadonlyArray<PickerEngine>,
  agent: string,
  live: ReadonlyArray<LiveEngine> = [],
): string | null {
  const models = engines.find((e) => e.id === agent)?.models ?? [];
  const own = live.find((e) => e.id === agent)?.default_model;
  return models.find((m) => m.id === own)?.id ?? models[0]?.id ?? null;
}

/**
 * The model a Cloud start names: the person's own pick, by the id its agent runs it by. Nothing when they picked
 * none (null) or picked the agent's own choice: the computer then starts on its default, which a model named here
 * would override.
 */
export const startModel = (picked: string | null): string | undefined =>
  picked === null || picked === AUTO_MODEL || picked === AGENT_DEFAULT ? undefined : picked;
