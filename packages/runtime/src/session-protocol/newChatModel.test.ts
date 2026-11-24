// A new chat's model (2026-10-18, the permissions ruling applied to the model):
// the one asked for, else its project's default, else Settings > General >
// New chats, else the engine's default_model. A turn's pick changes that chat
// only, never a default.
import * as fs from "node:fs";

import { DatabaseSync } from "node:sqlite";

import { ThreadId } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createReady, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let config: Awaited<ReturnType<typeof makeConfig>>;
let client: ReturnType<typeof connect>;
let n = 0;

beforeAll(async () => {
  root = tempRoot("sp-new-chat-model-");
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: services });
  client = connect(runtime.url, runtime.token);
});
// Claude Agent's models as its provider snapshot lists them, MODEL its default; Opus and Sonnet take an effort, and Opus
// has a fast mode.
const effort = { id: "effort", type: "select", options: [{ id: "low" }, { id: "high" }] };
const fastMode = { id: "fastMode", label: "Fast Mode", type: "boolean" };
const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  getProviders: Effect.succeed([
    {
      instanceId: "claudeAgent",
      installed: true,
      auth: { status: "authenticated" },
      models: ["claude-opus-4-6", MODEL, "claude-haiku-4-5"].map((slug) => ({
        slug,
        name: slug,
        isDefault: slug === MODEL,
        capabilities: { optionDescriptors: slug.includes("haiku") ? [] : slug.includes("opus") ? [effort, fastMode] : [effort] },
      })),
    },
  ]),
} as unknown as ProviderRegistry.ProviderRegistry["Service"]);
// upstream settings, kept across the restarts below.
const serverContext = await Effect.runPromise(
  Effect.flatMap(Scope.make(), (scope) => Layer.buildWithScope(ServerSettings.layerTest().pipe(Layer.orDie), scope)),
);
const services = Layer.mergeAll(providers, Layer.succeedContext(serverContext));
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const selectionOf = async (workspaceId: string) =>
  (await Effect.runPromise(orchestratorOf(runtime).getThreadProjection(ThreadId.make(`caveman:${workspaceId}`)))).thread.modelSelection;
const modelOf = async (workspaceId: string) => (await selectionOf(workspaceId)).model;
const create = (repo: string, model?: string) =>
  createReady(client, { request_id: `w${++n}`, repo: { path: repo }, engine: "claude-agent", ...(model ? { options: { model } } : {}) });

test("the project's default, then the setting, then the engine's default_model; an explicit pick wins and a turn's pick saves nothing", async () => {
  const claude = (await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")!;
  // Signed out of Caveman here, so no Auto: the engine's own default.
  expect(claude.models.some((m) => m.id === "caveman-auto")).toBe(false);
  expect(claude.default_model).toBe(MODEL);
  const [setting, project] = claude.models.map((m) => m.id).filter((id) => id !== claude.default_model);
  const repo = makeRepo(root, { "README.md": "a\n" });

  const first = await create(repo);
  expect(await modelOf(first.id)).toBe(claude.default_model);

  await client.call("settings.set", { request_id: "s1", settings: { engines: { "claude-agent": { model: setting! } } } });
  expect(await modelOf((await create(repo)).id)).toBe(setting);

  const own = await client.call("project.update", { request_id: "p1", project_id: first.project_id!, default_models: { "claude-agent": project! } });
  expect(own.default_models).toEqual({ "claude-agent": project });
  const second = await create(repo);
  expect(await modelOf(second.id)).toBe(project);
  // Another project follows the setting.
  expect(await modelOf((await create(makeRepo(root, { "README.md": "b\n" }))).id)).toBe(setting);
  expect(await modelOf((await create(repo, claude.default_model)).id)).toBe(claude.default_model);

  // A pick in the composer: that chat's model changes, the defaults do not.
  await client.call("turn.submit", { request_id: "t1", session_id: second.session_id, kind: "followup", input: { text: "hi" }, options: { model: setting! } });
  await until(async () => (await modelOf(second.id)) === setting);
  expect((await client.call("settings.get", {})).engines["claude-agent"]?.model).toBe(setting);
  expect((await client.call("project.list", {})).projects.find((p) => p.id === first.project_id)?.default_models).toEqual({ "claude-agent": project });

  const cleared = await client.call("project.update", { request_id: "p2", project_id: first.project_id!, default_models: { "claude-agent": null } });
  expect(cleared.default_models).toBeUndefined();
  expect(await modelOf((await create(repo)).id)).toBe(setting);
});

test("a saved effort counts only with the model it was saved with; a configured model the engine no longer lists gives way", async () => {
  const repo = makeRepo(root, { "README.md": "c\n" });
  await client.call("settings.set", { request_id: "e1", settings: { engines: { "claude-agent": { model: MODEL, effort: "high" } } } });
  expect((await selectionOf((await create(repo)).id)).options).toEqual([{ id: "effort", value: "high" }]);
  // The project's own default is another model: the effort saved with the setting's stays with it.
  const first = await create(repo);
  await client.call("project.update", { request_id: "e2", project_id: first.project_id!, default_models: { "claude-agent": "claude-opus-4-6" } });
  const onOpus = await selectionOf((await create(repo)).id);
  expect(onOpus.model).toBe("claude-opus-4-6");
  expect(onOpus.options ?? []).toEqual([]);
  // Gone from the engine's list (a retired model): the engine's default, as the composer shows.
  await client.call("project.update", { request_id: "e3", project_id: first.project_id!, default_models: { "claude-agent": "claude-retired-1" } });
  expect(await modelOf((await create(repo)).id)).toBe(MODEL);
  await client.call("project.update", { request_id: "e4", project_id: first.project_id!, default_models: { "claude-agent": null } });
});

test("a model starts where the person set it (model_defaults); a turn's speed stays until one names another", async () => {
  const opus = (await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")!.models.find((m) => m.id === "claude-opus-4-6")!;
  expect(opus.speeds).toEqual(["fast"]);
  expect((await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")!.models.find((m) => m.id === MODEL)!.speeds).toBeUndefined();

  const repo = makeRepo(root, { "README.md": "d\n" });
  await client.call("settings.set", { request_id: "d1", settings: { model_defaults: { "claude-agent/claude-opus-4-6": { effort: "low", speed: "fast" } } } });
  expect((await client.call("settings.get", {})).model_defaults).toEqual({ "claude-agent/claude-opus-4-6": { effort: "low", speed: "fast" } });
  const chat = await create(repo, "claude-opus-4-6");
  expect((await selectionOf(chat.id)).options).toEqual([{ id: "effort", value: "low" }, { id: "fastMode", value: true }]);
  // What a chat names wins over the model's start.
  const named = await createReady(client, { request_id: `w${++n}`, repo: { path: repo }, engine: "claude-agent", options: { model: "claude-opus-4-6", speed: "standard" } });
  expect((await selectionOf(named.id)).options).toEqual([{ id: "effort", value: "low" }, { id: "fastMode", value: false }]);

  // A turn naming only its effort keeps the chat's speed; one naming standard turns it off.
  await client.call("turn.submit", { request_id: "d2", session_id: chat.session_id, kind: "followup", input: { text: "hi" }, options: { effort: "high" } });
  await until(async () => JSON.stringify((await selectionOf(chat.id)).options) === JSON.stringify([{ id: "effort", value: "high" }, { id: "fastMode", value: true }]));
  await client.call("turn.submit", { request_id: "d3", session_id: chat.session_id, kind: "followup", input: { text: "slower" }, options: { effort: "high", speed: "standard" } });
  await until(async () => JSON.stringify((await selectionOf(chat.id)).options) === JSON.stringify([{ id: "effort", value: "high" }, { id: "fastMode", value: false }]));
  // A speed the model does not offer is refused, as an effort is.
  await expect(client.call("turn.submit", { request_id: "d4", session_id: chat.session_id, kind: "followup", input: { text: "x" }, options: { speed: "ultrafast" } })).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });

  // A start the model no longer offers is dropped, not refused.
  await client.call("settings.set", { request_id: "d5", settings: { model_defaults: { "claude-agent/claude-opus-4-6": { speed: "ultrafast" } } } });
  expect((await selectionOf((await create(repo, "claude-opus-4-6")).id)).options ?? []).toEqual([]);
  await client.call("settings.set", { request_id: "d6", settings: { model_defaults: {} } });
});

test("T3's defaultModelSelection gets only a model the person set, never a resolved default", async () => {
  const server = Context.get(serverContext, ServerSettings.ServerSettingsService);
  const mirrored = async () => (await Effect.runPromise(server.getSettings)).defaultModelSelection?.model;
  await client.call("settings.set", { request_id: "m1", settings: { engines: { "claude-agent": { model: "claude-opus-4-6" } } } });
  expect(await mirrored()).toBe("claude-opus-4-6");
  await client.call("settings.set", { request_id: "m2", settings: { engines: { "claude-agent": {} } } });
  // Nothing set: the last model the person named stays, rather than the default of this moment.
  expect(await mirrored()).toBe("claude-opus-4-6");
  await client.call("settings.set", { request_id: "m3", settings: { engines: { "claude-agent": { model: "caveman-auto" } } } });
  expect(await mirrored()).toBe("claude-opus-4-6");
});

test("models and efforts older composers saved as Settings go once on upgrade; New chats' own saves stay", async () => {
  await client.call("settings.set", { request_id: "u1", settings: { engines: { "claude-agent": { model: "claude-opus-4-6", effort: "low", account_id: "a1" }, codex: { model: "gpt-6" } } } });
  const restart = async () => {
    client.close();
    await runtime.close();
    runtime = await startRuntime(config, "fake-claude", undefined, { provide: services });
    client = connect(runtime.url, runtime.token);
    return (await client.call("settings.get", {})).engines;
  };
  // Saved after the drop (New chats): a restart keeps them.
  expect((await restart())["claude-agent"]).toEqual({ model: "claude-opus-4-6", effort: "low", account_id: "a1" });
  // The same values from a runtime from before the drop: the model and effort go, the rest stays, once.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_kv WHERE key = 'settings_composer_defaults_dropped'").run();
  db.close();
  const upgraded = await restart();
  expect(upgraded["claude-agent"]).toEqual({ account_id: "a1" });
  expect(upgraded.codex).toEqual({});
  await client.call("settings.set", { request_id: "u2", settings: { engines: { "claude-agent": { model: MODEL } } } });
  expect((await restart())["claude-agent"]).toEqual({ model: MODEL });
});
