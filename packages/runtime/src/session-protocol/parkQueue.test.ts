// A parked chat runs nothing: the follow-up the person queued behind the running turn waits (its queue held, as
// Stop holds it) instead of starting on the chat once the park stops that turn. A move parks the same way, so a
// chat that moved away never starts a turn on the computer it left.
import * as fs from "node:fs";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

const root = tempRoot("sp-park-queue-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("parking a chat mid-turn holds the follow-up queued behind it", { timeout: 120_000 }, async () => {
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    const repo = makeRepo(root, { "README.md": "hello\n" });
    const w = await createReady(client, { request_id: "w", repo: { path: repo }, title: "Parks", engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: the long one" } });
    await until(async () => (await client.call("workspace.get", { workspace_id: w.id })).status === "working", 30_000);
    // Queued behind the running turn.
    await client.call("turn.submit", { request_id: "t2", session_id: w.session_id, kind: "followup", input: { text: "queued behind it" } });
    await until(async () => (await client.call("queue.list", { session_id: w.session_id })).turns.length === 1, 10_000);
    await client.call("session.park", { request_id: "p1", session_id: w.session_id });
    expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
    // Long enough for a released queue to have started its run.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes("queued behind it"))).toBe(false);
    expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
  } finally {
    client.close();
    await runtime.close();
  }
});

test("parking a chat as its turn finishes (its engine done, its checkpoint still being taken) parks it, never refused", { timeout: 300_000 }, async () => {
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    const repo = makeRepo(root, { "README.md": "hello\n" });
    const w = await createReady(client, { request_id: "w", repo: { path: repo }, title: "Parks late", engine: "claude-agent", options: { model: MODEL } });
    // Untracked files each turn's checkpoint takes in: a capture long enough for the park to land in it, where the run
    // is "waiting" and T3 refuses to interrupt it (stopAfterSend's CHAOS-7 window). A move parks the same way, so a
    // move by hand as a turn finished failed with "Run ... is not interruptible" (computerDelete.e2e, real stack).
    const scratch = `${w.root_path!}/scratch`;
    fs.mkdirSync(scratch);
    for (let i = 0; i < 2000; i++) fs.writeFileSync(`${scratch}/f${i}.txt`, `${i} ${"x".repeat(200)}\n`);
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    // Parked at a sweep of moments after the reply, so some land while the checkpoint is taken (8 of 12 did before).
    for (let n = 0; n < 12; n++) {
      fs.writeFileSync(`${scratch}/g${n}.txt`, `${n}\n`);
      if (n > 0) await client.call("session.resume", { request_id: `r${n}`, session_id: w.session_id });
      const answer = await client.call("turn.submit", { request_id: `t${n}`, session_id: w.session_id, kind: "followup", input: { text: `slow 100: finishing ${n}` } });
      await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.turn_id === answer.turn_id), 120_000);
      await new Promise((r) => setTimeout(r, n * 20));
      await client.call("session.park", { request_id: `p${n}`, session_id: w.session_id });
      expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
      await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === answer.turn_id), 120_000);
    }
    // Each turn ran once.
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(12);
  } finally {
    client.close();
    await runtime.close();
  }
});

test("parking a chat right behind a send stops the turn that send started, never refused (CHAOS-7's window)", { timeout: 300_000 }, async () => {
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    const repo = makeRepo(root, { "README.md": "hello\n" });
    const w = await createReady(client, { request_id: "w", repo: { path: repo }, title: "Parks at once", engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    // A move by hand, or the lid, right after the person sent: the turn is still preparing, with no node T3 can stop
    // yet. The park waits for it as Stop does, instead of failing the move with "Run ... is not interruptible".
    for (let n = 0; n < 6; n++) {
      if (n > 0) await client.call("session.resume", { request_id: `r${n}`, session_id: w.session_id });
      // Pipelined on one connection, as stopAfterSend's stop: the park goes out before the send's answer comes back.
      const sent = client.call("turn.submit", { request_id: `t${n}`, session_id: w.session_id, kind: "followup", input: { text: `slow 60000: just sent ${n}` } });
      const parked = client.call("session.park", { request_id: `p${n}`, session_id: w.session_id });
      const [answer] = await Promise.all([sent, parked]);
      expect(answer).toMatchObject({ disposition: "started" });
      expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
      // Its turn stopped there: it never runs on to its answer.
      await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === answer.turn_id), 60_000);
      expect(events.find((e) => e.type === "turn.done" && e.turn_id === answer.turn_id)?.payload).toMatchObject({ status: "interrupted" });
    }
  } finally {
    client.close();
    await runtime.close();
  }
});
