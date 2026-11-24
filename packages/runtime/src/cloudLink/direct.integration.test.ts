// The direct path end to end (DESIGN S14): a runtime on This Mac linked to the test Cloud with Remote control on, a
// device the Mac allowed (S13), and the real client (session-protocol direct.ts) reaching it through a stand-in for the
// relay's client side, then over a real WebRTC data channel (node-datachannel on both ends, two peers on loopback,
// no STUN). Cloud, and a stolen Cloud session, are played by writing to relay streams directly.
import * as path from "node:path";

import { connect, deviceHandshake, type SessionEvent } from "@caveman-app/session-protocol";
import { connectDirect, type DirectClient, type DirectOptions, type DirectPath, type RtcPeerConstructor } from "@caveman-app/session-protocol/direct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { afterEach, expect, test } from "vitest";

import { allowedStream, challengeOf, relayBridge, replyTo, sayHello, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { enroll } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reasonIn = (reply: { error?: unknown }) => (reply.error as { data?: { reason?: string } } | undefined)?.data?.reason;
const reasonOf = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason ?? String(error));

/** This Mac, enrolled in the test Cloud with Remote control on, a chat on it, and the relay's side of its link. */
async function thisMac(provide?: Layer.Layer<any, never, any>) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude", undefined, provide ? { provide } : {});
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const relay = cloud.state.relays[0]!;
  const repo = makeRepo(tempRoot("direct-repo-"), { "README.md": "hello\n" });
  const workspace = await createReady(local, { request_id: "w0", repo: { path: repo }, title: "On the Mac", engine: "claude-agent", options: { model: MODEL } });
  const bridge = await relayBridge(relay);
  cleanups.push(bridge.close);
  return { cloud, runtime, local, relay, workspace, bridge };
}

/** The platform's RTCPeerConnection (node-datachannel's here), keeping each one made so a test can cut it. */
function rtc(tamper?: (sdp: string) => string) {
  const peers: RTCPeerConnection[] = [];
  /** Each local SDP as the platform made it, before `tamper`. */
  const offered: string[] = [];
  /** Each answer as it arrived: a refused channel closes its peer a few milliseconds after, when it no longer has one. */
  const answers: string[] = [];
  class Rtc extends RTCPeerConnection {
    constructor(config: ConstructorParameters<typeof RTCPeerConnection>[0]) {
      super(config);
      peers.push(this);
    }
    override setRemoteDescription(description: Parameters<RTCPeerConnection["setRemoteDescription"]>[0]) {
      if (description?.sdp) answers.push(description.sdp);
      return super.setRemoteDescription(description);
    }
    override get localDescription() {
      const description = super.localDescription;
      if (description?.sdp) offered.push(description.sdp);
      return tamper && description ? ({ type: description.type, sdp: tamper(description.sdp) } as typeof description) : description;
    }
  }
  return { Rtc: Rtc as unknown as RtcPeerConstructor, peers, offered, answers };
}

/** A device's client to This Mac: the relay through the bridge, and a direct path when the Mac answers. */
function device(
  mac: Awaited<ReturnType<typeof thisMac>>,
  phone: Awaited<ReturnType<typeof testDevice>>,
  options: { tamper?: (sdp: string) => string; openTimeoutMs?: number; retryMs?: number } & Pick<DirectOptions, "enabled" | "network"> = {},
) {
  const { Rtc, peers, offered, answers } = rtc(options.tamper);
  const paths: DirectPath[] = [];
  const statuses: string[] = [];
  const client = connectDirect(mac.bridge.url, "", undefined, {
    handshake: deviceHandshake({ device: phone, kind: () => "laptop", onStatus: (s) => statuses.push(s.status) }),
    direct: {
      rtc: Rtc,
      iceServers: [],
      retryMs: () => options.retryMs ?? 300,
      network: options.network ?? (() => () => undefined),
      onPath: (p) => paths.push(p),
      ...(options.enabled ? { enabled: options.enabled } : {}),
      ...(options.openTimeoutMs ? { openTimeoutMs: options.openTimeoutMs } : {}),
    },
  });
  cleanups.push(() => client.close());
  return { client, peers, paths, statuses, offered, answers };
}

const typesOf = (events: ReadonlyArray<SessionEvent>) => events.map((e) => `${e.cursor}:${e.type}`);

test("an allowed device gets a direct channel to This Mac; a turn streams over it, a cut mid-turn falls back to the relay with nothing lost or twice, and it comes back", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(mac.relay, mac.local, phone);
  // The next try waits past the turn's held end, so that end comes over the relay.
  const { client, peers, paths, statuses } = device(mac, phone, { retryMs: 5_000 });

  await until(() => client.path() === "direct", 20_000);
  // The channel ran the device check of its own: "approved" once for the relay and once for the channel.
  expect(statuses).toEqual(["approved", "approved"]);
  // The signaling crossed the relay sealed both ways: Cloud saw no SDP, fingerprint or candidate in clear.
  const relayText = mac.relay.frames.filter((f) => f.id.equals(mac.bridge.streams[0]!)).map((f) => f.payload.toString("utf8")).join("\n");
  const sentText = mac.bridge.fromClient.map((f) => f.text).join("\n");
  for (const text of [relayText, sentText]) {
    expect(text).not.toContain("a=fingerprint");
    expect(text).not.toContain("candidate:");
  }

  const seen: SessionEvent[] = [];
  /** The path each event was delivered on. */
  const via: string[] = [];
  const sub = await client.attach(mac.workspace.session_id, 0, (event) => (seen.push(event), via.push(client.path())));
  // A turn that holds its end for 3 s after the answer: the cut lands between the two.
  const turn = { request_id: "t1", session_id: mac.workspace.session_id, kind: "followup" as const, input: { text: "slow 3000: over the direct path" } };
  const started = (await client.call("turn.submit", turn)) as { turn_id: string };
  await until(() => seen.some((e) => e.type === "message.done" && (e.payload as { role?: string }).role === "assistant"), 30_000);
  expect(seen.some((e) => e.type === "turn.done")).toBe(false);
  // So far every event came over the channel.
  expect(new Set(via)).toEqual(new Set(["direct"]));
  const cutAt = seen.length;
  peers[0]!.close();
  await until(() => client.path() === "relay", 10_000);
  // The same principal on both paths: the relay answers the channel's call from its receipt, without running it again.
  expect(await client.call("turn.submit", turn)).toEqual(started);
  await until(() => seen.some((e) => e.type === "turn.done"), 30_000);
  const done = seen.findIndex((e) => e.type === "turn.done");
  expect(done).toBeGreaterThanOrEqual(cutAt);
  // The turn's end came over the relay.
  expect(via[done]).toBe("relay");

  // Back on the channel for the next turn.
  await until(() => client.path() === "direct", 20_000);
  await client.call("turn.submit", { request_id: "t2", session_id: mac.workspace.session_id, kind: "followup", input: { text: "and again" } });
  await until(() => seen.filter((e) => e.type === "turn.done").length === 2, 30_000);
  expect(paths).toEqual(["direct", "relay", "direct"]);

  // A send still in flight when the channel dies: answered once (the relay takes it over), and run once.
  const inflight = client.call("turn.submit", { request_id: "t3", session_id: mac.workspace.session_id, kind: "followup", input: { text: "cut while sending" } });
  peers.at(-1)!.close();
  await expect(inflight).resolves.toMatchObject({ turn_id: expect.any(String) });
  await until(() => seen.filter((e) => e.type === "turn.done").length === 3, 30_000);
  await new Promise((r) => setTimeout(r, 1_000));
  expect(seen.filter((e) => e.type === "turn.done")).toHaveLength(3);
  expect(paths.slice(0, 4)).toEqual(["direct", "relay", "direct", "relay"]);

  // Every event once, in order, as the journal has them.
  const journal: SessionEvent[] = [];
  const check = await mac.local.attach(mac.workspace.session_id, 0, (event) => journal.push(event));
  await until(() => journal.length >= seen.length);
  expect(seen.map((e) => e.cursor)).toEqual(Array.from({ length: seen.length }, (_, i) => i + 1));
  expect(typesOf(seen)).toEqual(typesOf(journal.slice(0, seen.length)));
  expect(sub.cursor()).toBe(seen.length);
  await check.detach();
}, 180_000);

/** upstream terminal manager stand-in: what the test prints goes through the runtime's terminal routes as a shell's output would. */
function terminals() {
  const opened: Array<{ terminalId: string; threadId: string }> = [];
  const listeners = new Set<(event: never) => Effect.Effect<void>>();
  const layer = Layer.mock(TerminalManager.TerminalManager)({
    open: (input) => Effect.sync(() => (opened.push({ terminalId: input.terminalId!, threadId: input.threadId }), {} as never)),
    write: () => Effect.void,
    close: () => Effect.void,
    subscribe: (listener) => Effect.sync(() => (listeners.add(listener as never), () => listeners.delete(listener as never))),
    observeStream: (_input, listener) => listener({ type: "snapshot", snapshot: { history: "" } } as never).pipe(Effect.as(() => undefined)),
  });
  const print = (data: string) => {
    const { terminalId, threadId } = opened.at(-1)!;
    return Promise.all([...listeners].map((l) => Effect.runPromise(l({ type: "output", threadId, terminalId, data } as never))));
  };
  return { layer, print };
}

test("a terminal opened over the relay before the channel came up prints once after the switch, while the chat follows the channel", async () => {
  const shell = terminals();
  const mac = await thisMac(shell.layer);
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(mac.relay, mac.local, phone);
  let allow = false;
  let changed: (online: boolean) => void = () => undefined;
  const { client } = device(mac, phone, { enabled: () => allow, network: (c) => ((changed = c), () => undefined) });
  const printed: string[] = [];
  client.on("term.output", (p) => printed.push(p.data));
  // The chat and its terminal tab, both on the relay through the same client.
  const seen: SessionEvent[] = [];
  await client.attach(mac.workspace.session_id, 0, (event) => seen.push(event));
  const { terminal_id } = await client.call("term.open", { request_id: "o1", workspace_id: mac.workspace.id, cols: 80, rows: 24 });
  await client.call("term.attach", { terminal_id });
  allow = true;
  changed(true);
  await until(() => client.path() === "direct", 20_000);
  // The chat's subscription has moved to the channel once a new event reaches it there.
  await client.call("turn.submit", { request_id: "t1", session_id: mac.workspace.session_id, kind: "followup", input: { text: "after the switch" } });
  await until(() => seen.some((e) => e.type === "turn.done"), 30_000);
  await shell.print("$ ls\r\n");
  await until(() => printed.join("").includes("$ ls"), 10_000);
  await new Promise((r) => setTimeout(r, 1_000));
  // The runtime sends it to the relay's connection, which opened the terminal, and to the channel's, on its chat.
  expect(printed.join("")).toBe("$ ls\r\n");
}, 120_000);

test("a stolen Cloud session or a device the Mac has not allowed gets no offer answered; removing a device ends its channel", async () => {
  const mac = await thisMac();
  const offer = async () => {
    const pc = new RTCPeerConnection({ iceServers: [] } as never);
    cleanups.push(() => pc.close());
    pc.createDataChannel("caveman.session.v1");
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription!.sdp;
  };
  const sdp = await offer();

  // Cloud opens a stream of its own: challenged, and its offer refused like any other call.
  const stolen = mac.relay.open();
  await challengeOf(mac.relay, stolen);
  mac.relay.send(stolen, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "direct.offer", params: { id: "a1", sdp } }));
  expect(reasonIn(await replyTo(mac.relay, stolen, 1))).toBe("device_not_approved");

  // A device waiting for the Mac's answer: the same.
  const pending = mac.relay.open();
  const waiting = await testDevice("Unknown phone");
  expect((await sayHello(mac.relay, pending, waiting)).reply.result).toMatchObject({ status: "pending" });
  mac.relay.send(pending, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "direct.offer", params: { id: "a2", sdp } }));
  expect(reasonIn(await replyTo(mac.relay, pending, 2))).toBe("device_not_approved");
  // No answer and no candidate went to either.
  for (const stream of [stolen, pending]) {
    const replies = mac.relay.replies(stream);
    expect(replies.some((r) => r.method === "direct.candidate" || (r.result as { sdp?: string } | undefined)?.sdp !== undefined)).toBe(false);
  }

  // An allowed device on the direct path; the Mac removes it: the channel and the relay stream both end.
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(mac.relay, mac.local, phone);
  const { client } = device(mac, phone);
  await until(() => client.path() === "direct", 20_000);
  await mac.local.call("device.remove", { request_id: "rm", device_id: phone.device_id });
  await until(() => client.path() === "relay", 10_000);
  expect(await reasonOf(client.call("workspace.list", {}))).toBe("device_not_approved");
}, 180_000);

test("a channel whose DTLS certificate is not the one the approved offer named never opens", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(mac.relay, mac.local, phone);
  // The offer names another certificate than the one the device's DTLS will present (a relay swapping it would).
  const swap = (sdp: string) => sdp.replace(/a=fingerprint:sha-256 ([0-9A-F:]+)/i, (_line, hex: string) => `a=fingerprint:sha-256 ${hex.split(":").reverse().join(":")}`);
  const { client, peers, offered, answers } = device(mac, phone, { tamper: swap, openTimeoutMs: 4_000 });
  await until(() => peers.length >= 1, 10_000);
  // The runtime took the offer and answered it: the refusal is DTLS's, against the fingerprint signaling named. Read
  // from the answers as they came: DTLS refuses within milliseconds, and the closed peer holds no description.
  await until(() => answers.some((sdp) => sdp.includes("a=fingerprint")), 10_000);
  expect(offered[0]).toContain("a=fingerprint:sha-256 ");
  expect(swap(offered[0]!)).not.toBe(offered[0]);
  await new Promise((r) => setTimeout(r, 5_000));
  expect(client.path()).toBe("relay");
  expect(peers.every((pc) => pc.connectionState !== "connected" || pc.sctp === null)).toBe(true);
  // The relay still serves it.
  expect((await client.call("workspace.list", {})).workspaces.map((w) => w.id)).toContain(mac.workspace.id);
}, 120_000);

test("a Cloud computer's runtime refuses direct.offer; a device on it stays on the relay", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("direct-computer-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const checkout = makeRepo(tempRoot("direct-computer-"), { "README.md": "hello\n" });
  const config = await makeConfig();
  const provide = Layer.mergeAll(
    Layer.succeed(CloudComputer, { linkDir, computerId: identity.computerId, workspaceRoot: checkout }),
    Layer.succeed(CloudLinkState, {}),
  ) as unknown as Layer.Layer<any>;
  const runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const relay = cloud.state.relays[0]!;

  const stream = relay.open();
  relay.send(stream, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "direct.offer", params: { id: "c1", sdp: "v=0" } }));
  const reply = await replyTo(relay, stream, 1);
  expect(reasonIn(reply)).toBe("unsupported");

  const bridge = await relayBridge(relay);
  cleanups.push(bridge.close);
  const { Rtc, peers } = rtc();
  const client: DirectClient = connectDirect(bridge.url, "", undefined, { direct: { rtc: Rtc, iceServers: [], retryMs: () => 100, network: () => () => undefined } });
  cleanups.push(() => client.close());
  await client.call("workspace.list", {});
  await new Promise((r) => setTimeout(r, 1_000));
  // Asked once, refused, not asked again.
  expect(peers).toHaveLength(1);
  expect(client.path()).toBe("relay");
}, 120_000);
