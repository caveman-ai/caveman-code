// Calls a device queued in Cloud reach the chat's runtime (CONTRACT §3, §6, S5, S7): taken off one long poll as soon as
// Cloud has them, run as the person with the device's request id, so a send that also came over the relay runs once;
// on This Mac only for a device the person approved. And a client that only watches keeps no computer awake.
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { connect, signCall, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, describe, expect, it, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { DeviceApproval } from "./calls.ts";
import { ACTIVE_AFTER_CHANGE_MS, inUse } from "./index.ts";
import { allowedStream } from "../session-protocol/devices.testkit.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A call over a relayed stream from a device This Mac allowed (S13, sealed frames). */
async function rpc(device: Awaited<ReturnType<typeof allowedStream>>, method: string, params: unknown) {
  const reply = await device.call(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as Record<string, any>;
}

const person = async (cloud: Awaited<ReturnType<typeof startTestCloud>>, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${cloud.url}/api/v1/code/${path}`, {
    method,
    headers: { authorization: `Bearer ${cloud.state.personToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, any>;
};

/** This Mac with sync and Remote control on, a chat synced, and a relayed client of the person attached to it. */
async function macWithChat(approved: boolean) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: Layer.succeed(DeviceApproval, { approved: (id: string | undefined) => Effect.succeed(approved && id === "phone-1") }) as Layer.Layer<any> });
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await local.call("settings.set", { request_id: "s1", settings: { sync_chats: true, remote_control: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const repo = makeRepo(tempRoot("calls-repo-"), { "README.md": "hello\n" });
  const w = await createReady(local, { request_id: "w1", repo: { path: repo }, title: "Queued", engine: "claude-agent", options: { model: MODEL } });
  await until(() => cloud.state.chats.summaries.has(w.session_id), 20_000);
  const events: Array<SessionEvent> = [];
  await local.attach(w.session_id, 0, (e) => events.push(e));
  return { cloud, local, w, events };
}

test("a send queued in Cloud and also sent over the relay runs once, taken off the long poll as soon as Cloud has it", async () => {
  const { cloud, local, w, events } = await macWithChat(true);
  // The runtime holds its wait before anything is queued.
  await until(() => cloud.state.chats.waits.some((x) => x.channel === "call"), 20_000);
  const device = await allowedStream(cloud.state.relays[0]!, local);
  const params = { session_id: w.session_id, kind: "followup", input: { text: "said once, sent twice" } };
  const queuedAt = Date.now();
  const queued = await person(cloud, "POST", `chats/${w.session_id}/calls`, { request_id: "send-1", method: "turn.submit", params, device_id: "phone-1" });
  expect(queued.status).toBe("queued");
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/send-1`)).status === "done", 20_000);
  const tookMs = Date.now() - queuedAt;
  // The same send over the relay (the phone got through after all): answered from the receipt, not run again.
  await rpc(device, "turn.submit", { request_id: "send-1", ...params });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  await new Promise((r) => setTimeout(r, 1_000));
  const said = events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text.includes("said once, sent twice"));
  expect(said).toHaveLength(1);
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  const done = await person(cloud, "GET", `chats/${w.session_id}/calls/send-1`);
  expect(done).toMatchObject({ status: "done" });
  expect(cloud.state.chats.callResults.filter((r) => r.ok)).toHaveLength(1);
  // Off the long poll, not a 30 s poll.
  expect(tookMs).toBeLessThan(10_000);
  // The chat's copy carries the call's receipt (M-8): a computer it moves to answers the same call again, never runs it.
  const receiptsOf = () => (cloud.state.chats.sessions.get(w.session_id)?.segments.at(-1)?.body as { receipts?: Array<{ principal: string; method: string; request_id: string }> } | undefined)?.receipts ?? [];
  await until(() => receiptsOf().some((r) => r.request_id === "send-1"), 30_000);
  expect(receiptsOf().find((r) => r.request_id === "send-1")).toMatchObject({ principal: "cloud:user-1", method: "turn.submit" });
}, 120_000);

test("on This Mac a queued call from a device the person has not approved does not run", async () => {
  const { cloud, local, w, events } = await macWithChat(false);
  await person(cloud, "POST", `chats/${w.session_id}/calls`, { request_id: "send-2", method: "turn.submit", params: { session_id: w.session_id, kind: "followup", input: { text: "from a stranger" } }, device_id: "phone-9" });
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/send-2`)).status === "failed", 20_000);
  expect((await person(cloud, "GET", `chats/${w.session_id}/calls/send-2`)).error).toMatchObject({ code: "device_not_approved" });
  expect(events.some((e) => e.type === "turn.started")).toBe(false);
  // A device this Mac allowed on its own screen (devices.ts) gets its queued send run.
  const phone = await allowedStream(cloud.state.relays[0]!, local);
  const asked = { session_id: w.session_id, request_id: "send-3", method: "turn.submit", params: { session_id: w.session_id, kind: "followup", input: { text: "from the allowed phone" } } };
  // Signed by the allowed phone: it runs. The same call with another phone's id and no valid signature does not.
  const forged = { device_id: phone.device.device_id, at: new Date().toISOString(), signature: "AAAA" };
  await person(cloud, "POST", `chats/${w.session_id}/calls`, { request_id: "send-4", method: "turn.submit", params: asked.params, device: forged });
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/send-4`)).status === "failed", 20_000);
  await person(cloud, "POST", `chats/${w.session_id}/calls`, { request_id: asked.request_id, method: asked.method, params: asked.params, device: await signCall(phone.device, asked) });
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/send-3`)).status === "done", 20_000);
}, 120_000);

describe("activity (S7)", () => {
  it("is a turn, a hosted run, a held desktop or a change within the window; an open connection is none of them", () => {
    const now = 1_000_000;
    const idle = { busy: false, working: false, desktopHeld: false, lastChangeAt: 0, now };
    expect(inUse(idle)).toBe(false);
    expect(inUse({ ...idle, busy: true })).toBe(true);
    expect(inUse({ ...idle, working: true })).toBe(true);
    expect(inUse({ ...idle, desktopHeld: true })).toBe(true);
    expect(inUse({ ...idle, lastChangeAt: now - 1_000 })).toBe(true);
    expect(inUse({ ...idle, lastChangeAt: now - ACTIVE_AFTER_CHANGE_MS - 1 })).toBe(false);
  });

  it("a relayed client attached to an idle chat keeps it idle; a change it makes is activity", async () => {
    const { cloud, local, w } = await macWithChat(true);
    const device = await allowedStream(cloud.state.relays[0]!, local);
    // The setup's own changes (sign-in, settings, the new chat, allowing the phone) count for their window: wait until
    // the link says idle.
    await until(() => cloud.state.heartbeats.at(-1)?.active === false, ACTIVE_AFTER_CHANGE_MS + 45_000);
    await rpc(device, "session.attach", { session_id: w.session_id, cursor: 0 });
    await rpc(device, "workspace.inbox", { request_id: "seen-1", workspace_id: w.id, action: { do: "seen", through: new Date().toISOString() } });
    const watched = cloud.state.heartbeats.length;
    // The link beats as it sees activity start: watching and reading start none.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(cloud.state.heartbeats.slice(watched).some((h) => h.active)).toBe(false);
    await rpc(device, "workspace.rename", { request_id: "rename-1", workspace_id: w.id, title: "Renamed from the phone" });
    await until(() => cloud.state.heartbeats.slice(watched).some((h) => h.active), 10_000);
  }, 180_000);
});
