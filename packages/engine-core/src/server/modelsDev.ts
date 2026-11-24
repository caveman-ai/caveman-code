/**
 * models.dev (MIT): every maker's models, with names, limits, prices and which ones their maker deprecated. One copy
 * per process serves every engine: the Caveman engine runs a family's new version on its wire (provider-caveman
 * modelsDev.ts), and the runtime lists a maker's new release beside an engine's own catalog (ModelCatalog.ts
 * `withSuccessors`). A new model then shows up within a quarter of an hour of models.dev listing it, with no app
 * release.
 *
 * Read every 15 minutes with the last answer's ETag, so a check that finds nothing new costs a 304. Nothing is fetched
 * while provider update checks are off or `CAVEMAN_MODELS_DEV_URL` is `off`; a copy fetched earlier stays in use.
 * Offline and before the first fetch, the bundled catalogs alone decide.
 *
 * @module engine-core/server/modelsDev
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const MODELS_DEV_URL = "https://models.dev/api.json";
/** How long an answer stays fresh, and how long a failed fetch waits before the next. */
const CHECK_EVERY_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_FILE = "models-dev.json";
/** The Caveman engine's copy before this one, keyed by pi-ai's provider ids: read when there is no other. */
const LEGACY_CACHE_FILE = "caveman-models-dev.json";

/** pi-ai provider ids models.dev names otherwise; every other one is the same id. */
export const MODELS_DEV_PROVIDER_OF_PI_AI: Readonly<Record<string, string>> = {
  fireworks: "fireworks-ai",
  together: "togetherai",
  "vercel-ai-gateway": "vercel",
  "kimi-coding": "kimi-code-plan-global",
  zai: "zai-coding-plan",
};

/** What models.dev says about one model. Prices are USD per million tokens. */
export interface ModelFacts {
  readonly name: string;
  /** Its release day as models.dev gives it (`2026-11-09`). */
  readonly releaseDate?: string;
  readonly deprecated: boolean;
  readonly reasoning: boolean;
  readonly image: boolean;
  readonly context?: number;
  readonly output?: number;
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}

/** models.dev provider id (`anthropic`, `openai`, `fireworks-ai`) -> model id -> facts. */
export type Facts = Readonly<Record<string, Readonly<Record<string, ModelFacts>>>>;

/** A fetch's outcome: the answer and its ETag, or "unchanged" when the server answered 304 to the ETag sent. */
export type ModelsDevAnswer = { readonly json: unknown; readonly etag?: string } | "unchanged";

/** A release day as models.dev writes it; anything else is dropped. */
const day = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
/** A model id as providers spell them; anything else from the network is dropped, never sent on. */
const MODEL_ID = /^[\w.:@/~+-]{1,200}$/;
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Every provider's facts out of models.dev's api.json: only models that call tools and answer in text. */
export function parseModelsDev(json: unknown): Facts {
  const facts: Record<string, Record<string, ModelFacts>> = {};
  for (const [provider, entry] of Object.entries(record(json) ?? {})) {
    const models = record(record(entry)?.models);
    if (models === undefined || !MODEL_ID.test(provider)) continue;
    const kept: Record<string, ModelFacts> = {};
    for (const [id, value] of Object.entries(models)) {
      const raw = record(value);
      if (raw === undefined || raw.tool_call !== true || !MODEL_ID.test(id)) continue;
      const modalities = raw.modalities as { input?: unknown; output?: unknown } | undefined;
      if (!Array.isArray(modalities?.output) || !modalities.output.includes("text")) continue;
      const limit = raw.limit as Record<string, unknown> | undefined;
      const cost = raw.cost as Record<string, unknown> | undefined;
      const input = num(cost?.input);
      const output = num(cost?.output);
      const context = num(limit?.context);
      const maxOutput = num(limit?.output);
      const releaseDate = day(raw.release_date);
      kept[id] = {
        name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : id,
        ...(releaseDate ? { releaseDate } : {}),
        deprecated: raw.status === "deprecated",
        reasoning: raw.reasoning === true,
        image: Array.isArray(modalities.input) && modalities.input.includes("image"),
        ...(context ? { context } : {}),
        ...(maxOutput ? { output: maxOutput } : {}),
        ...(input !== undefined && output !== undefined
          ? { cost: { input, output, cacheRead: num(cost?.cache_read) ?? 0, cacheWrite: num(cost?.cache_write) ?? 0 } }
          : {}),
      };
    }
    facts[provider] = kept;
  }
  return facts;
}

/** Facts read back from the disk copy, which may be from another version of this file or damaged: only what checks out. */
function readFacts(value: unknown): Facts {
  const facts: Record<string, Record<string, ModelFacts>> = {};
  for (const [provider, models] of Object.entries(record(value) ?? {})) {
    const kept: Record<string, ModelFacts> = {};
    for (const [id, entry] of Object.entries(record(models) ?? {})) {
      const fact = record(entry);
      const cost = record(fact?.cost);
      const prices = cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].map(num);
      if (fact === undefined || typeof fact.name !== "string" || !MODEL_ID.test(id)) continue;
      const releaseDate = day(fact.releaseDate);
      kept[id] = {
        name: fact.name,
        ...(releaseDate ? { releaseDate } : {}),
        deprecated: fact.deprecated === true,
        reasoning: fact.reasoning === true,
        image: fact.image === true,
        ...(num(fact.context) ? { context: num(fact.context)! } : {}),
        ...(num(fact.output) ? { output: num(fact.output)! } : {}),
        ...(prices?.every((n) => n !== undefined) ? { cost: { input: prices[0]!, output: prices[1]!, cacheRead: prices[2]!, cacheWrite: prices[3]! } } : {}),
      };
    }
    facts[provider] = kept;
  }
  return facts;
}

let current: { readonly fetchedAtMs: number; readonly facts: Facts; readonly etag?: string } | undefined;
let lastAttemptMs = 0;
let diskLoad: Promise<void> | undefined;

/** The facts in use: the last fetch, or undefined before any. */
export const modelsDevFacts = (): Facts | undefined => current?.facts;

/** Tests: start from nothing, or from `facts`. */
export const setModelsDevFacts = (facts: Facts | undefined, fetchedAtMs = Date.now()) => {
  current = facts === undefined ? undefined : { fetchedAtMs, facts };
  lastAttemptMs = 0;
  diskLoad = facts === undefined ? undefined : Promise.resolve();
};

/** Where models.dev is read from: `CAVEMAN_MODELS_DEV_URL` (a mirror, or `off` to read nothing), else models.dev. */
export const modelsDevUrl = (): string | undefined => {
  const configured = process.env.CAVEMAN_MODELS_DEV_URL?.trim();
  return configured === "off" ? undefined : configured || MODELS_DEV_URL;
};

const readCopy = async (file: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const cached = record(JSON.parse(await NodeFS.promises.readFile(file, "utf8")));
    return typeof cached?.fetchedAtMs === "number" ? cached : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Takes the copy fetched before this process started, once; it is local, so a provider check waits for it. With none,
 * the Caveman engine's older copy, its providers renamed to models.dev's ids, so a model it found keeps running offline
 * after an upgrade; the next fetch writes the new copy.
 */
export const loadModelsDevCache = (stateDir: string): Promise<void> =>
  (diskLoad ??= (async () => {
    const cached = await readCopy(NodePath.join(stateDir, CACHE_FILE));
    if (cached !== undefined) {
      if (current === undefined) {
        current = { fetchedAtMs: cached.fetchedAtMs as number, facts: readFacts(cached.facts), ...(typeof cached.etag === "string" ? { etag: cached.etag } : {}) };
      }
      return;
    }
    const legacy = await readCopy(NodePath.join(stateDir, LEGACY_CACHE_FILE));
    if (legacy === undefined || current !== undefined) return;
    const facts = Object.fromEntries(Object.entries(readFacts(legacy.facts)).map(([provider, models]) => [MODELS_DEV_PROVIDER_OF_PI_AI[provider] ?? provider, models]));
    current = { fetchedAtMs: legacy.fetchedAtMs as number, facts };
  })());

const fetchModelsDev = async (url: string, input: { readonly signal: AbortSignal; readonly etag?: string }): Promise<ModelsDevAnswer> => {
  const response = await fetch(url, {
    signal: input.signal,
    headers: { accept: "application/json", ...(input.etag ? { "if-none-match": input.etag } : {}) },
  });
  if (response.status === 304) return "unchanged";
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  const etag = response.headers.get("etag");
  return { json: await response.json(), ...(etag ? { etag } : {}) };
};

/**
 * Fetches when the facts in use are 15 minutes old, sending their ETag. Never throws and never blocks a turn:
 * provider checks run it in the background, and every engine's check may call it, since one fetch serves them all.
 * True when it replaced the facts.
 */
export async function refreshModelsDev(input: {
  readonly stateDir: string;
  readonly allowNetwork: boolean;
  readonly now?: number;
  readonly fetchModelsDev?: typeof fetchModelsDev;
}): Promise<boolean> {
  await loadModelsDevCache(input.stateDir);
  const url = modelsDevUrl();
  const now = input.now ?? Date.now();
  const fresh = current !== undefined && now >= current.fetchedAtMs && now - current.fetchedAtMs < CHECK_EVERY_MS;
  if (!input.allowNetwork || url === undefined || fresh || (now >= lastAttemptMs && now - lastAttemptMs < CHECK_EVERY_MS)) return false;
  lastAttemptMs = now;
  const cachePath = NodePath.join(input.stateDir, CACHE_FILE);
  try {
    const answer = await (input.fetchModelsDev ?? fetchModelsDev)(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...(current?.etag ? { etag: current.etag } : {}),
    });
    // Nothing new: fresh again in memory. The copy on disk keeps its time, which costs one more 304 after a restart.
    if (answer === "unchanged") {
      if (current !== undefined) current = { ...current, fetchedAtMs: now };
      return false;
    }
    const fetched = parseModelsDev(answer.json);
    // A broken or empty answer never replaces facts that worked, and a provider an answer lacks keeps its own.
    if (Object.values(fetched).every((models) => Object.keys(models).length === 0)) return false;
    current = { fetchedAtMs: now, facts: { ...current?.facts, ...fetched }, ...(answer.etag ? { etag: answer.etag } : {}) };
    await NodeFS.promises
      .writeFile(`${cachePath}.tmp`, JSON.stringify(current))
      .then(() => NodeFS.promises.rename(`${cachePath}.tmp`, cachePath))
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a maker has released, as models.dev lists it: every model it does not call deprecated, under models.dev's
 * provider id (`anthropic`). Empty before the first fetch.
 */
export const releasesOf = (maker: string): ReadonlyArray<{ readonly slug: string; readonly name: string; readonly releasedAt?: string }> =>
  Object.entries(current?.facts[maker] ?? {}).flatMap(([slug, fact]) =>
    fact.deprecated ? [] : [{ slug, name: fact.name, ...(fact.releaseDate ? { releasedAt: fact.releaseDate } : {}) }],
  );
