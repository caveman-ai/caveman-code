/** models.dev: what it says about each maker's models, and how it is read and kept. */
import { afterEach, assert, describe, it } from "@effect/vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModelsDevCache, modelsDevFacts, parseModelsDev, refreshModelsDev, releasesOf, setModelsDevFacts, type ModelFacts, type ModelsDevAnswer } from "./modelsDev.ts";

const model = (over: Record<string, unknown> = {}) => ({
  name: "M",
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_000_000, output: 64_000 },
  cost: { input: 3, output: 15, cache_read: 0.3 },
  ...over,
});
const API_JSON = {
  openai: {
    models: {
      "gpt-6.2-sol": model({ name: "GPT-6.2 Sol", reasoning: true }),
      "gpt-6.1-sol": model({ name: "GPT-6.1 Sol", status: "deprecated" }),
      "text-embedding-4": model({ tool_call: false }),
      "gpt-image-3": model({ modalities: { input: ["text"], output: ["image"] } }),
      "gpt-6.2-sol\u0000; rm -rf": model(),
    },
  },
  anthropic: {
    models: {
      "claude-fable-5-2": model({ name: "Claude Fable 5.2", reasoning: true, release_date: "2026-11-09" }),
      "claude-fable-5-1": model({ name: "Claude Fable 5.1", release_date: "Sept 2026" }),
      "claude-fable-5": model({ name: "Claude Fable 5", status: "deprecated" }),
    },
  },
  "fireworks-ai": { models: { "accounts/fireworks/models/kimi-k4": model({ name: "Kimi K4" }) } },
  "bad provider; x": { models: { m: model() } },
};
const fact = (over: Partial<ModelFacts> = {}): ModelFacts => ({ name: "GPT-6.2 Sol", deprecated: false, reasoning: true, image: true, ...over });

afterEach(() => setModelsDevFacts(undefined));

const withUrl = async <A>(url: string | undefined, run: () => Promise<A>) => {
  const previous = process.env.CAVEMAN_MODELS_DEV_URL;
  if (url === undefined) delete process.env.CAVEMAN_MODELS_DEV_URL;
  else process.env.CAVEMAN_MODELS_DEV_URL = url;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CAVEMAN_MODELS_DEV_URL;
    else process.env.CAVEMAN_MODELS_DEV_URL = previous;
  }
};

describe("parseModelsDev", () => {
  it("keeps every provider's models that call tools and answer in text, under models.dev's own ids", () => {
    const facts = parseModelsDev(API_JSON);
    assert.deepEqual(Object.keys(facts).sort(), ["anthropic", "fireworks-ai", "openai"]);
    assert.deepEqual(Object.keys(facts.openai!).sort(), ["gpt-6.1-sol", "gpt-6.2-sol"]);
    assert.deepEqual(facts.openai!["gpt-6.2-sol"], {
      name: "GPT-6.2 Sol",
      deprecated: false,
      reasoning: true,
      image: true,
      context: 1_000_000,
      output: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    });
    assert.equal(facts.openai!["gpt-6.1-sol"]!.deprecated, true);
    assert.equal(facts.anthropic!["claude-fable-5-2"]!.name, "Claude Fable 5.2");
    assert.equal(facts.anthropic!["claude-fable-5-2"]!.releaseDate, "2026-11-09");
    assert.equal(facts.anthropic!["claude-fable-5-1"]!.releaseDate, undefined, "a day models.dev did not write as one");
    assert.deepEqual(parseModelsDev("<html>"), {});
  });

  it("lists a maker's releases it does not call deprecated, with their release day", () => {
    setModelsDevFacts(parseModelsDev(API_JSON));
    assert.deepEqual(releasesOf("anthropic"), [
      { slug: "claude-fable-5-2", name: "Claude Fable 5.2", releasedAt: "2026-11-09" },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
    ]);
    assert.deepEqual(releasesOf("nobody"), []);
  });
});

describe("refreshModelsDev", () => {
  const minute = 60_000;

  it("asks every 15 minutes with the last ETag, keeps the copy on disk, and never lets a broken answer replace it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const asked: Array<{ url: string; etag?: string }> = [];
    let answer: ModelsDevAnswer = { json: API_JSON, etag: '"v1"' };
    const fetchModelsDev = async (url: string, input: { etag?: string }) => (asked.push({ url, ...(input.etag ? { etag: input.etag } : {}) }), answer);
    const refresh = (now: number) => withUrl(undefined, () => refreshModelsDev({ stateDir, allowNetwork: true, now, fetchModelsDev }));
    const start = 1_000 * minute;
    assert.equal(await refresh(start), true);
    assert.deepEqual(asked, [{ url: "https://models.dev/api.json" }]);
    assert.ok(modelsDevFacts()?.anthropic?.["claude-fable-5-2"]);
    assert.equal(await refresh(start + 14 * minute), false, "fresh for 15 minutes");
    assert.equal(asked.length, 1);
    // Nothing new: the server says so to the ETag, and the copy counts as fresh again.
    answer = "unchanged";
    assert.equal(await refresh(start + 15 * minute), false);
    assert.deepEqual(asked[1], { url: "https://models.dev/api.json", etag: '"v1"' });
    assert.equal(await refresh(start + 29 * minute), false);
    assert.equal(asked.length, 2, "a 304 starts the next 15 minutes");
    assert.ok(modelsDevFacts()?.openai?.["gpt-6.2-sol"]);
    answer = { json: { openai: "broken" } };
    assert.equal(await refresh(start + 31 * minute), false);
    assert.equal(asked.length, 3);
    assert.ok(modelsDevFacts()?.openai?.["gpt-6.2-sol"], "the copy that worked stays");
    // An answer that lacks a provider leaves that provider's facts as they were.
    answer = { json: { "fireworks-ai": API_JSON["fireworks-ai"] }, etag: '"v2"' };
    assert.equal(await refresh(start + 50 * minute), true);
    assert.ok(modelsDevFacts()?.openai?.["gpt-6.2-sol"] && modelsDevFacts()?.["fireworks-ai"]?.["accounts/fireworks/models/kimi-k4"]);
    // A restart takes the copy on disk, and its ETag, before any fetch.
    const disk = JSON.parse(readFileSync(join(stateDir, "models-dev.json"), "utf8"));
    assert.equal(disk.fetchedAtMs, start + 50 * minute);
    assert.equal(disk.etag, '"v2"');
    setModelsDevFacts(undefined);
    await loadModelsDevCache(stateDir);
    assert.ok(modelsDevFacts()?.openai?.["gpt-6.2-sol"]);
    answer = "unchanged";
    await refresh(start + 70 * minute);
    assert.equal(asked.at(-1)?.etag, '"v2"');
  });

  it("fetches nothing with update checks off or CAVEMAN_MODELS_DEV_URL=off, and reads a mirror when it names one", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const asked: Array<string> = [];
    const fetchModelsDev = async (url: string): Promise<ModelsDevAnswer> => (asked.push(url), { json: API_JSON });
    await withUrl(undefined, () => refreshModelsDev({ stateDir, allowNetwork: false, fetchModelsDev }));
    await withUrl("off", () => refreshModelsDev({ stateDir, allowNetwork: true, fetchModelsDev }));
    assert.deepEqual(asked, []);
    await withUrl("https://mirror.example/models.json", () => refreshModelsDev({ stateDir, allowNetwork: true, fetchModelsDev }));
    assert.deepEqual(asked, ["https://mirror.example/models.json"]);
  });
});

describe("loadModelsDevCache", () => {
  it("takes the Caveman engine's older copy when there is no other, under models.dev's provider ids", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const facts = { openai: { "gpt-6.2-sol": fact() }, fireworks: { "accounts/fireworks/models/kimi-k4": fact({ name: "Kimi K4" }) } };
    writeFileSync(join(stateDir, "caveman-models-dev.json"), JSON.stringify({ fetchedAtMs: 5, facts }));
    await loadModelsDevCache(stateDir);
    assert.ok(modelsDevFacts()?.openai?.["gpt-6.2-sol"]);
    assert.ok(modelsDevFacts()?.["fireworks-ai"]?.["accounts/fireworks/models/kimi-k4"]);
    assert.equal(modelsDevFacts()?.fireworks, undefined);
    // The current copy outranks it.
    setModelsDevFacts(undefined);
    writeFileSync(join(stateDir, "models-dev.json"), JSON.stringify({ fetchedAtMs: 6, facts: { anthropic: { "claude-fable-5-2": fact() } } }));
    await loadModelsDevCache(stateDir);
    assert.deepEqual(Object.keys(modelsDevFacts()!), ["anthropic"]);
  });


  it("takes only what checks out from a damaged or older copy, and never throws on it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "models-dev-"));
    const facts = { openai: { "gpt-6.2-sol": fact(), "bad id; x": fact(), "gpt-6.3-sol": null }, google: "nope" };
    writeFileSync(join(stateDir, "models-dev.json"), JSON.stringify({ fetchedAtMs: 5, facts }));
    await Promise.all([loadModelsDevCache(stateDir), loadModelsDevCache(stateDir)]);
    assert.deepEqual(Object.keys(modelsDevFacts()!.openai!), ["gpt-6.2-sol"]);
    assert.deepEqual(modelsDevFacts()!.google, {});
  });
});
