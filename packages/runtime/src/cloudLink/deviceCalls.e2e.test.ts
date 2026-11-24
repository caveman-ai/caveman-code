// A send queued in Cloud for a chat on This Mac, end to end (S13, correctness review X-2): the web's own sender and
// device hooks sign it with the phone's key, the test Cloud keeps and delivers it, and the Mac runs it only because a
// device it allowed signed exactly that call. An unsigned one, or one past its window, does not run, and says why.
import { connect, queuedCallFields, type DeviceKey, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";

import { allowedStream, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The web app's modules, as the browser runs them: loaded at run time, outside this package's typecheck (DOM types).
const web = (path: string) => import(/* @vite-ignore */ new URL(`../../../../apps/web/src/state/${path}`, import.meta.url).href);

interface WebSender {
  send(sessionId: string, method: string, params: { request_id: string }, route: { via: "cloud" }): Promise<unknown>;
}

async function webSender(cloud: Awaited<ReturnType<typeof startTestCloud>>, phone: DeviceKey): Promise<WebSender> {
  const [{ ChatSender }, { cloudApi }, { kvOutbox }, { memoryKv }, { installDeviceHooks }, { deviceHooks }, { onlyPage }] = await Promise.all([
    web("sync/sender.ts"),
    web("sync/cloud-api.ts"),
    web("sync/outbox.ts"),
    web("sync/kv.ts"),
    web("device-approval.ts"),
    web("sync/device-hooks.ts"),
    web("sync/pages.ts"),
  ]);
  // What the app installs as it starts (runtime.tsx), with this phone's key.
  installDeviceHooks({ kindOf: () => "laptop", device: async () => phone });
  return new ChatSender({
    api: cloudApi({ base: cloud.url, headers: async () => ({ authorization: `Bearer ${cloud.state.personToken}` }), renew: async () => false, credentials: "omit" }),
    outbox: kvOutbox(memoryKv(), "cloud", onlyPage()),
    callFields: (call: unknown) => deviceHooks().callFields(call),
  }) as WebSender;
}

const person = async (cloud: Awaited<ReturnType<typeof startTestCloud>>, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${cloud.url}/api/v1/code/${path}`, {
    method,
    headers: { authorization: `Bearer ${cloud.state.personToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, any>;
};

test("a send the web queues in Cloud runs on This Mac for a device the Mac allowed; unsigned or expired ones do not, and say why", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const local = connect(runtime.url, runtime.token);
  cleanups.push(() => local.close());
  await local.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await local.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  await until(async () => (await local.call("cloud.status", {})).state === "connected", 15_000);
  const repo = makeRepo(tempRoot("device-calls-repo-"), { "README.md": "hello\n" });
  const w = await createReady(local, { request_id: "w1", repo: { path: repo }, title: "Queued from the phone", engine: "claude-agent", options: { model: MODEL } });
  await until(() => cloud.state.chats.summaries.has(w.session_id), 20_000);
  const events: Array<SessionEvent> = [];
  await local.attach(w.session_id, 0, (e) => events.push(e));

  // The phone, allowed once on the Mac's own screen.
  const phone = await testDevice("iPhone, Safari");
  await allowedStream(cloud.state.relays[0]!, local, phone);
  const sender = await webSender(cloud, phone);

  // Sent through Cloud's queue, with a field the page left undefined (gone after Cloud's JSON, so not signed either).
  await sender.send(w.session_id, "turn.submit", { request_id: "queued-1", session_id: w.session_id, kind: "followup", input: { text: "queued from the phone", attachments: undefined } } as never, { via: "cloud" });
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/queued-1`)).status === "done", 30_000);
  await until(() => events.some((e) => e.type === "message.done" && JSON.stringify(e).includes("queued from the phone")), 30_000);

  // The same call queued without the phone's signature (a stolen Cloud session): refused as unapproved, never run.
  const bare = { session_id: w.session_id, kind: "followup", input: { text: "queued by someone else" } };
  await person(cloud, "POST", `chats/${w.session_id}/calls`, { request_id: "queued-2", method: "turn.submit", params: bare });
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/queued-2`)).status === "failed", 30_000);
  expect((await person(cloud, "GET", `chats/${w.session_id}/calls/queued-2`)).error).toMatchObject({ code: "device_not_approved" });

  // Signed by the phone a day ago: it waited too long, and says that, not that the phone is unknown.
  const old = { session_id: w.session_id, request_id: "queued-3", method: "turn.submit", params: { session_id: w.session_id, kind: "followup", input: { text: "from yesterday" } } };
  const fields = await queuedCallFields(phone, old, Date.now() - 24 * 60 * 60 * 1000);
  await person(cloud, "POST", `chats/${w.session_id}/calls`, { request_id: old.request_id, method: old.method, params: old.params, ...fields });
  await until(async () => (await person(cloud, "GET", `chats/${w.session_id}/calls/queued-3`)).status === "failed", 30_000);
  expect((await person(cloud, "GET", `chats/${w.session_id}/calls/queued-3`)).error).toMatchObject({ code: "call_expired" });
  await new Promise((r) => setTimeout(r, 300));
  expect(events.some((e) => JSON.stringify(e).includes("queued by someone else") || JSON.stringify(e).includes("from yesterday"))).toBe(false);
}, 180_000);
