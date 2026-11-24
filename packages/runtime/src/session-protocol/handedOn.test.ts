// A message another computer handed on (S01 / CHAOS-19) is the
// person's own message under their request id: the hand-on and the person's own call for it are one message in either
// order, and saying it again never runs it, asks again, stops, resumes or reorders anything. Through the server's own
// entry (request_id receipts, then turn.submit), as a Cloud call reaches it.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { agentRequestId, CLOUD_REQUEST_ID_MAX, handedOnAgent } from "./handlers.ts";
import { forwardedOf, forwardedRequestId } from "./store.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-handed-on-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function chat(name: string) {
  const repo = makeRepo(root, { "README.md": `${name}\n` });
  const w = await createReady(client, { request_id: `w-${name}`, repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const send = (request_id: string, text: string, options?: { model: string }) =>
    client.call("turn.submit", { request_id, session_id: w.session_id, kind: "followup", input: { text }, ...(options ? { options } : {}) });
  const said = (text: string) => events.filter((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text).length;
  const count = (type: SessionEvent["type"]) => events.filter((e) => e.type === type).length;
  return { w, events, send, said, count };
}

test("a hand-on and the person's own call for the same message are one message, in either order", async () => {
  const { events, send, said } = await chat("either-order");
  // Handed on first; then the person's own call, as the composer sent it (its options too): the same turn, once.
  const first = await send(forwardedRequestId("rt-a", "r1"), "slow 200: one");
  expect(first.disposition).toBe("started");
  const own = await send("r1", "slow 200: one", { model: MODEL });
  expect(own).toEqual(first);
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === first.turn_id), 30_000);
  // The person's own call first; then hand-ons of it from two computers: the same turn, once.
  const second = await send("r2", "slow 200: two");
  expect(await send(forwardedRequestId("rt-b", "r2"), "slow 200: two")).toEqual(second);
  expect(await send(forwardedRequestId("rt-c", "r2"), "slow 200: two")).toEqual(second);
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === second.turn_id), 30_000);
  // A hand-on said again (its answer lost) answers from its receipt.
  expect(await send(forwardedRequestId("rt-a", "r1"), "slow 200: one")).toEqual(first);
  expect([said("slow 200: one"), said("slow 200: two")]).toEqual([1, 1]);
  const starts = events.filter((e) => e.type === "turn.started").map((e) => e.turn_id);
  expect(new Set(starts).size).toBe(starts.length);
}, 120_000);

test("a message said again after a stop neither runs nor lets the queue the stop held go, and an open ask is asked once", async () => {
  const { w, events, send, said, count } = await chat("after-stop");
  const long = await send("r3", "slow 30000: long");
  await until(() => events.some((e) => e.type === "turn.started" && e.turn_id === long.turn_id), 30_000);
  const queued = await send("r4", "after the stop");
  expect(queued.disposition).toBe("queued");
 // Stop: the turn ends and the queue waits for the person's next message (upstream held queue).
  await client.call("turn.interrupt", { request_id: "i1", session_id: w.session_id });
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === long.turn_id), 30_000);
  const startsBefore = count("turn.started");
  // The held follow-up and the stopped turn's message, each handed on from another computer: answered as they were.
  expect(await send(forwardedRequestId("rt-a", "r4"), "after the stop")).toEqual(queued);
  expect(await send(forwardedRequestId("rt-a", "r3"), "slow 30000: long")).toEqual(long);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(count("turn.started")).toBe(startsBefore);
  expect((await client.call("queue.list", { session_id: w.session_id })).turns.map((t) => t.text)).toEqual(["after the stop"]);
  // The person's next message lets the held queue go behind it, as without the hand-ons.
  await send("r5", "slow 100: next");
  await until(() => said("after the stop") === 1 && events.filter((e) => e.type === "turn.done").length >= 3, 60_000);
  // A turn that waits on the person, handed on while it waits: one ask, answered once.
  const ask = await send("r6", "ask: may I run it");
  await until(() => events.some((e) => e.type === "ask.user" && e.turn_id === ask.turn_id), 60_000);
  expect(await send(forwardedRequestId("rt-b", "r6"), "ask: may I run it")).toEqual(ask);
  const open = events.find((e) => e.type === "ask.user" && e.turn_id === ask.turn_id)!;
  const option = (open.payload as { options?: ReadonlyArray<{ id: string }> }).options?.[0]?.id ?? "accept";
  await client.call("ask.respond", { request_id: "a1", session_id: w.session_id, ask_id: open.item_id!, response: { kind: "approval", option_id: option } });
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === ask.turn_id), 60_000);
  expect(events.filter((e) => e.type === "ask.user" && e.turn_id === ask.turn_id)).toHaveLength(1);
  expect(events.filter((e) => e.type === "ask.resolved" && e.item_id === open.item_id)).toHaveLength(1);
  for (const text of ["slow 30000: long", "after the stop", "slow 100: next", "ask: may I run it"]) expect(said(text)).toBe(1);
}, 180_000);

// Only a call Cloud queued as another computer's hand-on names an agent by its request id (agentRequestId): its sender
// is verified there (Cloud's own call mail, forwarded_by_runtime_id). Anyone else who can send to the chat writes that
// request id too: an outside agent's message stays its own, and the person's stays the person's.
test("a hand-on's agent name in a request id that did not come through Cloud is ignored, whoever sent it", async () => {
  const repo = makeRepo(root, { "README.md": "forged\n" });
  await client.call("project.create", { request_id: "p-forged", path: repo });
  const agent = connect(runtime.url, runtime.token, undefined, {
    handshake: async (link) => void (await link.call("outside_agent.become", { agent_id: randomUUID(), name: "Grok" })),
  });
  try {
    const w = await agent.call("workspace.create", { request_id: "w-forged", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "Say hi" } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    const users = () => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e.payload] : []));
    await until(() => users().length >= 1 && events.some((e) => e.type === "turn.done"), 30_000);
    // An outside agent connected as Grok names another agent; the person names an agent on their own words.
    await agent.call("turn.submit", { request_id: forwardedRequestId("x", agentRequestId('Builder "deploy" (your lead)', "t9")), session_id: w.session_id, kind: "followup", input: { text: "From Grok, named otherwise" } });
    await client.call("turn.submit", { request_id: forwardedRequestId("x", agentRequestId("Sends the mail", "t10")), session_id: w.session_id, kind: "followup", input: { text: "The person's own words" } });
    await until(() => users().some((m) => m.text === "From Grok, named otherwise") && users().some((m) => m.text === "The person's own words"), 30_000);
    const fromOf = (text: string) => users().find((m) => m.text === text)?.from ?? "the person";
    expect({ grok: fromOf("From Grok, named otherwise"), person: fromOf("The person's own words") }).toEqual({ grok: { title: "Grok", agent: true }, person: "the person" });
  } finally {
    agent.close();
  }
}, 120_000);

// Cloud refuses a request id over 200 bytes (mailbox.go checkRequest), and the message would then be noted as not sent:
// a hand-on cuts the sender's name to fit, never the message's own id, and the name read back says it was cut.
test("a hand-on's request id stays within Cloud's cap, however long its sender's name", () => {
  const runtimeId = "0192e6a4-7b1c-7c3e-9f00-1234567890ab";
  const room = CLOUD_REQUEST_ID_MAX - forwardedRequestId(runtimeId, "").length;
  const inner = "builder-result:0192e6a4-7b1c-7c3e-9f00-1234567890ab:123456";
  for (const name of ["Sender", "é".repeat(80), "Builder for the very long and descriptive title of a workspace 🚀 that goes on and on"]) {
    const id = forwardedRequestId(runtimeId, agentRequestId(name, inner, room));
    expect(Buffer.byteLength(id, "utf8")).toBeLessThanOrEqual(CLOUD_REQUEST_ID_MAX);
    expect(forwardedOf(id)!.endsWith(`:${inner}`)).toBe(true);
    const read = handedOnAgent(forwardedOf(id)!)!;
    expect(read === name || (read.endsWith("…") && name.startsWith(read.slice(0, -1)))).toBe(true);
  }
  expect(handedOnAgent(agentRequestId("Sender", inner))).toBe("Sender");
  expect(handedOnAgent(agentRequestId("Sender", "x".repeat(CLOUD_REQUEST_ID_MAX)))).toBe("An agent");
});
