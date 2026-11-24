// Real-stack chaos for decision 26 (losing the network parks a chat, and it resumes), against a REAL local Caveman
// Cloud and real runtime processes (moves.e2e.kit.ts): This Mac reaches Cloud through the kit's proxy, so a test cuts
// its network; Postgres goes away as `docker pause` of the stack's own container (CAVEMAN_E2E_PG_CONTAINER, that case
// only runs when it is named). What every case holds once Caveman answers again: nothing archived on Cloud or the Mac,
// one owner at an unchanged epoch, "Back online, continuing" in each chat the lease stop paused, its tool run once,
// cursors with no gaps and no message answered twice.
//
// CAVEMAN_E2E_OFFLINE_MINUTES (default 11) and CAVEMAN_E2E_PG_PAUSE_SECONDS (default 180) set the outages. Timings are
// lab-only: Mac host processes plus OrbStack containers, not the fleet.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { cloudComputer, contiguous, labFunding, MODEL, person, proxy, REAL_STACK, recordOn, replies, retireLabComputers, runtime, sql, stopAll, transcript, waitReply, type Person, type Runtime } from "./moves.e2e.kit.ts";

const results: Record<string, unknown> = {};
afterAll(() => {
  stopAll();
  if (process.env.CAVEMAN_E2E_RESULTS) fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS.replace(/(\.json)?$/, ".offline.json"), JSON.stringify(results, null, 1));
});
const load = () => os.loadavg().map((n) => n.toFixed(2)).join(" ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFFLINE_MS = Number(process.env.CAVEMAN_E2E_OFFLINE_MINUTES ?? 11) * 60_000;
const PG = process.env.CAVEMAN_E2E_PG_CONTAINER;
const PG_PAUSE_MS = Number(process.env.CAVEMAN_E2E_PG_PAUSE_SECONDS ?? 180) * 1000;

let me: Person;
let gitEnv: Record<string, string>;
let effects = "";

beforeAll(async () => {
  if (!REAL_STACK) return;
  me = await person();
  retireLabComputers(me);
  labFunding(me);
  const root = tempRoot("offline-e2e-");
  const name = `offline-${randomUUID().slice(0, 8)}`;
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/octocat/${name}` };
  Object.assign(process.env, gitEnv);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "offline\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  effects = path.join(root, "effects.log");
  results.stack = { cloud: process.env.CAVEMAN_E2E_CLOUD_URL, label: "lab-only: Mac host processes + OrbStack containers; network loss = the kit proxy's cut; Postgres away = docker pause; not fleet" };
}, 120_000);

/** This Mac through its own proxy, lid moves on, with a clone of the repository. */
async function mac() {
  const net = await proxy();
  const repo = path.join(tempRoot("offline-mac-"), "repo");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, repo]);
  const rt = await runtime("mac", { ...gitEnv, MOVES_CLOUD_URL: net.url, MOVES_BEARER: me.access_token, MOVES_EFFECTS: effects });
  await rt.client.call("settings.set", { request_id: "moves-on", settings: { sync_chats: true, move_to_cloud: true } });
  const status = await rt.client.call("cloud.status", {});
  return { ...rt, net, repo, computerId: status.computer_id! };
}
type Mac = Awaited<ReturnType<typeof mac>>;

const owner = (sessionId: string) => sql(`SELECT w.computer_id FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id AND w.organization_id = s.organization_id WHERE s.id = '${sessionId}'`);
const cloudStatus = (sessionId: string) => sql(`SELECT w.status FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id AND w.organization_id = s.organization_id WHERE s.id = '${sessionId}'`);
const epoch = (sessionId: string) => Number(sql(`SELECT epoch FROM code_journal_index WHERE session_id = '${sessionId}'`) || 0);
const effectLines = () => (fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean).length : 0);
const notes = (events: ReadonlyArray<SessionEvent>, title: string) => events.filter((e) => e.type === "notification" && e.payload.title === title).length;
const idleOn = (rt: Runtime, sessionId: string, ms = 60_000) => until(async () => (await recordOn(rt, sessionId))?.status === "idle", ms);

/** A chat on the Mac whose first turn answered and whose copy follows in Cloud. */
async function startChat(m: Mac, title: string, text: string) {
  // Full access: its command runs without asking, as an agent left to work does.
  const w = await m.client.call("workspace.create", { request_id: `w-${randomUUID()}`, repo: { path: m.repo }, title, engine: "caveman", options: { model: MODEL, access: "full" }, task: { text } });
  await waitReply(m, w.session_id, new RegExp(`${text} \\(on mac\\)$`));
  await idleOn(m, w.session_id);
  await until(() => sql(`SELECT follow FROM code_sessions WHERE id = '${w.session_id}'`) === "t" && Number(sql(`SELECT cursor_seq FROM code_journal_index WHERE session_id = '${w.session_id}'`) || 0) > 0, 60_000);
  return w;
}

/** A turn that runs one command (a line in the effects log) and then works on until it is stopped; it holds its lease. */
async function busy(m: Mac, sessionId: string, tag: string) {
  const ran = effectLines();
  await m.client.call("turn.submit", { request_id: `busy-${tag}`, session_id: sessionId, kind: "followup", input: { text: `approve hang ${tag}` } });
  await until(async () => effectLines() > ran && (await recordOn(m, sessionId))?.status === "working", 60_000);
  await until(() => sql(`SELECT lease_runtime_id IS NOT NULL FROM code_journal_index WHERE session_id = '${sessionId}'`) === "t", 60_000);
}

/** What every resumed chat holds once Caveman answered again. */
async function resumed(m: Mac, sessionId: string, tag: string, at: { readonly epoch: number }) {
  await until(async () => notes(await transcript(m, sessionId), "Back online, continuing") === 1, 120_000);
  const events = await waitReply(m, sessionId, new RegExp(`approve hang ${tag} \\(on mac\\)$`), 120_000);
  await idleOn(m, sessionId);
  expect(contiguous(events)).toBe(true);
  expect(notes(events, "Lost the connection to Caveman")).toBe(1);
  expect(replies(events).filter((r) => r.endsWith(`approve hang ${tag} (on mac)`))).toHaveLength(1);
  expect(owner(sessionId)).toBe(m.computerId);
  expect(epoch(sessionId)).toBe(at.epoch);
  expect(cloudStatus(sessionId)).toBe("active");
  expect((await recordOn(m, sessionId))?.status).not.toBe("archived");
  return events;
}

test.skipIf(!REAL_STACK)("(o1) a Mac offline for 11 minutes: its working chat stops within the lease, nothing is archived, and once Caveman answers it resumes by itself at the same epoch, its command run once", async () => {
  const m = await mac();
  const w = await startChat(m, "Offline", "ask o0");
  await busy(m, w.session_id, "o1");
  const ran = effectLines();
  const at = { epoch: epoch(w.session_id) };
  const cut = Date.now();
  m.net.state.cut = true;
  // Within the lease the turn stops here (a turn never runs on two computers), saying why; nothing is archived.
  await until(async () => (await recordOn(m, w.session_id))?.status === "idle", 150_000);
  const stoppedAfter = Date.now() - cut;
  expect(notes(await transcript(m, w.session_id), "Lost the connection to Caveman")).toBe(1);
  while (Date.now() - cut < OFFLINE_MS) {
    expect((await recordOn(m, w.session_id))?.status).toBe("idle");
    expect(cloudStatus(w.session_id)).toBe("active");
    await sleep(30_000);
  }
  m.net.state.cut = false;
  const back = Date.now();
  await resumed(m, w.session_id, "o1", at);
  expect(effectLines()).toBe(ran);
  results.o1 = { offlineMinutes: Math.round((back - cut) / 60_000), stoppedSecondsAfterCut: Math.round(stoppedAfter / 1000), resumedSecondsAfterReconnect: Math.round((Date.now() - back) / 1000), effects: effectLines() - ran + 1, load: load() };
}, OFFLINE_MS + 600_000);

test.skipIf(!REAL_STACK || PG === undefined)("(o2) Postgres away for 3 minutes with 6 busy chats on the Mac: each stops within the lease and resumes by itself once Cloud answers, at the same epoch, its command run once; a Cloud computer's chat is observed", async () => {
  const m = await mac();
  const chats: Array<Awaited<ReturnType<typeof startChat>>> = [];
  for (let i = 1; i <= 6; i++) chats.push(await startChat(m, `Busy ${i}`, `ask p${i}`));
  // One chat on a Cloud computer, working through the outage too: what it does is reported, not judged (item 26 covers
  // the Mac's own chats).
  const away = await startChat(m, "On Cloud", "ask c0");
  await m.client.call("session.move", { request_id: "to-cloud", session_id: away.session_id, to: "cloud" });
  let boxComputer = "";
  await until(() => ((boxComputer = owner(away.session_id)), boxComputer !== "" && boxComputer !== m.computerId), 120_000);
  const root = path.join(tempRoot("offline-box-"), "workspace");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, root]);
  const box = await cloudComputer(me, boxComputer, root, { ...gitEnv, MOVES_EFFECTS: effects });
  await idleOn(box, away.session_id, 120_000);
  for (const [i, w] of chats.entries()) await busy(m, w.session_id, `p${i + 1}x`);
  await box.client.call("turn.submit", { request_id: "c1", session_id: away.session_id, kind: "followup", input: { text: `slow ${Math.round((PG_PAUSE_MS + 120_000) / 1000)} c1` } });
  await until(async () => (await recordOn(box, away.session_id))?.status === "working", 60_000);
  const ran = effectLines();
  const at = new Map(chats.map((w) => [w.session_id, epoch(w.session_id)]));
  const awayEpoch = epoch(away.session_id);
  const paused = Date.now();
  execFileSync("docker", ["pause", PG!]);
  try {
    await until(async () => (await Promise.all(chats.map((w) => recordOn(m, w.session_id)))).every((r) => r?.status === "idle"), PG_PAUSE_MS);
    const stoppedAfter = Date.now() - paused;
    while (Date.now() - paused < PG_PAUSE_MS) await sleep(5_000);
    results.o2stopped = { stoppedSecondsAfterPause: Math.round(stoppedAfter / 1000) };
  } finally {
    execFileSync("docker", ["unpause", PG!]);
  }
  const back = Date.now();
  for (const [i, w] of chats.entries()) await resumed(m, w.session_id, `p${i + 1}x`, { epoch: at.get(w.session_id)! });
  expect(effectLines()).toBe(ran);
  // The Cloud computer's chat: reported as it is.
  await sleep(30_000);
  const there = await transcript(box, away.session_id);
  results.o2 = {
    pausedSeconds: Math.round((back - paused) / 1000),
    allResumedSecondsAfterUnpause: Math.round((Date.now() - 30_000 - back) / 1000),
    cloudComputerChat: {
      status: (await recordOn(box, away.session_id))?.status,
      owner: owner(away.session_id) === boxComputer ? "its Cloud computer" : owner(away.session_id),
      epochUnchanged: epoch(away.session_id) === awayEpoch,
      interrupted: there.some((e) => e.type === "turn.done" && e.payload.status === "interrupted"),
      answered: replies(there).some((r) => r.endsWith("c1 (on cloud)")),
      notes: there.flatMap((e) => (e.type === "notification" ? [e.payload.title] : [])),
      archived: cloudStatus(away.session_id) !== "active",
    },
    load: load(),
  };
}, PG_PAUSE_MS + 900_000);
