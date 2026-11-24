// A stop that reaches the runtime right behind a send (CHAOS-4, CHAOS-7): the person's message stays in the
// transcript and its turn ends interrupted, the stop takes the newest turn (never an old one that ended), and the
// chat goes on. A message sent right after a stop runs next, whichever kind the composer sent it as.
import * as fs from "node:fs";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { stopTarget } from "./handlers.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-stop-after-send-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const userTexts = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : []));

test("a stop sent right behind a send keeps the person's message and ends its turn interrupted, each time", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await createReady(client, { request_id: "w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  // A first turn that ends: an old run a later stop must never pick.
  await client.call("turn.submit", { request_id: "t0", session_id: w.session_id, kind: "followup", input: { text: "first turn" } });
  await until(() => events.filter((e) => e.type === "turn.done").length === 1, 60_000);
  for (const n of [1, 2, 3]) {
    const text = `slow 3000: pipelined ${n}`;
    // Pipelined on one connection: the stop goes out before the send's answer comes back.
    const sent = client.call("turn.submit", { request_id: `t${n}`, session_id: w.session_id, kind: "followup", input: { text } });
    const stopped = client.call("turn.interrupt", { request_id: `i${n}`, session_id: w.session_id });
    const [answer, stop] = await Promise.all([sent, stopped]);
    expect(answer).toMatchObject({ disposition: "started" });
    expect(stop).toMatchObject({ turn_id: answer.turn_id });
    await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === answer.turn_id), 30_000);
    expect(userTexts(events).filter((t) => t === text)).toHaveLength(1);
    const done = events.find((e) => e.type === "turn.done" && e.turn_id === answer.turn_id);
    expect(done?.payload).toMatchObject({ status: "interrupted" });
    const message = events.find((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text);
    expect(message?.turn_id).toBe(answer.turn_id);
  }
  // The chat goes on: the next send runs to its end.
  await client.call("turn.submit", { request_id: "t9", session_id: w.session_id, kind: "followup", input: { text: "after the stops" } });
  await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes("after the stops")), 60_000);
  // Nothing twice: each user message once, each turn started and ended once.
  const ids = events.filter((e) => e.type === "message.done").map((e) => e.item_id);
  expect(new Set(ids).size).toBe(ids.length);
  const starts = events.filter((e) => e.type === "turn.started").map((e) => e.turn_id);
  expect(new Set(starts).size).toBe(starts.length);
}, 180_000);

test("a stop as a turn finishes (its engine done, its checkpoint still being taken) is taken, never refused (CHAOS-7)", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await createReady(client, { request_id: "f", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  // Untracked files the checkpoint takes in: a capture long enough for the stops to land in it.
  const scratch = path.join(w.root_path!, "scratch");
  fs.mkdirSync(scratch);
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(scratch, `f${i}.txt`), `${i} ${"x".repeat(200)}\n`);
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  for (const n of [1, 2]) {
    const answer = await client.call("turn.submit", { request_id: `f${n}`, session_id: w.session_id, kind: "followup", input: { text: `slow 100: finishing ${n}` } });
    // The second turn starts once the first's checkpoint has the scratch files. Git writes each new one as an object
    // file of its own: under a second on a Mac, 15 s on an idle Windows runner and 33 s with four of its cores busy.
    await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.turn_id === answer.turn_id), 120_000);
    // Stops every few milliseconds from the reply to the turn's end: each one lands in the window the turn is "waiting".
    let stops = 0;
    while (!events.some((e) => e.type === "turn.done" && e.turn_id === answer.turn_id)) {
      await client.call("turn.interrupt", { request_id: `fi${n}-${stops++}`, session_id: w.session_id });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(stops).toBeGreaterThan(0);
  }
  // The chat goes on: the next send runs.
  await client.call("turn.submit", { request_id: "f9", session_id: w.session_id, kind: "followup", input: { text: "after finishing" } });
  await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes("after finishing")), 60_000);
}, 180_000);

test("a send right behind a stop that held the queue runs, and lets the held follow-up go after it", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await createReady(client, { request_id: "h", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "h1", session_id: w.session_id, kind: "followup", input: { text: "slow 20000: long one" } });
  await until(() => userTexts(events).includes("slow 20000: long one"), 60_000);
  expect(await client.call("turn.submit", { request_id: "h2", session_id: w.session_id, kind: "followup", input: { text: "held one" } })).toMatchObject({ disposition: "queued" });
  // Pipelined: the send reaches the runtime while the stopped turn is still ending, behind the queue the stop held.
  const stopped = client.call("turn.interrupt", { request_id: "h-stop", session_id: w.session_id });
  const sent = client.call("turn.submit", { request_id: "h3", session_id: w.session_id, kind: "followup", input: { text: "right after the stop" } });
  await Promise.all([stopped, sent]);
  const replied = (text: string) => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes(text));
  await until(() => replied("right after the stop") && replied("held one"), 60_000);
  // The person's new message first, then what the stop held.
  expect(userTexts(events).filter((t) => t === "right after the stop" || t === "held one")).toEqual(["right after the stop", "held one"]);
}, 180_000);

test("Stop, then a message sent as a steer (the stopped turn still reads running): it runs next, and lets the held follow-up go after it", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await createReady(client, { request_id: "s", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const replied = (text: string) => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes(text));
  const first = await client.call("turn.submit", { request_id: "s1", session_id: w.session_id, kind: "followup", input: { text: "slow 20000: long one" } });
  // Its engine turn runs (it answered, and holds its result): a steer would reach it.
  await until(() => replied("long one"), 60_000);
  expect(await client.call("turn.submit", { request_id: "s2", session_id: w.session_id, kind: "followup", input: { text: "held one" } })).toMatchObject({ disposition: "queued" });
  expect(await client.call("turn.interrupt", { request_id: "s-stop", session_id: w.session_id })).toMatchObject({ turn_id: first.turn_id });
  // The composer still shows the turn running until its turn.done, so Enter sends a steer.
  const sent = await client.call("turn.submit", { request_id: "s3", session_id: w.session_id, kind: "steer", input: { text: "do this instead" } }).then(
    (answer) => answer.disposition,
    (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
  );
  expect(sent).toMatch(/^(queued|started)$/);
  await until(() => replied("do this instead") && replied("held one"), 60_000);
  expect(userTexts(events).filter((t) => t === "do this instead" || t === "held one")).toEqual(["do this instead", "held one"]);
}, 180_000);

test("Stop is for the newest turn not done, a starting or preparing one included, never an older run left running", () => {
  const run = (ordinal: number, status: string) => ({ id: `run:${ordinal}`, ordinal, status });
  // The first run of a chat still "waiting" (its checkpoint being taken) and a new turn starting: the new one.
  expect(stopTarget([run(1, "waiting"), run(2, "completed"), run(3, "starting")])?.id).toBe("run:3");
  expect(stopTarget([run(1, "running"), run(4, "preparing")])?.id).toBe("run:4");
  // Order in the list is not the turns' order.
  expect(stopTarget([run(5, "running"), run(2, "waiting")])?.id).toBe("run:5");
  // Queued inputs wait for the next message, and ended turns are done: nothing to stop.
  expect(stopTarget([run(1, "completed"), run(2, "queued"), run(3, "interrupted")])).toBeUndefined();
});
