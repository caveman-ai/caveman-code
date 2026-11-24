// What a client is sent for two Claude Agent turns from a Windows install's report, through the real
// runtime, Claude adapter and Agent SDK, with the stand-in CLI (scripts/smoke-claude.mjs) streaming text as the real one
// does: a turn that answers, runs three tool calls, then signs off sends both replies whole, in their place around the
// calls; and a reply a steer cuts off mid-stream is withdrawn (finished empty) rather than kept as a half line.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
/** What the stand-in CLI wrote (SMOKE_CLAUDE_TRACE): when it has streamed a reply, whatever the client was shown of it. */
let trace: string;
const streamedByCli = () =>
  fs.existsSync(trace)
    ? fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { what: string; frame: { type?: string; event?: { type?: string; message?: { id: string }; delta?: { text?: string } } } })
    : [];

beforeAll(async () => {
  root = tempRoot("sp-reply-shape-");
  trace = path.join(root, "claude-trace.ndjson");
  process.env.SMOKE_CLAUDE_TRACE = trace;
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The assistant's replies as a client ends up with them: each item's last message.done. */
const replies = (events: ReadonlyArray<SessionEvent>) => {
  const last = new Map<string, string>();
  for (const e of events) if (e.type === "message.done" && e.payload.role === "assistant" && e.item_id) last.set(e.item_id, e.payload.text);
  return last;
};

test("an answer, three tool calls and a sign-off reach the client in that order, both replies whole", async () => {
  const w = await client.call("workspace.create", { request_id: "w-shape", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  // Long enough to stream past the secret scrub's hold-back (secrets.ts), as a real answer does.
  const answer =
    "I'm the Chief for your Caveman Code setup. I coordinate your work: you type notes, and I sort each one, answering quick questions, queueing things for later, or starting chats that do the actual coding in your projects. I don't write or run code myself; the chats do that, and I keep you posted when something's ready.";
  await client.call("turn.submit", { request_id: "t-shape", session_id: w.session_id, kind: "followup", input: { text: `chief-shape: ${answer}` } });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);

  // Both replies whole, each its own item: the streamed answer completed by its snapshot, not cut or merged.
  const said = [...replies(events)].filter(([, text]) => text.trim() !== "");
  expect(said.map(([, text]) => text)).toEqual([answer, "All set. Let me know what you'd like to work on."]);
  // In order: the answer, the three calls, the sign-off.
  // (The chat's worktree setup is a row of its own, before the turn.)
  const order = events.flatMap((e) => (e.type === "tool.started" && !e.item_id?.startsWith("worktree:") ? ["tool"] : e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.trim() ? ["reply"] : []));
  expect(order).toEqual(["reply", "tool", "tool", "tool", "reply"]);
}, 90_000);

test("a reply a steer cuts off mid-stream is withdrawn; the turn answers the steer", async () => {
  const w = await client.call("workspace.create", { request_id: "w-cut", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  // As long as a real first sentence and a half, so it streams to the client before the steer.
  const partial =
    "I'm the Chief for your Caveman Code setup. You type notes to me, and I sort each one: I answer quick questions, queue things for later, and start chats that do the coding in your projects. When one of them";
  const running = await client.call("turn.submit", { request_id: "t-cut", session_id: w.session_id, kind: "followup", input: { text: `steer-cut: ${partial}` } });
  // The CLI has streamed the half reply (and holds it, unfinished) before the steer arrives.
  const cutMessage = () => {
    const frames = streamedByCli().filter((f) => f.what === "out" && f.frame.type === "stream_event");
    const start = frames.findLast((f) => f.frame.event?.type === "message_start");
    const text = frames.slice(frames.indexOf(start!)).map((f) => f.frame.event?.delta?.text ?? "").join("");
    return start && text === partial ? start.frame.event!.message!.id : undefined;
  };
  await until(() => cutMessage() !== undefined, 30_000);
  const steered = await client.call("turn.submit", { request_id: "t-steer", session_id: w.session_id, kind: "steer", input: { text: "s" } });
  expect(steered).toEqual({ turn_id: running.turn_id, disposition: "steered" });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);

  const final = replies(events);
  // The cut-off item ends empty: nothing kept of the half line (its item is the streamed block's, `<message>:text:0`).
  const cutItem = [...final.keys()].find((id) => id.includes(encodeURIComponent(`${cutMessage()}:text:0`)));
  expect(cutItem).toBeDefined();
  expect(final.get(cutItem!)).toBe("");
  // What the person reads: the steer's answer, and nothing that starts like the half line.
  const shown = [...final.values()].filter((text) => text.trim() !== "");
  expect(shown).toEqual(["smoke ok: s"]);
  expect(events.find((e) => e.type === "turn.done")?.payload).toMatchObject({ status: "completed" });
}, 90_000);
