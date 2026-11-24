// How the runtime runs mutating calls (CONTRACT §6, G13/G14): a chat's calls from one connection run in the order they
// arrived (send, then stop, stops what was sent), and a call whose asker left still finishes once, so the asker's
// retry from another connection gets its answer at once instead of waiting on a call nobody ends. A chat's attaches and
// detaches on one connection apply in the order they arrived too, even while another write holds the store, and an
// attach still under way when its connection closes leaves nothing behind. Slow work beside a chat (Record a skill,
// Push, Open PR) keeps that order but never holds up the chat's Stop or answers.
import * as fs from "node:fs";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";

import { liveOutboxes } from "./server.ts";
import { SkillWriter } from "./services.ts";
import * as Store from "./store.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-order-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let sqlClient: SqlClient.SqlClient | undefined;
let sessions: Store.SessionStore["Service"] | undefined;
/**
 * The store's own SqlClient, so a test can hold its one writer as a commit in progress does, and the route's own store
 * (Store.layer is memoized: one instance).
 */
const captureSql = Layer.effectDiscard(
  Effect.gen(function* () {
    sqlClient = yield* SqlClient.SqlClient;
    sessions = yield* Store.SessionStore;
  }),
).pipe(Layer.provide(Store.layer));

/** Record a skill's writer (an LLM call over the whole transcript): it writes until the test lets it go, then gives up. */
let skillWriting = false;
let finishSkill: () => void = () => undefined;
const skillWritten = new Promise<void>((resolve) => (finishSkill = resolve));
const slowSkillWriter = Layer.succeed(SkillWriter, {
  write: () =>
    Effect.promise(() => ((skillWriting = true), skillWritten)).pipe(Effect.andThen(Effect.fail(new Error("the test ended the writer")))),
});

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: Layer.mergeAll(captureSql, slowSkillWriter) as never });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  finishSkill();
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function rawClient() {
  const ws = new WebSocket(runtime.url, ["caveman.session.v1"], { headers: { authorization: `Bearer ${runtime.token()}` } });
  const frames: Array<{ id?: number; method?: string; params?: any; result?: any; error?: any }> = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
  let next = 1;
  const send = (method: string, params: unknown) => {
    const id = next++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  };
  const answer = async (id: number, ms = 20_000) => {
    await until(() => frames.some((f) => f.id === id), ms);
    return frames.find((f) => f.id === id)!;
  };
  return { ws, frames, send, answer };
}

/** Holds the runtime's one SQLite writer, as another chat's commit does while it streams, until the returned release. */
async function holdWriter() {
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = Effect.runPromise(sqlClient!.withTransaction(Effect.promise(() => (entered(), released))));
  await inside;
  return async () => {
    release();
    await done;
  };
}

/** Live subscriptions to the store's committed events: every attachment holds one (Effect's PubSub counts them on its tail). */
const eventSubscriptions = () => (sessions!.events as unknown as { pubsub: { publisherTail: { subscribers: number } } }).pubsub.publisherTail.subscribers;

/** The chat's events a raw connection heard from frame `from` on, as `cursor:type`. */
const heardAfter = (frames: ReadonlyArray<{ method?: string; params?: any }>, from: number, sessionId: string) =>
  frames
    .slice(from)
    .filter((f) => f.method === "session.event" || f.method === "session.events")
    .flatMap((f) => (f.method === "session.event" ? [f.params] : f.params.events))
    .filter((e: SessionEvent) => e.session_id === sessionId)
    .map((e: SessionEvent) => `${e.cursor}:${e.type}`);

/** A chat that has finished its start, a client following it, and its head. */
async function followedChat(label: string) {
  const repo = makeRepo(root, { "README.md": `${label}\n` });
  const w = await createReady(client, { request_id: `w-${label}`, repo: { path: repo }, title: label, engine: "claude-agent", options: { model: MODEL } });
  const watched: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => watched.push(e));
  const head = (await client.call("workspace.get", { workspace_id: w.id })).head ?? 0;
  /** One turn, until the following client has seen it end. */
  const turn = async (text: string) => {
    const before = watched.length;
    await client.call("turn.submit", { request_id: `t-${label}`, session_id: w.session_id, kind: "followup", input: { text } });
    await until(() => watched.slice(before).some((e) => e.type === "turn.done"), 30_000);
  };
  return { w, head, turn };
}

test("a chat's calls on one connection run in the order they arrived: a send after a restore finds the chat restored", async () => {
  const repo = makeRepo(root, { "README.md": "order\n" });
  const w = await createReady(client, { request_id: "w-order", repo: { path: repo }, title: "Order", engine: "claude-agent", options: { model: MODEL } });
  await client.call("workspace.archive", { request_id: "o-archive", workspace_id: w.id });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const raw = await rawClient();
  try {
    // Back to back, in one tick: the send must not overtake the restore (it would find the chat archived).
    const restored = raw.send("workspace.restore", { request_id: "o-restore", workspace_id: w.id });
    const sent = raw.send("turn.submit", { request_id: "o-send", session_id: w.session_id, kind: "followup", input: { text: "sent after the restore" } });
    const [restoreAnswer, sendAnswer] = [await raw.answer(restored, 30_000), await raw.answer(sent, 30_000)];
    expect(restoreAnswer.error).toBeUndefined();
    expect(sendAnswer.error).toBeUndefined();
    expect(raw.frames.findIndex((f) => f.id === restored)).toBeLessThan(raw.frames.findIndex((f) => f.id === sent));
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    // Reads are not held behind them.
    const listed = raw.send("workspace.list", {});
    expect((await raw.answer(listed)).error).toBeUndefined();
  } finally {
    raw.ws.close();
  }
}, 60_000);

test("a call whose connection closed mid-call runs once, and its retry on a new connection is answered at once", async () => {
  const repo = makeRepo(root, { "README.md": "once\n" });
  const first = await rawClient();
  const params = { request_id: "once-1", repo: { path: repo }, title: "Asked once", engine: "claude-agent", options: { model: MODEL } };
  first.send("workspace.create", params);
  // The tab closes (or the phone loses signal) while the runtime works on it.
  first.ws.terminate();
  const second = await rawClient();
  try {
    const started = Date.now();
    const answer = await second.answer(second.send("workspace.create", params), 15_000);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(answer.error).toBeUndefined();
    const again = await second.answer(second.send("workspace.create", params));
    expect(again.result.id).toBe(answer.result.id);
    const listed = (await client.call("workspace.list", {})).workspaces.filter((x) => x.title === "Asked once");
    expect(listed.map((x) => x.id)).toEqual([answer.result.id]);
    // A retry with other params is refused, not run.
    const conflict = await second.answer(second.send("workspace.create", { ...params, title: "Something else" }));
    expect(conflict.error.data.reason).toBe("request_id_conflict");
  } finally {
    second.ws.close();
  }
}, 60_000);

test("a request_id reused with other params while the first call runs is refused, never answered with the first call's chat", async () => {
  const [repoA, repoB] = [makeRepo(root, { "README.md": "a\n" }), makeRepo(root, { "README.md": "b\n" })];
  const [a, b] = [await rawClient(), await rawClient()];
  try {
    const base = { request_id: "reused-1", engine: "claude-agent", options: { model: MODEL } };
    // Back to back from two connections of one person: whichever arrives second finds the first still making its worktree.
    const sentA = a.send("workspace.create", { ...base, repo: { path: repoA }, title: "Reused A" });
    const sentB = b.send("workspace.create", { ...base, repo: { path: repoB }, title: "Reused B" });
    const answers = { "Reused A": await a.answer(sentA, 30_000), "Reused B": await b.answer(sentB, 30_000) };
    const made = Object.entries(answers).filter(([, answer]) => answer.error === undefined);
    expect(Object.values(answers).map((answer) => answer.error?.data?.reason ?? "ok").sort()).toEqual(["ok", "request_id_conflict"]);
    expect(made.map(([title, answer]) => answer.result.title === title)).toEqual([true]);
    const listed = (await client.call("workspace.list", {})).workspaces.filter((x) => x.title.startsWith("Reused "));
    expect(listed.map((x) => x.title)).toEqual(made.map(([title]) => title));
  } finally {
    a.ws.close();
    b.ws.close();
  }
}, 60_000);

// The client's reattach (after a journal_reset, a reconnect or a gap) and, when its last subscriber lets go meanwhile,
// the session.detach right behind it. The attach reads the store before it takes its place; the detach reads nothing.
test("a detach sent right behind an attach on one connection stops the chat's events there, even while the store is busy", async () => {
  const { w, head, turn } = await followedChat("attach-detach");
  const raw = await rawClient();
  try {
    const release = await holdWriter();
    const attached = raw.send("session.attach", { session_id: w.session_id, cursor: head, batch: true });
    const detached = raw.send("session.detach", { session_id: w.session_id });
    // Another chat's detach waits on nothing: once it is answered, the runtime has read the two frames before it.
    await raw.answer(raw.send("session.detach", { session_id: "s-elsewhere" }));
    await release();
    const [attachAnswer, detachAnswer] = [await raw.answer(attached), await raw.answer(detached)];
    expect(attachAnswer.error).toBeUndefined();
    expect(detachAnswer.error).toBeUndefined();
    const answeredAt = raw.frames.length;
    await turn("after the detach");
    await raw.answer(raw.send("session.detach", { session_id: "s-elsewhere" }));
    expect(heardAfter(raw.frames, answeredAt, w.session_id)).toEqual([]);
    expect(raw.frames.filter((f) => f.id === attached || f.id === detached).map((f) => f.id)).toEqual([attached, detached]);
  } finally {
    raw.ws.close();
  }
}, 90_000);

// Two subscribers on one client attach at about the same time (two panes on one chat, a remount): two session.attach
// frames for one chat. The later one replaces the earlier, and the earlier is still answered.
test("two attaches of one chat on one connection are both answered, in the order sent, and its events come once", async () => {
  const { w, head, turn } = await followedChat("attach-twice");
  const raw = await rawClient();
  try {
    const release = await holdWriter();
    const first = raw.send("session.attach", { session_id: w.session_id, cursor: head, batch: true });
    const second = raw.send("session.attach", { session_id: w.session_id, cursor: head, batch: true });
    await raw.answer(raw.send("session.detach", { session_id: "s-elsewhere" }));
    await release();
    expect((await raw.answer(second)).error).toBeUndefined();
    expect(raw.frames.filter((f) => f.id === first || f.id === second).map((f) => f.id)).toEqual([first, second]);
    const answeredAt = raw.frames.length;
    await turn("after both attaches");
    await until(() => heardAfter(raw.frames, answeredAt, w.session_id).some((e) => e.endsWith(":turn.done")), 30_000);
    const heard = heardAfter(raw.frames, answeredAt, w.session_id);
    expect(heard.map((e) => Number(e.split(":")[0]))).toEqual(Array.from({ length: heard.length }, (_, i) => head + 1 + i));
  } finally {
    raw.ws.close();
  }
}, 90_000);

// The tab closes while the runtime still reads the store for a session.attach it sent (another chat's commit holds the
// one writer). The close ends the connection's attachments; the attach must not take one after it, which nothing would
// ever end: it would hear every chat's events until the runtime stops.
test("an attach still reading the store when its connection closes leaves no attachment behind", async () => {
  const { w, head } = await followedChat("attach-close");
  const baseline = eventSubscriptions();
  // What the count measures: one attachment's subscription, gone with its connection.
  const shown = await rawClient();
  expect((await shown.answer(shown.send("session.attach", { session_id: w.session_id, cursor: head }))).error).toBeUndefined();
  expect(eventSubscriptions()).toBe(baseline + 1);
  shown.ws.close();
  await until(() => eventSubscriptions() === baseline);

  const before = new Set(liveOutboxes);
  const raw = await rawClient();
  await until(() => [...liveOutboxes].some((outbox) => !before.has(outbox)));
  const outbox = [...liveOutboxes].find((o) => !before.has(o))!;
  const release = await holdWriter();
  raw.send("session.attach", { session_id: w.session_id, cursor: head });
  await raw.answer(raw.send("session.detach", { session_id: "s-elsewhere" }));
  raw.ws.close();
  // The runtime let the connection go (its outbox last) while the attach still waits on the store.
  await until(() => !liveOutboxes.has(outbox));
  await release();
  // The attach has read the store once a read queued behind it has.
  await Effect.runPromise(sessions!.getBySession(w.session_id));
  await until(() => eventSubscriptions() !== baseline, 1_000).catch(() => undefined);
  expect(eventSubscriptions()).toBe(baseline);
}, 60_000);

// Record a skill runs its writer inside the call, for as long as the LLM takes. The dialog and the pane's Stop share one
// client, so a Stop pressed meanwhile is the chat's next call on that connection: it must stop the turn now.
test("Stop answers and ends the turn while a Record a skill of that chat is still writing", async () => {
  const repo = makeRepo(root, { "README.md": "record\n" });
  const w = await createReady(client, { request_id: "w-record", repo: { path: repo }, title: "Record", engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "r-first", session_id: w.session_id, kind: "followup", input: { text: "something to record" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  const { turn_id } = await client.call("turn.submit", { request_id: "r-long", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: keep working" } });
  await until(() => events.some((e) => e.type === "turn.started" && e.turn_id === turn_id), 30_000);

  const recording = client.call("skill.record", { request_id: "r-skill", session_id: w.session_id, scope: "me" }).then(
    () => "written",
    () => "gave up",
  );
  await until(() => skillWriting, 10_000);
  const stop = client.call("turn.interrupt", { request_id: "r-stop", session_id: w.session_id }).then(() => "answered");
  const stopped = await Promise.race([stop, new Promise<string>((resolve) => setTimeout(() => resolve("waiting behind the recording"), 10_000))]);
  const turnEnded = await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === turn_id), 10_000).then(
    () => true,
    () => false,
  );
  const recordingThen = await Promise.race([recording, Promise.resolve("still writing")]);
  finishSkill();
  expect({ stopped, turnEnded, recordingThen }).toEqual({ stopped: "answered", turnEnded: true, recordingThen: "still writing" });
  expect(await recording).toBe("gave up");
}, 90_000);
