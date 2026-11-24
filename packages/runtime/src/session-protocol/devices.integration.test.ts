// Device approval end to end (DESIGN S13): a runtime on This Mac linked to the test Cloud, relayed streams opened on
// the relay's side as Cloud would, and the real Session Protocol client reaching the runtime through a stand-in for
// the relay's client side. Cloud (and a stolen Cloud session) is played by writing to relay streams directly.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, deviceCode, deviceHandshake, helloPayload, newDeviceKeyPair, remoteControlOn, sealFrame, signCall, signStatement, verifyPairAnswer, webCryptoDeviceKey, type DeviceList } from "@caveman-app/session-protocol";
import * as Layer from "effect/Layer";
import { afterEach, expect, test, vi } from "vitest";

import { enroll } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState } from "../cloudLink/index.ts";
import { startTestCloud } from "../cloudLink/testCloud.ts";
import { DRIVE_WINDOW_MS, DevicesClock, MAX_STATEMENTS } from "./devices.ts";
import { allowStatement, allowedStream, challengeOf, pairingCodeOn, relayBridge, relayWire, removeStatement, replyTo, sayHello, sealedOn, streamClosed, testDevice } from "./devices.testkit.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const reasonOf = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason ?? String(error));
const reasonIn = (reply: { error?: unknown }) => (reply.error as { data?: { reason?: string } } | undefined)?.data?.reason;

/**
 * This Mac, enrolled in the test Cloud with Remote control on, and the relay's side of its link. `names` false: as a
 * Cloud that does not name the enrolling person (an enrollment from before it did), so the Mac has no owner among them.
 */
async function thisMac(options: { readonly clock?: { now: number }; readonly names?: false } = {}) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  if (options.names === false) cloud.state.enrollWithoutPerson = true;
  const config = await makeConfig();
  const provide = options.clock ? (Layer.succeed(DevicesClock, () => options.clock!.now) as unknown as Layer.Layer<any>) : undefined;
  const runtime = await startRuntime(config, "fake-claude", undefined, provide ? { provide } : {});
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  const requests: Array<{ device_id: string; name: string; code: string }> = [];
  local.on("device.request", (request) => requests.push(request));
  const enrolled = await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await local.call("settings.set", { request_id: "rc-on", settings: { remote_control: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const relay = cloud.state.relays[0]!;
  const repo = makeRepo(tempRoot("devices-repo-"), { "README.md": "hello\n", "notes.md": "the launch code is 7f3a9c-zebra\n" });
  const workspace = await createReady(local, { request_id: "w0", repo: { path: repo }, title: "On the Mac", engine: "claude-agent", options: { model: MODEL } });
  return { cloud, config, runtime, local, relay, requests, workspace, runtimeId: enrolled.runtime_id };
}

/** The chat's journal head: anything a device ran in it moves it. */
const headOf = async (local: ReturnType<typeof connect>, workspaceId: string) => (await local.call("workspace.get", { workspace_id: workspaceId })).head ?? 0;

test("an unapproved device cannot submit, answer, open a terminal, read files or list chats on This Mac; a pending one neither", async () => {
  const mac = await thisMac();
  const head = await headOf(mac.local, mac.workspace.id);
  const attempts = [
    ["workspace.list", {}],
    ["turn.submit", { request_id: "t1", session_id: mac.workspace.session_id, kind: "followup", input: { text: "run rm -rf" } }],
    ["ask.respond", { request_id: "a1", session_id: mac.workspace.session_id, ask_id: "ask-1", response: { kind: "approval", option_id: "allow" } }],
    ["term.open", { request_id: "o1", workspace_id: mac.workspace.id, cols: 80, rows: 24 }],
    ["fs.read", { workspace_id: mac.workspace.id, path: "README.md" }],
    ["session.attach", { session_id: mac.workspace.session_id, cursor: 0 }],
    ["device.list", {}],
    ["device.allow", { request_id: "al", device_id: "x" }],
  ] as const;

  // A stolen Cloud session (or Cloud itself) opens a stream: it is challenged first and served nothing.
  const stolen = mac.relay.open();
  const challenge = await challengeOf(mac.relay, stolen);
  expect(challenge).toMatchObject({ runtime_id: mac.runtimeId, runtime_name: expect.any(String) });
  for (const [index, [method, params]] of attempts.entries()) {
    mac.relay.send(stolen, JSON.stringify({ jsonrpc: "2.0", id: index, method, params }));
    expect([method, reasonIn(await replyTo(mac.relay, stolen, index))]).toEqual([method, "device_not_approved"]);
  }

  // A device that says hello waits for the Mac; until it answers, still nothing runs.
  const phone = await testDevice("iPhone, Safari");
  const pending = mac.relay.open();
  const { reply } = await sayHello(mac.relay, pending, phone);
  expect(reply.result).toEqual({ status: "pending", code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{3}(-[0-9A-HJKMNP-TV-Z]{3}){3}$/) });
  await until(() => mac.requests.length === 1);
  expect(mac.requests[0]).toMatchObject({ device_id: phone.device_id, name: "iPhone, Safari", code: (reply.result as { code: string }).code });
  for (const [index, [method, params]] of attempts.entries()) {
    mac.relay.send(pending, JSON.stringify({ jsonrpc: "2.0", id: 100 + index, method, params }));
    expect([method, reasonIn(await replyTo(mac.relay, pending, 100 + index))]).toEqual([method, "device_not_approved"]);
  }

  // Nothing reached the chat, and no terminal was opened.
  expect(await headOf(mac.local, mac.workspace.id)).toBe(head);
  expect((await mac.local.call("term.list", { workspace_id: mac.workspace.id })).terminals).toEqual([]);
  expect(streamClosed(mac.relay, stolen)).toBe(false);
}, 120_000);

test("only This Mac's own screen allows a device; the real client waits, then its held calls run sealed", async () => {
  const mac = await thisMac();
  // An allowed device cannot allow another one: device.* is for the Mac's own clients.
  const laptop = await allowedStream(mac.relay, mac.local, await testDevice("Other Mac"));
  const phone = await testDevice("iPhone, Safari");
  const bridge = await relayBridge(mac.relay);
  cleanups.push(bridge.close);
  const statuses: Array<string> = [];
  const client = connect(bridge.url, "", undefined, { handshake: deviceHandshake({ device: phone, kind: () => "laptop", onStatus: (status) => statuses.push(status.status) }) });
  cleanups.push(() => client.close());
  const listed = client.call("workspace.list", {});
  await until(() => mac.requests.some((r) => r.device_id === phone.device_id));
  expect(statuses).toEqual(["pending"]);

  expect(reasonIn(await laptop.call("device.allow", { request_id: "sneak", device_id: phone.device_id }))).toBe("forbidden");
  expect(reasonIn(await laptop.call("device.list", {}))).toBe("forbidden");
  expect(reasonIn(await laptop.call("device.remove", { request_id: "sneak2", device_id: laptop.device.device_id }))).toBe("forbidden");
  expect((await mac.local.call("device.list", {})).requests.map((r) => r.device_id)).toEqual([phone.device_id]);
  // Still waiting: the call was held, not refused.
  expect(await Promise.race([listed.then(() => "answered"), new Promise((r) => setTimeout(() => r("held"), 500))])).toBe("held");

  const allowed = await mac.local.call("device.allow", { request_id: "yes", device_id: phone.device_id });
  expect(allowed.device).toMatchObject({ device_id: phone.device_id, name: "iPhone, Safari", connected: true });
  expect((await listed).workspaces.map((w) => w.id)).toContain(mac.workspace.id);
  expect(statuses).toEqual(["pending", "approved"]);

  // It drives the Mac now: a turn runs, and every frame it sent after the hello was sealed.
  const head = await headOf(mac.local, mac.workspace.id);
  await client.call("turn.submit", { request_id: "from-phone", session_id: mac.workspace.session_id, kind: "followup", input: { text: "hello from the phone" } });
  await until(async () => (await headOf(mac.local, mac.workspace.id)) > head, 30_000);
  // Nothing went out before the hello, and every frame after it was sealed.
  const first = bridge.fromClient.filter((f) => f.stream.equals(bridge.streams[0]!));
  expect(JSON.parse(first[0]!.text).method).toBe("device.hello");
  expect(first.length).toBeGreaterThan(2);
  expect(first.slice(1).every((f) => JSON.parse(f.text).device_frame !== undefined)).toBe(true);

  // A reconnect is approved at once: no new question on the Mac.
  const asked = mac.requests.length;
  const again = connect(bridge.url, "", undefined, { handshake: deviceHandshake({ device: phone, kind: () => "laptop" }) });
  cleanups.push(() => again.close());
  expect((await again.call("workspace.list", {})).workspaces.length).toBeGreaterThan(0);
  expect(mac.requests.length).toBe(asked);
}, 120_000);

test("This Mac takes only its owner's devices: another person's is told so at its hello, asks no screen and is never listed; the owner's next device still asks and connects", async () => {
  const mac = await thisMac();
  const listed = async () => (await mac.local.call("device.list", {})).requests.map((r) => r.name);
  // Another member of the org, as Caveman Cloud verified them. The device is real: it answers the challenge with its own key.
  const theirs = mac.relay.open({ user_id: "user-2", organization_id: mac.cloud.state.organizationId });
  const hello = await sayHello(mac.relay, theirs, await testDevice("A colleague's iPhone"));
  const sentence = `${hello.challenge.runtime_name} takes only its owner's devices.`;
  expect({ answer: hello.reply.result ?? hello.reply.error, asked: mac.requests.map((r) => r.name), listed: await listed() }).toEqual({
    answer: expect.objectContaining({ message: sentence, data: { reason: "device_not_approved" } }),
    asked: [],
    listed: [],
  });
  await until(() => streamClosed(mac.relay, theirs));

  // Nor as a Mac with the code this screen shows: refused the same, and the code is not theirs to use up.
  const code = await pairingCodeOn(mac.local);
  const theirMac = mac.relay.open({ user_id: "user-2", organization_id: mac.cloud.state.organizationId });
  expect((await sayHello(mac.relay, theirMac, await testDevice("A colleague's Mac", "mac"), { pair: code })).reply.error).toMatchObject({ message: sentence });
  const joining = mac.relay.open();
  expect((await sayHello(mac.relay, joining, await testDevice("Studio", "mac"), { pair: code })).reply.result).toMatchObject({ status: "pending" });
  expect({ asked: mac.requests.map((r) => r.name), listed: await listed() }).toEqual({ asked: ["Studio"], listed: ["Studio"] });

  // The owner's next device: the screen asks, they allow it, and it drives the Mac.
  const mine = await allowedStream(mac.relay, mac.local, await testDevice("iPad, Safari"));
  expect(mac.requests.map((r) => r.name)).toEqual(["Studio", "iPad, Safari"]);
  expect((await mine.call("workspace.list", {})).error).toBeUndefined();
}, 120_000);

test("a Mac whose sign-in names no person still asks its screen about any device; once it names its owner, a device it allowed for someone else counts for nothing", async () => {
  const mac = await thisMac({ names: false });
  // No owner among the people Cloud brings: the screen is asked, as before, and its Allow lets the device in.
  const colleague = await testDevice("A colleague's iPhone");
  const other = { user_id: "user-2", organization_id: mac.cloud.state.organizationId };
  const allowed = await allowedStream(mac.relay, mac.local, colleague, mac.relay.open(other));
  expect((await allowed.call("workspace.list", {})).error).toBeUndefined();
  expect((await mac.local.call("device.list", {})).family).toBeUndefined();

  // The Mac signs in again and Cloud names its person: the earlier allow was for someone who is not that person.
  mac.cloud.state.enrollWithoutPerson = false;
  const relays = mac.cloud.state.relays.length;
  await mac.local.call("cloud.enroll", { request_id: "e2", cloud_url: mac.cloud.url, token: mac.cloud.state.personToken, name: "Test Mac" });
  await until(() => mac.cloud.state.relays.length > relays, 15_000);
  await until(async () => (await mac.local.call("device.list", {})).family?.user_id === "user-1", 15_000);
  const relay = mac.cloud.state.relays.at(-1)!;
  const again = relay.open(other);
  const hello = await sayHello(relay, again, colleague);
  expect(hello.reply.error).toMatchObject({ message: `${hello.challenge.runtime_name} takes only its owner's devices.`, data: { reason: "device_not_approved" } });
  await until(() => streamClosed(relay, again));
}, 120_000);

test("removing a device closes its open streams at once and blocks it; Don't allow blocks a waiting one", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  const raw = await allowedStream(mac.relay, mac.local, phone);
  const bridge = await relayBridge(mac.relay);
  cleanups.push(bridge.close);
  const states: Array<string> = [];
  const client = connect(bridge.url, "", (state) => states.push(state), { handshake: deviceHandshake({ device: phone, kind: () => "laptop" }) });
  cleanups.push(() => client.close());
  await client.call("workspace.list", {});
  expect((await mac.local.call("device.list", {})).devices).toEqual([expect.objectContaining({ device_id: phone.device_id, connected: true })]);

  const removedAt = Date.now();
  await mac.local.call("device.remove", { request_id: "rm", device_id: phone.device_id });
  await until(() => streamClosed(mac.relay, raw.stream) && bridge.streams.every((s) => streamClosed(mac.relay, s)), 2_000);
  expect(Date.now() - removedAt).toBeLessThan(2_000);
  // It was told why, sealed like everything after its approval.
  expect((await raw.opened()).some((r) => r.method === "device.status" && (r.params as { status: string }).status === "refused")).toBe(true);
  // The client is told and stops: its calls fail plainly instead of waiting.
  await until(() => states.includes("closed"));
  expect(await reasonOf(client.call("workspace.list", {}))).toBe("device_not_approved");
  // And it does not keep knocking.
  const knocks = bridge.streams.length;
  await new Promise((r) => setTimeout(r, 1_500));
  expect(bridge.streams.length).toBe(knocks);
  const list = (await mac.local.call("device.list", {})) as DeviceList;
  expect(list.devices).toEqual([]);
  expect(list.blocked.map((b) => b.device_id)).toEqual([phone.device_id]);

  // It cannot ask again: refused without a question on the Mac.
  const asked = mac.requests.length;
  const back = mac.relay.open();
  expect((await sayHello(mac.relay, back, phone)).reply.result).toMatchObject({ status: "refused" });
  await until(() => streamClosed(mac.relay, back));
  expect(mac.requests.length).toBe(asked);

  // Don't allow (remove a waiting device) ends its stream and blocks it too; remove again unblocks.
  const tablet = await testDevice("iPad, Safari");
  const waiting = mac.relay.open();
  expect((await sayHello(mac.relay, waiting, tablet)).reply.result).toMatchObject({ status: "pending" });
  await mac.local.call("device.remove", { request_id: "no", device_id: tablet.device_id });
  await until(() => streamClosed(mac.relay, waiting), 2_000);
  expect((await mac.local.call("device.list", {})).blocked.map((b) => b.device_id).sort()).toEqual([phone.device_id, tablet.device_id].sort());
  await mac.local.call("device.remove", { request_id: "unblock", device_id: tablet.device_id });
  const asksAgain = mac.relay.open();
  expect((await sayHello(mac.relay, asksAgain, tablet)).reply.result).toMatchObject({ status: "pending" });
}, 120_000);

test("a replayed hello, a hello signed for another runtime, an unsealed or replayed frame on an approved stream all fail", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  const first = mac.relay.open();
  const { hello } = await sayHello(mac.relay, first, phone);
  await mac.local.call("device.allow", { request_id: "yes", device_id: phone.device_id });
  await until(() => mac.relay.replies(first).some((r) => r.method === "device.status"));

  // Cloud saw that hello: on a new stream (a new nonce and runtime key) it is worthless.
  const replay = mac.relay.open();
  await challengeOf(mac.relay, replay);
  mac.relay.send(replay, hello);
  expect(reasonIn(await replyTo(mac.relay, replay, "device.hello"))).toBe("device_not_approved");
  await until(() => streamClosed(mac.relay, replay));

  // Signed for another runtime (Cloud relaying one Mac's challenge answer to another): refused.
  const elsewhere = mac.relay.open();
  const other = await sayHello(mac.relay, elsewhere, phone, { runtimeId: "00000000-0000-4000-8000-000000000000" });
  expect(reasonIn(other.reply)).toBe("device_not_approved");
  await until(() => streamClosed(mac.relay, elsewhere));

  // An allowed device's id on another key, signed properly with that key: refused.
  const spoof = mac.relay.open();
  const spoofed = await sayHello(mac.relay, spoof, await testDevice("Impostor"), { deviceId: phone.device_id });
  expect(reasonIn(spoofed.reply)).toBe("device_not_approved");
  await until(() => streamClosed(mac.relay, spoof));

  // An approved stream takes only sealed frames, in order: Cloud injecting a plain call ends it, unrun.
  const head = await headOf(mac.local, mac.workspace.id);
  const driven = await allowedStream(mac.relay, mac.local, phone);
  expect((await driven.call("workspace.list", {})).result).toBeDefined();
  mac.relay.send(driven.stream, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "turn.submit", params: { request_id: "inj", session_id: mac.workspace.session_id, kind: "followup", input: { text: "injected" } } }));
  await until(() => streamClosed(mac.relay, driven.stream), 2_000);

  // Replaying a sealed frame (same sequence number) ends the stream too.
  const second = await allowedStream(mac.relay, mac.local, phone);
  await second.call("workspace.list", {});
  mac.relay.send(second.stream, second.sent[0]!);
  await until(() => streamClosed(mac.relay, second.stream), 2_000);

  // So does a sealed frame Cloud changed by one bit, even at the right place in the sequence.
  const third = await allowedStream(mac.relay, mac.local, phone);
  await third.call("workspace.list", {});
  const next = JSON.parse(await sealFrame(third.keys.to_runtime, 2, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "workspace.list", params: {} }), "to_runtime")) as {
    device_frame: { seq: number; ct: string };
  };
  const bits = Buffer.from(next.device_frame.ct, "base64url");
  bits[0] = bits[0]! ^ 1;
  mac.relay.send(third.stream, JSON.stringify({ device_frame: { seq: 2, ct: bits.toString("base64url") } }));
  await until(() => streamClosed(mac.relay, third.stream), 2_000);
  await new Promise((r) => setTimeout(r, 500));
  expect(await headOf(mac.local, mac.workspace.id)).toBe(head);
}, 120_000);

test("the relay sees only ciphertext either way; a Mac reply it changes, a frame it makes up or replays is never shown", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  const bridge = await relayBridge(mac.relay);
  cleanups.push(bridge.close);
  const client = connect(bridge.url, "", undefined, { handshake: deviceHandshake({ device: phone, kind: () => "laptop" }) });
  cleanups.push(() => client.close());
  const listed = client.call("workspace.list", {});
  await until(() => mac.requests.some((r) => r.device_id === phone.device_id));
  await mac.local.call("device.allow", { request_id: "yes", device_id: phone.device_id });
  await listed;
  const read = await client.call("fs.read", { workspace_id: mac.workspace.id, path: "notes.md" });
  expect(read.content).toContain("7f3a9c-zebra");

  // Neither way carried the file, its name, the method or the chat's title in the clear.
  const wire = [...bridge.toClient, ...bridge.fromClient].map((f) => f.text).join("\n");
  for (const secret of ["7f3a9c-zebra", "notes.md", "fs.read", "On the Mac"]) expect(wire).not.toContain(secret);
  // After the Mac's plain "approved", every frame it sent was sealed.
  const back = bridge.toClient.filter((f) => f.stream.equals(bridge.streams[0]!)).map((f) => JSON.parse(f.text) as { method?: string; params?: { status?: string }; device_frame?: unknown });
  const approvedAt = back.findIndex((m) => m.method === "device.status" && m.params?.status === "approved");
  expect(approvedAt).toBeGreaterThanOrEqual(0);
  expect(back.length).toBeGreaterThan(approvedAt + 1);
  expect(back.slice(approvedAt + 1).every((m) => m.device_frame !== undefined)).toBe(true);

  // The relay flips one bit of the Mac's next frame: the client drops the socket, asks again and gets the true answer.
  let flipped = 0;
  bridge.hostile.tamper = (text) => {
    if (flipped > 0 || !text.startsWith('{"device_frame"')) return text;
    flipped++;
    const frame = JSON.parse(text) as { device_frame: { seq: number; ct: string } };
    const ct = Buffer.from(frame.device_frame.ct, "base64url");
    ct[ct.length - 20] = ct[ct.length - 20]! ^ 1;
    return JSON.stringify({ device_frame: { ...frame.device_frame, ct: ct.toString("base64url") } });
  };
  const sockets = bridge.streams.length;
  const again = await client.call("fs.read", { workspace_id: mac.workspace.id, path: "notes.md" });
  expect(flipped).toBe(1);
  expect(bridge.streams.length).toBe(sockets + 1);
  expect(again.content).toContain("7f3a9c-zebra");
  delete bridge.hostile.tamper;

  // A frame the relay makes up (plain), or one of the Mac's it sends again: dropped unread, the socket with it.
  const shown: Array<string> = [];
  client.on("workspace.changed", (w) => shown.push(w.title ?? ""));
  const beforeForge = bridge.streams.length;
  bridge.inject(JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: { ...mac.workspace, title: "Forged by the relay" } }));
  await until(() => bridge.streams.length === beforeForge + 1);
  expect(shown).not.toContain("Forged by the relay");
  await client.call("workspace.list", {});
  const current = bridge.streams.at(-1)!;
  const sealedBack = bridge.toClient.filter((f) => f.stream.equals(current) && f.text.startsWith('{"device_frame"'));
  expect(sealedBack.length).toBeGreaterThan(0);
  const beforeReplay = bridge.streams.length;
  bridge.inject(sealedBack[0]!.text);
  await until(() => bridge.streams.length === beforeReplay + 1);
  // And it still works.
  expect((await client.call("workspace.list", {})).workspaces.map((w) => w.id)).toContain(mac.workspace.id);
}, 120_000);

test("a device that does not know a Mac is a laptop, and gets its challenge late, keeps its calls and asks again; a full waiting list is not a no", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(mac.relay, mac.local, phone);
  // The relay holds the first connection's frames 2.5 s: the device gives up waiting (1.5 s) and speaks plainly.
  const bridge = await relayBridge(mac.relay);
  cleanups.push(bridge.close);
  bridge.hostile.holdFirstMs = 2_500;
  const client = connect(bridge.url, "", undefined, { handshake: deviceHandshake({ device: phone, kind: () => undefined }) });
  cleanups.push(() => client.close());
  // Turned away unrun on the first socket, then held and sent again sealed on the next: answered, never failed.
  const listed = await client.call("workspace.list", {});
  expect(listed.workspaces.map((w) => w.id)).toContain(mac.workspace.id);
  expect(bridge.streams.length).toBeGreaterThanOrEqual(2);
  const first = bridge.fromClient.filter((f) => f.stream.equals(bridge.streams[0]!)).map((f) => JSON.parse(f.text) as { method?: string });
  expect(first.some((f) => f.method === "workspace.list")).toBe(true);

  // Three devices wait for an answer; a fourth is asked to come back later, not refused, and not blocked.
  for (const name of ["One", "Two", "Three"]) expect((await sayHello(mac.relay, mac.relay.open(), await testDevice(name))).reply.result).toMatchObject({ status: "pending" });
  const fourth = await testDevice("Four");
  const busy = mac.relay.open();
  const answer = await sayHello(mac.relay, busy, fourth);
  expect(reasonIn(answer.reply)).toBe("rate_limited");
  await until(() => streamClosed(mac.relay, busy));
  expect((await mac.local.call("device.list", {})).blocked).toEqual([]);
  // Its client takes that as "later": it keeps trying rather than giving up for good.
  const states: Array<string> = [];
  const later = connect(bridge.url, "", (state) => states.push(state), { handshake: deviceHandshake({ device: fourth, kind: () => "laptop" }) });
  cleanups.push(() => later.close());
  const asked = later.call("workspace.list", {});
  await until(() => states.filter((s) => s === "unauthorized").length >= 2, 15_000);
  expect(states).not.toContain("closed");
  // Once the Mac says no to one of the three, the fourth asks and waits like the others.
  const waiting = (await mac.local.call("device.list", {})).requests;
  await mac.local.call("device.remove", { request_id: "no-1", device_id: waiting[0]!.device_id });
  await until(async () => (await mac.local.call("device.list", {})).requests.some((r) => r.device_id === fourth.device_id), 15_000);
  await mac.local.call("device.allow", { request_id: "yes-4", device_id: fourth.device_id });
  expect((await asked).workspaces.length).toBeGreaterThan(0);
}, 120_000);

test("a burst of events reaches an allowed device one sealing step later, not one step per frame before it (S14)", async () => {
  const mac = await thisMac();
  const phone = await testDevice("iPhone, Safari");
  const bridge = await relayBridge(mac.relay);
  cleanups.push(bridge.close);
  const client = connect(bridge.url, "", undefined, { handshake: deviceHandshake({ device: phone, kind: () => "laptop" }) });
  cleanups.push(() => client.close());
  const listed = client.call("workspace.list", {});
  await until(() => mac.requests.some((r) => r.device_id === phone.device_id));
  await mac.local.call("device.allow", { request_id: "yes", device_id: phone.device_id });
  await listed;
  // Which events committed (the Mac's own loopback, not sealed), and the order they reached the phone in.
  const committed = new Set<number>();
  const shown: Array<number> = [];
  const sid = mac.workspace.session_id;
  const head = await headOf(mac.local, mac.workspace.id);
  const mine = await mac.local.attach(sid, head, (e) => void committed.add(e.cursor));
  const theirs = await client.attach(sid, head, (e) => void shown.push(e.cursor));
  cleanups.push(() => mine.detach(), () => theirs.detach());
  // From here every WebCrypto AES-GCM job waits until the test lets it go, as on a phone slow to open a frame. Frames
  // opened as they arrive are all waiting at once; opened one at a time, only one ever is. The Mac seals with Node's
  // own AES-GCM (frameCrypto), so its frames reach the phone while WebCrypto waits; a seal waiting on WebCrypto, or on
  // a turn's busy event loop, would bring the phone nothing.
  const before = shown.length;
  const waiting: Array<() => void> = [];
  let held = true;
  let opening = 0;
  const subtle = globalThis.crypto.subtle;
  for (const name of ["encrypt", "decrypt"] as const) {
    const original = subtle[name].bind(subtle) as (...args: Array<unknown>) => Promise<ArrayBuffer>;
    const spy = vi.spyOn(subtle, name).mockImplementation((async (...args: Array<unknown>) => {
      if (name === "decrypt") opening++;
      try {
        if (held) await new Promise<void>((resolve) => waiting.push(resolve));
        return await original(...args);
      } finally {
        if (name === "decrypt") opening--;
      }
    }) as never);
    cleanups.push(() => spy.mockRestore());
  }
  const release = () => {
    held = false;
    for (const go of waiting.splice(0).reverse()) go();
  };
  cleanups.push(release);
  await mac.local.call("turn.submit", { request_id: "burst", session_id: sid, kind: "followup", input: { text: "a turn's events come in a burst" } });
  // A burst is being opened at once: in it, each frame waits for one opening, not for every frame before it.
  await until(() => opening >= 3, 60_000).catch(() => undefined);
  expect(opening, "frames of one burst being opened at once").toBeGreaterThanOrEqual(3);
  expect(shown.length).toBe(before);
  // The last frame's opening ends first: the phone still hands them on in order.
  release();
  await until(async () => {
    const now = await headOf(mac.local, mac.workspace.id);
    return now > head + 5 && committed.size >= now - head && [...committed].every((c) => shown.includes(c));
  }, 60_000);
  expect(shown).toEqual([...committed].sort((a, b) => a - b));
}, 120_000);

test("a Cloud computer needs no device approval: its relayed streams are served at once", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const linkDir = path.join(tempRoot("devices-computer-link-"), "link");
  const identity = await enroll({ dir: linkDir, cloudUrl: cloud.url, bearer: cloud.state.personToken, name: "computer" });
  const checkout = makeRepo(tempRoot("devices-computer-"), { "README.md": "hello\n" });
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
  relay.send(stream, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.list", params: {} }));
  expect((await replyTo(relay, stream, 1)).result).toBeDefined();
  expect(relay.replies(stream).some((r) => r.method === "device.challenge")).toBe(false);
  expect((await local.call("device.list", {})).required).toBe(false);
  // The real client with a device key reaches it unchanged.
  const bridge = await relayBridge(relay);
  cleanups.push(bridge.close);
  // Even a device that does not know the runtime's kind: it waits briefly for a challenge that never comes.
  const client = connect(bridge.url, "", undefined, { handshake: deviceHandshake({ device: await testDevice(), kind: () => undefined }) });
  cleanups.push(() => client.close());
  expect((await client.call("engine.list", {})).engines.length).toBeGreaterThan(0);
  expect(bridge.fromClient.every((f) => JSON.parse(f.text).device_frame === undefined)).toBe(true);
  fs.rmSync(checkout, { recursive: true, force: true });
}, 120_000);

test("Remote control follows sync unless the person set it; a new sign-in goes back to following sync", async () => {
  expect(remoteControlOn({})).toBe(false);
  expect(remoteControlOn({ sync_chats: true })).toBe(true);
  expect(remoteControlOn({ sync_chats: true, remote_control: false })).toBe(false);
  expect(remoteControlOn({ sync_chats: false, remote_control: true })).toBe(true);

  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const runtime = await startRuntime(config, "fake-claude");
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await new Promise((r) => setTimeout(r, 2_500));
  expect(cloud.state.relays).toHaveLength(0);
  // The one notice turns sync on: the relay link comes with it, no second switch.
  await local.call("settings.set", { request_id: "sync-on", settings: { sync_chats: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  expect(cloud.state.relays).toHaveLength(1);
  // The person's own off wins over sync.
  await local.call("settings.set", { request_id: "rc-off", settings: { remote_control: false } });
  await until(() => cloud.state.relays[0]!.ws.readyState === cloud.state.relays[0]!.ws.CLOSED, 10_000);
  expect((await local.call("cloud.status", {})).state).toBe("off");
}, 120_000);

// The lid's move says This Mac is going to sleep (Cloud hears it at once and moves its chats off it on the next phone
// send) and hands a running turn on mid-way: only This Mac's own lid says so, as cloud.suspend.
test("a relayed device's move never claims the lid: Cloud never hears an awake Mac is going to sleep", async () => {
  const mac = await thisMac();
  const phone = await allowedStream(mac.relay, mac.local);
  const reply = await phone.call("session.move", { request_id: "phone-lid", session_id: mac.workspace.session_id, to: "cloud", reason: "lid" });
  expect(reasonIn(reply)).toBe("forbidden");
  expect(mac.cloud.state.heartbeats.some((h) => h.suspending === true)).toBe(false);
  expect((await mac.local.call("workspace.get", { workspace_id: mac.workspace.id })).status).not.toBe("parked");
}, 120_000);

test("keep awake: wanted while a device drove a chat in the last 10 minutes or a chat it sent to still works", async () => {
  const clock = { now: Date.now() };
  const mac = await thisMac({ clock });
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: false });
  const phone = await allowedStream(mac.relay, mac.local);
  expect(reasonIn(await phone.call("device.awake", {}))).toBe("forbidden");
  // Reads alone do not count.
  await phone.call("workspace.list", {});
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: false });

  await phone.call("turn.submit", { request_id: "slow", session_id: mac.workspace.session_id, kind: "followup", input: { text: "slow 6000: keep going" } });
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: true });
  await until(async () => (await mac.local.call("workspace.get", { workspace_id: mac.workspace.id })).status === "working", 15_000);
  // Ten minutes on, the chat it sent to still works: still wanted.
  clock.now += DRIVE_WINDOW_MS + 1_000;
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: true });
  await until(async () => (await mac.local.call("workspace.get", { workspace_id: mac.workspace.id })).status !== "working", 30_000);
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: false });

  // The setting turns it off.
  await phone.call("turn.submit", { request_id: "again", session_id: mac.workspace.session_id, kind: "followup", input: { text: "again" } });
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: true });
  await mac.local.call("settings.set", { request_id: "ka-off", settings: { keep_awake_remote: false } });
  expect(await mac.local.call("device.awake", {})).toEqual({ wanted: false });
}, 120_000);

// ------------------------------------------------------------ approvals the person's Macs share (devices-2026-10-31)

/** What one of the person's other Macs signs about `device` (its screen, with its desktop key), as Cloud would carry it. */
const signedBy = (mac: Awaited<ReturnType<typeof testDevice>>, cloud: Awaited<ReturnType<typeof startTestCloud>>, device: Awaited<ReturnType<typeof testDevice>>, kind: "allow" | "remove") =>
  signStatement(mac, {
    kind,
    organization_id: cloud.state.organizationId,
    user_id: "user-1",
    device_id: device.device_id,
    ...(kind === "allow" ? { public_key: device.public_key, name: device.name, role: device.kind ?? "device" } : {}),
  });

test("a v2 hello signs kind and name: one the relay changed is refused (T11), and a v1 hello asks as a device", async () => {
  const mac = await thisMac();
  const studioPair = await newDeviceKeyPair();
  const studio = await webCryptoDeviceKey({ ...studioPair, name: "Caveman Code on Studio", kind: "mac" });
  for (const [label, options] of [
    ["kind flipped", { kind: "device" }],
    ["name changed", { name: "Mallory's Mac" }],
  ] as const) {
    const stream = mac.relay.open();
    const { reply } = await sayHello(mac.relay, stream, studio, options);
    expect([label, reasonIn(reply)]).toEqual([label, "device_not_approved"]);
    await until(() => streamClosed(mac.relay, stream));
  }
  expect(mac.requests).toEqual([]);
  // Offered v2 but answered v1 (an older device, or an offer the relay stripped): asked as a device, never a Mac, and
  // with no kind kept, since its hello never said one.
  const { reply: v1 } = await sayHello(mac.relay, mac.relay.open(), studio, { v1: true });
  expect(v1.result).toMatchObject({ status: "pending" });
  const asked = (await mac.local.call("device.list", {})).requests.find((r) => r.device_id === studio.device_id)!;
  expect(asked).toMatchObject({ name: "Caveman Code on Studio", public_key: studio.public_key });
  expect(asked).not.toHaveProperty("role");
  // Asking again while it waits, now as a Mac under another name, changes nothing the screen shows (a page Cloud serves
  // could switch just before the click): the stream joins the request as it was, and the screen is not asked again.
  for (const as of [studio, await webCryptoDeviceKey({ ...studioPair, name: "Studio (renamed)", kind: "mac" })])
    expect((await sayHello(mac.relay, mac.relay.open(), as)).reply.result).toMatchObject({ status: "pending" });
  expect((await mac.local.call("device.list", {})).requests).toEqual([asked]);
  expect(mac.requests.filter((r) => r.device_id === studio.device_id)).toHaveLength(1);
  // An Allow of a kind the screen did not show is refused; the one it showed goes in.
  expect(await reasonOf(mac.local.call("device.allow", { request_id: "as-mac", device_id: studio.device_id, role: "mac" }))).toBe("invalid_state");
  expect(await reasonOf(mac.local.call("device.allow", { request_id: "as-shown", device_id: studio.device_id, role: "device" }))).toBe("ok");
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === studio.device_id)).not.toHaveProperty("role");
  // A Mac's v2 hello, from a key that asks for the first time, asks as a device: only the code this Mac's screen shows
  // makes it a Mac (decision 31).
  const mini = await testDevice("Caveman Code on Mac mini", "mac");
  expect((await sayHello(mac.relay, mac.relay.open(), mini)).reply.result).toMatchObject({ status: "pending" });
  expect((await mac.local.call("device.list", {})).requests.find((r) => r.device_id === mini.device_id)).toMatchObject({ role: "device", name: "Caveman Code on Mac mini" });
  expect((await mac.local.call("device.list", {})).family).toEqual({ organization_id: mac.cloud.state.organizationId, user_id: "user-1" });
}, 120_000);

test("only the code this Mac's screen shows makes a key a Mac here: a wrong, old or used code is refused and uses it up (decision 31, T22)", async () => {
  const clock = { now: Date.now() };
  const mac = await thisMac({ clock });
  const studio = await testDevice("Studio", "mac");
  // Only This Mac's own screen shows a code: never to a device through the relay, even one it allowed.
  const phone = await allowedStream(mac.relay, mac.local, await testDevice("iPhone, Safari"));
  expect(reasonIn(await phone.call("device.pair.start", { request_id: "relayed" }))).toBe("forbidden");
  const asked = () => mac.local.call("device.list", {}).then((l) => l.requests.find((r) => r.device_id === studio.device_id));

  // Without a code, a Mac's key asks as a device.
  expect((await sayHello(mac.relay, mac.relay.open(), studio)).reply.result).toMatchObject({ status: "pending" });
  expect(await asked()).toMatchObject({ role: "device" });
  expect((await mac.local.call("device.list", {})).pairing).toBeUndefined();

  // A wrong code: refused, the connection closes, and the code is used up, so the right one fails after it.
  const first = await pairingCodeOn(mac.local);
  expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect((await mac.local.call("device.list", {})).pairing?.expires_at).toBe(new Date(clock.now + 10 * 60_000).toISOString());
  const wrongStream = mac.relay.open();
  const wrong = await sayHello(mac.relay, wrongStream, studio, { pair: first === "0000-0000-0000" ? "1111-1111-1111" : "0000-0000-0000" });
  expect(reasonIn(wrong.reply)).toBe("invalid_params");
  await until(() => streamClosed(mac.relay, wrongStream));
  expect((await mac.local.call("device.list", {})).pairing).toBeUndefined();
  expect(reasonIn((await sayHello(mac.relay, mac.relay.open(), studio, { pair: first })).reply)).toBe("invalid_params");
  expect(await asked()).toMatchObject({ role: "device" });

  // A proof made for another hello (one the relay saw on another connection) does not hold on this one.
  const second = await pairingCodeOn(mac.local);
  const elsewhere = await sayHello(mac.relay, mac.relay.open(), await testDevice("Mallory's Mac", "mac"), { proof: "A".repeat(43) });
  expect(reasonIn(elsewhere.reply)).toBe("invalid_params");
  expect(reasonIn((await sayHello(mac.relay, mac.relay.open(), studio, { pair: second })).reply)).toBe("invalid_params");

  // An old code (past its ten minutes) is refused.
  const third = await pairingCodeOn(mac.local);
  clock.now += 10 * 60_000 + 1_000;
  expect(reasonIn((await sayHello(mac.relay, mac.relay.open(), studio, { pair: third })).reply)).toBe("invalid_params");
  // (Its request lapsed with the clock too: it asks afresh below.)

  // A phone's key, or a v1 hello (which signs no kind), never pairs, even with the live code.
  const fourth = await pairingCodeOn(mac.local);
  expect(reasonIn((await sayHello(mac.relay, mac.relay.open(), await testDevice("iPad, Safari"), { pair: fourth })).reply)).toBe("invalid_params");
  const fifth = await pairingCodeOn(mac.local);
  expect(reasonIn((await sayHello(mac.relay, mac.relay.open(), studio, { pair: fifth, v1: true })).reply)).toBe("invalid_params");

  // A new code replaces the last; with it, the Mac's request asks as a Mac, and the one it had as a device turns into it.
  await pairingCodeOn(mac.local);
  const live = await pairingCodeOn(mac.local);
  expect((await sayHello(mac.relay, mac.relay.open(), studio)).reply.result).toMatchObject({ status: "pending" });
  expect(await asked()).toMatchObject({ role: "device" });
  const before = mac.requests.length;
  expect((await sayHello(mac.relay, mac.relay.open(), studio, { pair: live })).reply.result).toMatchObject({ status: "pending" });
  expect(await asked()).toMatchObject({ role: "mac", name: "Studio" });
  // The screen hears of it as a Mac (its question changes), and the code is gone.
  await until(() => mac.requests.length === before + 1);
  expect((await mac.local.call("device.list", {})).pairing).toBeUndefined();
}, 180_000);

test("a joining Mac's pairing hello sent again under a key the relay swapped in is refused: the code is used up and nobody asks as a Mac (A-1, T22)", async () => {
  const mac = await thisMac();
  const studio = await testDevice("Studio", "mac");
  // The relay holds Studio's hello back and sends its bytes signed by a key of its own, with Studio's proof of the code.
  const swappedIn = await testDevice("Studio", "mac");
  const stream = mac.relay.open();
  const swapped = await sayHello(mac.relay, stream, studio, { pair: await pairingCodeOn(mac.local), swapKey: swappedIn });
  expect(reasonIn(swapped.reply)).toBe("invalid_params");
  await until(() => streamClosed(mac.relay, stream));
  const list = await mac.local.call("device.list", {});
  expect(list.pairing).toBeUndefined();
  expect(list.requests).toEqual([]);
  expect(mac.requests).toEqual([]);
  // Studio itself, with a new code: asked about as a Mac, under its own key's code.
  const genuine = await sayHello(mac.relay, mac.relay.open(), studio, { pair: await pairingCodeOn(mac.local) });
  expect(genuine.reply.result).toMatchObject({ status: "pending", code: deviceCode(studio.device_id) });
  expect((await mac.local.call("device.list", {})).requests).toEqual([expect.objectContaining({ device_id: studio.device_id, role: "mac", code: deviceCode(studio.device_id) })]);
}, 60_000);

test("a device allowed here counts as a Mac only once it joins with this Mac's code; Keep as a device keeps it one, and the Join hears the answer (decision 31, m-13)", async () => {
  const mac = await thisMac();
  const signer = await testDevice("Test Mac", "mac");
  for (const [name, keep] of [
    ["Studio", true],
    ["Mac mini", false],
  ] as const) {
    const other = await testDevice(name, "mac");
    // Allowed before Macs shared approvals (a v1 hello), or as a device: it drives this Mac, as a device.
    await allowedStream(mac.relay, mac.local, other, mac.relay.open(), { hello: { v1: true } });
    const asked = mac.requests.length;
    // Its next hellos say, signed, that it is a Mac: served as before, and the screen is never asked (the pre-v2
    // question is gone: only the code makes a Mac).
    for (let i = 0; i < 2; i++) expect((await sayHello(mac.relay, mac.relay.open(), other)).reply.result).toMatchObject({ status: "approved" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mac.requests.length).toBe(asked);
    expect((await mac.local.call("device.list", {})).requests).toEqual([]);
    // With the code: the screen asks once whether it counts as a Mac. The Join's own connection waits on that answer
    // (m-13: it never says the Mac was taken while the screen still asks); the device's other connections are served.
    const join = mac.relay.open();
    expect((await sayHello(mac.relay, join, other, { pair: await pairingCodeOn(mac.local) })).reply.result).toMatchObject({ status: "pending" });
    await until(() => mac.requests.length === asked + 1);
    expect((await mac.local.call("device.list", {})).requests.find((r) => r.device_id === other.device_id)).toMatchObject({ role: "mac", name });
    expect((await sayHello(mac.relay, mac.relay.open(), other)).reply.result).toMatchObject({ status: "approved" });
    const joinHeard = () => mac.relay.replies(join).flatMap((r) => (r.method === "device.status" ? [(r.params as { status: string }).status] : []));
    if (keep) {
      // Kept as a device: on this Mac only, as before; it signs nothing for the other Macs, and the Join hears no.
      await mac.local.call("device.allow", { request_id: `keep-${name}`, device_id: other.device_id, role: "device" });
      const list = await mac.local.call("device.list", {});
      expect(list.requests).toEqual([]);
      expect(list.devices.find((d) => d.device_id === other.device_id)).not.toHaveProperty("role");
      await until(() => joinHeard().includes("refused"), 10_000);
      await until(() => streamClosed(mac.relay, join), 10_000);
      expect(joinHeard()).not.toContain("approved");
      expect((await sayHello(mac.relay, mac.relay.open(), other)).reply.result).toMatchObject({ status: "approved" });
      expect(mac.requests.length).toBe(asked + 1);
      continue;
    }
    // Allowed as a Mac, signed by this Mac's desktop key: an approver here, with no removal of it anywhere.
    const statement = await allowStatement(mac.local, signer, other.device_id);
    expect(statement).toMatchObject({ kind: "allow", role: "mac", device_id: other.device_id });
    expect(joinHeard()).toEqual([]);
    await mac.local.call("device.allow", { request_id: `upgrade-${name}`, device_id: other.device_id, role: "mac", statement });
    expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === other.device_id)).toMatchObject({ role: "mac", shared: true });
    // The Join hears yes only now.
    await until(() => joinHeard().includes("approved"), 10_000);
    await until(() => mac.cloud.state.devices.rows.some((r) => (r.statement as { device_id?: string }).device_id === other.device_id));
    expect(mac.cloud.state.devices.rows.filter((r) => (r.statement as { kind?: string }).kind === "remove")).toEqual([]);
    // Its approvals count here now.
    const phone = await testDevice("iPhone, Safari");
    mac.cloud.state.devices.inject("user-1", await signedBy(other, mac.cloud, phone, "allow"));
    expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  }
}, 120_000);

test("a Join hears it was taken only in its first sealed frame, proved under the code, once this screen allowed it as a Mac; another Mac's allow of its key as a device answers nothing there (m-h)", async () => {
  const mac = await thisMac();
  const signer = await testDevice("Test Mac", "mac");
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const joining = await testDevice("Mac mini", "mac");
  const code = await pairingCodeOn(mac.local);
  const join = mac.relay.open();
  const { reply, keys, challenge, hello } = await sayHello(mac.relay, join, joining, { pair: code });
  expect(reply.result).toMatchObject({ status: "pending" });
  const joinHeard = () => mac.relay.replies(join).flatMap((r) => (r.method === "device.status" ? [(r.params as { status: string }).status] : []));
  // The Studio allows that key as a device meanwhile (its own screen, through the log): its other connections drive this
  // Mac, but the Join asked to count as a Mac, and the screen still asks that.
  const asDevice = await signStatement(studio, {
    kind: "allow",
    organization_id: mac.cloud.state.organizationId,
    user_id: "user-1",
    device_id: joining.device_id,
    public_key: joining.public_key,
    name: joining.name,
    role: "device",
  });
  mac.cloud.state.devices.inject("user-1", asDevice);
  await until(async () => ((await sayHello(mac.relay, mac.relay.open(), joining)).reply.result as { status?: string } | undefined)?.status === "approved", 15_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(joinHeard()).toEqual([]);
  expect(streamClosed(mac.relay, join)).toBe(false);
  expect((await mac.local.call("device.list", {})).requests.find((r) => r.device_id === joining.device_id)).toMatchObject({ role: "mac" });
  // The screen allows it as a Mac: "approved" (plain, as the hello's answer was), then the first sealed frame, which
  // names the role with a proof under the code this screen showed, for this connection's hello.
  const statement = await allowStatement(mac.local, signer, joining.device_id);
  await mac.local.call("device.allow", { request_id: "join-as-mac", device_id: joining.device_id, role: "mac", statement });
  await until(() => joinHeard().includes("approved"), 10_000);
  const sealed = sealedOn(relayWire(mac.relay, join), keys);
  await until(async () => (await sealed.opened()).length > 0, 10_000);
  const first = (await sealed.opened())[0] as { method?: string; params?: { status?: string; role?: string; proof?: string } };
  expect(first).toMatchObject({ method: "device.status", params: { status: "approved", role: "mac" } });
  const sent = (JSON.parse(hello) as { params: { key: string } }).params;
  const signed = helloPayload({ runtime_id: challenge.runtime_id, nonce: challenge.nonce, runtime_key: challenge.key, device_key: sent.key, v2: { kind: "mac", name: "Mac mini" } });
  expect(await verifyPairAnswer(code, joining.device_id, signed, first.params?.proof)).toBe(true);
  expect(await verifyPairAnswer("0000-0000-0000", joining.device_id, signed, first.params?.proof)).toBe(false);
  // A connection that proved no code hears no such answer: its first sealed frame is whatever it asked for.
  const plain = await allowedStream(mac.relay, mac.local, await testDevice("iPhone, Safari"));
  await plain.call("workspace.list", {});
  expect((await plain.opened()).some((r) => r.method === "device.status")).toBe(false);
}, 120_000);

test("what this screen signed for the person's other Macs reads as waiting until Caveman takes it: a stolen phone's removal made offline says it has not gone yet (m-j)", async () => {
  const mac = await thisMac();
  const signer = await testDevice("Test Mac", "mac");
  const phone = await testDevice("iPhone, Safari");
  const list = () => mac.local.call("device.list", {});
  // Allowed and signed while Caveman answers: sent, and it says so.
  await allowedStream(mac.relay, mac.local, phone, mac.relay.open(), { signer });
  await until(() => mac.cloud.state.devices.rows.some((r) => (r.statement as { kind?: string; device_id?: string }).kind === "allow" && (r.statement as { device_id?: string }).device_id === phone.device_id), 30_000);
  await until(async () => (await list()).devices.find((d) => d.device_id === phone.device_id)?.waiting === undefined, 15_000);
  expect((await list()).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ shared: true });
  // Offline (the phone stolen on a train): removed here, and signed for the other Macs, but nothing has gone yet.
  mac.cloud.state.unreachable = true;
  await mac.local.call("device.remove", { request_id: "rm-offline", device_id: phone.device_id, statement: await removeStatement(mac.local, signer, phone.device_id) });
  expect((await list()).blocked.find((b) => b.device_id === phone.device_id)).toMatchObject({ waiting: true });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect((await list()).blocked.find((b) => b.device_id === phone.device_id)).toMatchObject({ waiting: true });
  expect(mac.cloud.state.devices.rows.some((r) => (r.statement as { kind?: string }).kind === "remove")).toBe(false);
  // Caveman answers again: the removal goes, and the screen stops saying it waits.
  mac.cloud.state.unreachable = false;
  await until(() => mac.cloud.state.devices.rows.some((r) => (r.statement as { kind?: string; device_id?: string }).kind === "remove" && (r.statement as { device_id?: string }).device_id === phone.device_id), 90_000);
  await until(async () => (await list()).blocked.find((b) => b.device_id === phone.device_id)?.waiting === undefined, 15_000);
}, 180_000);

test("over the cap the log takes nothing more by keys this Mac does not trust, but still what a Mac it trusts signs (T12)", async () => {
  const mac = await thisMac();
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  // A flood (one stolen sign-in's runtimes, or Cloud): well-formed allows by a key this Mac never trusted, each its own
  // statement, up to the cap with the phone's.
  const rogue = await testDevice("Rogue", "mac");
  const filler = await testDevice("Filler");
  for (let i = 1; i < MAX_STATEMENTS; i++) mac.cloud.state.devices.inject("user-1", await signedBy(rogue, mac.cloud, filler, "allow"));
  // Past the cap: one more by a key it does not trust, then the Studio's allow of a tablet and its removal of the phone.
  const stray = await testDevice("Rogue's iPad", "mac");
  mac.cloud.state.devices.inject("user-1", await signedBy(rogue, mac.cloud, stray, "allow"));
  const late = await testDevice("iPad, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, late, "allow"));
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  const last = mac.cloud.state.devices.seq;
  await until(() => mac.cloud.state.devices.reads.some((r) => r.runtime_id === mac.runtimeId && r.after >= last), 60_000);
  // What the Studio signed goes in, flood or not: its allow past the cap and its removal. The rogue's never.
  expect((await sayHello(mac.relay, mac.relay.open(), late)).reply.result).toMatchObject({ status: "approved" });
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "refused" });
  // The rogue key's allow past the cap was never taken: trusted later (this screen allows it as a Mac), what it signed
  // before the cap counts, and that one does not.
  await allowedStream(mac.relay, mac.local, rogue);
  const ids = (await mac.local.call("device.list", {})).devices.map((d) => d.device_id);
  expect(ids).toContain(filler.device_id);
  expect(ids).not.toContain(stray.device_id);
}, 180_000);

test("a hello after the Mac slept reads the person's log again first: a removal made meanwhile is not missed", async () => {
  const clock = { now: Date.now() };
  const mac = await thisMac({ clock });
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  // The Mac falls asleep mid-read: its long read of the log hangs (a row moves it on to the next read, which is held).
  const reads = mac.cloud.state.devices.reads.length;
  mac.cloud.state.devices.hold = () => true;
  mac.cloud.state.devices.inject("user-1", "nothing");
  await until(() => mac.cloud.state.devices.reads.slice(reads).some((r) => r.held === true), 30_000);
  mac.cloud.state.devices.hold = undefined;
  // Meanwhile the Studio removes the phone. Within one wait cycle a known device is still let in (its read hangs).
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  // The Mac wakes: its clock jumped past a wait cycle. The phone's next hello waits on a fresh read, and is refused.
  clock.now += 60_000;
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "refused" });
}, 120_000);

test("a Mac that read the person's log before it trusted a Mac reads it again once it does: a removal that Mac signed past a flood still counts (A-3)", async () => {
  const mac = await thisMac();
  const studio = await testDevice("Studio", "mac");
  const phone = await testDevice("iPhone, Safari");
  // This Mac trusts no Mac yet, and reads: the Studio's allow of the phone, a flood of removals (2,000, the cap) by a key
  // nobody trusts (one stolen sign-in's throwaway keys), then the Studio's removal of the phone (its phone was stolen).
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  const rogue = await testDevice("Rogue", "mac");
  const filler = await testDevice("Filler");
  for (let i = 0; i < MAX_STATEMENTS; i++) mac.cloud.state.devices.inject("user-1", await signedBy(rogue, mac.cloud, filler, "remove"));
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  const last = mac.cloud.state.devices.seq;
  await until(() => mac.cloud.state.devices.reads.some((r) => r.runtime_id === mac.runtimeId && r.after >= last), 60_000);
  // Its screen then allows the Studio as a Mac (it joined with the code): the Studio's allow of the phone counts now,
  // and so must its removal, which came past the flood.
  await allowedStream(mac.relay, mac.local, studio);
  await until(async () => (await mac.local.call("device.list", {})).blocked.some((b) => b.device_id === phone.device_id && b.removed_by?.name === "Studio"), 30_000);
  expect((await mac.local.call("device.list", {})).devices.map((d) => d.device_id)).not.toContain(phone.device_id);
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "refused" });
  // The rogue's removals never counted: the filler is listed nowhere.
  expect((await mac.local.call("device.list", {})).blocked.map((b) => b.device_id)).not.toContain(filler.device_id);
}, 240_000);

test("a log read sent before the Mac slept and answered empty after it woke leaves the log unread: a removed phone's queued call waits, then is refused (A-9)", async () => {
  const clock = { now: Date.now() };
  const mac = await thisMac({ clock });
  await mac.local.call("settings.set", { request_id: "sync-on", settings: { sync_chats: true } });
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  await until(() => mac.cloud.state.chats.summaries.has(mac.workspace.session_id), 20_000);
  const person = (method: string, route: string, body?: unknown) =>
    fetch(`${mac.cloud.url}/api/v1/code/${route}`, { method, headers: { authorization: `Bearer ${mac.cloud.state.personToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json() as Promise<{ status: string; error?: { code?: string } }>);
  const queue = async (request_id: string) => {
    const call = { session_id: mac.workspace.session_id, request_id, method: "turn.submit", params: { session_id: mac.workspace.session_id, kind: "followup", input: { text: request_id } } };
    await person("POST", `chats/${call.session_id}/calls`, { request_id, method: call.method, params: call.params, device: await signCall(phone, call) });
    return () => person("GET", `chats/${call.session_id}/calls/${request_id}`);
  };
  // The follow loop's read goes out before the sleep; Cloud takes its answer then (nothing new) and it is held in flight.
  const reads = mac.cloud.state.devices.reads.length;
  mac.cloud.state.devices.stall = () => true;
  mac.cloud.state.devices.inject("user-1", "nothing");
  await until(() => mac.cloud.state.devices.reads.slice(reads).some((r) => r.stalled === true), 30_000);
  mac.cloud.state.devices.stall = undefined;
  // Asleep: the clock jumps past a wait cycle, the Studio removes the phone, and reads from here hang (the network is
  // not back yet). Then the read from before the sleep is answered, empty.
  clock.now += 60_000;
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  mac.cloud.state.devices.hold = () => true;
  const released = mac.cloud.state.devices.reads.length;
  mac.cloud.state.devices.release();
  // The follow loop took that answer and went on to its next read (held).
  await until(() => mac.cloud.state.devices.reads.slice(released).some((r) => r.held === true), 30_000);
  // A call the phone queued is neither run nor refused: the log was not read since the wake (device_log_unread).
  const state = await queue("after-wake");
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(["done", "failed"]).not.toContain((await state()).status);
  // Reads land again: the removal is in, and the call, handed out again, is refused.
  mac.cloud.state.devices.hold = undefined;
  await until(async () => ["done", "failed"].includes((await state()).status), 90_000);
  expect(await state()).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
}, 180_000);

test("a device another of the person's Macs allowed is approved at its hello without asking; one waiting goes in when the allow arrives", async () => {
  const mac = await thisMac();
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === studio.device_id)).toMatchObject({ role: "mac" });
  const asked = mac.requests.length;
  // The log is read once, briefly, for a device this Mac does not know: the Studio's allow is in it.
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  const { reply } = await sayHello(mac.relay, mac.relay.open(), phone);
  expect(reply.result).toMatchObject({ status: "approved" });
  expect(mac.requests.length).toBe(asked);
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ allowed_by: { device_id: studio.device_id, name: "Studio" } });
  // A tablet asks here; while it waits, the Studio allows it: it goes in at once, and the screen stops asking.
  const tablet = await testDevice("iPad, Safari");
  const stream = mac.relay.open();
  expect((await sayHello(mac.relay, stream, tablet)).reply.result).toMatchObject({ status: "pending" });
  await until(() => mac.requests.length === asked + 1);
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, tablet, "allow"));
  await until(() => mac.relay.replies(stream).some((r) => r.method === "device.status" && (r.params as { status: string }).status === "approved"), 15_000);
  expect((await mac.local.call("device.list", {})).requests).toEqual([]);
  // A statement by a key this Mac never allowed approves nothing.
  const stranger = await testDevice("Someone's Mac", "mac");
  const mallory = await testDevice("Mallory's phone");
  mac.cloud.state.devices.inject("user-1", await signedBy(stranger, mac.cloud, mallory, "allow"));
  expect((await sayHello(mac.relay, mac.relay.open(), mallory)).reply.result).toMatchObject({ status: "pending" });
}, 120_000);

test("a removal by another of the person's Macs ends the device's open gates at once, and its queued calls are refused (T8)", async () => {
  const mac = await thisMac();
  await mac.local.call("settings.set", { request_id: "sync-on", settings: { sync_chats: true } });
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  const open = await allowedStream(mac.relay, mac.local, phone);
  await until(() => mac.cloud.state.chats.summaries.has(mac.workspace.session_id), 20_000);
  const queue = async (request_id: string) => {
    const call = { session_id: mac.workspace.session_id, request_id, method: "turn.submit", params: { session_id: mac.workspace.session_id, kind: "followup", input: { text: request_id } } };
    const person = (method: string, route: string, body?: unknown) =>
      fetch(`${mac.cloud.url}/api/v1/code/${route}`, { method, headers: { authorization: `Bearer ${mac.cloud.state.personToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json() as Promise<{ status: string; error?: { code?: string } }>);
    await person("POST", `chats/${call.session_id}/calls`, { request_id, method: call.method, params: call.params, device: await signCall(phone, call) });
    await until(async () => ["done", "failed"].includes((await person("GET", `chats/${call.session_id}/calls/${request_id}`)).status), 30_000);
    return person("GET", `chats/${call.session_id}/calls/${request_id}`);
  };
  expect((await queue("before")).status).toBe("done");
  const removedAt = Date.now();
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  await until(() => streamClosed(mac.relay, open.stream), 10_000);
  expect(Date.now() - removedAt).toBeLessThan(10_000);
  expect((await mac.local.call("device.list", {})).blocked.find((b) => b.device_id === phone.device_id)).toMatchObject({ removed_by: { device_id: studio.device_id, name: "Studio" } });
  expect(await queue("after")).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "refused" });
  // Unblock here lifts it on this Mac only: it asks again, and this screen's Allow lets it in here.
  await mac.local.call("device.remove", { request_id: "unblock", device_id: phone.device_id });
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "pending" });
  await mac.local.call("device.allow", { request_id: "again", device_id: phone.device_id });
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ name: "iPhone, Safari" });
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === phone.device_id)).not.toHaveProperty("shared");
}, 120_000);

test("a phone that says it is a Mac without this Mac's code is never asked about; with it, Allow keeps the name it was allowed under (T7, decision 31)", async () => {
  const mac = await thisMac();
  const signer = await testDevice("Test Mac", "mac");
  // A phone allowed on a v1 hello (before v2, or a challenge whose offer Cloud stripped): no kind kept.
  const pair = await newDeviceKeyPair();
  const phone = await webCryptoDeviceKey({ ...pair, name: "iPhone, Safari" });
  await allowedStream(mac.relay, mac.local, phone, mac.relay.open(), { hello: { v1: true } });
  const asked = mac.requests.length;
  // A page Cloud serves on it says, signed, that it is a Mac, under the name of the person's real Mac or its own: it is
  // served as the phone it was allowed as, and the screen is never asked.
  for (const name of ["Julius's MacBook Pro", "iPhone, Safari"])
    expect((await sayHello(mac.relay, mac.relay.open(), await webCryptoDeviceKey({ ...pair, name, kind: "mac" }))).reply.result).toMatchObject({ status: "approved" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(mac.requests.length).toBe(asked);
  expect((await mac.local.call("device.list", {})).requests).toEqual([]);
  // Joining with the code (the person typed it there): asked about as this screen allowed it, its stored name and key.
  const posing = await webCryptoDeviceKey({ ...pair, name: "Julius's MacBook Pro", kind: "mac" });
  expect((await sayHello(mac.relay, mac.relay.open(), posing, { pair: await pairingCodeOn(mac.local) })).reply.result).toMatchObject({ status: "pending" });
  await until(() => mac.requests.length === asked + 1);
  expect((await mac.local.call("device.list", {})).requests.find((r) => r.device_id === phone.device_id)).toMatchObject({ name: "iPhone, Safari", public_key: phone.public_key, role: "mac" });
  // An Allow signed under another name is refused; the one the screen showed keeps the stored name.
  const renamed = await signStatement(signer, {
    kind: "allow",
    organization_id: mac.cloud.state.organizationId,
    user_id: "user-1",
    device_id: phone.device_id,
    public_key: phone.public_key,
    name: "Julius's MacBook Pro",
    role: "mac",
  });
  expect(await reasonOf(mac.local.call("device.allow", { request_id: "renamed", device_id: phone.device_id, role: "mac", statement: renamed }))).toBe("invalid_params");
  const statement = await allowStatement(mac.local, signer, phone.device_id);
  expect(statement).toMatchObject({ name: "iPhone, Safari", role: "mac" });
  await mac.local.call("device.allow", { request_id: "as-shown", device_id: phone.device_id, role: "mac", statement });
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ name: "iPhone, Safari", role: "mac", shared: true });
}, 120_000);

test("a request another Mac removed or allowed stops asking at once, with no stream open: the removed device stays out", async () => {
  const mac = await thisMac();
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  // The phone asks here, then gives up waiting: no open stream holds its request.
  const phone = await testDevice("iPhone, Safari");
  const stream = mac.relay.open();
  expect((await sayHello(mac.relay, stream, phone)).reply.result).toMatchObject({ status: "pending" });
  mac.relay.close(stream);
  // The Studio removes it: the request goes with it, so the screen no longer asks (no Don't allow is left to click,
  // which would read as an Unblock of that removal here), and its hello is refused.
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  await until(async () => (await mac.local.call("device.list", {})).blocked.some((b) => b.device_id === phone.device_id && b.removed_by?.name === "Studio"), 15_000);
  expect((await mac.local.call("device.list", {})).requests).toEqual([]);
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "refused" });
  // A tablet asks and gives up; the Studio allows it: its request goes, and its next hello is approved without asking.
  const tablet = await testDevice("iPad, Safari");
  const waiting = mac.relay.open();
  expect((await sayHello(mac.relay, waiting, tablet)).reply.result).toMatchObject({ status: "pending" });
  mac.relay.close(waiting);
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, tablet, "allow"));
  await until(async () => (await mac.local.call("device.list", {})).requests.length === 0, 15_000);
  expect((await sayHello(mac.relay, mac.relay.open(), tablet)).reply.result).toMatchObject({ status: "approved" });
}, 120_000);

test("a call a removed phone queued while This Mac slept waits for a fresh read of the log, and is then refused (T8)", async () => {
  const clock = { now: Date.now() };
  const mac = await thisMac({ clock });
  await mac.local.call("settings.set", { request_id: "sync-on", settings: { sync_chats: true } });
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  await until(() => mac.cloud.state.chats.summaries.has(mac.workspace.session_id), 20_000);
  const person = (method: string, route: string, body?: unknown) =>
    fetch(`${mac.cloud.url}/api/v1/code/${route}`, { method, headers: { authorization: `Bearer ${mac.cloud.state.personToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json() as Promise<{ status: string; error?: { code?: string } }>);
  const queue = async (request_id: string) => {
    const call = { session_id: mac.workspace.session_id, request_id, method: "turn.submit", params: { session_id: mac.workspace.session_id, kind: "followup", input: { text: request_id } } };
    await person("POST", `chats/${call.session_id}/calls`, { request_id, method: call.method, params: call.params, device: await signCall(phone, call) });
    return () => person("GET", `chats/${call.session_id}/calls/${request_id}`);
  };
  // The Mac falls asleep mid-read, and every read from now on hangs (Cloud away, or the Mac's network not back yet).
  const reads = mac.cloud.state.devices.reads.length;
  mac.cloud.state.devices.hold = () => true;
  mac.cloud.state.devices.inject("user-1", "nothing");
  await until(() => mac.cloud.state.devices.reads.slice(reads).some((r) => r.held === true), 30_000);
  // Meanwhile the Studio removes the phone, and the phone queues a call for the Mac's wake.
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "remove"));
  clock.now += 60_000;
  const held = mac.cloud.state.devices.reads.length;
  const state = await queue("while-asleep");
  // Woken, the Mac reads the log before it answers the call; the read hangs, so the call is neither run nor refused.
  await until(() => mac.cloud.state.devices.reads.slice(held).some((r) => r.held === true), 30_000);
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(["done", "failed"]).not.toContain((await state()).status);
  // The log is read again: the removal is in it, and the call, handed out again, is refused.
  mac.cloud.state.devices.hold = undefined;
  await until(async () => ["done", "failed"].includes((await state()).status), 90_000);
  expect(await state()).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
}, 180_000);

test("a Cloud without the device log costs a hello no read once it said so", async () => {
  const clock = { now: Date.now() };
  const mac = await thisMac({ clock });
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(mac.relay, mac.local, phone);
  mac.cloud.state.devices.absent = 404;
  // The Mac slept: the phone's hello reads the log first, and Cloud says it has none.
  clock.now += 60_000;
  const before = mac.cloud.state.devices.reads.length;
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  await until(() => mac.cloud.state.devices.reads.slice(before).some((r) => r.absent === true), 10_000);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  // Slept again (within the 5 minutes Cloud's answer stands): the next hello reads nothing, and is approved.
  clock.now += 60_000;
  const after = mac.cloud.state.devices.reads.length;
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(mac.cloud.state.devices.reads.length).toBe(after);
}, 120_000);

test("a page Cloud carries again at once is not taken twice, and the next read waits a moment (T12)", async () => {
  const mac = await thisMac();
  const studio = await testDevice("Studio", "mac");
  await allowedStream(mac.relay, mac.local, studio);
  const phone = await testDevice("iPhone, Safari");
  mac.cloud.state.devices.inject("user-1", await signedBy(studio, mac.cloud, phone, "allow"));
  expect((await sayHello(mac.relay, mac.relay.open(), phone)).reply.result).toMatchObject({ status: "approved" });
  // Cloud ignores the wait and answers every read at once with the whole log again, numbered as before.
  mac.cloud.state.devices.replay = true;
  mac.cloud.state.devices.inject("user-1", "nothing");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const before = mac.cloud.state.devices.reads.filter((r) => r.runtime_id === mac.runtimeId).length;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  // About one read a second (a tight loop would make hundreds), and nothing it carried again changed anything.
  expect(mac.cloud.state.devices.reads.filter((r) => r.runtime_id === mac.runtimeId).length - before).toBeLessThanOrEqual(8);
  mac.cloud.state.devices.replay = false;
  expect((await mac.local.call("device.list", {})).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ allowed_by: { name: "Studio" } });
}, 120_000);
