// The lid, end to end, against a REAL local Caveman Cloud (moves.e2e.kit.ts): "close my laptop and it continues on
// Cloud; open it and it comes back", every way it can go. Each case has its own Mac (a real runtime process enrolled
// through a proxy, so the test can cut its network; asleep is SIGSTOP, awake SIGCONT, gone SIGKILL), its own chat on
// the real Caveman engine with a scripted model, and the Cloud computers Cloud picks for it (real runtime processes
// enrolled by SQL, the computers service's part). The lid is the desktop's own onLidClose.
//
// The cases: (a) idle at the lid, then the phone's message while the Mac sleeps; (b) mid-turn; (c) mid-approval;
// (d) no network at the lid; (e) woken after more than 20 s, the chat back by itself 30 s after, once idle; (f) the
// worktree edited while away; (g) two quick lid cycles; (h) a Mac that never comes back; (i) work in progress past
// what a segment holds (AC-08: chunks of the copy, against the branch's control-api); (j) work in progress written
// mid-turn, which only the lid's own last copy carries (as chunks); (k) work in progress past what any copy carries,
// written mid-turn: the lid pauses the chat, and the phone's message while the Mac sleeps waits for it, sweep after
// sweep, rather than moving the chat onto older files (F-5, against the branch's control-api); (l) secret-shaped files,
// and the Cloud computer's edit to one coming back held for review (A-5, A-8); (m) a working chat moved by hand to
// Cloud; (n) a chat at work on a Cloud computer moved to This Mac by hand, with the desktop's signed stop (decision 29
// both ways); (o) a working chat the lid keeps on its Mac, never moved while the Mac sleeps (A-6); (p) the lid's
// switch off while the chat's move lock is held past the lid's budget: kept here at once, never moved once the lock is
// free (F-3); (q) a file the Mac's git ignores, at a path the Cloud computer's work commits: kept byte for byte through
// the return, Cloud's held (F-2); (r) a Caveman chat where Cloud's computers cannot run one (no Caveman credits reach
// them, as in production today): kept on its Mac, saying why, never moved while it sleeps; (s) a chat on its way to a
// Cloud computer made for another chat, which comes back to the Mac meanwhile: the computer stays and takes it (M-5).
// Each checks one owner (Cloud's code_workspaces.computer_id), one session id, cursors 1..n, no message answered twice,
// and a reason in every chat that did not move.
//
// Skipped unless CAVEMAN_E2E_MOVES=1 with the env moves.e2e.test.ts names. CAVEMAN_E2E_RESULTS names the file
// moves.e2e writes its evidence to; this file's (each case's timings, with the Mac's load) goes beside it as
// <name>.lid-cycle.json, so a run of both keeps each.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { signMove, signStop, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { onLidClose } from "../../../../apps/desktop/src/lid.ts";
import { testDevice } from "../session-protocol/devices.testkit.ts";
import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { api, cloudComputer, contiguous, labFunding, MODEL, out, person, proxy, REAL_STACK, recordOn, replies, retireLabComputers, runtime, sql, stopAll, transcript, waitReply, working, type Person, type Runtime } from "./moves.e2e.kit.ts";

const results: Record<string, unknown> = {};
afterAll(() => {
  stopAll();
  if (process.env.CAVEMAN_E2E_RESULTS) fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS.replace(/(\.json)?$/, ".lid-cycle.json"), JSON.stringify(results, null, 1));
});
const load = () => os.loadavg().map((n) => n.toFixed(2)).join(" ");
const lid = (mac: Runtime) => onLidClose(mac.client, () => `lid:${randomUUID()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let me: Person;
let signedInAt = 0;
/**
 * The person signed in again once their sign-in is 10 minutes old: Cloud's access token lasts 15, and on a loaded Mac
 * the cases outlast it (a desktop refreshes its own). Each case starts with one, so its calls carry a live token.
 */
const signedIn = async () => {
  if (Date.now() - signedInAt > 10 * 60_000) [me, signedInAt] = [await person(), Date.now()];
  return me;
};
let gitEnv: Record<string, string>;
let bare = "";
let effects = "";
/** The Cloud computers' runtimes, by computer: started the first time Cloud puts a chat on one. */
const boxes = new Map<string, Runtime & { readonly runtimeId: string; readonly computerId: string; readonly root: string }>();

beforeAll(async () => {
  if (!REAL_STACK) return;
  await signedIn();
  // Each case has Cloud make Cloud computers for the lab person: an earlier run's would use up its awake quota, and a
  // fresh stack's organization has no plan or credits to make them with.
  retireLabComputers(me);
  labFunding(me);
  // A GitHub repository, served from a local bare repo: every git here reads its URL as the bare one.
  const root = tempRoot("lid-cycle-");
  const name = `lid-${randomUUID().slice(0, 8)}`;
  bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/octocat/${name}` };
  Object.assign(process.env, gitEnv);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "lid\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  gitEnv.GIT_CONFIG_VALUE_0 = `https://github.com/octocat/${name}`;
  effects = path.join(root, "effects.log");
  results.stack = { cloud: process.env.CAVEMAN_E2E_CLOUD_URL, label: "lab-only: Mac host processes + OrbStack containers; sleep = SIGSTOP; not fleet" };
}, 120_000);

/** A Mac of its own for one case: enrolled through its own proxy, moves on, with a clone of the repository. */
async function mac() {
  await signedIn();
  const net = await proxy();
  const repo = path.join(tempRoot("lid-mac-"), "repo");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, repo]);
  const rt = await runtime("mac", { ...gitEnv, MOVES_CLOUD_URL: net.url, MOVES_BEARER: me.access_token, MOVES_EFFECTS: effects });
  await rt.client.call("settings.set", { request_id: "moves-on", settings: { sync_chats: true, move_to_cloud: true } });
  const status = await rt.client.call("cloud.status", {});
  return { ...rt, net, repo, computerId: status.computer_id!, runtimeId: status.runtime_id! };
}
type Mac = Awaited<ReturnType<typeof mac>>;

/** Cloud's word on where the chat runs: its workspace's computer (SQL, the one owner). */
const owner = (sessionId: string) => sql(`SELECT w.computer_id FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id AND w.organization_id = s.organization_id WHERE s.id = '${sessionId}'`);
const journal = (sessionId: string) => {
  const [cursor, epoch] = sql(`SELECT cursor_seq, epoch FROM code_journal_index WHERE session_id = '${sessionId}'`).split("|");
  return { cursor: Number(cursor ?? 0), epoch: Number(epoch ?? 0) };
};

/** The runtime of the Cloud computer `computerId`, started on a fresh checkout the first time. */
async function box(computerId: string) {
  const known = boxes.get(computerId);
  if (known) return known;
  const root = path.join(tempRoot("lid-box-"), "workspace");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, root]);
  const rt = { ...(await cloudComputer(me, computerId, root, { ...gitEnv, MOVES_EFFECTS: effects })), root };
  boxes.set(computerId, rt);
  return rt;
}

/** Waits for Cloud to put the chat on a Cloud computer (not `from`), and that computer's runtime. */
async function onCloud(sessionId: string, from: string, ms = 120_000) {
  let computer = "";
  await until(() => {
    computer = owner(sessionId);
    return computer !== "" && computer !== from;
  }, ms);
  return box(computer);
}

/** The person's phone: a message queued in Cloud, which runs wherever the chat is. */
const phone = (sessionId: string, text: string) =>
  api(me.access_token, `/api/v1/code/chats/${sessionId}/calls`, { method: "POST", body: { request_id: `phone-${randomUUID()}`, method: "turn.submit", params: { session_id: sessionId, kind: "followup", input: { text } } } });

/** What every case holds: one session, cursors 1..n, and no message of the person's answered twice. */
function holds(events: ReadonlyArray<SessionEvent>, sessionId: string) {
  expect(contiguous(events)).toBe(true);
  expect(events.every((e) => e.session_id === sessionId)).toBe(true);
  const asked = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" && /^(ask|hang|slow|approve)\b/.test(e.payload.text) ? [e.payload.text] : []));
  for (const text of new Set(asked)) expect(replies(events).filter((r) => r.endsWith(`${text} (on mac)`) || r.endsWith(`${text} (on cloud)`)).length, text).toBeLessThanOrEqual(1);
}
/** The lid's own word in a chat it kept: its note, or its "Didn't move" line. */
const reasonIn = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "notification" && e.payload.title === "Paused when the lid closed" ? [e.payload.body ?? ""] : e.type === "session.resumed" && (e.payload as { move_failed?: string }).move_failed ? [(e.payload as { move_failed: string }).move_failed] : [],
  );

/** A chat on the Mac whose first turn answered and whose copy follows in Cloud (it may move). */
async function startChat(m: Mac, title: string, text: string, access: "auto" | "ask" | "full" = "auto") {
  const w = await m.client.call("workspace.create", { request_id: `w-${randomUUID()}`, repo: { path: m.repo }, title, engine: "caveman", options: { model: MODEL, access }, task: { text } });
  await waitReply(m, w.session_id, new RegExp(`${text} \\(on mac\\)$`));
  await idleOn(m, w.session_id);
  await until(() => sql(`SELECT follow FROM code_sessions WHERE id = '${w.session_id}'`) === "t" && journal(w.session_id).cursor > 0, 60_000);
  return w;
}
const idleOn = (rt: Runtime, sessionId: string) => until(async () => (await recordOn(rt, sessionId))?.status === "idle", 60_000);
const copied = (m: Mac, sessionId: string) => until(async () => journal(sessionId).cursor === (await transcript(m, sessionId)).at(-1)?.cursor, 60_000);

test.skipIf(!REAL_STACK)("(a) idle at the lid: the copy is flushed and nothing moves; the phone's message while the Mac sleeps moves it and runs on Cloud", async () => {
  const m = await mac();
  const w = await startChat(m, "Idle", "ask a1");
  await idleOn(m, w.session_id);
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 0, paused: 0 });
  await copied(m, w.session_id);
  expect(owner(w.session_id)).toBe(m.computerId);
  // Asleep: the phone's message moves the chat to a Cloud computer, which answers it, heard whole.
  m.child.kill("SIGSTOP");
  expect((await phone(w.session_id, "ask a2 from the phone")).status).toBeLessThan(300);
  const there = await onCloud(w.session_id, m.computerId);
  const events = await waitReply(there, w.session_id, /ask a1 \| ask a2 from the phone \(on cloud\)$/, 120_000);
  holds(events, w.session_id);
  expect(events.findLast((e) => e.type === "session.parked")).toMatchObject({ payload: { reason: "move", cause: "asleep" } });
  expect(owner(w.session_id)).toBe(there.computerId);
  results.a = { phoneToReplySeconds: Math.round((Date.now() - at) / 1000), load: load() };
  m.child.kill("SIGCONT");
}, 300_000);

test.skipIf(!REAL_STACK)("(b) mid-turn, on a message the queue started: the lid hands it off, and the Cloud computer finishes the turn, told it moved and what was asked", async () => {
  const m = await mac();
  const w = await startChat(m, "Mid-turn", "ask b1");
  // A slow turn, and a message queued behind it, which the queue starts.
  await m.client.call("turn.submit", { request_id: "b2", session_id: w.session_id, kind: "followup", input: { text: "slow 3 b2" } });
  await m.client.call("turn.submit", { request_id: "b3", session_id: w.session_id, kind: "followup", input: { text: "hang b3" } });
  await until(async () => (await transcript(m, w.session_id)).some((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === "hang b3"), 60_000);
  await working(m, w.session_id);
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  const events = await waitReply(there, w.session_id, /ask b1 \| slow 3 b2 \| hang b3 \(on cloud\)$/, 120_000);
  results.b = { lidToReplySeconds: Math.round((Date.now() - at) / 1000), load: load() };
  holds(events, w.session_id);
  expect(events.some((e) => e.type === "turn.done" && e.payload.status === "interrupted")).toBe(true);
  expect(owner(w.session_id)).toBe(there.computerId);
  // The Mac never answered it, and shows the chat on Cloud.
  expect(replies(await transcript(m, w.session_id)).some((r) => r.includes("hang b3"))).toBe(false);
  expect(await recordOn(m, w.session_id)).toMatchObject({ status: "parked", computer: { kind: "caveman_cloud" } });
}, 300_000);

test.skipIf(!REAL_STACK)("(c) mid-approval: Cloud asks again, the Mac's card is closed, and the command runs once", async () => {
  const m = await mac();
  const before = fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean).length : 0;
  const w = await startChat(m, "Approval", "ask c1", "ask");
  await m.client.call("turn.submit", { request_id: "c2", session_id: w.session_id, kind: "followup", input: { text: "approve c2" } });
  let onMac: Array<SessionEvent> = [];
  await until(async () => (onMac = await transcript(m, w.session_id)).some((e) => e.type === "ask.user"), 60_000);
  const macAsk = onMac.find((e) => e.type === "ask.user")!;
  expect(await recordOn(m, w.session_id)).toMatchObject({ status: "needs_input" });
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  // Cloud asks again; the Mac's ask is resolved in the transcript, never answerable there.
  let events: Array<SessionEvent> = [];
  await until(async () => (events = await transcript(there, w.session_id).catch(() => [])).some((e) => e.type === "ask.user" && e.item_id !== macAsk.item_id), 120_000);
  expect(events.some((e) => e.type === "ask.resolved" && e.item_id === macAsk.item_id)).toBe(true);
  const cloudAsk = events.findLast((e) => e.type === "ask.user")!;
  const option = (cloudAsk.payload as { options?: ReadonlyArray<{ id: string }> }).options?.[0]?.id ?? "accept";
  await expect(there.client.call("ask.respond", { request_id: "c-stale", session_id: w.session_id, ask_id: macAsk.item_id!, response: { kind: "approval", option_id: option } })).rejects.toThrow();
  await there.client.call("ask.respond", { request_id: "c-ok", session_id: w.session_id, ask_id: cloudAsk.item_id!, response: { kind: "approval", option_id: option } });
  events = await waitReply(there, w.session_id, /approve c2 \(on cloud\)$/, 60_000);
  holds(events, w.session_id);
  // The command ran exactly once, on the Cloud computer.
  const ran = fs.readFileSync(effects, "utf8").split("\n").filter(Boolean).slice(before);
  expect(ran).toEqual(["cloud"]);
  results.c = { ran, load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(d) no network at the lid: the chat pauses with its reason, nothing moves, and its copy catches up once the network is back", async () => {
  const m = await mac();
  const w = await startChat(m, "Offline", "ask d1");
  await m.client.call("turn.submit", { request_id: "d2", session_id: w.session_id, kind: "followup", input: { text: "hang d2" } });
  await working(m, w.session_id);
  m.net.state.cut = true;
  expect(await lid(m)).toEqual({ moving: 0, paused: 1 });
  await idleOn(m, w.session_id);
  const events = await transcript(m, w.session_id);
  expect(reasonIn(events)).toHaveLength(1);
  expect(reasonIn(events)[0]).toMatch(/reach Caveman: /);
  expect(owner(w.session_id)).toBe(m.computerId);
  const cut = Date.now();
  await sleep(5_000);
  m.net.state.cut = false;
  // Back: the copy catches up by itself (the outbox, at most a minute between tries).
  await until(async () => journal(w.session_id).cursor === (await transcript(m, w.session_id)).at(-1)?.cursor, 120_000);
  results.d = { reason: reasonIn(events)[0], catchUpSeconds: Math.round((Date.now() - cut) / 1000), load: load() };
  expect(owner(w.session_id)).toBe(m.computerId);
}, 300_000);

test.skipIf(!REAL_STACK)("(e) woken after more than 20 s: the chat comes back by itself, no sooner than 30 s after waking and only once idle", async () => {
  const m = await mac();
  const w = await startChat(m, "Comes back", "ask e1");
  await m.client.call("turn.submit", { request_id: "e2", session_id: w.session_id, kind: "followup", input: { text: "hang e2" } });
  await working(m, w.session_id);
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  await waitReply(there, w.session_id, /hang e2 \(on cloud\)$/, 120_000);
  await idleOn(there, w.session_id);
  // Asleep for 25 s, then awake; the phone keeps the chat busy on Cloud for 40 s past the wake.
  m.child.kill("SIGSTOP");
  await sleep(25_000);
  m.child.kill("SIGCONT");
  const woke = Date.now();
  expect((await phone(w.session_id, "slow 40 e3")).status).toBeLessThan(300);
  await until(async () => (await recordOn(there, w.session_id))?.status === "working", 30_000);
  let busyUntil = 0;
  await until(async () => {
    const here = await recordOn(m, w.session_id);
    if (busyUntil === 0 && (await recordOn(there, w.session_id))?.status === "idle") busyUntil = Date.now();
    return here?.computer.kind === "this_mac" && here.status === "idle";
  }, 240_000);
  const back = Date.now();
  results.e = { backSecondsAfterWake: Math.round((back - woke) / 1000), busyForSecondsAfterWake: busyUntil ? Math.round((busyUntil - woke) / 1000) : null, load: load() };
  expect(back - woke).toBeGreaterThanOrEqual(30_000);
  expect(busyUntil).toBeGreaterThan(0);
  expect(back).toBeGreaterThanOrEqual(busyUntil);
  const events = await transcript(m, w.session_id);
  holds(events, w.session_id);
  expect(replies(events).at(-1)).toMatch(/slow 40 e3 \(on cloud\)$/);
  expect(owner(w.session_id)).toBe(m.computerId);
}, 420_000);

// Finding R4, formal/OneHolder.tla's AskFirst and NothingOverwritten. With CAVEMAN_ASK_FIRST=off in this run's
// environment this case fails: Bring it back replaces the Mac's edit without a question.
test.skipIf(!REAL_STACK)("(f) the worktree edited while away: it stays on Cloud and says so; Bring it back asks first, naming what changed here, and on yes lands Cloud's work, keeps the Mac's edits on a ref and says where (R4)", async () => {
  const m = await mac();
  const w = await startChat(m, "Edited here", "ask f1");
  await m.client.call("turn.submit", { request_id: "f2", session_id: w.session_id, kind: "followup", input: { text: "hang f2" } });
  await working(m, w.session_id);
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  await waitReply(there, w.session_id, /hang f2 \(on cloud\)$/, 120_000);
  await idleOn(there, w.session_id);
  // Cloud's work, and an edit on the Mac meanwhile.
  // A Cloud computer never shows a worktree's path (root_path is This Mac's): its git says where the chat's branch is.
  const branch = (await recordOn(there, w.session_id))!.branch;
  const trees = out(there.root, "worktree", "list", "--porcelain").split("\n\n");
  const boxTree = trees.find((t) => t.includes(`branch refs/heads/${branch}`))!.split("\n")[0]!.replace(/^worktree /, "");
  fs.writeFileSync(path.join(boxTree, "from-cloud.txt"), "made on Cloud\n");
  fs.writeFileSync(path.join(w.root_path!, "mac-edit.txt"), "edited on the Mac while away\n");
  // Awake past 30 s (the lid's suspending mark clears within 60 s): it says it stays, and does not come back.
  await until(async () => (await transcript(m, w.session_id)).some((e) => e.type === "notification" && e.payload.title === "It stays on Cloud for now"), 150_000);
  expect(owner(w.session_id)).toBe(there.computerId);
  // Bring it back: asked first, naming what would be set aside and where it would be kept. Nothing moves on the question.
  const kept = `refs/caveman/kept/${w.session_id}`;
  const asked = await m.client.call("session.move", { request_id: "f-ask", session_id: w.session_id, to: "this_mac" });
  expect(asked).toMatchObject({ pending: false, needs_confirmation: { files: ["mac-edit.txt"], total: 1, commits: 0, kept_ref: kept } });
  await sleep(3_000);
  expect(owner(w.session_id)).toBe(there.computerId);
  expect(fs.readFileSync(path.join(w.root_path!, "mac-edit.txt"), "utf8")).toBe("edited on the Mac while away\n");
  // On the person's yes it comes back: Cloud's work lands, the Mac's edit is kept on the ref, and the chat says where.
  const back = await m.client.call("session.move", { request_id: "f-back", session_id: w.session_id, to: "this_mac", replace: true });
  expect(back.needs_confirmation).toBeUndefined();
  await until(async () => (await recordOn(m, w.session_id))?.computer.kind === "this_mac" && (await recordOn(m, w.session_id))?.status === "idle", 120_000);
  expect(fs.readFileSync(path.join(w.root_path!, "from-cloud.txt"), "utf8")).toBe("made on Cloud\n");
  expect(fs.existsSync(path.join(w.root_path!, "mac-edit.txt"))).toBe(false);
  expect(out(w.root_path!, "show", `${kept}:mac-edit.txt`)).toBe("edited on the Mac while away");
  const said = (await transcript(m, w.session_id)).flatMap((e) => (e.type === "notification" && e.payload.title === "The changes made here were set aside" ? [e.payload.body ?? ""] : []));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain(kept);
  holds(await transcript(m, w.session_id), w.session_id);
  expect(owner(w.session_id)).toBe(m.computerId);
  results.f = { kept, load: load() };
}, 420_000);

test.skipIf(!REAL_STACK)("(g) two quick lid cycles: closed, woken after 10 s and closed again, and closed while a return lands, the chat has one owner and never forks", async () => {
  const m = await mac();
  // g1: the second close finds the first one's move finishing.
  const w = await startChat(m, "Quick cycles", "ask g1");
  await m.client.call("turn.submit", { request_id: "g2", session_id: w.session_id, kind: "followup", input: { text: "hang g2" } });
  await working(m, w.session_id);
  m.net.state.onSuspend = () => m.child.kill("SIGSTOP");
  const firstLid = Date.now();
  await lid(m);
  await sleep(10_000);
  m.child.kill("SIGCONT");
  const woke = Date.now();
  // H1: a sleep shorter than the 20 s a pass tells a wake by still reads as one (the runtime's wake watch): Cloud
  // stops hearing "going to sleep" within seconds of the wake, not when the lid's mark lapses (60 s).
  const suspending = () => sql(`SELECT suspending_at IS NOT NULL FROM code_runtimes WHERE id = '${m.runtimeId}'`) === "t";
  const stillSuspending = suspending();
  await until(() => !suspending(), 120_000);
  const clearedAfterLid = Date.now() - firstLid;
  const clearedAfterWake = Date.now() - woke;
  expect(clearedAfterWake).toBeLessThan(15_000);
  await lid(m);
  const there = await onCloud(w.session_id, m.computerId);
  const events = await waitReply(there, w.session_id, /hang g2 \(on cloud\)$/, 120_000);
  holds(events, w.session_id);
  await until(async () => (await recordOn(m, w.session_id))?.computer.kind === "caveman_cloud", 60_000);
  expect(owner(w.session_id)).toBe(there.computerId);
  const sessions = (await api(me.access_token, `/api/v1/code/sessions?workspace_id=${(await api(me.access_token, `/api/v1/code/sessions/${w.session_id}`)).body.workspace_id}`)).body.sessions as Array<{ id: string }>;
  expect(sessions.map((s) => s.id)).toEqual([w.session_id]);
  // g2: the lid closes while the chat's return is landing on the Mac.
  await idleOn(there, w.session_id);
  const pulled = m.client.call("session.move", { request_id: "g-back", session_id: w.session_id, to: "this_mac" });
  await sleep(300);
  const second = await lid(m);
  await pulled.catch(() => undefined);
  await until(async () => {
    const at = owner(w.session_id);
    const here = await recordOn(m, w.session_id);
    const away = await recordOn(there, w.session_id);
    // Settled: exactly one runtime has it live, and Cloud names that one's computer.
    return (at === m.computerId && here?.computer.kind === "this_mac" && here.status === "idle" && away?.status === "parked") || (at === there.computerId && away?.status === "idle" && here?.computer.kind === "caveman_cloud");
  }, 180_000);
  const settled = owner(w.session_id) === m.computerId ? m : there;
  holds(await transcript(settled, w.session_id), w.session_id);
  results.g = { secondLid: second, settledOn: settled === m ? "mac" : "cloud", h1: { suspendingAtWake: stillSuspending, clearedSecondsAfterFirstLid: Math.round(clearedAfterLid / 1000), clearedSecondsAfterWake: Math.round(clearedAfterWake / 1000) }, load: load() };
}, 480_000);

test.skipIf(!REAL_STACK)("(h) a Mac that never comes back: the chat keeps running on Cloud for the phone, and once the Mac is revoked nothing waits for it", async () => {
  const m = await mac();
  const w = await startChat(m, "Gone", "ask h1");
  await m.client.call("turn.submit", { request_id: "h2", session_id: w.session_id, kind: "followup", input: { text: "hang h2" } });
  await working(m, w.session_id);
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  await waitReply(there, w.session_id, /hang h2 \(on cloud\)$/, 120_000);
  m.child.kill("SIGKILL");
  expect((await phone(w.session_id, "ask h3 from the phone")).status).toBeLessThan(300);
  await waitReply(there, w.session_id, /ask h3 from the phone \(on cloud\)$/, 120_000);
  const returnsBefore = sql(`SELECT COALESCE(returns_to_runtime_id::text, '') FROM code_sessions WHERE id = '${w.session_id}'`);
  expect((await api(me.access_token, `/api/v1/code/runtimes/${m.runtimeId}/revoke`, { method: "POST", body: {} })).status).toBeLessThan(300);
  expect((await phone(w.session_id, "ask h4 after the revoke")).status).toBeLessThan(300);
  const events = await waitReply(there, w.session_id, /ask h4 after the revoke \(on cloud\)$/, 120_000);
  holds(events, w.session_id);
  expect(owner(w.session_id)).toBe(there.computerId);
  const returnsAfter = sql(`SELECT COALESCE(returns_to_runtime_id::text, '') FROM code_sessions WHERE id = '${w.session_id}'`);
  results.h = { returnsToBefore: returnsBefore === m.runtimeId ? "the Mac" : returnsBefore, returnsToAfterRevoke: returnsAfter === m.runtimeId ? "the revoked Mac" : returnsAfter || "none", load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(i) large work in progress: 20 MiB committed and never pushed and 12 MiB uncommitted go with the lid as checked chunks, land byte for byte, and come back", async () => {
  const m = await mac();
  const w = await startChat(m, "Large files", "ask i1");
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  // Nobody can compress these: one commit the Mac never pushed, and a file beside it.
  fs.writeFileSync(path.join(w.root_path!, "committed.bin"), randomBytes(20 * 1024 * 1024));
  git(w.root_path!, "add", "committed.bin");
  git(w.root_path!, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "large files");
  fs.writeFileSync(path.join(w.root_path!, "loose.bin"), randomBytes(12 * 1024 * 1024));
  const want = { committed: sha(path.join(w.root_path!, "committed.bin")), loose: sha(path.join(w.root_path!, "loose.bin")) };
  await m.client.call("turn.submit", { request_id: "i2", session_id: w.session_id, kind: "followup", input: { text: "ask i2" } });
  await waitReply(m, w.session_id, /ask i2 \(on mac\)$/);
  await idleOn(m, w.session_id);
  await copied(m, w.session_id);
  // Cloud holds the chunks the copy names, each at most 8 MiB.
  const [chunks, bytes, largest] = sql(`SELECT count(*), COALESCE(sum(bytes), 0), COALESCE(max(bytes), 0) FROM code_journal_blobs WHERE session_id = '${w.session_id}'`).split("|").map(Number);
  expect(chunks).toBeGreaterThanOrEqual(4);
  expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(largest).toBeLessThanOrEqual(8 * 1024 * 1024);
  // The lid mid-turn, and the Mac asleep.
  await m.client.call("turn.submit", { request_id: "i3", session_id: w.session_id, kind: "followup", input: { text: "hang i3" } });
  await working(m, w.session_id);
  m.net.state.onSuspend = () => m.child.kill("SIGSTOP");
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  holds(await waitReply(there, w.session_id, /hang i3 \(on cloud\)$/, 180_000), w.session_id);
  const lidToReply = Date.now() - at;
  await idleOn(there, w.session_id);
  const branch = (await recordOn(there, w.session_id))!.branch;
  const boxTree = out(there.root, "worktree", "list", "--porcelain").split("\n\n").find((t) => t.includes(`branch refs/heads/${branch}`))!.split("\n")[0]!.replace(/^worktree /, "");
  expect({ committed: sha(path.join(boxTree, "committed.bin")), loose: sha(path.join(boxTree, "loose.bin")) }).toEqual(want);
  expect(out(boxTree, "log", "-1", "--format=%s")).toBe("large files");
  fs.writeFileSync(path.join(boxTree, "from-cloud.txt"), "made on Cloud\n");
  // Awake: it comes back by itself once idle, with both files and Cloud's.
  m.child.kill("SIGCONT");
  const woke = Date.now();
  await until(async () => owner(w.session_id) === m.computerId && (await recordOn(m, w.session_id))?.status === "idle", 240_000);
  const back = Date.now() - woke;
  expect({ committed: sha(path.join(w.root_path!, "committed.bin")), loose: sha(path.join(w.root_path!, "loose.bin")) }).toEqual(want);
  expect(fs.readFileSync(path.join(w.root_path!, "from-cloud.txt"), "utf8")).toBe("made on Cloud\n");
  holds(await transcript(m, w.session_id), w.session_id);
  results.i = { chunks, mib: Math.round(bytes! / 1024 / 1024), lidToReplySeconds: Math.round(lidToReply / 1000), backSecondsAfterWake: Math.round(back / 1000), load: load() };
  // Asleep past a minute (the lid's mark clears by its minute rule): still no sooner than 30 s after waking (H1).
  expect(back).toBeGreaterThanOrEqual(30_000);
}, 420_000);

test.skipIf(!REAL_STACK)("(j) work in progress written mid-turn: the lid's own last copy puts it up as chunks before it hands the chat off, and the chat lands with it byte for byte", async () => {
  const m = await mac();
  const w = await startChat(m, "Large at the lid", "ask j1");
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  await m.client.call("turn.submit", { request_id: "j2", session_id: w.session_id, kind: "followup", input: { text: "hang j2" } });
  await working(m, w.session_id);
  // Written mid-turn, after every boundary the copy has: only the lid's last copy can carry it.
  fs.writeFileSync(path.join(w.root_path!, "mid-turn.bin"), randomBytes(12 * 1024 * 1024));
  const want = sha(path.join(w.root_path!, "mid-turn.bin"));
  const chunks = () => Number(sql(`SELECT count(*) FROM code_journal_blobs WHERE session_id = '${w.session_id}'`));
  expect(chunks()).toBe(0);
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  const events = await waitReply(there, w.session_id, /hang j2 \(on cloud\)$/, 180_000);
  const lidToReply = Date.now() - at;
  holds(events, w.session_id);
  // Handed off by the lid (awake, the Mac parked it itself), not moved by Cloud from an older copy.
  expect(events.findLast((e) => e.type === "session.parked")).toMatchObject({ payload: { reason: "move", cause: "lid" } });
  expect(chunks()).toBeGreaterThanOrEqual(2);
  await idleOn(there, w.session_id);
  const branch = (await recordOn(there, w.session_id))!.branch;
  const boxTree = out(there.root, "worktree", "list", "--porcelain").split("\n\n").find((t) => t.includes(`branch refs/heads/${branch}`))!.split("\n")[0]!.replace(/^worktree /, "");
  expect(sha(path.join(boxTree, "mid-turn.bin"))).toBe(want);
  expect(owner(w.session_id)).toBe(there.computerId);
  results.j = { chunks: chunks(), lidToReplySeconds: Math.round(lidToReply / 1000), load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(k) work in progress past what any copy carries, written mid-turn: the lid pauses the chat saying why, and the phone's message while the Mac sleeps waits for the Mac, sweep after sweep, never moving it onto older files", async () => {
  const m = await mac();
  const w = await startChat(m, "Too big to carry", "ask k1");
  await m.client.call("turn.submit", { request_id: "k2", session_id: w.session_id, kind: "followup", input: { text: "hang k2" } });
  await working(m, w.session_id);
  // Past one blob's 64 MiB, written after every boundary the copy has: only the lid's own last copy could carry it.
  const big = path.join(w.root_path!, "too-big.bin");
  fs.writeFileSync(big, randomBytes(70 * 1024 * 1024));
  const sha = () => createHash("sha256").update(fs.readFileSync(big)).digest("hex");
  const want = sha();
  // The Cloud computers made for this chat: a move's is spawned for its workspace. The org's other chats get their own
  // (a chat an earlier run left mid-turn on a Mac gone quiet is moved again every sweep), and those are not this one's.
  const computers = () =>
    Number(sql(`SELECT count(*) FROM code_computers c JOIN code_sessions s ON s.organization_id = c.organization_id AND s.workspace_id = c.spawned_for WHERE s.id = '${w.session_id}'`));
  const moves = () => Number(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}'`));
  await lid(m);
  // Kept here, its turn stopped, saying why with the fix. The turn stops at once; the reason is known only once the
  // lid's last copy found 70 MiB too much, which on a loaded machine is after the lid's own budget ran out.
  await idleOn(m, w.session_id);
  await until(async () => reasonIn(await transcript(m, w.session_id)).length > 0, 60_000);
  expect(reasonIn(await transcript(m, w.session_id))).toEqual([expect.stringMatching(/^its uncommitted changes are 70 MiB, more than a move carries; commit and push the large files/)]);
  expect(owner(w.session_id)).toBe(m.computerId);
  // Cloud's copy ends on the lid's boundary that says it went without that work: Cloud counts it as carrying none.
  expect(sql(`SELECT wip FROM code_journal_segments WHERE session_id = '${w.session_id}' AND boundary ORDER BY n DESC LIMIT 1`)).toBe("f");
  // Asleep: the phone's message waits for the Mac, saying why (once Cloud counts the Mac asleep or gone quiet). The
  // moves so far are the lid's own check, which it let lapse.
  const before = { moves: moves(), computers: computers() };
  m.child.kill("SIGSTOP");
  const slept = Date.now();
  const asked = await phone(w.session_id, "ask k3 from the phone");
  expect(asked.status).toBeLessThan(300);
  const callOf = async () => (await api(me.access_token, `/api/v1/code/chats/${w.session_id}/calls/${asked.body.request_id}`)).body as { status: string; waiting?: { reason: string; detail: string }; error?: { code: string } };
  await until(async () => (await callOf()).waiting?.reason === "not_movable", 180_000);
  const waiting = (await callOf()).waiting!;
  const waited = Date.now() - slept;
  // More than a sweep (30 s) later: no move, no Cloud computer made (the old Cloud moved it to a new one that refused
  // its copy, every sweep, for as long as the Mac slept).
  await sleep(40_000);
  expect({ moves: moves() - before.moves, made: computers() - before.computers, owner: owner(w.session_id) }).toEqual({ moves: 0, made: 0, owner: m.computerId });
  // Awake: the call reaches the Mac, which answers it as it answers any call from a device it never approved (this
  // lab's phone signs nothing; a Cloud computer would have run it). Nothing ran anywhere else; its files are as they were.
  m.child.kill("SIGCONT");
  await until(async () => ["done", "failed"].includes((await callOf()).status), 180_000);
  expect(await callOf()).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
  holds(await transcript(m, w.session_id), w.session_id);
  expect(sha()).toBe(want);
  expect({ moves: moves() - before.moves, owner: owner(w.session_id) }).toEqual({ moves: 0, owner: m.computerId });
  results.k = { waiting: waiting.detail, waitingSecondsAfterSleep: Math.round(waited / 1000), load: load() };
}, 480_000);

test.skipIf(!REAL_STACK)("(l) secret-shaped files git does not ignore: the Cloud checkout lacks the untracked ones and holds HEAD's version of the tracked one; the Mac's worktree is byte for byte as it was after the move and after the return (decision 24); the Cloud computer's edit to the tracked one comes back held for review and applies on the person's word, and a new one it wrote stays there, named (A-5, A-8)", async () => {
  const m = await mac();
  // A tracked secret-shaped file, on GitHub at its HEAD version, in the Mac's clone.
  const seed = path.join(tempRoot("lid-seed-secret-"), "repo");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, seed]);
  if (!fs.existsSync(path.join(seed, ".env.local"))) {
    fs.writeFileSync(path.join(seed, ".env.local"), "TOKEN=head-version\n");
    git(seed, "add", ".env.local");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tracked env");
    git(seed, "push", "-q", "origin", "HEAD:main");
  }
  git(m.repo, "pull", "-q", "origin", "main");
  const w = await startChat(m, "Secrets", "ask l1");
  const root = w.root_path!;
  fs.writeFileSync(path.join(root, ".env"), "SECRET=mac-only-untracked\n", { mode: 0o600 });
  fs.writeFileSync(path.join(root, ".env.local"), "TOKEN=mac-edited\n", { mode: 0o640 });
  fs.mkdirSync(path.join(root, "keys"), { recursive: true });
  fs.writeFileSync(path.join(root, "keys", "id_ed25519"), "ssh-mac-only\n", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "work.txt"), "ordinary work\n");
  const secrets = [".env", ".env.local", "keys/id_ed25519"];
  const as = () => Object.fromEntries(secrets.map((f) => [f, `${(fs.statSync(path.join(root, f)).mode & 0o777).toString(8)}:${fs.readFileSync(path.join(root, f), "utf8")}`]));
  const before = as();
  await m.client.call("turn.submit", { request_id: "l2", session_id: w.session_id, kind: "followup", input: { text: "hang l2" } });
  await working(m, w.session_id);
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  holds(await waitReply(there, w.session_id, /hang l2 \(on cloud\)$/, 120_000), w.session_id);
  await idleOn(there, w.session_id);
  // On the Cloud computer: the work, HEAD's version of the tracked one, none of the others.
  const tree = out(there.root, "worktree", "list", "--porcelain").split("\n\n").find((t) => t.includes(`branch refs/heads/${w.branch}`))!.split("\n")[0]!.replace(/^worktree /, "");
  expect(fs.readFileSync(path.join(tree, "work.txt"), "utf8")).toBe("ordinary work\n");
  expect(fs.readFileSync(path.join(tree, ".env.local"), "utf8")).toBe("TOKEN=head-version\n");
  expect(fs.existsSync(path.join(tree, ".env"))).toBe(false);
  expect(fs.existsSync(path.join(tree, "keys", "id_ed25519"))).toBe(false);
  // The Mac's own, untouched by the move.
  expect(as()).toEqual(before);
  // The Cloud computer's agent edits the tracked one and writes a new one (A-5).
  fs.writeFileSync(path.join(tree, ".env.local"), "TOKEN=head-version\nNEW_FLAG=from-cloud\n");
  fs.writeFileSync(path.join(tree, ".env.cloud"), "SECRET=cloud-only\n", { mode: 0o600 });
  // Awake again: the chat comes home by itself once idle, and the Mac's secret-shaped files are as they were.
  m.child.kill("SIGSTOP");
  await sleep(25_000);
  m.child.kill("SIGCONT");
  await until(async () => {
    const here = await recordOn(m, w.session_id);
    return here?.computer.kind === "this_mac" && here.status === "idle";
  }, 240_000);
  expect(owner(w.session_id)).toBe(m.computerId);
  expect(fs.readFileSync(path.join(root, "work.txt"), "utf8")).toBe("ordinary work\n");
  expect(as()).toEqual(before);
  // Cloud's edit is never lost: it waits on the held ref for the person, who reviews it as a diff (A-5, A-8). The new
  // one stayed on the Cloud computer, and the chat names it.
  const held = await m.client.call("session.move.held", { session_id: w.session_id });
  expect(held.paths).toEqual([".env.local"]);
  expect(held.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(held.files).toEqual([expect.objectContaining({ path: ".env.local", change: "changed", secret: true, diff: expect.stringContaining("+NEW_FLAG=from-cloud") })]);
  expect(git(root, "show", `refs/caveman/held/${w.session_id}:.env.local`)).toBe("TOKEN=head-version\nNEW_FLAG=from-cloud\n");
  expect(fs.existsSync(path.join(root, ".env.cloud"))).toBe(false);
  const said = await transcript(m, w.session_id);
  expect(said.some((e) => e.type === "notification" && /stayed on the Cloud computer/.test(e.payload.title) && (e.payload.body ?? "").includes(".env.cloud"))).toBe(true);
  holds(said, w.session_id);
  // Applied on the person's word, as reviewed: Cloud's version lands.
  expect((await m.client.call("session.move.apply_held", { request_id: "l3", session_id: w.session_id, commit: held.commit! })).paths).toEqual([".env.local"]);
  expect(fs.readFileSync(path.join(root, ".env.local"), "utf8")).toBe("TOKEN=head-version\nNEW_FLAG=from-cloud\n");
  results.l = { left: secrets, heldForReview: held.paths, namedOnCloud: [".env.cloud"], load: load() };
}, 480_000);

test.skipIf(!REAL_STACK)("(m) a working chat moved by hand: its turn stops on the Mac first, and it lands idle on the Cloud computer with nothing run again (decision 29)", async () => {
  const m = await mac();
  const ran = () => (fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean) : []);
  const w = await startChat(m, "Moved by hand", "ask m1", "full");
  const before = ran().length;
  // A command runs (a line in the effects log), then the turn works on.
  await m.client.call("turn.submit", { request_id: "m2", session_id: w.session_id, kind: "followup", input: { text: "approve hang m2" } });
  await until(async () => ran().length > before && (await recordOn(m, w.session_id))?.status === "working", 60_000);
  const sentAt = (await transcript(m, w.session_id)).at(-1)!.cursor;
  const at = Date.now();
  const moved = await m.client.call("session.move", { request_id: "move-m", session_id: w.session_id, to: "cloud" });
  expect(moved.pending).toBe(false);
  const onMac = await transcript(m, w.session_id);
  expect(onMac.some((e) => e.type === "turn.done" && e.payload.status === "interrupted")).toBe(true);
  expect(onMac.some((e) => e.type === "notification" && e.payload.title === "Stopped this turn to move it")).toBe(true);
  const there = await onCloud(w.session_id, m.computerId);
  await until(async () => (await recordOn(there, w.session_id))?.status === "idle", 120_000);
  await sleep(5_000);
  const events = await transcript(there, w.session_id);
  holds(events, w.session_id);
  // Landed idle: no turn after the stop, the command never ran again, nothing answered the stopped message.
  const stoppedAt = events.findIndex((e) => e.type === "turn.done" && e.payload.status === "interrupted" && e.cursor > sentAt - 5);
  expect(stoppedAt).toBeGreaterThan(0);
  expect(events.slice(stoppedAt).some((e) => e.type === "turn.started")).toBe(false);
  expect(replies(events).some((r) => r.includes("approve hang m2"))).toBe(false);
  expect(ran().slice(before)).toEqual(["mac"]);
  expect(owner(w.session_id)).toBe(there.computerId);
  results.m = { moveToIdleOnCloudSeconds: Math.round((Date.now() - at) / 1000), ran: ran().slice(before), load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(n) a chat at work on a Cloud computer moved to This Mac by hand: its turn stops on the Cloud computer first, and it lands idle on the Mac with nothing run again (decision 29)", async () => {
  const m = await mac();
  const ran = () => (fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean) : []);
  const w = await startChat(m, "Pulled back by hand", "ask n1", "full");
  expect((await m.client.call("session.move", { request_id: "to-cloud-n", session_id: w.session_id, to: "cloud" })).pending).toBe(false);
  const there = await onCloud(w.session_id, m.computerId);
  await idleOn(there, w.session_id);
  const before = ran().length;
  // On the Cloud computer, a command runs (a line in the effects log), then the turn works on for two minutes.
  await there.client.call("turn.submit", { request_id: "n2", session_id: w.session_id, kind: "followup", input: { text: "approve slow 120 n2" } });
  await until(async () => ran().length > before && (await recordOn(there, w.session_id))?.status === "working", 60_000);
  const sentAt = (await transcript(there, w.session_id)).at(-1)!.cursor;
  // The desktop's Move to, This Mac: the Mac's own runtime pulls it, its move and its stop signed by this Mac's key.
  const key = await testDevice("Lid Mac", "mac");
  const to = { computer_id: m.computerId };
  const request_id = `pull-n-${randomUUID()}`;
  const at = Date.now();
  await m.client.call("session.move", {
    request_id,
    session_id: w.session_id,
    to,
    device: await signMove(key, { session_id: w.session_id, request_id, to }),
    stop: await signStop(key, { session_id: w.session_id, move_request_id: request_id }),
  });
  await until(async () => (await recordOn(m, w.session_id))?.computer.kind === "this_mac" && (await recordOn(m, w.session_id))?.status === "idle", 120_000);
  const landedSeconds = Math.round((Date.now() - at) / 1000);
  // Well before its turn would have answered: the Cloud computer stopped it and said so.
  expect(Date.now() - at).toBeLessThan(90_000);
  const onCloudComputer = await transcript(there, w.session_id);
  expect(onCloudComputer.some((e) => e.type === "notification" && e.payload.title === "Stopped this turn to move it")).toBe(true);
  await sleep(5_000);
  const events = await transcript(m, w.session_id);
  holds(events, w.session_id);
  // Landed idle: no turn after the stop, the command never ran again, nothing answered the stopped message.
  const stoppedAt = events.findIndex((e) => e.type === "turn.done" && e.payload.status === "interrupted" && e.cursor > sentAt - 5);
  expect(stoppedAt).toBeGreaterThan(0);
  expect(events.slice(stoppedAt).some((e) => e.type === "turn.started")).toBe(false);
  expect(replies(events).some((r) => r.includes("approve slow 120 n2"))).toBe(false);
  expect(ran().slice(before)).toEqual(["cloud"]);
  expect(owner(w.session_id)).toBe(m.computerId);
  results.n = { pullToIdleOnMacSeconds: landedSeconds, ran: ran().slice(before), load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(o) lid moves off, a working chat the lid keeps: Cloud reads it idle, every suspending heartbeat names it kept, and Cloud never moves it while the Mac sleeps, even told it is at work (A-6)", async () => {
  const m = await mac();
  // Chats copy and may move, but the lid's own setting is off.
  await m.client.call("settings.set", { request_id: "lid-off", settings: { move_to_cloud: false } });
  const w = await startChat(m, "Kept by the lid", "ask o1");
  await m.client.call("turn.submit", { request_id: "o2", session_id: w.session_id, kind: "followup", input: { text: "hang o2" } });
  await working(m, w.session_id);
  const runState = () => sql(`SELECT w.run_state FROM code_sessions s JOIN code_workspaces w ON w.id = s.workspace_id AND w.organization_id = s.organization_id WHERE s.id = '${w.session_id}'`);
  const kept = () => sql(`SELECT COALESCE('${w.session_id}' = ANY(suspending_kept), false) FROM code_runtimes WHERE id = '${m.runtimeId}'`);
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 0, paused: 1 });
  const lidMs = Date.now() - at;
  await until(() => runState() === "idle", 10_000);
  await until(() => kept() === "t", 10_000);
  expect(reasonIn(await transcript(m, w.session_id))).toEqual(["Moving chats to Cloud when the lid closes is off on this Mac (Settings, Computers)"]);
  // The lid's last copy lands a moment after the heartbeat that names the chat kept, and gives the chat's lease back
  // with it: the Mac sleeps once it has (asleep before that, the lease stands until it lapses, and the lines below
  // read a lease that is still held).
  await until(() => sql(`SELECT COALESCE(lease_expires_at <= now(), true) FROM code_journal_index WHERE session_id = '${w.session_id}'`) === "t", 30_000);
  // Asleep. Then what a stop that lands slowly, or a Mac asleep before its idle reached Cloud, leaves Cloud reading: the
  // chat at work, its lease gone. Cloud's own move of a sleeping laptop's chats (MoveQuiet, every 15 s) passes it over.
  m.child.kill("SIGSTOP");
  sql(`UPDATE code_workspaces SET run_state = 'working' WHERE id = (SELECT workspace_id FROM code_sessions WHERE id = '${w.session_id}')`);
  expect(sql(`SELECT suspending_at IS NOT NULL FROM code_runtimes WHERE id = '${m.runtimeId}'`)).toBe("t");
  expect(sql(`SELECT COALESCE(lease_expires_at <= now(), true) FROM code_journal_index WHERE session_id = '${w.session_id}'`)).toBe("t");
  await sleep(75_000);
  expect(owner(w.session_id)).toBe(m.computerId);
  expect(Number(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}'`))).toBe(0);
  // Awake: the chat is still the Mac's, its stopped turn never ran again anywhere, and the heartbeats stop naming it.
  m.child.kill("SIGCONT");
  await until(() => kept() === "f", 120_000);
  await idleOn(m, w.session_id);
  const events = await transcript(m, w.session_id);
  holds(events, w.session_id);
  expect(replies(events).filter((r) => /hang o2/.test(r))).toEqual([]);
  results.o = { lidMs, keptNamed: true, movedWhileAsleep: false, load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(p) lid moves off, and the chat's move lock held past the lid's budget (its copy waiting on a slow uplink): the lid keeps it here at once, saying why, and nothing parks or moves once the lock is free (F-3)", async () => {
  const m = await mac();
  await m.client.call("settings.set", { request_id: "lid-off", settings: { move_to_cloud: false } });
  const w = await startChat(m, "Kept behind a copy", "ask p1");
  // The turn's first copy hangs on its way up, holding the chat's move lock as long as it does.
  let release!: () => void;
  m.net.state.hold = { match: /^PUT .*\/journal\/segments\/\d+$/, until: new Promise<void>((resolve) => (release = resolve)), waiting: 0 };
  await m.client.call("turn.submit", { request_id: "p2", session_id: w.session_id, kind: "followup", input: { text: "hang p2" } });
  await working(m, w.session_id);
  await until(() => m.net.state.hold!.waiting > 0, 60_000);
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 0, paused: 1 });
  const lidMs = Date.now() - at;
  // The lock comes free after the lid's budget: a move waiting behind it would park the chat and hand it to Cloud now.
  await sleep(2_000);
  m.net.state.hold = undefined;
  release();
  await sleep(20_000);
  const events = await transcript(m, w.session_id);
  expect(reasonIn(events)).toEqual(["Moving chats to Cloud when the lid closes is off on this Mac (Settings, Computers)"]);
  expect(events.some((e) => e.type === "session.parked")).toBe(false);
  expect(owner(w.session_id)).toBe(m.computerId);
  expect(Number(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}'`))).toBe(0);
  expect(await recordOn(m, w.session_id)).toMatchObject({ computer: { kind: "this_mac" } });
  holds(events, w.session_id);
  results.p = { lidMs, load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(q) a secret-shaped file this Mac's git ignores, at a path the Cloud computer's work commits: the return keeps the Mac's byte for byte and holds Cloud's for review, and the chat's note is true (F-2)", async () => {
  const m = await mac();
  const w = await startChat(m, "Ignored secret", "ask q1");
  const root = w.root_path!;
  // Ignored by this Mac's own excludes only, so a Cloud computer's agent can commit the same path.
  fs.appendFileSync(path.join(m.repo, ".git", "info", "exclude"), "\n.env.development\n");
  const mine = ("STRIPE_KEY=sk_" + "live_mac_only\n");
  fs.writeFileSync(path.join(root, ".env.development"), mine, { mode: 0o600 });
  expect(out(root, "status", "--porcelain", "--ignored", "--", ".env.development")).toBe("!! .env.development");
  expect((await m.client.call("session.move", { request_id: "q-away", session_id: w.session_id, to: "cloud" })).pending).toBe(false);
  const there = await onCloud(w.session_id, m.computerId);
  await idleOn(there, w.session_id);
  const tree = out(there.root, "worktree", "list", "--porcelain").split("\n\n").find((t) => t.includes(`branch refs/heads/${w.branch}`))!.split("\n")[0]!.replace(/^worktree /, "");
  expect(fs.existsSync(path.join(tree, ".env.development"))).toBe(false);
  // The Cloud computer's agent writes its own and commits it.
  fs.writeFileSync(path.join(tree, ".env.development"), ("STRIPE_KEY=sk_" + "test_from_cloud\n"));
  git(tree, "add", ".env.development");
  git(tree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "env from cloud");
  const at = Date.now();
  await m.client.call("session.move", { request_id: "q-back", session_id: w.session_id, to: "this_mac" });
  await until(async () => (await recordOn(m, w.session_id))?.computer.kind === "this_mac" && (await recordOn(m, w.session_id))?.status === "idle", 120_000);
  // The Mac's own, as it was: bytes and mode.
  expect(fs.existsSync(path.join(root, ".env.development"))).toBe(true);
  expect(fs.readFileSync(path.join(root, ".env.development"), "utf8")).toBe(mine);
  expect(fs.statSync(path.join(root, ".env.development")).mode & 0o777).toBe(0o600);
  // Cloud's waits on the held ref for the person, and the chat's note names it.
  const held = await m.client.call("session.move.held", { session_id: w.session_id });
  expect(held.paths).toContain(".env.development");
  expect(git(root, "show", `refs/caveman/held/${w.session_id}:.env.development`)).toBe(("STRIPE_KEY=sk_" + "test_from_cloud\n"));
  const events = await transcript(m, w.session_id);
  expect(events.some((e) => e.type === "notification" && (e.payload.body ?? "").includes("this Mac kept its own versions") && (e.payload.body ?? "").includes(".env.development"))).toBe(true);
  holds(events, w.session_id);
  expect(owner(w.session_id)).toBe(m.computerId);
  results.q = { backSeconds: Math.round((Date.now() - at) / 1000), held: held.paths, load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(r) a Caveman chat where Cloud's computers cannot run Caveman chats (no Caveman credits reach them): the lid keeps it on its Mac, saying why, as the move check and Move to say, and Cloud never moves it while the Mac sleeps (AUDIT-W4-FINAL-CLOUD)", async (ctx) => {
  await signedIn();
  // Only against a Cloud that says so, as production does today; a lab whose computers get a Caveman key moves it.
  const listed = await api(me.access_token, "/api/v1/code/computers?mine=true");
  if (listed.body.caveman_on_computers !== false) return ctx.skip();
  const m = await mac();
  const w = await startChat(m, "Caveman stays", "ask r1");
  const why = "Caveman chats don't move to Cloud computers yet: your Caveman credits don't reach them";
  await expect(m.client.call("session.move.check", { session_id: w.session_id, to: "cloud" })).rejects.toThrow(why);
  await expect(m.client.call("session.move", { request_id: "r-hand", session_id: w.session_id, to: "cloud" })).rejects.toThrow(why);
  await m.client.call("turn.submit", { request_id: "r2", session_id: w.session_id, kind: "followup", input: { text: "hang r2" } });
  await working(m, w.session_id);
  const at = Date.now();
  expect(await lid(m)).toEqual({ moving: 0, paused: 1 });
  const lidMs = Date.now() - at;
  await until(async () => reasonIn(await transcript(m, w.session_id)).length > 0, 30_000);
  expect(reasonIn(await transcript(m, w.session_id))).toEqual([why]);
  // Asleep, its lease gone, named kept by no heartbeat and Cloud told it is at work: Cloud's own move of a sleeping Mac's
  // chats (MoveQuiet, every 15 s) takes it up, and Cloud refuses it a Cloud computer.
  m.child.kill("SIGSTOP");
  sql(`UPDATE code_workspaces SET run_state = 'working' WHERE id = (SELECT workspace_id FROM code_sessions WHERE id = '${w.session_id}')`);
  sql(`UPDATE code_runtimes SET suspending_kept = '{}' WHERE id = '${m.runtimeId}'`);
  sql(`UPDATE code_journal_index SET lease_runtime_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE session_id = '${w.session_id}'`);
  await sleep(45_000);
  expect(owner(w.session_id)).toBe(m.computerId);
  expect(Number(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}' AND state IN ('handed','adopted')`))).toBe(0);
  m.child.kill("SIGCONT");
  await idleOn(m, w.session_id);
  const events = await transcript(m, w.session_id);
  holds(events, w.session_id);
  expect(await recordOn(m, w.session_id)).toMatchObject({ computer: { kind: "this_mac" } });
  results.r = { lidMs, load: load() };
}, 300_000);

test.skipIf(!REAL_STACK)("(s) a chat on its way to a Cloud computer made for another chat: that chat coming back to the Mac does not delete the computer under it, and it is handed there and adopted (AUDIT-W4-FINAL-CLOUD M-5)", async () => {
  const m = await mac();
  // Chat one moves to Cloud, which makes a Cloud computer for it.
  const one = await startChat(m, "Made the computer", "ask s1");
  expect((await m.client.call("session.move", { request_id: "s-one", session_id: one.session_id, to: "cloud" })).pending).toBe(false);
  const there = await onCloud(one.session_id, m.computerId);
  await until(async () => (await recordOn(there, one.session_id))?.status === "idle", 120_000);
  expect(sql(`SELECT spawned_for IS NOT NULL FROM code_computers WHERE id = '${there.computerId}'`)).toBe("t");
  // Chat two is moved by hand to that computer: accepted there, its hand over held on the Mac's way to Cloud.
  const two = await startChat(m, "On its way", "ask s2");
  let release!: () => void;
  m.net.state.hold = { match: new RegExp(`^POST .*/sessions/${two.session_id}/move$`), until: new Promise<void>((resolve) => (release = resolve)), waiting: 0 };
  const moving = m.client.call("session.move", { request_id: "s-two", session_id: two.session_id, to: { computer_id: there.computerId } });
  await until(() => m.net.state.hold!.waiting > 0, 120_000);
  expect(sql(`SELECT state FROM code_session_moves WHERE session_id = '${two.session_id}' ORDER BY created_at DESC LIMIT 1`)).toBe("accepted");
  // Chat one comes back to the Mac and settles there: Cloud retires the computers made for it that it left, but not one
  // chat two is on its way to.
  const at = Date.now();
  await m.client.call("session.move", { request_id: "s-back", session_id: one.session_id, to: "this_mac" });
  await until(() => owner(one.session_id) === m.computerId && sql(`SELECT state FROM code_session_moves WHERE session_id = '${one.session_id}' ORDER BY created_at DESC LIMIT 1`) === "adopted", 180_000);
  const backMs = Date.now() - at;
  expect(sql(`SELECT desired_state FROM code_computers WHERE id = '${there.computerId}'`)).not.toBe("deleted");
  // Chat two's hand over goes on: it lands on the computer, still running, which adopts it.
  m.net.state.hold = undefined;
  release();
  expect((await moving).pending).toBe(false);
  await until(() => sql(`SELECT state FROM code_session_moves WHERE session_id = '${two.session_id}' ORDER BY created_at DESC LIMIT 1`) === "adopted", 180_000);
  expect(owner(two.session_id)).toBe(there.computerId);
  expect(sql(`SELECT desired_state FROM code_computers WHERE id = '${there.computerId}'`)).toBe("running");
  await until(async () => (await recordOn(there, two.session_id))?.status === "idle", 120_000);
  holds(await transcript(there, two.session_id), two.session_id);
  results.s = { backMs, load: load() };
}, 600_000);

/** The lines the scripted agent's commands added to the effects log. */
const effectsRan = () => (fs.existsSync(effects) ? fs.readFileSync(effects, "utf8").split("\n").filter(Boolean) : []);
const percentile = (sorted: ReadonlyArray<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

// Finding R11, formal/NothingLost.tla's WriteAhead and NoSilentRerun. With CAVEMAN_TOOL_GATE=off in this run's
// environment (the gate before each tool off, as before it existed) this case fails: the turn that carries on is told
// nothing of the command, and runs it a second time.
test.skipIf(!REAL_STACK)("(t) a Cloud computer that dies right after a command took effect, and comes back on an empty disk: the turn that carries on is told the command may or may not have finished, and it runs once (R11)", async () => {
  const m = await mac();
  const w = await startChat(m, "Dies after a push", "ask t1", "full");
  await m.client.call("session.move", { request_id: "move-t", session_id: w.session_id, to: "cloud" });
  const there = await onCloud(w.session_id, m.computerId);
  await idleOn(there, w.session_id);
  await until(async () => journal(w.session_id).cursor === (await transcript(there, w.session_id)).at(-1)?.cursor, 60_000);
  const before = effectsRan().length;
  // The phone's message: 1.5 s in, the agent runs a command that takes effect, and the computer dies with it (kill -9).
  expect((await phone(w.session_id, "crash t2")).status).toBeLessThan(300);
  await until(() => there.child.exitCode !== null || there.child.signalCode !== null, 120_000);
  expect(effectsRan().slice(before)).toEqual(["cloud"]);
  const copyAtDeath = journal(w.session_id);
  // It comes back as the computers service brings one back: a new identity (the old one revoked), an empty state
  // directory, a fresh checkout. It asks Cloud which chats live here and takes this one from its copy.
  sql(`UPDATE code_runtimes SET status='revoked', revoked_at=now(), token_hash=NULL, token_expires_at=NULL WHERE id='${there.runtimeId}'`);
  const root = path.join(tempRoot("lid-box-"), "workspace");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, root]);
  const back = { ...(await cloudComputer(me, there.computerId, root, { ...gitEnv, MOVES_EFFECTS: effects })), root };
  boxes.set(there.computerId, back);
  const events = await waitReply(back, w.session_id, /crash t2 \(on cloud\)$/, 240_000);
  expect(contiguous(events)).toBe(true);
  const told = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" && e.payload.text.startsWith("[Caveman Code]") ? [e.payload.text] : [])).at(-1) ?? "";
  results.t = { ran: effectsRan().slice(before), told: told.split("\n").filter((line) => line.startsWith("- ") || /may or may not/.test(line)), copyAtDeath, load: load() };
  // Told, step by step, and so not run a second time.
  expect(told).toContain("this may or may not have finished: check before doing it again");
  expect(told).toMatch(/\n- echo cloud >> /);
  expect(effectsRan().slice(before)).toEqual(["cloud"]);
  expect(owner(w.session_id)).toBe(there.computerId);
}, 600_000);

// What the gate adds to a tool, and to which: a command pays for one write to Cloud's copy before it runs; a file read
// does not, and no tool of a chat that is not copied to Cloud does. The times are this lab's (Cloud on this machine,
// through the Mac's proxy): two requests to Cloud per command, so a real network adds two round trips.
test.skipIf(!REAL_STACK)("(u) what the gate before each tool costs: a command in a chat Cloud may move pays one write-ahead, a file read pays nothing, and a chat that is not copied pays nothing", async () => {
  const timings = path.join(tempRoot("lid-gate-"), "gate-ms.txt");
  const samples = () => (fs.existsSync(timings) ? fs.readFileSync(timings, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const net = await proxy();
  await signedIn();
  const repo = path.join(tempRoot("lid-mac-"), "repo");
  execFileSync("git", ["clone", "-q", gitEnv.GIT_CONFIG_VALUE_0!, repo]);
  const rt = await runtime("mac", { ...gitEnv, MOVES_CLOUD_URL: net.url, MOVES_BEARER: me.access_token, MOVES_EFFECTS: effects, CAVEMAN_GATE_TIMINGS: timings });
  const make = async (title: string, text: string) => {
    const w = await rt.client.call("workspace.create", { request_id: `w-${randomUUID()}`, repo: { path: repo }, title, engine: "caveman", options: { model: MODEL, access: "full" }, task: { text } });
    await waitReply(rt, w.session_id, new RegExp(`${text} \\(on mac\\)$`));
    await idleOn(rt, w.session_id);
    return w;
  };
  const turn = async (sessionId: string, requestId: string, text: string) => {
    const started = Date.now();
    await rt.client.call("turn.submit", { request_id: requestId, session_id: sessionId, kind: "followup", input: { text } });
    await waitReply(rt, sessionId, new RegExp(`${text} \\(on mac\\)$`), 180_000);
    return Date.now() - started;
  };
  // Not copied (the person has not turned sync on): 30 commands, and none pays.
  const local = await make("Not copied", "ask u1");
  const uncopiedMs = await turn(local.session_id, "u2", "burst 30 u2");
  expect(samples()).toEqual([]);
  // Copied, and Cloud may move it: each of 60 commands pays once; a file read does not.
  await rt.client.call("settings.set", { request_id: "moves-on", settings: { sync_chats: true, move_to_cloud: true } });
  const w = await make("Copied", "ask u3");
  await until(() => sql(`SELECT follow FROM code_sessions WHERE id = '${w.session_id}'`) === "t" && journal(w.session_id).cursor > 0, 60_000);
  await turn(w.session_id, "u4", "peek u4");
  expect(samples()).toEqual([]);
  const segmentsBefore = Number(sql(`SELECT segments FROM code_journal_index WHERE session_id = '${w.session_id}'`));
  const copiedMs = await turn(w.session_id, "u5", "burst 60 u5");
  const took = samples().sort((a, b) => a - b);
  expect(took).toHaveLength(60);
  const segments = Number(sql(`SELECT segments FROM code_journal_index WHERE session_id = '${w.session_id}'`)) - segmentsBefore;
  results.u = { commands: 60, p50Ms: percentile(took, 50), p95Ms: percentile(took, 95), maxMs: took.at(-1), turnMsPerCommand: Math.round(copiedMs / 60), uncopiedTurnMsPerCommand: Math.round(uncopiedMs / 30), segments, load: load() };
  // Each within what a command itself takes: far under a second here.
  expect(percentile(took, 95)).toBeLessThan(2_000);
  holds(await transcript(rt, w.session_id), w.session_id);
}, 600_000);

// formal/OneHolder.tla's Adopt guard (AskFirst and edits => asked), where no question could be put: the Mac asked for
// the chat back by itself while its folder was unchanged, and the person edited it before the chat arrived. With
// CAVEMAN_ASK_FIRST=off this case fails: the return lands over the edit.
test.skipIf(!REAL_STACK)("(w) the worktree edited after the Mac asked for its chat back by itself: the return never lands over the edit; the chat stays on Cloud, saying so, and the edit is as the person left it (R4)", async () => {
  const m = await mac();
  const w = await startChat(m, "Edited as it returned", "ask w1");
  await m.client.call("turn.submit", { request_id: "w2", session_id: w.session_id, kind: "followup", input: { text: "hang w2" } });
  await working(m, w.session_id);
  expect(await lid(m)).toEqual({ moving: 1, paused: 0 });
  const there = await onCloud(w.session_id, m.computerId);
  await waitReply(there, w.session_id, /hang w2 \(on cloud\)$/, 120_000);
  await idleOn(there, w.session_id);
  // Asleep 25 s, then awake on a slow network: what an adopt reads of the chat's copy takes a while to reach the Mac.
  m.child.kill("SIGSTOP");
  await sleep(25_000);
  let release = () => {};
  const hold = { match: /^GET .*\/journal\/segments\/\d+$/, until: new Promise<void>((resolve) => (release = resolve)), waiting: 0 };
  m.net.state.hold = hold;
  m.child.kill("SIGCONT");
  const woke = Date.now();
  // 30 s after waking the Mac asks for its chat back by itself (its folder is unchanged, so nobody is asked), Cloud
  // hands it over, and the Mac starts to take it.
  await until(() => hold.waiting > 0, 180_000);
  expect(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${w.session_id}' AND target = 'runtime:${m.runtimeId}'`)).toBe("1");
  // The person edits the chat's folder on the Mac while the return is on its way.
  fs.writeFileSync(path.join(w.root_path!, "mac-edit.txt"), "edited as it came back\n");
  release();
  m.net.state.hold = undefined;
  // The Mac does not take the chat over the edit: Cloud hands it back to the computer it runs on, and the Mac says so.
  await until(async () => (await transcript(m, w.session_id)).some((e) => e.type === "notification" && e.payload.title === "It stays on Cloud for now"), 120_000);
  await until(() => sql(`SELECT state || ':' || coalesce(code, '') FROM code_session_moves WHERE session_id = '${w.session_id}' AND target = 'runtime:${m.runtimeId}'`) === "failed:cave_code_copy_not_movable", 60_000);
  await until(async () => owner(w.session_id) === there.computerId && (await recordOn(there, w.session_id))?.status === "idle", 120_000);
  expect(fs.readFileSync(path.join(w.root_path!, "mac-edit.txt"), "utf8")).toBe("edited as it came back\n");
  expect(await recordOn(m, w.session_id)).toMatchObject({ computer: { kind: "caveman_cloud" } });
  holds(await transcript(there, w.session_id), w.session_id);
  results.w = { stayedSecondsAfterWake: Math.round((Date.now() - woke) / 1000), load: load() };
}, 420_000);

// formal/OneHolder.tla's LidOpens and Recheck. With CAVEMAN_LID_RECHECK=off in this run's environment this case
// fails: the Mac takes the message in and answers it, in a chat that lives on a Cloud computer by then.
test.skipIf(!REAL_STACK)("(v) a chat Cloud moved while the Mac slept: a message sent on the Mac the moment it wakes is not taken in there; the Mac asks Cloud first and hears the chat lives on Cloud", async () => {
  const m = await mac();
  const w = await startChat(m, "Moved while asleep", "ask v1");
  await idleOn(m, w.session_id);
  expect(await lid(m)).toEqual({ moving: 0, paused: 0 });
  await copied(m, w.session_id);
  m.child.kill("SIGSTOP");
  const slept = Date.now();
  expect((await phone(w.session_id, "ask v2 from the phone")).status).toBeLessThan(300);
  const there = await onCloud(w.session_id, m.computerId);
  await waitReply(there, w.session_id, /ask v1 \| ask v2 from the phone \(on cloud\)$/, 120_000);
  await sleep(Math.max(0, 10_000 - (Date.now() - slept)));
  // The Mac wakes on a slow network: Cloud's answers about its chats' journals take a while to reach it.
  let release = () => {};
  m.net.state.hold = { match: /^GET .*\/journal$/, until: new Promise<void>((resolve) => (release = resolve)), waiting: 0 };
  m.child.kill("SIGCONT");
  const sent = m.client.call("turn.submit", { request_id: "v3", session_id: w.session_id, kind: "followup", input: { text: "ask v3 on the mac" } }).then(
    () => "taken in",
    (error: Error) => error.message,
  );
  await sleep(5_000);
  // Nothing was added to the chat on the Mac while Cloud had not answered: no message of it, no answer to it.
  const onMac = await transcript(m, w.session_id);
  expect(onMac.some((e) => e.type === "message.done" && e.payload.text.includes("ask v3 on the mac"))).toBe(false);
  release();
  m.net.state.hold = undefined;
  expect(await sent).toMatch(/moved to a Cloud computer while this Mac slept/);
  await until(async () => (await recordOn(m, w.session_id))?.computer.kind === "caveman_cloud", 60_000);
  expect(owner(w.session_id)).toBe(there.computerId);
  expect(replies(await transcript(m, w.session_id)).some((r) => r.includes("ask v3 on the mac"))).toBe(false);
  holds(await transcript(there, w.session_id), w.session_id);
  results.v = { refused: await sent, load: load() };
}, 300_000);
