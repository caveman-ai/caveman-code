// What the pickers offer, in the desktop's shapes (packages/ui/src/components/model-picker.tsx PickerEngine and
// PickerModel, Session Protocol's EngineDescriptor): each harness this computer runs, its models with their effort
// levels, their own start and their faster speeds, and what the person keeps in Settings (Home's order, favorites,
// the default, each model's start). `CATALOG` is the scripted world's stand-in for engine.list. On a board that is
// the person's own the pickers list what the chat's place runs instead (live/engines.ts, from that computer's own
// engine.list), in these same shapes; the catalog then only gives a model its name where a chat holds a bare id.
import { useSyncExternalStore } from "react";
import { type Engine, ENGINE_NAME } from "./model";

/** An effort level, as the engines name them (effort.tsx). */
export type Level = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** A speed past standard (speed.tsx): Claude Agent's fast mode, Codex's Fast and Ultrafast. */
export const STANDARD = "standard";

export interface CatalogModel {
  /** The engine's id: `claude-opus-5-5`; a Caveman engine model is `provider/model`. */
  readonly id: string;
  /** Its name as the engine gives it, and as a chat's bar shows it: "Opus 5.5", "Claude Opus 5.5". */
  readonly label: string;
  readonly efforts: readonly Level[];
  readonly defaultEffort?: Level;
  /** Faster tiers than standard; absent, the picker's foot has no bolt. */
  readonly speeds?: readonly string[];
  /** Older models wait under "More models". */
  readonly legacy?: boolean;
  readonly description?: string;
 /** A Caveman engine model's connection: the quiet heading over its models ("Anthropic", "compact"). */
  readonly source?: string;
}

export interface CatalogEngine {
  /** The harness, as the desktop names it: `caveman`, `claude-agent`, `codex`, `cursor`… */
  readonly id: string;
  readonly label: string;
  readonly models: readonly CatalogModel[];
  /** The model a new chat on it starts on when none is named (EngineDescriptor.default_model), by its id. */
  readonly defaultModel?: string;
}

const CLAUDE_LEVELS: readonly Level[] = ["low", "medium", "high", "xhigh", "max"];

/** The harnesses on your Mac, in the rail's order: Caveman, the two first-class connectors, then the registry's. */
export const CATALOG: readonly CatalogEngine[] = [
  {
    id: "caveman",
    label: "Caveman",
    models: [
      { id: "auto", label: "Auto", efforts: ["low", "medium", "high"], defaultEffort: "medium", description: "Routes each turn to the cheapest model that can do it" },
      { id: "caveman/moonshot/kimi-k3", label: "Kimi K3", efforts: ["low", "max"], defaultEffort: "low", source: "Caveman credits" },
      { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5", efforts: CLAUDE_LEVELS, defaultEffort: "high", source: "Anthropic" },
      { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: CLAUDE_LEVELS, defaultEffort: "high", source: "Anthropic" },
      { id: "chatgpt/openai/gpt-5-5", label: "GPT-5.5", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "medium", source: "ChatGPT" },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", efforts: ["none", "max"], defaultEffort: "max", source: "DeepSeek" },
      { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["low", "medium", "high"], legacy: true, source: "Anthropic" },
    ],
  },
  {
    id: "claude-agent",
    label: "Claude Agent",
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts: [...CLAUDE_LEVELS, "ultracode"], defaultEffort: "high", speeds: ["fast"] },
      { id: "claude-fable-5-1", label: "Fable 5.1", efforts: CLAUDE_LEVELS, defaultEffort: "high" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: CLAUDE_LEVELS, defaultEffort: "high" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: CLAUDE_LEVELS, defaultEffort: "medium" },
      { id: "claude-opus-4-1", label: "Opus 4.1", efforts: ["low", "medium", "high"], legacy: true },
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5", efforts: ["low", "medium", "high"], legacy: true },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    models: [
      { id: "gpt-5-5", label: "GPT-5.5", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "medium", speeds: ["fast", "ultrafast"] },
      { id: "gpt-5-4", label: "GPT-5.4", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", speeds: ["fast"] },
      { id: "gpt-5-4-mini", label: "GPT-5.4 mini", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "gpt-5-2", label: "GPT-5.2", efforts: ["low", "medium", "high"], legacy: true },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    models: [
      { id: "composer-2-5", label: "Composer 2.5", efforts: [], speeds: ["fast"] },
      { id: "composer-2", label: "Composer 2", efforts: [] },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    models: [
      { id: "moonshotai/kimi-k3", label: "Kimi K3", efforts: ["low", "max"], defaultEffort: "low" },
      { id: "zai/glm-5-3", label: "GLM 5.3", efforts: ["low", "max"], defaultEffort: "low" },
    ],
  },
  {
    id: "grok",
    label: "Grok",
    models: [
      { id: "grok-4-7", label: "Grok 4.7", efforts: ["low", "high", "xhigh"], defaultEffort: "high" },
      { id: "grok-build", label: "Grok Build", efforts: [] },
    ],
  },
];

/**
 * The scripted world's harnesses this phone can start a chat on. The desktop lists only engines that can take the
 * chat, so a harness the board can't run yet has no section, and its models no rows, until it can.
 */
export const SCRIPTED: readonly CatalogEngine[] = CATALOG.filter((e) => boardEngine(e.id) !== undefined);

// ---------------------------------------------------------------- harness and model lookups

export interface ModelRef {
  /** The harness id (`claude-agent`), never the board's short name. */
  readonly engine: string;
  readonly model: string;
}
export interface Entry {
  readonly engine: CatalogEngine;
  readonly model: CatalogModel;
}

/** Settings' key for a model, "<engine>/<model>", as favorites and Home's order store it. */
export const modelKey = (r: ModelRef) => `${r.engine}/${r.model}`;
export const entryKey = (e: Entry) => modelKey({ engine: e.engine.id, model: e.model.id });

/** The board's engine for a harness, or undefined where the board can't run its chats yet. */
export function boardEngine(harness: string): Engine | undefined {
  const id = harness === "claude-agent" ? "claude" : harness;
  return Object.hasOwn(ENGINE_NAME, id) ? (id as Engine) : undefined;
}

/**
 * A model by its id or the name a chat shows it by, among `engines`: the scripted catalog, or on the person's own
 * board what the chat's place offers (live/engines.ts). There a chat may hold its engine's fuller id for a model the
 * place lists by a shorter one ("claude-opus-5-5-20260101"): the same model.
 */
export function findEntry(engine: string, model: string, engines: readonly CatalogEngine[] = CATALOG): Entry | undefined {
  const e = engines.find((x) => x.id === engine);
  const m = e?.models.find((x) => x.id === model) ?? e?.models.find((x) => x.label === model) ?? (model && engines !== CATALOG ? e?.models.find((x) => x.id !== "" && bareId(x.id) === bareId(model)) : undefined);
  return e && m ? { engine: e, model: m } : undefined;
}

/**
 * A model's id as two engines may write it, made comparable: no vendor before it ("anthropic/", "us.anthropic."), no
 * date, revision or context after it ("-20251001", "-2025-10-01", "-v1:0", "-latest", "[1m]"), and "gpt-5.5" the same
 * as "gpt-5-5".
 */
function bareId(id: string): string {
  const whole = id.trim().toLowerCase().replace(/\[.*\]$/, "");
  return whole
    .slice(whole.lastIndexOf("/") + 1)
    .replace(/^([a-z]+\.)+(?=[a-z])/, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "")
    .replace(/\./g, "-");
}

/** Short words that are written in capitals: a model family's letters ("GPT", "GLM"). */
const LETTERS = /^[bcdfghjklmnpqrstvwxz]{2,4}$/;

/** A name made from an id the catalog does not know: "claude-haiku-4-5" reads "Claude Haiku 4.5", "gpt-5-5-codex" "GPT-5.5 Codex". */
function nameFromId(bare: string): string {
  // OpenAI's o-series is written as it is ("o3", "o4-mini").
  if (/^o\d/.test(bare)) return bare;
  const out: string[] = [];
  for (const part of bare.split(/[-_]/).filter(Boolean)) {
    const prev = out[out.length - 1];
    // A version's second number joins its first with a point ("4", "5" is "4.5"), and GPT takes its version on a hyphen.
    if (/^\d{1,2}$/.test(part) && prev !== undefined && /(^|[^\d.])\d{1,2}$/.test(prev)) out[out.length - 1] = `${prev}.${part}`;
    else if (/^\d/.test(part) && prev === "GPT") out[out.length - 1] = `GPT-${part}`;
    else out.push(LETTERS.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(" ");
}

/**
 * A model's name for a person to read, from whatever a chat holds for it: the catalog's name where the catalog knows
 * the model, by its id as any engine writes it ("openai/gpt-5.5" is "GPT-5.5") or by the name itself ("Opus 5.5");
 * else a name made from the id ("claude-haiku-4-5-20251001" reads "Claude Haiku 4.5"). Never the raw id. `engine` (a
 * harness id, or the board's short name for one) is looked in first, since two engines may name one model differently.
 */
export function modelName(id: string, engine?: string): string {
  const given = id.trim();
  if (!given) return "";
  const bare = bareId(given);
  const harness = engine === "claude" ? "claude-agent" : engine;
  const known = (e: CatalogEngine) => e.models.find((m) => m.id === given || m.label === given) ?? e.models.find((m) => bareId(m.id) === bare);
  const own = CATALOG.find((e) => e.id === harness);
  const hit = (own && known(own)) ?? CATALOG.reduce<CatalogModel | undefined>((found, e) => found ?? known(e), undefined);
  if (hit) return hit.label;
  // Words already (a name the catalog does not list): they stay as they are.
  return /\s/.test(given) ? given : nameFromId(bare);
}

/** Caveman's own models: its Auto and what Caveman credits serve, never a person's own key (homeModels). */
const isCavemanOwn = (e: Entry) => e.engine.id === "caveman" && !e.model.legacy && (e.model.id === "auto" || e.model.id.startsWith("caveman/"));

/**
 * Home, one list in the person's order with the default first (model-picker.tsx homeModels): the
 * default, the rows they arranged, Caveman's own models, their favorites, then each other harness's first two
 * current models. The ones the order doesn't name yet follow it, in that order.
 */
export function homeModels(engines: readonly CatalogEngine[], favorites: readonly string[], order: readonly string[], lead: ModelRef | null): Entry[] {
  const all = engines.flatMap((engine) => engine.models.map((model) => ({ engine, model })));
  const byKey = (key: string) => all.find((e) => entryKey(e) === key);
  const first = lead ? byKey(modelKey(lead)) : undefined;
  const picks = engines.filter((e) => e.id !== "caveman").flatMap((engine) => engine.models.filter((m) => !m.legacy && m.id !== "auto").slice(0, 2).map((model) => ({ engine, model })));
  const listed = [...(first ? [first] : []), ...order.flatMap((k) => byKey(k) ?? []), ...all.filter(isCavemanOwn), ...favorites.flatMap((k) => byKey(k) ?? []), ...picks];
  const unique = listed.filter((e, i) => listed.findIndex((o) => entryKey(o) === entryKey(e)) === i);
  const rank = (e: Entry) => (order.includes(entryKey(e)) ? order.indexOf(entryKey(e)) : order.length);
  const rest = unique.slice(first ? 1 : 0).sort((a, b) => rank(a) - rank(b));
  return first ? [first, ...rest] : rest;
}

/** `order` with `key` moved to index `to`. */
export function moveKey(order: readonly string[], key: string, to: number): string[] {
  const next = order.filter((k) => k !== key);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, key);
  return next;
}

/** Every search word appears in the model's name, id, connection or harness. */
export function matches(e: Entry, query: string): boolean {
  const hay = `${e.model.label} ${e.model.id} ${e.engine.label} ${e.model.source ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

// ---------------------------------------------------------------- effort and speed

/** The effort to run a model at: the wanted level if it offers it, else its start, else its middle stop (pickEffort). */
export function pickEffort(efforts: readonly Level[], wanted?: string, fallback?: string): Level | undefined {
  const offered = (l: string | undefined): l is Level => l !== undefined && (efforts as readonly string[]).includes(l);
  if (offered(wanted)) return wanted;
  if (offered(fallback)) return fallback;
  return efforts[Math.floor((efforts.length - 1) / 2)];
}

const SPEED_LABEL: Record<string, string> = { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast" };
export const speedLabel = (speed: string) => SPEED_LABEL[speed] ?? speed.charAt(0).toUpperCase() + speed.slice(1);

/** The speed after `current`: standard, each faster one in turn, then standard again (nextSpeed). */
export function nextSpeed(speeds: readonly string[], current: string | undefined): string {
  const order = [STANDARD, ...speeds];
  return order[(Math.max(0, order.indexOf(current ?? STANDARD)) + 1) % order.length]!;
}

// ---------------------------------------------------------------- smarts and cost at a glance

/**
 * How smart a model is and what a task costs, by effort: the desktop's dated snapshot (packages/ui lib/model-facts.ts,
 * Artificial Analysis, read 2026-10-20) for the models here that it measured. A model it didn't measure shows no
 * glance, never a guess.
 */
const RUNS: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = {
  "claude-opus-5-5": { low: [42, 0.55], medium: [51, 1.34], high: [54, 1.82], xhigh: [56, 3.46], max: [58, 5.98] },
  "claude-sonnet-5-5": { low: [36, 0.35], medium: [41, 0.48], high: [47, 0.88], xhigh: [52, 2.01], max: [56, 5.46] },
  "claude-haiku-5-5": { low: [29, 0.02], medium: [34, 0.05], high: [38, 0.08], xhigh: [41, 0.12], max: [43, 0.21] },
  "claude-fable-5-1": { low: [47, 2.37], medium: [49, 2.98], high: [51, 3.91], xhigh: [53, 5.98], max: [53, 7.63] },
  "deepseek-v4-pro": { none: [20, 0.36], max: [36, 0.67] },
  "glm-5-3": { low: [34, 0.85], max: [45, 2.01] },
  "grok-4-7": { low: [42, 1.25], high: [46, 2.73], xhigh: [46, 3.74] },
  "kimi-k3": { low: [30, 1.15], max: [44, 2] },
};

const SMARTS_BANDS = [20, 30, 40, 48, 55] as const;
const COST_BANDS = [0.1, 0.5, 2] as const;

/** Signal bars (0 to 5) and dollars (1 to 4) for a model at an effort; undefined where it wasn't measured there. */
export function glance(modelId: string, effort: string | undefined): { smarts: number; cost: number } | undefined {
  const runs = RUNS[modelId.slice(modelId.lastIndexOf("/") + 1)];
  const run = runs && ((effort !== undefined ? runs[effort] : undefined) ?? runs[""]);
  if (!run) return undefined;
  return { smarts: SMARTS_BANDS.filter((b) => run[0] >= b).length, cost: 1 + COST_BANDS.filter((b) => run[1] >= b).length };
}

// ---------------------------------------------------------------- what the person keeps

/** The picker's part of Settings: Home's order, favorites, the default new chats start on, each model's start. */
export interface Choices {
  readonly favorites: readonly string[];
  readonly homeOrder: readonly string[];
  readonly defaultModel: ModelRef;
  /** Settings.model_defaults: a model's own effort and speed, "<engine>/<model>" to the start. */
  readonly starts: Readonly<Record<string, { readonly effort?: string; readonly speed?: string }>>;
}

/** What the scripted person starred. */
const SCRIPTED_FAVORITES: readonly string[] = ["claude-agent/claude-sonnet-5-5"];

let choices: Choices = {
  favorites: SCRIPTED_FAVORITES,
  homeOrder: [],
  defaultModel: { engine: "caveman", model: "auto" },
  starts: {},
};
const listeners = new Set<() => void>();

/** Settings as the picker reads them, kept for the session (synced with the person on a real runtime). */
export function useChoices(): Choices {
  return useSyncExternalStore(
    (on) => {
      listeners.add(on);
      return () => listeners.delete(on);
    },
    () => choices,
  );
}

export function setChoices(next: (was: Choices) => Choices) {
  choices = next(choices);
  for (const on of listeners) on();
}

/** On a board that is the person's own, nothing the script starred stands as theirs. */
export function forgetScriptedChoices() {
  if (choices.favorites === SCRIPTED_FAVORITES) setChoices((was) => ({ ...was, favorites: [] }));
}

/** Where a model starts: its saved start, else its own default effort, at standard speed. */
export function startOf(e: Entry, saved: Choices["starts"]): { effort?: Level; speed: string } {
  const s = saved[entryKey(e)];
  return { effort: pickEffort(e.model.efforts, s?.effort, e.model.defaultEffort), speed: s?.speed && (s.speed === STANDARD || e.model.speeds?.includes(s.speed)) ? s.speed : STANDARD };
}
