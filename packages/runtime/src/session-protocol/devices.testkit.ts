// Test helpers for device approval (devices.ts): a device key in Node's WebCrypto, the handshake done by hand on a
// raw relay stream (so a test can also do it wrong, as an attacker would), sealed calls on it, and a bridge that lets
// the real Session Protocol client reach the runtime through the test Cloud's relay.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  allowStatementFor,
  channelKeys,
  ephemeralKey,
  helloPayload,
  newDeviceKeyPair,
  openFrame,
  pairProof,
  removeStatementFor,
  sealFrame,
  toBase64url,
  webCryptoDeviceKey,
  type Client,
  type DeviceKey,
  type DeviceKind,
  type ChannelKeys,
} from "@caveman-app/session-protocol";
import { WebSocketServer } from "ws";

import type { RelaySide } from "../cloudLink/testCloud.ts";
import { until } from "./testHarness.ts";

/** A device key; `kind` "mac" stands for a Mac's desktop key (the keychain-sealed one, in software here). */
export const testDevice = async (name = "Test phone", kind?: DeviceKind): Promise<DeviceKey> => {
  const pair = await newDeviceKeyPair();
  return webCryptoDeviceKey({ ...pair, name, ...(kind ? { kind } : {}) });
};

export type Reply = ReturnType<RelaySide["replies"]>[number];

/** Any connection to the runtime a test drives by hand: frames out, and every text frame that came back, parsed. */
export interface Wire {
  send(text: string): void;
  replies(): ReadonlyArray<Reply>;
}
export const relayWire = (relay: RelaySide, stream: Buffer): Wire => ({ send: (text) => relay.send(stream, text), replies: () => relay.replies(stream) });

export interface Challenge {
  readonly nonce: string;
  readonly runtime_id: string;
  readonly key: string;
  readonly runtime_name: string;
  readonly hello?: number;
}

/** The runtime's first frame on a connection to This Mac through the relay. */
export async function challengeOn(wire: Wire): Promise<Challenge> {
  await until(() => wire.replies().some((r) => r.method === "device.challenge"), 10_000);
  return wire.replies().find((r) => r.method === "device.challenge")!.params as Challenge;
}
export const challengeOf = (relay: RelaySide, stream: Buffer) => challengeOn(relayWire(relay, stream));

/** The reply to `id`, once it came. */
export async function replyOn(wire: Wire, id: unknown, ms = 30_000): Promise<Reply> {
  await until(() => wire.replies().some((r) => r.id === id && r.method === undefined), ms);
  return wire.replies().find((r) => r.id === id && r.method === undefined)!;
}
export const replyTo = (relay: RelaySide, stream: Buffer, id: unknown, ms?: number) => replyOn(relayWire(relay, stream), id, ms);

/** Whether the runtime closed `stream` (a relay close frame). */
export const streamClosed = (relay: RelaySide, stream: Buffer) => relay.frames.some((f) => f.type === 4 && f.id.equals(stream));

export interface HelloOptions {
  /** Sign for this runtime instead of the challenge's. */
  readonly runtimeId?: string;
  /** Claim this device id instead of the key's. */
  readonly deviceId?: string;
  /** Answer v1 even when the challenge offers v2 (an older device, or an offer the relay stripped). */
  readonly v1?: boolean;
  /** Say this kind or name in the frame instead of the ones signed (a relay that changed them). */
  readonly kind?: string;
  readonly name?: string;
  /** The code This Mac's screen showed (device.pair.start), proved over this hello: a Mac's desktop app joining it. */
  readonly pair?: string;
  /** Say this proof instead (a guess, or one made for another hello). */
  readonly proof?: string;
  /**
   * A relay that held this device's hello back and sends it as its own: the same signed bytes and the same proof (made
   * for `device`), under this key's id, public key and signature over those bytes.
   */
  readonly swapKey?: DeviceKey;
}

/**
 * device.hello by hand: signs for `runtime_id` (default: the challenge's) over the challenge's nonce. Returns the
 * hello as sent (to replay it) and the frame key a real device would hold.
 */
export async function helloOn(wire: Wire, device: DeviceKey, options: HelloOptions = {}) {
  const challenge = await challengeOn(wire);
  const ephemeral = await ephemeralKey();
  const runtime_id = options.runtimeId ?? challenge.runtime_id;
  const v2 = challenge.hello === 2 && !options.v1 ? { kind: device.kind ?? ("device" as const), name: device.name } : undefined;
  const payload = helloPayload({ runtime_id, nonce: challenge.nonce, runtime_key: challenge.key, device_key: ephemeral.public_key, ...(v2 ? { v2 } : {}) });
  const signer = options.swapKey ?? device;
  const signature = await signer.sign(payload);
  const pair = options.proof ?? (options.pair === undefined ? undefined : await pairProof(options.pair, device.device_id, payload));
  const keys = await channelKeys({ privateKey: ephemeral.privateKey, peer_key: challenge.key, runtime_id: challenge.runtime_id, nonce: challenge.nonce, runtime_key: challenge.key, device_key: ephemeral.public_key });
  const hello = JSON.stringify({
    jsonrpc: "2.0",
    id: "device.hello",
    method: "device.hello",
    params: {
      device_id: options.deviceId ?? signer.device_id,
      name: options.name ?? device.name,
      public_key: signer.public_key,
      key: ephemeral.public_key,
      signature: toBase64url(signature),
      ...(v2 ? { kind: options.kind ?? v2.kind } : {}),
      ...(pair === undefined ? {} : { pair }),
    },
  });
  wire.send(hello);
  return { reply: await replyOn(wire, "device.hello"), hello, keys, challenge };
}
export const sayHello = (relay: RelaySide, stream: Buffer, device: DeviceKey, options?: HelloOptions) => helloOn(relayWire(relay, stream), device, options);

/**
 * Sealed JSON-RPC calls on an approved connection, numbered from 1, and the runtime's frames opened in order. A frame
 * that does not open where it stands sets `broken` (a real device drops the socket then).
 */
export function sealedOn(wire: Wire, keys: ChannelKeys) {
  let seq = 0;
  let id = 1_000;
  const sent: Array<string> = [];
  const opened: Array<Reply> = [];
  let readSeq = 0;
  let readIndex = 0;
  let broken = false;
  let reading: Promise<void> = Promise.resolve();
  const read = () =>
    (reading = reading.then(async () => {
      const all = wire.replies();
      while (readIndex < all.length && !broken) {
        const frame = all[readIndex++] as { device_frame?: unknown };
        if (frame?.device_frame === undefined) continue;
        const text = await openFrame(keys.to_device, readSeq + 1, JSON.stringify(frame), "to_device");
        if (text === undefined) broken = true;
        else {
          readSeq++;
          opened.push(JSON.parse(text) as Reply);
        }
      }
    }));
  return {
    sent,
    broken: () => broken,
    /** Every frame the runtime sealed so far, opened. */
    async opened(): Promise<ReadonlyArray<Reply>> {
      await read();
      return opened;
    },
    /** Sends one call sealed; resolves with its reply. */
    async call(method: string, params: unknown): Promise<Reply> {
      const callId = id++;
      const frame = await sealFrame(keys.to_runtime, ++seq, JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }), "to_runtime");
      sent.push(frame);
      wire.send(frame);
      await until(async () => (await read(), opened.some((r) => r.id === callId && r.method === undefined)), 30_000);
      return opened.find((r) => r.id === callId && r.method === undefined)!;
    },
  };
}

type Local = Pick<Client, "call">;

/**
 * This Mac's screen signs its Allow of a waiting device with `signer` (its desktop key), for the person's other Macs:
 * the device as it asked (device.list's request) and the person device.list names, as the app's Allow button does.
 */
export async function allowStatement(local: Local, signer: DeviceKey, deviceId: string) {
  const list = await local.call("device.list", {});
  const request = list.requests.find((r) => r.device_id === deviceId);
  const statement = request && (await allowStatementFor(signer, list.family, request));
  if (!statement) throw new Error(`nothing to sign for ${deviceId}: ${JSON.stringify(list)}`);
  return statement;
}

/** The same for a removal, as the app's Remove button signs it. */
export async function removeStatement(local: Local, signer: DeviceKey, deviceId: string) {
  const statement = await removeStatementFor(signer, (await local.call("device.list", {})).family, deviceId);
  if (!statement) throw new Error("this Mac shares no approvals");
  return statement;
}

/** This Mac's screen shows a new code another of the person's Macs joins it with (Add a Mac, decision 31). */
export const pairingCodeOn = async (local: Local) => (await local.call("device.pair.start", { request_id: `pair-${crypto.randomUUID()}` })).code;

/**
 * A device This Mac allowed, on any connection: hello, the local client's device.allow of the kind the screen showed
 * (signed for the person's other Macs when `signer`, this Mac's desktop key, is given), then sealed calls. One already
 * allowed through another Mac is approved at its hello. `hello`: how the device says hello (a v1 one, as an older app).
 * A Mac's desktop key joins with the code this screen shows (decision 31), unless `pair` is false: without it, it asks
 * as a device.
 */
export async function allowedOn(wire: Wire, local: Local, device?: DeviceKey, options: { readonly signer?: DeviceKey; readonly hello?: HelloOptions; readonly pair?: boolean } = {}) {
  const own = device ?? (await testDevice());
  const pair = (options.pair ?? (own.kind === "mac" && !options.hello?.v1)) ? await pairingCodeOn(local) : undefined;
  const { reply, keys } = await helloOn(wire, own, { ...options.hello, ...(pair === undefined ? {} : { pair }) });
  const status = (reply.result as { status?: string } | undefined)?.status;
  if (status === "pending") {
    const request = (await local.call("device.list", {})).requests.find((r) => r.device_id === own.device_id);
    const statement = options.signer ? await allowStatement(local, options.signer, own.device_id) : undefined;
    await local.call("device.allow", { request_id: `allow-${own.device_id}-${Date.now()}`, device_id: own.device_id, role: request?.role ?? "device", ...(statement ? { statement } : {}) });
    await until(() => wire.replies().some((r) => r.method === "device.status" && (r.params as { status: string }).status === "approved"), 10_000);
  } else if (status !== "approved") throw new Error(`device.hello answered ${JSON.stringify(reply)}`);
  return { device: own, keys, ...sealedOn(wire, keys) };
}

/** The same on a raw relay stream. */
export async function allowedStream(relay: RelaySide, local: Local, device?: DeviceKey, stream: Buffer = relay.open(), options: { readonly signer?: DeviceKey; readonly hello?: HelloOptions; readonly pair?: boolean } = {}) {
  return { stream, ...(await allowedOn(relayWire(relay, stream), local, device, options)) };
}

/**
 * A WebSocket server standing in for the relay's client side: each client socket becomes one stream on `relay`,
 * frames pass both ways, and a stream the runtime closes closes the socket. `fromClient` records what clients sent.
 */
export async function relayBridge(relay: RelaySide) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, handleProtocols: (protocols) => (protocols.has("caveman.session.v1") ? "caveman.session.v1" : false) });
  const fromClient: Array<{ stream: Buffer; text: string }> = [];
  const toClient: Array<{ stream: Buffer; text: string }> = [];
  const streams: Array<Buffer> = [];
  const sockets: Array<import("ws").WebSocket> = [];
  /** Playing a hostile relay: rewrite a frame on its way to the client (return it unchanged to pass it). */
  const hostile: { tamper?: (text: string) => string; holdFirstMs?: number } = {};
  wss.on("connection", (socket) => {
    const stream = relay.open();
    streams.push(stream);
    sockets.push(socket);
    // A slow relay: the first connection's frames to the client wait this long (a laptop's challenge arrives late).
    const holdUntil = streams.length === 1 && hostile.holdFirstMs ? Date.now() + hostile.holdFirstMs : 0;
    const deliver = (text: string) => {
      const wait = holdUntil - Date.now();
      if (wait > 0) return void setTimeout(() => socket.readyState === socket.OPEN && socket.send(text), wait);
      socket.send(text);
    };
    const onFrame = (data: Buffer) => {
      const type = data[0];
      if (!data.subarray(1, 17).equals(stream)) return;
      if (type === 2) {
        const text = data.subarray(17).toString("utf8");
        toClient.push({ stream, text });
        deliver(hostile.tamper ? hostile.tamper(text) : text);
      }
      else if (type === 4) socket.close(1000, data.subarray(17).toString("utf8"));
    };
    relay.ws.on("message", onFrame);
    socket.on("message", (data) => {
      const text = data.toString("utf8");
      fromClient.push({ stream, text });
      relay.send(stream, text);
    });
    socket.on("close", () => {
      relay.ws.off("message", onFrame);
      relay.close(stream, "the client left");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/`,
    fromClient,
    toClient,
    streams,
    hostile,
    /** Sends a frame of the relay's own to the newest client socket, as if the runtime sent it. */
    inject: (text: string) => sockets.at(-1)?.send(text),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
