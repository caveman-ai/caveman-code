// The laptop's side of the direct path (direct.ts) with real node-datachannel on both ends over loopback: a relayed
// stream that offers a channel, the channel's send under load, its liveness, and where its STUN servers come from.
// The whole path (device gate, server, client switching) is direct.integration.test.ts.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { DIRECT_CHANNEL_LABEL, DirectReader, directPing } from "@caveman-app/session-protocol/direct-wire";
import ndc from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { afterEach, expect, test } from "vitest";

import { until } from "../session-protocol/testHarness.ts";
import { FALLBACK_STUN, HIGH_WATER, makeDirectPeers, type DirectPeersOptions, type Ndc, type NdcChannel, type NdcPeer } from "./direct.ts";
import type { RelayStream, StreamSink } from "./relay.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A device's offer over a stand-in relayed stream, the runtime's answer applied, and the channel open both ways. */
async function channelTo(options: Partial<DirectPeersOptions> = {}, offer: { ice_servers?: string[] } = {}) {
  const peers = makeDirectPeers({ log: () => undefined, iceServers: [], ...options });
  cleanups.push(() => peers.closeAll());
  const fromRuntime: Array<{ id?: unknown; method?: string; result?: { sdp: string }; params?: { candidate: string; mid: string } }> = [];
  const relayed: RelayStream = { send: async (data) => void fromRuntime.push(JSON.parse(String(data))), close: () => undefined };
  const inner: StreamSink = { message: () => undefined, closed: () => undefined };
  let channel: RelayStream | undefined;
  const state = { closed: undefined as string | undefined, frames: [] as string[] };
  const sink = peers.serve(relayed, inner, (opened) => {
    channel = opened;
    return { message: (text) => void state.frames.push(String(text)), closed: (reason) => void (state.closed = reason) };
  });

  const pc = new RTCPeerConnection({ iceServers: [] } as never);
  cleanups.push(() => pc.close());
  const dc = pc.createDataChannel("caveman.session.v1", { ordered: true });
  dc.binaryType = "arraybuffer";
  const reader = new DirectReader();
  const device = { frames: [] as string[], answerPings: true };
  dc.onmessage = (event: { data: string | ArrayBuffer }) => {
    const input = reader.read(event.data);
    if (input.kind === "frame") device.frames.push(input.text);
    else if (input.kind === "ping" && device.answerPings) dc.send(input.reply);
  };
  const opened = new Promise<void>((resolve) => (dc.onopen = () => resolve()));
  await pc.setLocalDescription(await pc.createOffer());
  await until(() => pc.iceGatheringState === "complete", 5_000);
  sink.message(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "direct.offer", params: { id: "attempt-1", sdp: pc.localDescription!.sdp, ...offer } }));
  await until(() => fromRuntime.some((m) => m.id === 1), 5_000);
  await pc.setRemoteDescription({ type: "answer", sdp: fromRuntime.find((m) => m.id === 1)!.result!.sdp });
  // The runtime's candidates, as the relay would bring them.
  let given = 0;
  const trickle = setInterval(() => {
    for (const m of fromRuntime.slice(given)) if (m.method === "direct.candidate") void pc.addIceCandidate({ candidate: m.params!.candidate, sdpMid: m.params!.mid });
    given = fromRuntime.length;
  }, 5);
  cleanups.push(() => clearInterval(trickle));
  await opened;
  await until(() => channel !== undefined, 5_000);
  return { peers, channel: channel!, state, device, dc };
}

test("a channel takes far more than the SCTP buffer at once: libdatachannel queues it, the runtime paces it, nothing ends", async () => {
  const { channel, state, device } = await channelTo();
  // A long chat's backlog going out at once: one 6 MiB frame (fragmented) and 60 frames of 100 KiB, not awaited.
  const big = JSON.stringify({ jsonrpc: "2.0", method: "session.events", params: { text: "b".repeat(6 * 1024 * 1024) } });
  const small = Array.from({ length: 60 }, (_, i) => JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { cursor: i, text: "s".repeat(100 * 1024) } }));
  const sent = [channel.send(big), ...small.map((frame) => channel.send(frame))];
  const total = big.length + small.reduce((n, f) => n + f.length, 0);
  expect(total).toBeGreaterThan(4 * HIGH_WATER);
  await Promise.all(sent);
  await until(() => device.frames.length === 61, 30_000);
  expect(state.closed).toBeUndefined();
  expect(device.frames[0]).toBe(big);
  expect(device.frames.slice(1)).toEqual(small);
}, 60_000);

test("a device that stops answering is let go within the silence window; one that answers stays", async () => {
  const { state, device } = await channelTo({ pingMs: 100, silenceMs: 600 });
  // Quiet but alive: the runtime's pings are answered, so the channel stays.
  await new Promise((r) => setTimeout(r, 1_200));
  expect(state.closed).toBeUndefined();
  // The phone vanishes (no pong, nothing else): its attachments end with the channel.
  device.answerPings = false;
  const at = Date.now();
  await until(() => state.closed !== undefined, 3_000);
  expect(state.closed).toBe("the device stopped answering on the direct channel");
  expect(Date.now() - at).toBeLessThan(1_500);
});

test("a ping that comes after the device closed the channel ends the channel, never the runtime", async () => {
  // node-datachannel once the channel is closed: every send throws, and a throw out of its callback aborts the process.
  const closedError = () => {
    throw new Error("libdatachannel error while sending data channel message: DataChannel is closed");
  };
  let deliver: ((message: string | Buffer | ArrayBuffer) => void) | undefined;
  const channel: NdcChannel = {
    getLabel: () => DIRECT_CHANNEL_LABEL,
    sendMessage: closedError,
    sendMessageBinary: closedError,
    bufferedAmount: () => 0,
    maxMessageSize: () => 65_536,
    setBufferedAmountLowThreshold: () => undefined,
    onBufferedAmountLow: () => undefined,
    onMessage: (cb) => void (deliver = cb),
    onClosed: () => undefined,
    onError: () => undefined,
    close: () => undefined,
  };
  let opened: ((channel: NdcChannel) => void) | undefined;
  class Peer implements NdcPeer {
    #answer: ((sdp: string, type: string) => void) | undefined;
    setRemoteDescription() {
      queueMicrotask(() => this.#answer?.("v=0 answer", "answer"));
    }
    addRemoteCandidate() {}
    onLocalDescription(cb: (sdp: string, type: string) => void) {
      this.#answer = cb;
    }
    onLocalCandidate() {}
    onStateChange() {}
    onDataChannel(cb: (channel: NdcChannel) => void) {
      opened = cb;
    }
    close() {}
  }
  const peers = makeDirectPeers({ log: () => undefined, iceServers: [], load: async () => ({ PeerConnection: Peer }) });
  cleanups.push(() => peers.closeAll());
  const replies: unknown[] = [];
  let closed: string | undefined;
  const sink = peers.serve({ send: async (d) => void replies.push(d), close: () => undefined }, { message: () => undefined, closed: () => undefined }, () => ({ message: () => undefined, closed: (reason) => void (closed = reason) }));
  sink.message(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "direct.offer", params: { id: "attempt-1", sdp: "v=0 offer" } }));
  await until(() => replies.length > 0, 5_000);
  opened!(channel);
  expect(() => deliver!(Buffer.from(directPing(1234)))).not.toThrow();
  expect(closed).toBe("the direct channel failed");
  expect(peers.count()).toBe(0);
});

// The same with real node-datachannel, in a child process (an abort would take the test worker with it). A device on
// loopback opens the channel, pings and closes it while the runtime's event loop is busy (a turn streaming), so
// libdatachannel has the channel closed before the ping reaches onMessage.
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const pingThenClose = `
const root = ${JSON.stringify(repoRoot)};
const { makeDirectPeers } = await import(root + "/packages/runtime/src/cloudLink/direct.ts");
const { DIRECT_CHANNEL_LABEL, directPing } = await import(root + "/packages/session-protocol/src/directWire.ts");
const { createRequire } = await import("node:module");
const ndc = createRequire(root + "/packages/runtime/package.json")("node-datachannel");
const until = async (f, ms) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };
const peers = makeDirectPeers({ log: () => undefined, iceServers: [] });
const fromRuntime = [];
let served = false;
let ended;
const sink = peers.serve({ send: async (d) => void fromRuntime.push(JSON.parse(String(d))), close: () => undefined }, { message() {}, closed() {} }, () => { served = true; return { message() {}, closed(reason) { ended = reason; } }; });
const device = new ndc.PeerConnection("device", { iceServers: [] });
let gathered = false;
device.onGatheringStateChange((state) => { if (state === "complete") gathered = true; });
const dc = device.createDataChannel(DIRECT_CHANNEL_LABEL);
let open = false;
dc.onOpen(() => (open = true));
await until(() => gathered, 15000);
sink.message(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "direct.offer", params: { id: "attempt-1", sdp: device.localDescription().sdp } }));
await until(() => fromRuntime.some((m) => m.id === 1), 15000);
device.setRemoteDescription(fromRuntime.find((m) => m.id === 1).result.sdp, "answer");
let given = 0;
const trickle = setInterval(() => { for (const m of fromRuntime.slice(given)) if (m.method === "direct.candidate") device.addRemoteCandidate(m.params.candidate, m.params.mid); given = fromRuntime.length; }, 5);
await until(() => open && served, 30000);
clearInterval(trickle);
dc.sendMessageBinary(directPing(performance.now()));
dc.close();
const busyUntil = Date.now() + 50;
while (Date.now() < busyUntil) {}
await until(() => ended !== undefined, 15000);
console.log("ALIVE, the channel ended");
device.close();
process.exit(0);
`;

test("the runtime survives a device that pings and closes the direct channel while it is busy (real node-datachannel)", () => {
  // A busy runner gathers and connects on loopback slowly: the child's waits allow for it, and its stderr says which ran out.
  const run = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", pingThenClose], { cwd: path.join(repoRoot, "packages/runtime"), encoding: "utf8", timeout: 90_000 });
  const crash = run.stderr.split("\n").find((line) => line.includes("terminating")) ?? null;
  expect({ status: run.status, signal: run.signal, crash, stdout: run.stdout.trim() }, run.stderr.slice(-2000)).toEqual({ status: 0, signal: null, crash: null, stdout: "ALIVE, the channel ended" });
}, 100_000);

test("the runtime's STUN servers: this computer's setting, else the install's list from the offer (STUN only), else Google's", async () => {
  const configs: Array<{ iceServers: Array<string> }> = [];
  const spying: DirectPeersOptions["load"] = async () =>
    ({
      PeerConnection: class extends ndc.PeerConnection {
        constructor(name: string, config: { iceServers: Array<string> }) {
          configs.push(config);
          super(name, config);
        }
      },
    }) as unknown as Ndc;
  const offerWith = async (options: Partial<DirectPeersOptions>, offer: { ice_servers?: string[] }) => {
    const peers = makeDirectPeers({ log: () => undefined, load: spying, ...options });
    cleanups.push(() => peers.closeAll());
    const replies: unknown[] = [];
    const sink = peers.serve({ send: async (d) => void replies.push(d), close: () => undefined }, { message: () => undefined, closed: () => undefined }, () => ({ message: () => undefined, closed: () => undefined }));
    const pc = new RTCPeerConnection({ iceServers: [] } as never);
    cleanups.push(() => pc.close());
    pc.createDataChannel("caveman.session.v1");
    await pc.setLocalDescription(await pc.createOffer());
    sink.message(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "direct.offer", params: { id: "a", sdp: pc.localDescription!.sdp, ...offer } }));
    await until(() => configs.length > 0 && replies.length > 0, 5_000);
    return configs.splice(0)[0]!.iceServers;
  };
  expect(await offerWith({}, { ice_servers: ["stun:stun.example.test:3478", "turn:relay.example.test:3478", "stun:user:pw@x"] })).toEqual(["stun:stun.example.test:3478"]);
  expect(await offerWith({}, { ice_servers: [] })).toEqual([]);
  expect(await offerWith({}, {})).toEqual(FALLBACK_STUN);
  expect(await offerWith({ iceServers: ["stun:local.example.test:3478"] }, { ice_servers: ["stun:stun.example.test:3478"] })).toEqual(["stun:local.example.test:3478"]);
});
