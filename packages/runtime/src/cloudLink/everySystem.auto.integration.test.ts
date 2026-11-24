// Auto (the Caveman router) wherever a chat runs: This Mac, and a Cloud computer whose person's credentials stay
// outside it (cloud-computers CONTRACT §2). The same real runtime in both places, the stand-in CLI as Claude Agent,
// Codex and the Caveman engine, a stand-in gateway as Cloud's router. What it settles:
//
// - On a Mac, Claude Agent's and Codex's Auto is the app's own proxy asking Cloud with the sign-in's routing key.
// - A Cloud computer keeps no Caveman sign-in, so that key is never there, and under the rule the engines' requests
//   leave through Cloud's data plane, past the app's proxies. Where Cloud says its data plane routes Auto
//   (`routes_auto`, the spec), Auto is offered for Claude Agent and Codex there: the engine sends Auto's model, the
//   data plane asks Cloud's router and sends the request on with the model it chose. A Cloud that says nothing (older)
//   or names neither (its switch off) keeps today's sentence, in words that are true there (never "buy a plan").
// - The Caveman engine's Auto, a subagent's Auto and the Chief's ask Cloud's router themselves. On a Cloud computer
//   they ask with the credits key Cloud mints its runtime: offered without asking Cloud anything, minted by the first
//   ask, sent to the gateway Cloud named, and never a sign-in or a key of the person's brought into the computer.
// - The routing policy stays in Cloud: an ask names what is connected and gets one model back.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test, vi } from "vitest";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ROUTER_UNAVAILABLE, routerUnavailableOnComputer } from "../router/cavemanRouter.ts";
import { writeProxyCloud } from "../router/proxyLauncher.ts";
import { routingCredential } from "../router/routerKey.ts";
import { askRoute, routeBody } from "../router/subagentAuto.ts";

// The app's own caveman-proxies, as if the runtime had started them, and their home: no test reaches a real one.
const proxyHome = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("../router/proxyLauncher.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appProxyUrl: () => "http://127.0.0.1:8787",
  codexProxyUrl: () => "http://127.0.0.1:8788",
  appProxyHome: () => proxyHome.dir,
}));

import { MODEL, tempRoot } from "../session-protocol/testHarness.ts";
import {
  CHATGPT_PLAN,
  CLAUDE_PLAN,
  everySystemKit,
  MONEY,
  OPENAI_KEY,
  refusalOf,
  watch,
} from "./everySystem.kit.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const { mac, computer } = everySystemKit(cleanups);

/** Each engine's own models, as its provider snapshot lists them: Auto goes before them where it is offered. */
const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  getProviders: Effect.succeed([
    {
      instanceId: "claudeAgent",
      installed: true,
      auth: { status: "authenticated" },
      models: [
        { slug: MODEL, name: "Sonnet", isDefault: true, capabilities: { optionDescriptors: [] } },
      ],
    },
    {
      instanceId: "codex",
      installed: true,
      auth: { status: "authenticated" },
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          isDefault: true,
          capabilities: { optionDescriptors: [] },
        },
      ],
    },
    {
      instanceId: "caveman",
      installed: true,
      auth: { status: "authenticated" },
      models: [
        {
          slug: "deepseek/deepseek-flash",
          name: "DeepSeek Flash",
          isDefault: true,
          capabilities: { optionDescriptors: [] },
        },
      ],
    },
  ]),
} as unknown as ProviderRegistry.ProviderRegistry["Service"]);

/** Cloud's router at its gateway: every ask's credential and body, answered with one of the pool it was sent. */
async function router() {
  const asks: Array<{
    authorization: string | undefined;
    body: { pool?: ReadonlyArray<{ id: string }>; task?: unknown; models?: unknown };
  }> = [];
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.method !== "POST" || request.url !== "/v1/route")
      return void response.writeHead(404).end();
    const body = JSON.parse(text) as { pool?: ReadonlyArray<{ id: string }> };
    asks.push({ authorization: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    // The policy is Cloud's own: all that comes back is which of the pool, and an effort.
    response.end(
      JSON.stringify({ pool_id: body.pool?.at(-1)?.id, model: "routed", effort: "low" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asks };
}

const engineOf = async (client: Awaited<ReturnType<typeof mac>>["client"], id: string) =>
  (await client.call("engine.list", {})).engines.find((engine) => engine.id === id)!;

test.skipIf(process.platform === "win32")(
  "This Mac: Claude Agent's and Codex's Auto is offered while the sign-in holds a routing key, and is a new chat's default",
  async () => {
    proxyHome.dir = tempRoot("every-system-proxy-home-");
    const here = await mac({ alsoAs: ["caveman", "codex"], provide: providers });
    // Signed in with no paid routing credential: no Auto, and a chat that asks for it is told what it needs.
    writeProxyCloud(proxyHome.dir, {
      cloudUrl: "https://cloud.example",
      accessToken: "cave_free_login_fake",
    });
    expect((await engineOf(here.client, "claude-agent")).models.map((m) => m.id)).toEqual([MODEL]);
    expect(
      await refusalOf(
        here.client.call("workspace.create", {
          request_id: "auto-off",
          repo: here.where,
          engine: "claude-agent",
          options: { model: "caveman-auto" },
        }),
      ),
    ).toBe(`invalid_params: ${ROUTER_UNAVAILABLE}`);
    // With one: Auto heads the list, and a new chat starts on it.
    writeProxyCloud(proxyHome.dir, {
      cloudUrl: "https://cloud.example",
      accessToken: "cave_paid_login_fake",
      routingKey: "cave_paid_router_fake",
    });
    const claude = await engineOf(here.client, "claude-agent");
    expect(claude.models[0]).toEqual({
      id: "caveman-auto",
      label: "Auto",
      efforts: [],
      description: "Caveman picks the model for each message",
    });
    expect(claude.default_model).toBe("caveman-auto");
    expect((await engineOf(here.client, "codex")).models[0]?.id).toBe("caveman-auto");
    const chat = await here.client.call("workspace.create", {
      request_id: "auto-on",
      repo: here.where,
      engine: "claude-agent",
    });
    const seen = await watch(here.client, chat);
    await seen.turn("hello");
    expect(seen.events.find((event) => event.type === "turn.started")?.payload).toMatchObject({
      model: "caveman-auto",
    });
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a Cloud computer whose Cloud routes Auto in its data plane: Claude Agent and Codex offer Auto, and a chat on it runs on the model Cloud's router chose",
  async () => {
    proxyHome.dir = tempRoot("every-system-proxy-home-");
    const there = await computer({
      connections: [CLAUDE_PLAN, CHATGPT_PLAN, OPENAI_KEY],
      routesAuto: ["claude-agent", "codex"],
      alsoAs: ["codex"],
      provide: providers,
    });

    // ---- Offered for both, heading each list, and a new chat's default: nobody picks anything.
    const claude = await engineOf(there.client, "claude-agent");
    expect(claude.models[0]).toEqual({
      id: "caveman-auto",
      label: "Auto",
      efforts: [],
      description: "Caveman picks the model for each message",
    });
    expect(claude.default_model).toBe("caveman-auto");
    const codex = await engineOf(there.client, "codex");
    expect(codex.models[0]?.id).toBe("caveman-auto");
    expect(codex.default_model).toBe("caveman-auto");

    // ---- A Claude Agent chat on Auto: the engine sends Auto's model to the data plane, which asks the router and sends
    // the request on with the model it chose; the provider answered as that model, and the chat goes on.
    const chat = await there.client.call("workspace.create", {
      request_id: "auto-claude",
      repo: there.where,
      engine: "claude-agent",
    });
    const seen = await watch(there.client, chat);
    await seen.turn("model: hello");
    expect(seen.events.find((event) => event.type === "turn.started")?.payload).toMatchObject({
      model: "caveman-auto",
    });
    expect(seen.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    let report = await there.cloud.report();
    expect(report.routed).toEqual([
      { lane: "claude", model: "claude-sonnet-5-5", fallback: false },
    ]);
    expect(report.upstream.filter((u) => u.method === "POST").map((u) => u.model)).toEqual([
      "claude-sonnet-5-5",
    ]);
    // The person's own plan paid, outside the computer, as for any model.
    expect(report.upstream.at(-1)!.credentials).toEqual(["claudePlan"]);

    // ---- A Codex chat on Auto, likewise.
    const codexChat = await there.client.call("workspace.create", {
      request_id: "auto-codex",
      repo: there.where,
      engine: "codex",
    });
    const codexSeen = await watch(there.client, codexChat);
    await codexSeen.turn("model: hi");
    expect(codexSeen.events.find((event) => event.type === "turn.started")?.payload).toMatchObject({
      model: "caveman-auto",
    });
    expect(codexSeen.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    report = await there.cloud.report();
    expect(report.routed).toHaveLength(2);

    // ---- The router down: the turn never fails, it runs on the agent's default model.
    await there.cloud.configure({ router: "down" });
    await seen.turn("model: again");
    expect(seen.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    report = await there.cloud.report();
    expect(report.routed.at(-1)).toEqual({
      lane: "claude",
      model: "claude-opus-5-5",
      fallback: true,
    });
    expect(report.upstream.filter((u) => u.method === "POST").at(-1)!.model).toBe(
      "claude-opus-5-5",
    );

    // ---- A chosen model is never routed: it reaches the provider as picked.
    await seen.turn("model: plain", { model: MODEL });
    report = await there.cloud.report();
    expect(report.routed).toHaveLength(3);
    expect(report.upstream.filter((u) => u.method === "POST").at(-1)!.model).toBe(MODEL);

    // ---- Nothing of the policy reached the computer, and nothing of the person's came into it.
    expect(seen.shown()).not.toMatch(/claude-sonnet-5-5|router|routed|easy_turn|hard_turn/i);
    expect(seen.shown()).not.toMatch(MONEY);
    expect(report.answersWithCanary).toEqual([]);
    expect((await there.cloud.report()).closed).toEqual([]);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a Cloud computer whose Cloud routes no Auto (older, or its switch off): no Auto for Claude Agent or Codex, said plainly; the Caveman engine's Auto asks Cloud's router with the credits key Cloud mints the runtime",
  async () => {
    proxyHome.dir = tempRoot("every-system-proxy-home-");
    const gateway = await router();
    const there = await computer({
      connections: [CLAUDE_PLAN, CHATGPT_PLAN, OPENAI_KEY],
      alsoAs: ["caveman", "codex"],
      provide: providers,
    });
    there.inner.state.environments.credits.on = true;
    there.inner.state.environments.credits.gateway = gateway.url;
    const minted = there.inner.state.environments.credits.minted;

    // ---- Claude Agent and Codex: not offered, though the app's proxies are up. Nothing a person could do on the
    // computer would change that (no sign-in is kept there), so the words say what is so, and what does work.
    const claude = await engineOf(there.client, "claude-agent");
    expect(claude.models.map((m) => m.id)).toEqual([MODEL]);
    expect(claude.default_model).toBe(MODEL);
    expect((await engineOf(there.client, "codex")).models.map((m) => m.id)).toEqual(["gpt-5.5"]);
    const claudeSays =
      "invalid_params: Auto doesn't run Claude Agent in Cloud yet. Pick a model, or use Caveman's Auto.";
    expect(`invalid_params: ${routerUnavailableOnComputer("claude-agent")}`).toBe(claudeSays);
    expect(
      await refusalOf(
        there.client.call("workspace.create", {
          request_id: "auto-claude",
          repo: there.where,
          engine: "claude-agent",
          options: { model: "caveman-auto" },
        }),
      ),
    ).toBe(claudeSays);
    expect(
      await refusalOf(
        there.client.call("workspace.create", {
          request_id: "auto-codex",
          repo: there.where,
          engine: "codex",
          options: { model: "caveman-auto" },
        }),
      ),
    ).toBe(
      "invalid_params: Auto doesn't run Codex in Cloud yet. Pick a model, or use Caveman's Auto.",
    );
    // A new chat with no model named starts on the engine's own, and runs: nobody has to pick anything.
    const chat = await there.client.call("workspace.create", {
      request_id: "plain",
      repo: there.where,
      engine: "claude-agent",
    });
    const seen = await watch(there.client, chat);
    await seen.turn("hello");
    expect(seen.events.find((event) => event.type === "turn.started")?.payload).toMatchObject({
      model: MODEL,
    });
    expect(seen.said().at(-1)).toBe("smoke ok: hello");
    // A chat that had Auto picked for it elsewhere (the desktop's picker lists This Mac's models; a chat that came from
    // a Mac): the message is refused in the same words, and the chat goes on with its own model after.
    expect(
      await refusalOf(
        there.client.call("turn.submit", {
          request_id: "auto-turn",
          session_id: chat.session_id,
          kind: "followup",
          input: { text: "again" },
          options: { model: "caveman-auto" },
        }),
      ),
    ).toBe(claudeSays);
    await seen.turn("still here");
    expect(seen.said().at(-1)).toBe("smoke ok: still here");

    // ---- The Caveman engine: Auto heads its list and is a new chat's default, and listing it asked Cloud for nothing.
    const caveman = await engineOf(there.client, "caveman");
    expect(caveman.models[0]).toEqual({
      id: "auto",
      label: "Auto",
      efforts: [],
      description: "Caveman picks the model and effort",
    });
    expect(caveman.default_model).toBe("auto");
    expect(minted).toHaveLength(0);

    // ---- The ask itself, as the engine's Auto, a subagent's and the Chief's make it (routerKey.ts routingCredential):
    // the credits key is minted now, for this computer's runtime, and goes to the gateway Cloud named.
    const credential = await routingCredential.get();
    expect(minted).toHaveLength(1);
    expect(minted[0]!.runtimeId).toBe(there.identity.runtimeId);
    expect(credential).toEqual({ key: minted[0]!.key, url: gateway.url });
    const pool = [
      { id: "p-sonnet", model: MODEL, host: "anthropic", via: "local", harness: "claude-agent" },
      { id: "p-codex", model: "gpt-5.5", host: "openai", via: "local", harness: "codex" },
    ] as unknown as Parameters<typeof routeBody>[2];
    const targets = new Map([
      ["p-sonnet", { instanceId: "claudeAgent", model: MODEL }],
      ["p-codex", { instanceId: "codex", model: "gpt-5.5" }],
    ]) as unknown as Parameters<typeof askRoute>[3];
    const answer = await askRoute(
      { url: credential!.url, fetch, timeoutMs: 5_000, credential: routingCredential },
      credential!.key,
      routeBody(MODEL, { kind: "general", brief: "rename a function" }, pool),
      targets,
    );
    // Cloud picked across engines; the computer learned the model and the effort, nothing of why.
    expect(answer).toEqual({
      kind: "pick",
      target: { instanceId: "codex", model: "gpt-5.5" },
      effort: "low",
    });
    expect(gateway.asks).toHaveLength(1);
    expect(gateway.asks[0]!.authorization).toBe(`Bearer ${minted[0]!.key}`);
    expect(Object.keys(gateway.asks[0]!.body).sort()).toEqual(["models", "pool", "task"]);
    // Asked again: the key held serves, nothing minted twice.
    expect((await routingCredential.get())?.key).toBe(minted[0]!.key);
    expect(minted).toHaveLength(1);

    // ---- Nothing of the person's came into the computer for any of it: not one call to a route the rule closes.
    expect((await there.cloud.report()).closed).toEqual([]);
  },
  180_000,
);

test.skipIf(process.platform === "win32")(
  "a Cloud computer whose Cloud runs no credits there: no Auto for the Caveman engine once Cloud has said so, and nothing asked again",
  async () => {
    proxyHome.dir = tempRoot("every-system-proxy-home-");
    const there = await computer({ alsoAs: ["caveman"], provide: providers });
    // Before anything was asked the computer cannot know; the first ask is refused, and Auto goes from the list.
    expect(await routingCredential.get()).toBeUndefined();
    const caveman = await engineOf(there.client, "caveman");
    expect(caveman.models.map((m) => m.id)).toEqual(["deepseek/deepseek-flash"]);
    expect(caveman.default_model).not.toBe("auto");
    expect(await routingCredential.get()).toBeUndefined();
    expect(there.inner.state.environments.credits.minted).toHaveLength(0);
  },
  120_000,
);

test.skipIf(process.platform === "win32")(
  "a Cloud computer whose Cloud has Auto's switches off (routes_auto is empty): the same sentence, and a chat runs on its own model",
  async () => {
    proxyHome.dir = tempRoot("every-system-proxy-home-");
    const there = await computer({
      connections: [CLAUDE_PLAN, CHATGPT_PLAN],
      routesAuto: [],
      alsoAs: ["codex"],
      provide: providers,
    });
    expect((await engineOf(there.client, "claude-agent")).models.map((m) => m.id)).toEqual([MODEL]);
    expect((await engineOf(there.client, "codex")).models.map((m) => m.id)).toEqual(["gpt-5.5"]);
    expect(
      await refusalOf(
        there.client.call("workspace.create", {
          request_id: "auto-off",
          repo: there.where,
          engine: "claude-agent",
          options: { model: "caveman-auto" },
        }),
      ),
    ).toBe(
      "invalid_params: Auto doesn't run Claude Agent in Cloud yet. Pick a model, or use Caveman's Auto.",
    );
    const chat = await there.client.call("workspace.create", {
      request_id: "plain-off",
      repo: there.where,
      engine: "claude-agent",
    });
    const seen = await watch(there.client, chat);
    await seen.turn("model: hello");
    expect(seen.said().at(-1)).toBe("smoke ok: model said: answer from the provider");
    expect((await there.cloud.report()).routed).toEqual([]);
  },
  120_000,
);
