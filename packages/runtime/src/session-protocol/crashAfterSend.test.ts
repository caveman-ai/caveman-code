// A kill -9 at any moment after the runtime accepted a send (CHAOS-4): the person's message survives the restart,
// once. A send stopped right away and then killed shows the message and its turn ends interrupted; a follow-up
// queued behind a stopped turn still waits in the queue. The runtime is a real process (the chaos harness's
// chaos.runtime.ts, without a Cloud link) on one state dir, killed at a spread of moments after the stop.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";

import { createReady, makeRepo, MODEL, tempRoot, until } from "./testHarness.ts";

const RUNTIME = fileURLToPath(new URL("../cloudLink/chaos/chaos.runtime.ts", import.meta.url));
const base = tempRoot("sp-crash-after-send-");
const children: Array<ChildProcess> = [];
afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  fs.rmSync(base, { recursive: true, force: true });
});

/** The runtime on `base`'s state, as the app's server starts it (settling what a crash left open first). */
async function start() {
  const out = path.join(base, "out.json");
  fs.rmSync(out, { force: true });
  const log = fs.openSync(path.join(base, "runtime.log"), "a");
  const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
    env: { ...process.env, CHAOS_BASE: path.join(base, "state"), CHAOS_OUT: out, CHAOS_PARENT: String(process.pid), CLAUDE_CONFIG_DIR: path.join(base, "claude") },
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  children.push(child);
  await until(() => fs.existsSync(out) || child.exitCode !== null, 120_000);
  const info = JSON.parse(fs.readFileSync(out, "utf8")) as { url: string; token: string };
  const client = connect(info.url, info.token);
  const kill = async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    client.close();
  };
  return { client, kill };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const userTexts = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : []));

test("a kill -9 at any moment after a send and its stop keeps the person's message, once, and ends its turn", async () => {
  const repo = makeRepo(base, { "README.md": "hi\n" });
  let runtime = await start();
  const w = await createReady(runtime.client, { request_id: "w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  // Killed right as the stop is sent, and at moments after it: before the turn's run started, while T3 ends it,
  // after it ended.
  for (const [n, delay] of [0, 5, 20, 60, 150, 400].entries()) {
    const text = `slow 3000: cut off ${n}`;
    const sent = runtime.client.call("turn.submit", { request_id: `t${n}`, session_id: w.session_id, kind: "followup", input: { text } });
    const stopped = runtime.client.call("turn.interrupt", { request_id: `i${n}`, session_id: w.session_id }).catch(() => undefined);
    const answer = await sent;
    if (delay > 0) await sleep(delay);
    void stopped;
    await runtime.kill();
    runtime = await start();
    const events: Array<SessionEvent> = [];
    await runtime.client.attach(w.session_id, 0, (e) => events.push(e));
    // Its turn ends (the stop, or the restart's recovery), with the person's message in the transcript.
    await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === answer.turn_id), 30_000);
    expect(userTexts(events).filter((t) => t === text), `kill ${delay} ms after the stop`).toHaveLength(1);
    expect(events.find((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text)?.turn_id).toBe(answer.turn_id);
  }

  // A follow-up queued behind a running turn, the turn stopped (the stop holds the queue), then a kill -9: the
  // follow-up still waits, and the next send runs it.
  let events: Array<SessionEvent> = [];
  await runtime.client.attach(w.session_id, 0, (e) => events.push(e));
  await runtime.client.call("turn.submit", { request_id: "q0", session_id: w.session_id, kind: "followup", input: { text: "slow 3000: running" } });
  await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === "slow 3000: running"), 30_000);
  const queued = await runtime.client.call("turn.submit", { request_id: "q1", session_id: w.session_id, kind: "followup", input: { text: "queued behind it" } });
  expect(queued).toMatchObject({ disposition: "queued" });
  await runtime.client.call("turn.interrupt", { request_id: "q-stop", session_id: w.session_id });
  await runtime.kill();
  runtime = await start();
  events = [];
  await runtime.client.attach(w.session_id, 0, (e) => events.push(e));
  await until(async () => (await runtime.client.call("queue.list", { session_id: w.session_id })).turns.some((t) => t.text === "queued behind it"), 30_000);
  await runtime.client.call("turn.submit", { request_id: "q2", session_id: w.session_id, kind: "followup", input: { text: "and then this" } });
  await until(() => ["queued behind it", "and then this"].every((t) => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes(t))), 60_000);
  for (const t of ["queued behind it", "and then this"]) expect(userTexts(events).filter((x) => x === t)).toHaveLength(1);
  await runtime.kill();
}, 400_000);
