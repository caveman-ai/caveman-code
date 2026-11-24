// A lid move cut short (its last copy failed as the Mac fell asleep: Cloud busy, or every call timed out across the
// sleep) never leaves the chat paused: it stays parked, and the move is made again once the Mac is awake, so the turn
// goes on on a Cloud computer (K5). A chat Cloud took while the Mac slept, which its Cloud computer then cannot adopt,
// is handed back to the Mac, which takes it (two-phase moves: one owner that can run it). A Mac killed while the lid's
// move is on its way finishes it at the next start (CHAOS-17). Against the test Cloud, the runtime in-process on the
// stand-in claude (a real process where it is killed).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { startTestCloud } from "./testCloud.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A send whose text has `marker` waits between submit's checks and T3 while `held` is pending (a busy machine's). */
const sends = { marker: "", held: Promise.resolve(), waiting: 0 };
const holdingSends = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const real = yield* Orchestrator.OrchestratorV2;
    return Orchestrator.OrchestratorV2.of({
      ...real,
      dispatch: (command) =>
        command.type === "message.dispatch" && sends.marker !== "" && command.text.includes(sends.marker)
          ? Effect.sync(() => sends.waiting++).pipe(Effect.andThen(Effect.promise(() => sends.held)), Effect.andThen(real.dispatch(command)))
          : real.dispatch(command),
    });
  }),
);

test("a lid move whose last copy did not land is made once the Mac is awake, never left paused", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const mac = connect(runtime.url, runtime.token);
  cleanups.push(() => mac.close());
  await mac.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true, move_to_cloud: true } });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("lid-retry-"), { "README.md": "lid\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/lid-retry.git"], { cwd: repo });
  const w = await createReady(mac, { request_id: "w1", repo: { path: repo }, title: "Sleeps mid-copy", engine: "claude-agent", options: { model: MODEL } });
  const chats = cloud.state.chats;
  await until(() => chats.summaries.has(w.session_id), 20_000);
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  await mac.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: keep going after the lid" } });
  await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
  // The lid's last copy cannot land (Cloud's segment store is down as the Mac falls asleep, or every call times out
  // across the sleep).
  chats.down.segments = 503;
  const out = await mac.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
  // Counted as on its way, parked here (nothing runs), never resumed here as paused.
  expect(out.handed_off).toEqual([w.session_id]);
  expect((await mac.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
  // A device's send in the move's window is told the chat moved (its sender then queues it in Cloud, CHAOS-15), never
  // "the session is parked; call session.resume first".
  const sent = await mac.call("turn.submit", { request_id: "t-moving", session_id: w.session_id, kind: "followup", input: { text: "sent while it moves" } }).then(
    () => "ran",
    (e: { error?: { data?: { reason?: string } }; message?: string }) => `${e.error?.data?.reason}: ${e.message}`,
  );
  expect(sent).toBe("lease_lost: This chat moved to another computer.");
  delete chats.down.segments;
  // Awake (or the lid done closing): the move is made, the copy whole first, and Cloud takes the chat.
  await until(async () => (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "caveman_cloud", 150_000);
  expect(chats.sessions.get(w.session_id)).toMatchObject({ computer_id: box.computerId });
  const last = chats.sessions.get(w.session_id)!.segments.at(-1)!;
  expect(last).toMatchObject({ boundary: true });
  expect((last.body as { interrupted?: boolean }).interrupted).toBe(true);
  // Never resumed here in between (the old code gave up on the timeout and the chat carried on paused).
  expect(events.some((e) => e.type === "session.resumed")).toBe(false);
  // And it comes back to this Mac the same way as a lid move that landed at once (Cloud's list names it).
  expect(chats.sessions.get(w.session_id)?.returns_to).toBeDefined();
});

test("a chat Cloud took while the Mac slept, which its Cloud computer then cannot adopt, comes back to the Mac", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const mac = connect(runtime.url, runtime.token);
  cleanups.push(() => mac.close());
  await mac.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("reassign-"), { "README.md": "home\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/reassign.git"], { cwd: repo });
  const w = await createReady(mac, { request_id: "w1", repo: { path: repo }, title: "Taken while asleep", engine: "claude-agent", options: { model: MODEL } });
  const chats = cloud.state.chats;
  await until(() => (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0 && chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  // A turn first, so the copy carries the chat's engine and model.
  await mac.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "remember theta" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  await until(() => chats.copyOf(w.session_id).some((e) => e.type === "turn.done") && chats.summaries.get(w.session_id)?.status !== "working", 30_000);
  // The Mac sleeps (no heartbeat, its lease gone): the person's move goes ahead without it. This Mac never let the chat
  // go, so it holds no move of its own for it.
  cloud.state.skewMs = 3 * 60_000;
  const person = (method: string, route: string, body?: unknown, token = cloud.state.personToken) =>
    fetch(`${cloud.url}/api/v1/code/${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect((await person("POST", `chats/${w.session_id}/move`, { to: { computer_id: box.computerId } })).status).toBe(200);
  const move = [...chats.moves.values()].find((m) => m.session_id === w.session_id && m.committed)!;
  expect(move.target).toBe(box.computerId);
  // Awake again, the Mac sees it is gone as soon as it acts on it (a turn there cannot take the chat's lease).
  await mac.call("turn.submit", { request_id: "t-awake", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: typed as the Mac wakes" } });
  await until(async () => (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "caveman_cloud", 120_000);
  // Awake, the Mac is up to Cloud again (its heartbeats go on): what it typed, forwarded to the chat wherever it is, never
  // sends a chat handed back to it off to a Cloud computer as one whose Mac sleeps.
  cloud.state.skewMs = 0;
  // The Cloud computer cannot adopt it (its copy does not read there): Cloud hands it back to its source.
  expect((await person("POST", `runtime/moves/${move.move_id}`, { phase: "adopt", ok: false, code: "cave_code_adopt_failed", message: "The copy did not read." }, box.token)).status).toBe(204);
  // The Mac takes its own chat back (the old Mac refused it as a move it never asked for, leaving it with no owner).
  await until(async () => (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "this_mac", 60_000);
  await until(() => move.answers.length === 2, 30_000);
  expect(move.answers.map((a) => [a.phase, a.ok])).toEqual([
    ["adopt", false],
    ["adopt", true],
  ]);
  expect(move.reassigned).toBe("source");
  expect(chats.sessions.get(w.session_id)?.computer_id).not.toBe(box.computerId);
  await until(() => events.some((e) => JSON.stringify(e).includes("Back on this computer")), 30_000);
});

test("a copy naming another chat's workspace here is refused where it lands, never written over that chat", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude");
  cleanups.push(runtime.close);
  const mac = connect(runtime.url, runtime.token);
  cleanups.push(() => mac.close());
  await mac.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repoOf = (name: string) => {
    const repo = makeRepo(tempRoot(`forged-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], { cwd: repo });
    return repo;
  };
  const other = await createReady(mac, { request_id: "w0", repo: { path: repoOf("other") }, title: "Another chat", engine: "claude-agent", options: { model: MODEL } });
  const w = await createReady(mac, { request_id: "w1", repo: { path: repoOf("forged") }, title: "Forged copy", engine: "claude-agent", options: { model: MODEL } });
  const chats = cloud.state.chats;
  await until(() => (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0 && chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  await mac.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "remember iota" } });
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  await until(() => chats.copyOf(w.session_id).some((e) => e.type === "turn.done") && chats.summaries.get(w.session_id)?.status !== "working", 30_000);
  // The person moves it to a Cloud computer while the Mac sleeps.
  cloud.state.skewMs = 3 * 60_000;
  const person = (method: string, route: string, body?: unknown, token = cloud.state.personToken) =>
    fetch(`${cloud.url}/api/v1/code/${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect((await person("POST", `chats/${w.session_id}/move`, { to: { computer_id: box.computerId } })).status).toBe(200);
  const move = [...chats.moves.values()].find((m) => m.session_id === w.session_id && m.committed)!;
  await mac.call("turn.submit", { request_id: "t-awake", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: typed as the Mac wakes" } });
  await until(async () => (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "caveman_cloud", 120_000);
  // Awake, the Mac is up to Cloud again, as in the test above.
  cloud.state.skewMs = 0;
  // Whoever held the chat last wrote its copy (a Cloud computer, running agent code): its last segment names the
  // other chat's workspace on the Mac. Then that computer hands the chat back.
  const segments = chats.sessions.get(w.session_id)!.segments;
  const last = segments.at(-1)!;
  const body = JSON.parse(gunzipSync(last.raw).toString("utf8")) as { record: { workspace: { id: string } } };
  body.record.workspace.id = other.id;
  segments[segments.length - 1] = { ...last, raw: gzipSync(JSON.stringify(body)), body };
  expect((await person("POST", `runtime/moves/${move.move_id}`, { phase: "adopt", ok: false, code: "cave_code_adopt_failed", message: "The copy did not read." }, box.token)).status).toBe(204);
  // The Mac refuses it at once, and the other chat is as it was (the old adopt went on to write this chat's record
  // over that one's, and broke half way).
  await until(() => move.answers.length === 2, 60_000);
  expect(move.answers.map((a) => [a.phase, a.ok, a.code])).toEqual([
    ["adopt", false, "cave_code_adopt_failed"],
    ["adopt", false, "cave_code_copy_not_movable"],
  ]);
  expect(await mac.call("workspace.get", { workspace_id: other.id })).toMatchObject({ session_id: other.session_id, title: "Another chat" });
});

test("a Mac killed while the lid's move is on its way runs the chat again at the next start when Cloud still places it there (CHAOS-17)", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  // This Mac as a real process on one state dir (the chaos harness's runtime), killed -9 and started again.
  const base = tempRoot("lid-crash-");
  const children: Array<ChildProcess> = [];
  cleanups.push(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const start = async () => {
    const out = path.join(base, "out.json");
    fs.rmSync(out, { force: true });
    const log = fs.openSync(path.join(base, "runtime.log"), "a");
    const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(new URL("./chaos/chaos.runtime.ts", import.meta.url))], {
      env: { ...process.env, CHAOS_BASE: path.join(base, "state"), CHAOS_OUT: out, CHAOS_PARENT: String(process.pid), CHAOS_ROLE: "mac", CHAOS_CLOUD_URL: cloud.url, CHAOS_BEARER: cloud.state.personToken, CLAUDE_CONFIG_DIR: path.join(base, "claude") },
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
  };
  let mac = await start();
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true, move_to_cloud: true } });
  const repo = makeRepo(tempRoot("lid-crash-repo-"), { "README.md": "crash\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/lid-crash.git"], { cwd: repo });
  const w = await createReady(mac.client, { request_id: "w1", repo: { path: repo }, title: "Killed mid-move", engine: "claude-agent", options: { model: MODEL } });
  const chats = cloud.state.chats;
  await until(() => chats.summaries.has(w.session_id), 20_000);
  await mac.client.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "slow 60000: working as the lid closes" } });
  await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
  // Cloud keeps this chat on the Mac (as an idle one, released), and its answer to the lid's handoff is slow: the Mac
  // dies before it hears it.
  chats.delay.handoff = 60_000;
  chats.sessions.get(w.session_id)!.movable_flag = false;
  const lid = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 2_000 });
  expect(lid.handed_off).toEqual([w.session_id]);
  // Parked here, its turn stopped, the copy still on its way.
  await until(async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "parked", 20_000);
  const beforeCrash = await mac.client.call("workspace.get", { workspace_id: w.id });
  const beforeEpoch = beforeCrash.epoch ?? 0;
  expect(beforeEpoch).toBeGreaterThan(0);
  await mac.kill();
  delete chats.delay.handoff;
  // Cloud still places the chat on this Mac.
  expect(chats.sessions.get(w.session_id)?.computer_id).not.toBe(undefined);
  expect(chats.computers.get(chats.sessions.get(w.session_id)!.computer_id)?.kind ?? "laptop").toBe("laptop");
  let releaseEpoch!: () => void;
  chats.epochGate = new Promise<void>((resolve) => { releaseEpoch = resolve; });
  cleanups.push(() => releaseEpoch());
  mac = await start();
  // It runs here again (the old Mac kept it parked for good, refusing every send).
  await until(async () => {
    const now = await mac.client.call("workspace.get", { workspace_id: w.id });
    return now.computer.kind === "this_mac" && now.status !== "parked";
  }, 60_000);
  // Resumed placement is visible before the synced journal has recovered. No send may bypass that guard.
  await expect(mac.client.call("turn.submit", { request_id: "t-too-early", session_id: w.session_id, kind: "followup", input: { text: "before recovery" } })).rejects.toThrow(/waiting for Caveman/);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(beforeEpoch);
  releaseEpoch();
  await until(async () => ((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch ?? 0) > beforeEpoch, 60_000);
  expect(chats.epochBumps).toContainEqual({ session_id: w.session_id, epoch: beforeEpoch + 1, why: "rebuild" });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  expect(events.some((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === "before recovery")).toBe(false);
  await mac.client.call("turn.submit", { request_id: "t2", session_id: w.session_id, kind: "followup", input: { text: "after the crash" } });
  await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text.includes("after the crash")), 60_000);
  await mac.kill();
});

test("a lid move a send is still on its way into keeps the chat here, its turn stopped and Cloud told it is kept", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: holdingSends });
  cleanups.push(runtime.close);
  const mac = connect(runtime.url, runtime.token);
  cleanups.push(() => mac.close());
  await mac.call("cloud.enroll", { request_id: "e1", cloud_url: cloud.url, token: cloud.state.personToken, name: "Test Mac" });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true, move_to_cloud: true } });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("lid-landing-"), { "README.md": "lid\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/lid-landing.git"], { cwd: repo });
  const w = await createReady(mac, { request_id: "w1", repo: { path: repo }, title: "A send on its way in", engine: "claude-agent", options: { model: MODEL } });
  const chats = cloud.state.chats;
  await until(() => chats.summaries.has(w.session_id), 20_000);
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  await mac.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "slow 120000: working as the lid closes" } });
  await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
  // A send past submit's checks that T3 does not take in for as long as the move waits for it.
  let release!: () => void;
  sends.held = new Promise<void>((resolve) => (release = resolve));
  sends.marker = "stuck on its way in";
  cleanups.push(() => release());
  const sent = mac.call("turn.submit", { request_id: "t-stuck", session_id: w.session_id, kind: "followup", input: { text: "slow 50: stuck on its way in" } }).then(
    () => "taken",
    (e: Error) => e.message,
  );
  await until(() => sends.waiting > 0, 30_000);
  await mac.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
  // The send had its time (30 s from when the lid's move began): the lid keeps the chat here, paused as any chat it
  // does not move, its turn stopped and Cloud told it is kept, never left working here while Cloud waits for it.
  await until(() => events.some((e) => e.type === "notification" && e.payload.title === "Paused when the lid closed"), 90_000);
  await until(() => events.some((e) => e.type === "turn.done" && e.payload.status === "interrupted"), 30_000);
  await until(() => cloud.state.heartbeats.some((h) => h.kept?.includes(w.session_id) === true), 30_000);
  const kept = await mac.call("workspace.get", { workspace_id: w.id });
  expect(kept.computer.kind).toBe("this_mac");
  expect(kept.status).not.toBe("parked");
  release();
  await sent;
});
