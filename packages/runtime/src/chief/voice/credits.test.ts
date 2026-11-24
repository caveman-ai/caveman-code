// Calls and dictation on Caveman credits, through the real runtime's Session Protocol route: a person with no
// Deepgram key of their own calls and dictates on credits (Caveman Cloud relays Deepgram on Caveman's key,
// Caveman Cloud the spec); a key they add pays instead, and removing it goes back to credits. Only the network is
// replaced: Cloud's ticket route and Deepgram's token grant answer as they do.
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { setCavemanKey } from "@caveman-app/provider-caveman/server";
import { connect, type VoiceCall } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { makeConfig, makeRepo, startRuntime, until } from "../../session-protocol/testHarness.ts";
import { makeDeepgram, VoiceEngineRef } from "./deepgram.ts";

const COMPUTER_KEY = "cave_computer_credits_key_0123456789";
const KEPT_KEY = "cave_kept_credits_key_0123456789";
const DG_KEY = "dg-own-key-0123456789abcdef";

let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let config: Awaited<ReturnType<typeof makeConfig>>;
let host: ProviderHost.ProviderHost["Service"];
/** Whether the Cloud computer's credits may pay: Cloud can say they may not. */
let computerCredits = true;
/** Whether the gateway offers voice on credits: false answers as a gateway from before Caveman Cloud the spec does. */
let gatewayOffers = true;
const asked: Array<{ url: string; auth: string; body: unknown }> = [];
/** The chat each ticket request named for its minutes (x-caveman-session), in order. */
const sessions: Array<string | undefined> = [];
const updates: Array<VoiceCall> = [];
let request = 0;
const rid = () => `voice-credits-${++request}`;

const spendRows = () => {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT usage FROM caveman_sp_spend WHERE usage LIKE '%deepgram/%' ORDER BY at")
    .all() as Array<{ usage: string }>;
  db.close();
  return rows.map(
    (r) =>
      JSON.parse(r.usage) as Record<string, unknown> & {
        cost: { usd: number };
        duration_ms: number;
      },
  );
};

beforeAll(async () => {
  config = await makeConfig();
  // Cloud's ticket route (a ticket and what a minute costs) and Deepgram's grant, each request kept.
  const engine = makeDeepgram({
    fetch: async (url, init) => {
      asked.push({
        url,
        auth: init.headers.Authorization ?? "",
        body: JSON.parse(init.body) as unknown,
      });
      if (url.endsWith("/v1/code/voice")) sessions.push(init.headers["x-caveman-session"]);
      if (!url.endsWith("/v1/code/voice"))
        return { status: 200, json: async () => ({ access_token: "jwt-own-key", expires_in: 60 }) };
      return gatewayOffers
        ? {
            status: 200,
            json: async () => ({
              ticket: `cvt_ticket-${asked.length}`,
              expires_in: 60,
              usd_per_minute: 0.08,
            }),
          }
        : {
            status: 404,
            json: async () => ({
              error: {
                type: "cave_gateway_error",
                code: "cave_route_not_found",
                message: "Gateway path is not recognized.",
              },
            }),
          };
    },
  });
  // A Cloud computer: its runtime holds its person's credits key in memory, and says where it runs.
  const held = { key: COMPUTER_KEY, gateway: "https://computer-gateway.example" };
  const context = await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        TestProviderHost.layer({
          credits: { available: () => computerCredits, peek: () => held, get: async () => held },
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  host = Context.get(context, ProviderHost.ProviderHost);
  runtime = await startRuntime(config, "fake-claude", undefined, {
    provide: Layer.mergeAll(Layer.succeedContext(context), Layer.succeed(VoiceEngineRef, engine)),
  });
  client = connect(runtime.url, runtime.token);
  client.on("chief.voice.updated", (call) => updates.push(call));
  // A project, so it has a Chief to call.
  await client.call("project.create", {
    request_id: rid(),
    path: makeRepo(config.stateDir, { "README.md": "chief\n" }),
    name: "chief-project",
  });
});
afterAll(async () => {
  client?.close();
  await runtime?.close();
  if (config) fs.rmSync(config.stateDir, { recursive: true, force: true });
});

/** A call that goes live and is hung up: what it was told to connect to. */
const oneCall = async () => {
  const { call, connect: opened } = await client.call("chief.voice.start", {
    request_id: rid(),
    device: "Test",
  });
  await client.call("chief.voice.signal", {
    request_id: rid(),
    call_id: call.id,
    seq: 0,
    events: [{ type: "Welcome", request_id: "dg-1" }, { type: "SettingsApplied" }],
  });
  await until(() => updates.some((c) => c.id === call.id && c.state === "live"), 5_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.call("chief.voice.end", { request_id: rid(), call_id: call.id });
  return opened;
};

describe("voice on Caveman credits", () => {
  test("no key of their own: calls are ready on credits, and nothing asks Cloud until a call starts", async () => {
    const voice = (await client.call("chief.get", {})).voice!;
    expect(voice).toMatchObject({
      state: "ready",
      engine: "deepgram",
      credits: "on",
      paid_by: "credits",
    });
    expect(voice.key_hint).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("a call on credits opens Cloud's socket with a one-time ticket, keeps Deepgram's settings, and its minutes are credits spend", async () => {
    const opened = await oneCall();
    expect(asked).toEqual([
      {
        url: "https://computer-gateway.example/v1/code/voice",
        auth: `Bearer ${COMPUTER_KEY}`,
        body: { kind: "agent" },
      },
    ]);
    // The minutes are the Chief's chat's, as its typed turns are.
    expect(sessions.at(-1)).toBe((await client.call("chief.get", {})).workspace.id);
    expect(opened).toMatchObject({
      transport: "websocket",
      url: "wss://computer-gateway.example/v1/code/voice/socket",
      protocols: ["bearer", "cvt_ticket-1"],
      input_rate: 16_000,
      output_rate: 24_000,
    });
    const settings = opened.settings as {
      agent: {
        listen: { provider: { type: string } };
        think: Array<{ provider: { type: string; model: string } }>;
        speak: { provider: { type: string } };
      };
    };
    // What Cloud relays on credits (code_voice.go codeVoiceSettingsRefusal): Deepgram listens and speaks, a Standard-tier model thinks.
    expect(settings.agent.listen.provider.type).toBe("deepgram");
    expect(settings.agent.speak.provider.type).toBe("deepgram");
    expect(settings.agent.think.map((t) => `${t.provider.type}/${t.provider.model}`)).toEqual([
      "open_ai/gpt-4.1-mini",
      "anthropic/claude-haiku-4-5",
    ]);
    expect(JSON.stringify(opened)).not.toContain(COMPUTER_KEY);
    const [row] = spendRows();
    expect(row).toMatchObject({ model: "deepgram/voice-agent", cost: { basis: "list_price" } });
    // Billed by Cloud to the credits, at its price: never as the person's own key.
    expect(row).not.toHaveProperty("billing");
    expect(row!.cost.usd).toBeCloseTo((row!.duration_ms / 60_000) * 0.08, 9);
  });

  test("dictation on credits: Cloud gets the keyterms, the box gets Cloud's socket, the minutes are credits spend", async () => {
    asked.length = 0;
    const { dictation_id, connect: opened } = await client.call("dictation.start", {
      request_id: rid(),
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      url: "https://computer-gateway.example/v1/code/voice",
      auth: `Bearer ${COMPUTER_KEY}`,
      body: { kind: "dictation" },
    });
    expect(opened).toEqual({
      transport: "websocket",
      url: "wss://computer-gateway.example/v1/code/voice/socket",
      protocols: ["bearer", "cvt_ticket-1"],
      input_rate: 16_000,
    });
    await client.call("dictation.end", { request_id: rid(), dictation_id, audio_ms: 1_500 });
    const row = spendRows().find((r) => r.model === "deepgram/nova-3")!;
    expect(row).not.toHaveProperty("billing");
    expect(row.cost.usd).toBeCloseTo((1_500 / 60_000) * 0.08, 9);
  });

  test("a key of their own pays instead, straight to Deepgram; removing it goes back to credits", async () => {
    expect(
      await client.call("chief.voice.key", { request_id: rid(), engine: "deepgram", key: DG_KEY }),
    ).toMatchObject({ state: "ready", key_hint: `...${DG_KEY.slice(-4)}` });
    expect((await client.call("chief.get", {})).voice?.credits).toBeUndefined();
    asked.length = 0;
    const opened = await oneCall();
    expect(opened.url).toBe("wss://agent.deepgram.com/v1/agent/converse");
    expect(asked.map((a) => a.url)).toEqual(["https://api.deepgram.com/v1/auth/grant"]);
    expect(spendRows().at(-1)).toMatchObject({ model: "deepgram/voice-agent", billing: "api_key" });
    expect(
      await client.call("chief.voice.key", { request_id: rid(), engine: "deepgram", key: null }),
    ).toMatchObject({ state: "ready", credits: "on" });
  });

  test("credits kept with the person's sign-in pay at the gateway kept with them; with none, calls wait for a key or a plan", async () => {
    // Cloud says this computer's credits may not pay; the person's own credits key, kept on This Mac, does.
    computerCredits = false;
    await Effect.runPromise(
      setCavemanKey(ProviderInstanceId.make("caveman"), "caveman", {
        key: KEPT_KEY,
        gateway: "https://kept-gateway.example",
      }).pipe(Effect.provideService(ProviderHost.ProviderHost, host)),
    );
    asked.length = 0;
    const opened = await oneCall();
    expect(asked).toEqual([
      {
        url: "https://kept-gateway.example/v1/code/voice",
        auth: `Bearer ${KEPT_KEY}`,
        body: { kind: "agent" },
      },
    ]);
    expect(opened.url).toBe("wss://kept-gateway.example/v1/code/voice/socket");

    await Effect.runPromise(
      setCavemanKey(ProviderInstanceId.make("caveman"), "caveman", null).pipe(
        Effect.provideService(ProviderHost.ProviderHost, host),
      ),
    );
    expect((await client.call("chief.get", {})).voice).toMatchObject({ state: "no_key" });
    await expect(
      client.call("chief.voice.start", { request_id: rid(), device: "Test" }),
    ).rejects.toThrow(/no_key: calls need a Caveman plan or credits, or a Deepgram key/);
    await expect(client.call("dictation.start", { request_id: rid() })).rejects.toThrow(
      /no_key: dictation needs a Caveman plan or credits, or a Deepgram key/,
    );
  });

  test("a gateway that doesn't offer voice on credits is remembered: no_key, and no start asks it again until a key is added", async () => {
    await Effect.runPromise(
      setCavemanKey(ProviderInstanceId.make("caveman"), "caveman", {
        key: KEPT_KEY,
        gateway: "https://kept-gateway.example",
      }).pipe(Effect.provideService(ProviderHost.ProviderHost, host)),
    );
    expect((await client.call("chief.get", {})).voice).toMatchObject({
      state: "ready",
      credits: "on",
    });
    gatewayOffers = false;
    asked.length = 0;
    // The first start asks, and is told; the person is pointed to a key (not_offered).
    await expect(
      client.call("chief.voice.start", { request_id: rid(), device: "Test" }),
    ).rejects.toThrow(/^not_offered: Calls and dictation on Caveman credits aren't on yet/);
    expect(asked).toHaveLength(1);
    expect((await client.call("chief.get", {})).voice).toMatchObject({
      state: "no_key",
      credits: "unavailable",
    });
    // Neither a call nor dictation asks the gateway again.
    await expect(client.call("dictation.start", { request_id: rid() })).rejects.toThrow(
      /^not_offered:/,
    );
    await expect(
      client.call("chief.voice.start", { request_id: rid(), device: "Test" }),
    ).rejects.toThrow(/^not_offered:/);
    expect(asked).toHaveLength(1);
    // A key of their own still calls.
    await client.call("chief.voice.key", { request_id: rid(), engine: "deepgram", key: DG_KEY });
    expect((await oneCall()).url).toBe("wss://agent.deepgram.com/v1/agent/converse");
  });
});
