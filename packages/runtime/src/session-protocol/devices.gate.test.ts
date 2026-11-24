// The gate on a relayed stream (devices.ts makeDevices().gate) while the relay socket holds what This Mac sends
// (relay.ts: a send waits while the socket is over HIGH_WATER): a device removed here gets nothing more through at once
// (THREAT-MODEL T8), and a stream that closed before its approval left the socket is never served. Real makeDevices over
// the real SessionStore (in-memory SQLite), real WebCrypto keys on the device's side.
import { KeyObject } from "node:crypto";

import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import {
  channelKeys,
  ephemeralKey,
  helloPayload,
  openFrame,
  sealFrame,
  toBase64url,
  type ChannelKeys,
  type DeviceKey,
} from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, expect, test, vi } from "vitest";

import { CloudComputer } from "../cloudLink/index.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { makeDevices, type FrameChannel, type FrameSink } from "./devices.ts";
import { testDevice } from "./devices.testkit.ts";
import { SessionStore, make as makeStore } from "./store.ts";
import { until } from "./testHarness.ts";

const ME = "user-1";

/** A relayed stream as relay.ts makes one: a send waits while the socket is backed up, even past the stream's close; close tells the sink at once. */
class RelayChannel implements FrameChannel {
  readonly sent: Array<string> = [];
  readonly held: Array<() => void> = [];
  backedUp = false;
  closedWith: string | undefined;
  sink: FrameSink | undefined;
  send(data: string | Uint8Array): Promise<void> {
    if (this.closedWith !== undefined) return Promise.resolve();
    this.sent.push(typeof data === "string" ? data : "<bytes>");
    if (!this.backedUp) return Promise.resolve();
    return new Promise<void>((resolve) => this.held.push(resolve));
  }
  close(reason = "") {
    if (this.closedWith !== undefined) return;
    this.closedWith = reason || "closed";
    this.sink?.closed(this.closedWith);
  }
  drain() {
    this.backedUp = false;
    for (const resolve of this.held.splice(0)) resolve();
  }
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/** Everything already queued runs (the gate's frames go through promise chains, not timers). */
const quiet = () => new Promise<void>((resolve) => setImmediate(resolve));

/** This Mac, its screen having allowed `phone` earlier, with one relayed stream open and what the server behind the gate saw. */
async function thisMacWith(phone: DeviceKey) {
  const storeRuntime = ManagedRuntime.make(NodeSqliteClient.layer({ filename: ":memory:" }));
  disposers.push(() => storeRuntime.dispose());
  const store = await storeRuntime.runPromise(
    makeStore.pipe(Effect.provideService(ProjectSecrets, {} as ProjectSecrets["Service"])),
  );
  const allowed = {
    device_id: phone.device_id,
    name: phone.name,
    public_key: phone.public_key,
    user_id: ME,
    added_at: "2026-11-06T09:00:00.000Z",
    role: "device",
  };
  await Effect.runPromise(
    store.kvSet(
      "devices",
      JSON.stringify({
        devices: [allowed],
        requests: [],
        blocked: [],
        outbox: [],
        refused: {},
        lifted: [],
        retired: [],
        seen: {},
      }),
    ),
  );
  const devices = await Effect.runPromise(
    makeDevices({ notifyLocal: () => undefined, runtimeName: () => "This Mac" }).pipe(
      Effect.provideService(SessionStore, store),
      Effect.provideService(CloudComputer, undefined),
    ),
  );
  const channel = new RelayChannel();
  const server = {
    served: 0,
    delivered: [] as Array<string>,
    closed: undefined as string | undefined,
    stream: undefined as FrameChannel | undefined,
  };
  const sink = devices.gate!(channel, { runtimeId: "rt-this-mac", userId: ME }, (stream) => {
    server.served++;
    server.stream = stream;
    return {
      message: (body) => void server.delivered.push(typeof body === "string" ? body : "<bytes>"),
      closed: (reason) => void (server.closed = reason),
    };
  });
  channel.sink = sink;
  const remove = (deviceId: string) =>
    Effect.runPromiseExit(
      devices.handlers["device.remove"](
        { device_id: deviceId },
        { principal: "local" },
      ) as Effect.Effect<unknown, unknown>,
    );
  return { channel, sink, server, remove };
}

/** The phone's device.hello on the stream, as a real device signs it; its frame keys. */
async function hello(
  channel: RelayChannel,
  sink: FrameSink,
  phone: DeviceKey,
): Promise<ChannelKeys> {
  await until(() => channel.sent.some((f) => f.includes('"device.challenge"')), 10_000);
  const challenge = (
    JSON.parse(channel.sent.find((f) => f.includes('"device.challenge"'))!) as {
      params: { nonce: string; runtime_id: string; key: string };
    }
  ).params;
  const ephemeral = await ephemeralKey();
  const payload = helloPayload({
    runtime_id: challenge.runtime_id,
    nonce: challenge.nonce,
    runtime_key: challenge.key,
    device_key: ephemeral.public_key,
    v2: { kind: "device", name: phone.name },
  });
  const signature = toBase64url(await phone.sign(payload));
  const keys = await channelKeys({
    privateKey: ephemeral.privateKey,
    peer_key: challenge.key,
    runtime_id: challenge.runtime_id,
    nonce: challenge.nonce,
    runtime_key: challenge.key,
    device_key: ephemeral.public_key,
  });
  sink.message(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "device.hello",
      method: "device.hello",
      params: {
        device_id: phone.device_id,
        name: phone.name,
        public_key: phone.public_key,
        key: ephemeral.public_key,
        signature,
        kind: "device",
      },
    }),
  );
  return keys;
}

/** What the phone reads in the sealed frames This Mac sent it, opened in order as a real device does. */
async function sealedToPhone(channel: RelayChannel, keys: ChannelKeys): Promise<Array<string>> {
  const out: Array<string> = [];
  let seq = 0;
  for (const frame of channel.sent.filter((f) => f.includes('"device_frame"'))) {
    const text = await openFrame(keys.to_device, ++seq, frame, "to_device");
    const message =
      text === undefined
        ? undefined
        : (JSON.parse(text) as { method?: string; params?: { status?: string } });
    out.push(
      message === undefined
        ? "unreadable"
        : message.method === "device.status"
          ? `status ${message.params?.status}`
          : (message.method ?? "reply"),
    );
  }
  return out;
}

test("a device removed on this screen gets nothing more to or from the server while its refusal waits in the relay socket (T8)", async () => {
  const phone = await testDevice("iPhone, Safari");
  const mac = await thisMacWith(phone);
  const keys = await hello(mac.channel, mac.sink, phone);
  await until(() => mac.server.served === 1, 10_000);

  mac.channel.backedUp = true;
  expect((await mac.remove(phone.device_id))._tag).toBe("Success");
  // The removed phone's next sealed frame, and an event the server had for it.
  const turn = JSON.stringify({
    jsonrpc: "2.0",
    id: 101,
    method: "turn.submit",
    params: { request_id: "r-1", session_id: "s-1", kind: "followup", input: { text: "rm -rf ~" } },
  });
  mac.sink.message(await sealFrame(keys.to_runtime, 1, turn, "to_runtime"));
  void mac.server.stream!.send(
    JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { text: "the chat" } }),
  );
  await quiet();

  expect({
    delivered: mac.server.delivered,
    serverClosed: mac.server.closed !== undefined,
    toPhone: await sealedToPhone(mac.channel, keys),
  }).toEqual({
    delivered: [],
    serverClosed: true,
    toPhone: ["status refused"],
  });
  // The phone hears why, then the stream ends.
  mac.channel.drain();
  await until(() => mac.channel.closedWith !== undefined, 10_000);
});

test("a stream that closes while its hello's approval waits in the relay socket is never served", async () => {
  const phone = await testDevice("iPhone, Safari");
  const mac = await thisMacWith(phone);
  await until(() => mac.channel.sent.some((f) => f.includes('"device.challenge"')), 10_000);

  mac.channel.backedUp = true;
  await hello(mac.channel, mac.sink, phone);
  await until(() => mac.channel.sent.some((f) => f.includes('"status":"approved"')), 10_000);
  mac.channel.close("the client left");
  mac.channel.drain();
  await quiet();

  expect(mac.server.served).toBe(0);
});

test("an approved device's sealed frames each way never hand Node a WebCrypto key it can't export (DEP0204)", async () => {
  // Node deprecates KeyObject.from on a non-extractable CryptoKey: a Node that removes it would break every remote
  // device's connection to This Mac.
  const from = vi.spyOn(KeyObject, "from");
  try {
    const phone = await testDevice("iPhone, Safari");
    const mac = await thisMacWith(phone);
    const keys = await hello(mac.channel, mac.sink, phone);
    await until(() => mac.server.served === 1, 10_000);
    const ask = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "workspace.list", params: {} });
    mac.sink.message(await sealFrame(keys.to_runtime, 1, ask, "to_runtime"));
    await until(() => mac.server.delivered.length === 1, 10_000);
    await mac.server.stream!.send(
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: { workspaces: [] } }),
    );

    expect({
      delivered: mac.server.delivered,
      toPhone: await sealedToPhone(mac.channel, keys),
    }).toEqual({ delivered: [ask], toPhone: ["reply"] });
    expect(
      from.mock.calls.filter(([key]) => !key.extractable).map(([key]) => key.algorithm.name),
    ).toEqual([]);
  } finally {
    from.mockRestore();
  }
});

test("a new device that leaves while its pending answer waits in the relay socket leaves no request timer holding its stream", async () => {
  const phone = await testDevice("iPhone, Safari");
  const tablet = await testDevice("iPad, Safari");
  const mac = await thisMacWith(phone);
  await until(() => mac.channel.sent.some((f) => f.includes('"device.challenge"')), 10_000);

  mac.channel.backedUp = true;
  await hello(mac.channel, mac.sink, tablet);
  await until(() => mac.channel.sent.some((f) => f.includes('"status":"pending"')), 10_000);
  mac.channel.close("the device left");
  // Only timers armed from here on are fake: the gate's own hello timer was real, and the stream's close cleared it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    mac.channel.drain();
    await quiet();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
