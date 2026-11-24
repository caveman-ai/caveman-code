// The default engine (2026-10-19): a new chat starts on the Caveman engine wherever it can run on this computer
// (something it runs on is connected), else on Claude Agent, until the person chooses a default; a chosen default
// never moves. Settings saved before the flag count as chosen unless they hold the old initial value.
import * as fs from "node:fs";

import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { connect } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "./testHarness.ts";

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
// The Caveman engine's key store; the stand-in claude also serves the `caveman` instance, so a chat on it runs here.
const host = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const start = async () => {
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: host, alsoAs: ["caveman"] });
  client = connect(runtime.url, runtime.token);
};
const restart = async () => {
  client.close();
  await runtime.close();
  await start();
};
const settings = () => client.call("settings.get", {});
/** A keyless endpoint of the person's own: something the Caveman engine runs on. The test host keeps keys per start. */
const connectEndpoint = (request_id: string) =>
  client.call("engine.account.add", { request_id, engine: "caveman", provider: "custom-local", endpoint: { name: "Local", base_url: "http://127.0.0.1:9/v1", models: ["coder"] } });
/** Writes Settings as a runtime from before default_engine_chosen saved them, and lets the next start mark them. */
const savedByOlderRuntime = (saved: Record<string, unknown>) => {
  const db = new DatabaseSync(config.dbPath);
  db.prepare("INSERT OR REPLACE INTO caveman_sp_kv (key, value) VALUES ('settings', ?)").run(JSON.stringify(saved));
  db.prepare("DELETE FROM caveman_sp_kv WHERE key = 'settings_default_engine_marked'").run();
  db.close();
};

beforeAll(async () => {
  root = tempRoot("sp-default-engine-");
  config = await makeConfig();
  await start();
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("nothing connected: Claude Agent; a connected endpoint makes the Caveman engine the default, and a chat with no engine starts on it", async () => {
  expect(await settings()).toMatchObject({ default_engine: "claude-agent", default_engine_chosen: false });

  await connectEndpoint("a1");
  expect(await settings()).toMatchObject({ default_engine: "caveman", default_engine_chosen: false });

  const ws = await client.call("workspace.create", { request_id: "w1", repo: { path: makeRepo(root, { "README.md": "a\n" }) }, title: "no engine named" });
  expect(ws.engine).toBe("caveman");

  // An unrelated save never freezes the default nobody chose.
  await client.call("settings.set", { request_id: "s1", settings: { theme: "dark" } });
  expect(await settings()).toMatchObject({ default_engine: "caveman", default_engine_chosen: false, theme: "dark" });

  // Nothing left to run on: back to Claude Agent.
  await client.call("engine.account.remove", { request_id: "r1", engine: "caveman", account_id: "caveman:custom-local" });
  expect(await settings()).toMatchObject({ default_engine: "claude-agent", default_engine_chosen: false });
});

test("a default the person chose stays, whatever is connected, across a restart", async () => {
  await connectEndpoint("a2");
  await client.call("settings.set", { request_id: "s2", settings: { default_engine: "claude-agent" } });
  expect(await settings()).toMatchObject({ default_engine: "claude-agent", default_engine_chosen: true });
  const ws = await client.call("workspace.create", { request_id: "w2", repo: { path: makeRepo(root, { "README.md": "b\n" }) }, title: "chosen", options: { model: MODEL } });
  expect(ws.engine).toBe("claude-agent");
  await client.call("settings.set", { request_id: "s3", settings: { theme: "light" } });
  await restart();
  expect(await settings()).toMatchObject({ default_engine: "claude-agent", default_engine_chosen: true, theme: "light" });
});

test("on upgrade, saved Settings holding the old initial Claude Agent are not a choice; any other saved engine is", async () => {
  savedByOlderRuntime({ default_engine: "claude-agent", theme: "dark" });
  await restart();
  expect(await settings()).toMatchObject({ default_engine: "claude-agent", default_engine_chosen: false });
  await connectEndpoint("a3");
  expect(await settings()).toMatchObject({ default_engine: "caveman", default_engine_chosen: false, theme: "dark" });

  savedByOlderRuntime({ default_engine: "codex", theme: "dark" });
  await restart();
  await connectEndpoint("a4");
  expect(await settings()).toMatchObject({ default_engine: "codex", default_engine_chosen: true });

  // Marked once: a later start leaves a default nobody chose alone, and keeps a choice made since.
  await client.call("settings.set", { request_id: "s4", settings: { default_engine: "caveman" } });
  await restart();
  // Chosen, so it stays even with nothing connected after the restart.
  expect(await settings()).toMatchObject({ default_engine: "caveman", default_engine_chosen: true });
});
