// Regression tests through the real runtime's public Session Protocol route, with only
// Deepgram's token grant replaced; no audio or model connection is needed for these races.
import * as fs from "node:fs";
import { connect, type SocketFactory, type VoiceCall } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { afterAll, beforeAll, expect, test } from "vitest";

import { makeConfig, makeRepo, startRuntime, until } from "../../session-protocol/testHarness.ts";
import { makeDeepgram, VoiceEngineRef } from "./deepgram.ts";

let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let config: Awaited<ReturnType<typeof makeConfig>>;
const updates: Array<VoiceCall> = [];
const messages: Array<{ type?: string; message?: string }> = [];
let request = 0;
const rid = () => `voice-race-${++request}`;

beforeAll(async () => {
  config = await makeConfig();
  const engine = makeDeepgram({ fetch: async () => ({ status: 200, json: async () => ({ access_token: "test-token" }), text: async () => "" }) });
  const host = Layer.succeedContext(await Effect.runPromise(Effect.scoped(Layer.build(TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer))))));
  runtime = await startRuntime(config, "fake-claude", undefined, { provide: Layer.mergeAll(host, Layer.succeed(VoiceEngineRef, engine)) });
  client = connect(runtime.url, runtime.token);
  client.on("chief.voice.updated", (call) => updates.push(call));
  client.on("chief.voice.send", (sent) => messages.push(...sent.messages as typeof messages));
  // A project, so it has a Chief to call.
  await client.call("project.create", { request_id: rid(), path: makeRepo(config.stateDir, { "README.md": "chief\n" }), name: "chief-project" });
  await client.call("chief.voice.key", { request_id: rid(), engine: "deepgram", key: "test-deepgram-key-0123456789" });
});
afterAll(async () => {
  client?.close();
  await runtime?.close();
  if (config) fs.rmSync(config.stateDir, { recursive: true, force: true });
});

test("a fatal error stops the rest of a batched signal, including a handoff", async () => {
  const { call } = await client.call("chief.voice.start", { request_id: rid(), device: "Test" });
  await client.call("chief.voice.signal", { request_id: rid(), call_id: call.id, seq: 0, events: [{ type: "SettingsApplied" }] });
  const result = await client.call("chief.voice.signal", {
    request_id: rid(), call_id: call.id, seq: 1,
    events: [
      { type: "Error", code: "SERVER_GOING_AWAY", description: "gone" },
      { type: "ConversationText", role: "user", content: "Do not capture words after the call ended." },
      { type: "FunctionCallRequest", functions: [{ id: "late-handoff", name: "hand_to_chief", client_side: true }] },
    ],
  });
  expect((await client.call("chief.get", {})).voice?.call).toBeUndefined();
  expect(result.send).toEqual([]);
  expect((await client.call("chief.items.list", {})).items.some((i) => i.text === "Do not capture words after the call ended.")).toBe(false);
});

test("a board change while connecting is announced once the line becomes live", async () => {
  const title = "Work finishing during connection";
  const previous = await client.call("chief.voice.start", { request_id: rid(), device: "Test" });
  await client.call("chief.voice.signal", { request_id: rid(), call_id: previous.call.id, seq: 0, events: [
    { type: "SettingsApplied" },
    { type: "ConversationText", role: "user", content: title },
    { type: "FunctionCallRequest", functions: [{ id: "work-handoff", name: "hand_to_chief", client_side: true }] },
  ] });
  await client.call("chief.voice.end", { request_id: rid(), call_id: previous.call.id });
  const item = (await client.call("chief.items.list", {})).items.find((i) => i.text === title)!;
  await client.call("chief.items.update", { request_id: rid(), item_id: item.id, state: "queued" });
  const { call } = await client.call("chief.voice.start", { request_id: rid(), device: "Test" });
  try {
    await client.call("chief.items.update", { request_id: rid(), item_id: item.id, state: "done" });
    // Let the connecting call consume the board notification before SettingsApplied.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.call("chief.voice.signal", { request_id: rid(), call_id: call.id, seq: 0, events: [{ type: "SettingsApplied" }] });
    await until(() => updates.some((c) => c.id === call.id && c.state === "live"), 5_000);
    await until(() => messages.some((m) => m.type === "InjectAgentMessage" && m.message?.toLowerCase().includes(title.toLowerCase())), 3_000);
    expect(messages.filter((m) => m.type === "InjectAgentMessage" && m.message?.toLowerCase().includes(title.toLowerCase()))).toHaveLength(1);
  } finally {
    await client.call("chief.voice.end", { request_id: rid(), call_id: call.id });
  }
});

test("a redial right after hanging up while it rang is not refused as busy", async () => {
  // The person hangs up while it rings and calls again at once. Their app ends the abandoned call only once its start
  // answers, so the redial reaches the runtime first.
  const abandoned = await client.call("chief.voice.start", { request_id: rid(), device: "Test" });
  const redial = client.call("chief.voice.start", { request_id: rid(), device: "Test" });
  const ended = (callId: string) => client.call("chief.voice.end", { request_id: rid(), call_id: callId }).catch(() => undefined);
  try {
    const { call } = await redial;
    expect(call.id).not.toBe(abandoned.call.id);
    expect(updates.find((c) => c.id === abandoned.call.id && c.state === "ended")).toMatchObject({ end_reason: "person" });
    // The app's late end of the abandoned call finds nothing to end, and leaves the redial on.
    await expect(client.call("chief.voice.end", { request_id: rid(), call_id: abandoned.call.id })).rejects.toThrow(`No call ${abandoned.call.id} on now.`);
    expect((await client.call("chief.get", {})).voice?.call?.id).toBe(call.id);
  } finally {
    await ended(abandoned.call.id);
    await redial.then(({ call }) => ended(call.id), () => undefined);
  }
});

test("a call ringing on another device still makes a new call busy", async () => {
  const other = connect(runtime.url, runtime.token);
  const { call } = await client.call("chief.voice.start", { request_id: rid(), device: "Laptop" });
  try {
    await expect(other.call("chief.voice.start", { request_id: rid(), device: "Phone" })).rejects.toThrow("busy: on a call on Laptop");
  } finally {
    other.close();
    await client.call("chief.voice.end", { request_id: rid(), call_id: call.id });
  }
});

// A call is the connection's that dialed it: when that socket drops, the runtime ends the call (connection_lost). A
// start whose answer was lost with its socket is resent, with its request_id, on the next one: it must dial there.
test("a call dialed again after its connection dropped starts on the new connection", async () => {
  let sockets = 0;
  let dropped: string | undefined;
  const blip: SocketFactory = (url, bearer) => {
    const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(bearer).toString("base64url")}`]);
    const first = ++sockets === 1;
    let start: unknown;
    return {
      get readyState() {
        return ws.readyState;
      },
      send(frame: string) {
        const message = JSON.parse(frame) as { id?: unknown; method?: string };
        if (message.method !== "chief.voice.start") return ws.send(frame);
        start = message.id;
        if (first) return ws.send(frame);
        // The resend goes out once the runtime has ended the call its dropped socket held.
        void until(() => updates.some((c) => c.id === dropped && c.state === "ended")).then(() => ws.send(frame));
      },
      close: (code?: number, why?: string) => ws.close(code, why),
      set onopen(fn: WebSocket["onopen"]) {
        ws.onopen = fn;
      },
      set onerror(fn: WebSocket["onerror"]) {
        ws.onerror = fn;
      },
      set onclose(fn: WebSocket["onclose"]) {
        ws.onclose = fn;
      },
      set onmessage(fn: WebSocket["onmessage"]) {
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { id?: unknown; result?: { call?: VoiceCall } };
          if (first && start !== undefined && message.id === start) {
            dropped = message.result?.call?.id;
            return ws.close();
          }
          fn?.call(ws, event);
        };
      },
    } as unknown as WebSocket;
  };
  const dialer = connect(runtime.url, runtime.token, undefined, { socket: blip });
  let started: { call: VoiceCall } | undefined;
  try {
    started = await dialer.call("chief.voice.start", { request_id: rid(), device: "Phone" });
    expect(sockets).toBe(2);
    expect(dropped).toBeDefined();
    const signal = await dialer.call("chief.voice.signal", { request_id: rid(), call_id: started.call.id, seq: 0, events: [{ type: "SettingsApplied" }] }).then(
      () => "ok",
      (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
    );
    expect({ dialedAgain: started.call.id !== dropped, on: (await client.call("chief.get", {})).voice?.call?.id === started.call.id, signal }).toEqual({ dialedAgain: true, on: true, signal: "ok" });
  } finally {
    if (started) await client.call("chief.voice.end", { request_id: rid(), call_id: started.call.id }).catch(() => undefined);
    dialer.close();
  }
});
