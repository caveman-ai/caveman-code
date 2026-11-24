// ask.user / ask.respond onto upstream runtime requests: the engine asks to run a
// command (access "ask"), the workspace needs input, the answer reaches the
// engine, and a second answer is refused. Real Claude adapter and SDK on
// scripts/smoke-claude.mjs.
import * as fs from "node:fs";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-asks-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an approval asks, the answer reaches the engine, a second answer is refused", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const changes: Array<Workspace> = [];
  client.on("workspace.changed", (w) => changes.push(w));
  const w = await client.call("workspace.create", { request_id: "w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));

  for (const [round, option, word] of [[1, "accept", "allowed"], [2, "decline", "denied"]] as const) {
    await client.call("turn.submit", { request_id: `t${round}`, session_id: w.session_id, kind: "followup", input: { text: `ask: round ${round}` } });
    await until(() => events.filter((e) => e.type === "ask.user").length === round);
    const ask = events.filter((e) => e.type === "ask.user").at(-1)!;
    expect(ask.payload).toMatchObject({ kind: "approval" });
    if (ask.type !== "ask.user" || ask.payload.kind !== "approval") throw new Error("not an approval");
    expect(ask.payload.options.map((o) => [o.id, o.decision])).toContainEqual(["accept", "allow"]);
    expect(ask.payload.options.map((o) => o.decision)).toContain("deny");
    // It names the Bash call it waits on, so the card can show the command (Claude raises it under the tool use's id).
    const waitsOn = events.filter((e) => e.type === "tool.started" && e.cursor < ask.cursor).at(-1);
    expect(waitsOn?.payload).toMatchObject({ kind: "command", title: "echo smoke" });
    expect(ask.payload.tool_item_id).toBe(waitsOn!.item_id);
    await until(() => changes.some((c) => c.id === w.id && c.status === "needs_input"));
    expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("needs_input");

    await client.call("ask.respond", { request_id: `r${round}`, session_id: w.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id: option } });
    await until(() => events.filter((e) => e.type === "turn.done").length === round, 30_000);
    const resolved = events.find((e) => e.type === "ask.resolved" && e.item_id === ask.item_id);
    expect(resolved?.payload).toMatchObject({ outcome: "answered" });
    const answer = events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").at(-1);
    expect(answer?.type === "message.done" && answer.payload.text).toBe(`smoke ok: ${word} round ${round}`);
    const refused = await client
      .call("ask.respond", { request_id: `again${round}`, session_id: w.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id: "accept" } })
      .then(() => "ok", (e: { error?: { data?: { reason?: string } } }) => e.error?.data?.reason);
    expect(refused).toBe("invalid_state");
  }

  const tool = events.find((e) => e.type === "tool.started" && e.turn_id !== undefined);
  expect(tool?.payload).toMatchObject({ kind: "command", title: "echo smoke" });
  expect(events.some((e) => e.type === "tool.done" && e.item_id === tool!.item_id)).toBe(true);
  expect(events.map((e) => e.cursor)).toEqual(events.map((_, i) => i + 1));
  await until(() => changes.some((c) => c.id === w.id && c.status === "idle" && changes.indexOf(c) > changes.findIndex((x) => x.status === "needs_input")));
});

test("a deny can carry a note: the call that asked reads it, the turn goes on, and the note shows as the person's (T3's #23657)", async () => {
  const repo = makeRepo(root, { "README.md": "note\n" });
  const w = await client.call("workspace.create", { request_id: "w-note", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "t-note", session_id: w.session_id, kind: "followup", input: { text: "ask: round 7" } });
  await until(() => events.some((e) => e.type === "ask.user"));
  const ask = events.find((e) => e.type === "ask.user")!;
  // Claude Agent's approvals take one.
  expect(ask.payload).toMatchObject({ kind: "approval", accepts_feedback: true });
  const reason = (response: unknown) =>
    client
      .call("ask.respond", { request_id: `bad-${Math.random()}`, session_id: w.session_id, ask_id: ask.item_id!, response: response as never })
      .then(() => "ok", (e: { error?: { data?: { reason?: string } } }) => e.error?.data?.reason);
  // A note goes only with a deny, and says something; the ask still waits after both refusals.
  expect(await reason({ kind: "approval", option_id: "accept", feedback: "go ahead" })).toBe("invalid_params");
  expect(await reason({ kind: "approval", option_id: "decline", feedback: "   " })).toBe("invalid_params");
  expect(events.some((e) => e.type === "ask.resolved")).toBe(false);

  await client.call("ask.respond", { request_id: "r-note", session_id: w.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id: "decline", feedback: "Print it with printf instead" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  expect(events.find((e) => e.type === "ask.resolved" && e.item_id === ask.item_id)?.payload).toMatchObject({ outcome: "answered", response: { kind: "approval", option_id: "decline" } });
  // The Bash call read the note as its refusal, and the agent went on in the same turn.
  const answer = events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").at(-1);
  expect(answer?.type === "message.done" && answer.payload.text).toBe("smoke ok: denied (Print it with printf instead) round 7");
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  // The note is in the chat as the person's words, after the ask; no new prompt went to the agent.
  const note = events.find((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === "Print it with printf instead");
  expect(note?.cursor).toBeGreaterThan(ask.cursor);
});

test("an approval takes only an option it offered: another decision is refused, and the ask still waits for the person's answer", async () => {
  const repo = makeRepo(root, { "README.md": "offered\n" });
  const w = await client.call("workspace.create", { request_id: "w-offered", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "t-offered", session_id: w.session_id, kind: "followup", input: { text: "ask: round 3" } });
  await until(() => events.some((e) => e.type === "ask.user"));
  const ask = events.find((e) => e.type === "ask.user")!;
  if (ask.type !== "ask.user" || ask.payload.kind !== "approval") throw new Error("not an approval");
  // Claude Agent offers a one-time allow and a deny, never a standing grant.
  expect(ask.payload.options.map((o) => o.id)).toEqual(["accept", "decline"]);
  const answer = (option_id: string) =>
    client
      .call("ask.respond", { request_id: `offered-${option_id}`, session_id: w.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id } })
      .then(() => "ok", (e: { error?: { data?: { reason?: string } } }) => e.error?.data?.reason);
  expect(await answer("acceptAlways")).toBe("invalid_params");
  expect(await answer("acceptForSession")).toBe("invalid_params");
  expect(events.some((e) => e.type === "ask.resolved")).toBe(false);

  expect(await answer("accept")).toBe("ok");
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  expect(events.find((e) => e.type === "ask.resolved" && e.item_id === ask.item_id)?.payload).toMatchObject({ outcome: "answered", response: { kind: "approval", option_id: "accept" } });
  const said = events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").at(-1);
  expect(said?.type === "message.done" && said.payload.text).toBe("smoke ok: allowed round 3");
});

test("two answers to one ask at the same instant, from two devices: exactly one goes through, the other hears it was answered (K3)", async () => {
  const repo = makeRepo(root, { "README.md": "race\n" });
  // Six devices at once (the race window is the time between reading the ask and the engine recording the answer).
  const others = Array.from({ length: 5 }, () => connect(runtime.url, runtime.token));
  try {
    const w = await client.call("workspace.create", { request_id: "w-race", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t-race", session_id: w.session_id, kind: "followup", input: { text: "ask: round 9" } });
    await until(() => events.some((e) => e.type === "ask.user"));
    const ask = events.find((e) => e.type === "ask.user")!;
    const answer = (via: ReturnType<typeof connect>, request_id: string, option_id: string) =>
      via
        .call("ask.respond", { request_id, session_id: w.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id } })
        .then(() => "ok", (e: { error?: { data?: { reason?: string }; message?: string } }) => `${e.error?.data?.reason}: ${e.error?.message}`);
    const outcomes = await Promise.all([answer(client, "phone", "accept"), ...others.map((via, i) => answer(via, `web-${i}`, i % 2 === 0 ? "decline" : "accept"))]);
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "ok")).toEqual(Array.from({ length: 5 }, () => "invalid_state: this ask was already answered"));
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    expect(events.filter((e) => e.type === "ask.resolved" && e.item_id === ask.item_id)).toHaveLength(1);
  } finally {
    for (const via of others) via.close();
  }
});
