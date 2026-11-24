// One chat moves between two of a person's Macs against a REAL local Caveman Cloud (control-api on Postgres,
// SeaweedFS for the journal segments, the relay on Valkey), as the same session, never a fork. Both Macs are real
// runtime processes (moves.e2e.runtime.ts, MOVES_NAME "Mac A" and "Mac B") on the real Caveman engine with a scripted
// model, each with its own state dir, link key and device key; each Mac's desktop key is a WebCrypto P-256 device key
// the other allowed through the real relay. GitHub is a local bare repository every git here reaches through
// url.insteadOf. Both reach Cloud through one front origin served here: /relay/* to the relay (WebSocket upgrades
// included), everything else to control-api, as the chart's ingress routes it.
//
// In order: a move Mac B did not ask for (unsigned, signed by a key it never allowed, signed over another target) is
// refused at its accept and the chat stays idle on Mac A, never parked; Cloud's person route with no device's word is
// refused by Mac A itself. Then Mac A's own screen moves it to Mac B, signed by Mac A's key: one session in Cloud, the
// transcript contiguous and equal through the move, Mac B's next turn hearing every earlier message, and the work in
// progress intact (an unpushed commit, an uncommitted file, a deletion, nothing staged). Back from Mac B's screen,
// signed by Mac B's key, into Mac A's own worktree with Mac B's edit; and once more to Mac B from a phone both Macs
// allowed, through Cloud's person route. Nothing is ever pushed to GitHub.
//
// Skipped unless CAVEMAN_E2E_MAC_TO_MAC=1 with CAVEMAN_E2E_CLOUD_URL (control-api), CAVEMAN_E2E_RELAY_URL (the relay),
// CAVEMAN_E2E_EMAIL / CAVEMAN_E2E_PASSWORD (a member who may write Code) and CAVEMAN_E2E_PSQL (SQL on its database, a
// shell command reading stdin). CAVEMAN_E2E_RESULTS names a file for the evidence.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { deviceCode, signMove, type DeviceKey, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";

import { allowedOn, testDevice } from "../session-protocol/devices.testkit.ts";
import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { api, CLOUD, front, person, PSQL, RELAY, relayWire, sql, startMac as mac, stopAll, type Mac } from "./macs.e2e.kit.ts";

const MODEL = "anthropic/claude-haiku-4-5";

afterAll(stopAll);

const out = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** Allows `key` on `on` through the real relay: the device's hello, then the Mac's own Allow (devices.testkit allowedOn). */
const allow = async (on: Mac, key: DeviceKey) => allowedOn(await relayWire(on), on.client, key);

async function transcript(rt: Mac, sessionId: string) {
  const events: Array<SessionEvent> = [];
  const sub = await rt.client.attach(sessionId, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  return events;
}
const replies = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []));
const contiguous = (events: ReadonlyArray<SessionEvent>) => events.every((e, i) => e.cursor === i + 1);
const notified = (events: ReadonlyArray<SessionEvent>, title: RegExp) => events.some((e) => e.type === "notification" && title.test(JSON.stringify(e.payload)));
const recordOn = async (rt: Mac, sessionId: string) => (await rt.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === sessionId);
/** The transcript once its last answer matches `reply` and its turn is over (not there yet until the Mac adopted it). */
async function waitReply(rt: Mac, sessionId: string, reply: RegExp, ms = 60_000) {
  let events: Array<SessionEvent> = [];
  await until(async () => reply.test(replies((events = await transcript(rt, sessionId).catch(() => events))).at(-1) ?? ""), ms);
  await until(async () => (await recordOn(rt, sessionId))?.status === "idle", 30_000);
  return transcript(rt, sessionId);
}
const say = (rt: Mac, sessionId: string, text: string) => rt.client.call("turn.submit", { request_id: `say-${text.replace(/\W/g, "-")}-${Date.now()}`, session_id: sessionId, kind: "followup", input: { text } });
/** The chat idle on `rt` itself (a chat parked there for another Mac reads "parked"). */
const landed = (rt: Mac, sessionId: string) => until(async () => (await recordOn(rt, sessionId))?.status === "idle", 120_000);

test.skipIf(!process.env.CAVEMAN_E2E_MAC_TO_MAC || !CLOUD || !RELAY || !PSQL || !process.env.CAVEMAN_E2E_EMAIL || !process.env.CAVEMAN_E2E_PASSWORD)(
  "real Cloud: a chat moves from one of the person's Macs to another and back, only on a device the target allowed",
  async () => {
    const results: Record<string, unknown> = {};
    const me = await person();
    const origin = await front();
    // GitHub: a local bare repository, which every git here (the Macs' too) reaches by its URL.
    const root = tempRoot("mac-to-mac-e2e-");
    const name = `mac-to-mac-${Date.now().toString(36)}`;
    const bare = path.join(root, `${name}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    const gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/octocat/${name}` };
    Object.assign(process.env, gitEnv);
    const seed = path.join(root, "seed");
    execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, seed]);
    for (const file of ["README.md", "keep.txt", "gone.txt"]) fs.writeFileSync(path.join(seed, file), `${file}\n`);
    git(seed, "add", ".");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const refs = () => out(bare, "for-each-ref", "--format=%(refname) %(objectname)");
    const refsBefore = refs();

    // Two Macs of the person's, each with its own state dir, link key and desktop key, and each allowed on the other.
    const a = await mac("Mac A", origin, me.access_token, gitEnv);
    const b = await mac("Mac B", origin, me.access_token, gitEnv);
    expect(new Set([a.stateDir, b.stateDir, a.runtimeId, b.runtimeId, a.computerId, b.computerId]).size).toBe(6);
    const keyA = await testDevice("Mac A");
    const keyB = await testDevice("Mac B");
    const phone = await testDevice("Phone");
    await allow(b, keyA);
    await allow(a, keyB);
    await allow(a, phone);
    await allow(b, phone);
    results.macs = { a: { runtime: a.runtimeId, computer: a.computerId }, b: { runtime: b.runtimeId, computer: b.computerId } };
    // Cloud lists both as the person's Macs, by name.
    const listed = (await api(me.access_token, "GET", "/api/v1/code/computers?mine=true")).body.computers as Array<{ id: string; name: string; driver: string }>;
    expect(listed.filter((c) => c.id === a.computerId || c.id === b.computerId).map((c) => [c.name, c.driver]).sort()).toEqual([
      ["Mac A", "local"],
      ["Mac B", "local"],
    ]);

    // Mac B's own clone, with a chat of its own in it: a chat moved there lands beside it.
    const bRepo = path.join(root, "mac-b-repo");
    execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, bRepo]);
    const bOwn = await b.client.call("workspace.create", { request_id: "b-own", repo: { path: bRepo }, title: "Mac B's own", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask on b" } });
    await waitReply(b, bOwn.session_id, /ask on b \(on Mac B\)$/);

    // The chat on Mac A: two turns, copied to Cloud, and work in progress.
    const macRepo = path.join(root, "mac-a-repo");
    execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, macRepo]);
    const w = await a.client.call("workspace.create", { request_id: "w1", repo: { path: macRepo }, title: "Mac to Mac", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask one" } });
    const sessionId = w.session_id;
    const worktree = w.root_path!;
    await waitReply(a, sessionId, /ask one \(on Mac A\)$/);
    await say(a, sessionId, "ask two");
    await waitReply(a, sessionId, /ask one \| ask two \(on Mac A\)$/);
    await until(async () => ((await api(me.access_token, "GET", `/api/v1/code/sessions/${sessionId}`)).body?.journal?.segments ?? 0) >= 1, 60_000);
    const workspaceId = (await api(me.access_token, "GET", `/api/v1/code/sessions/${sessionId}`)).body.workspace_id as string;
    fs.writeFileSync(path.join(worktree, "local.txt"), "committed on Mac A\n");
    git(worktree, "add", "local.txt");
    git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "local commit on Mac A");
    fs.writeFileSync(path.join(worktree, "notes.txt"), "written on Mac A\n");
    fs.rmSync(path.join(worktree, "gone.txt"));

    const toA = { computer_id: a.computerId };
    const toB = { computer_id: b.computerId };
    const move = async (from: Mac, request_id: string, to: { computer_id: string }, key?: DeviceKey, signed: { computer_id: string } = to) =>
      from.client.call("session.move", { request_id, session_id: sessionId, to, ...(key ? { device: await signMove(key, { session_id: sessionId, request_id, to: signed }) } : {}) });
    const notAsked = (key?: DeviceKey) =>
      key
        ? `Mac B takes a chat only from a device you allowed there, and the one that asked (${deviceCode(key.device_id)}) isn't. Allow it on Mac B or on any of your Macs it takes approvals from (Settings, Devices), then move the chat again.`
        : "Mac B takes a chat only when you move it from Mac B itself, or from a device you allowed on Mac B or on any of your Macs it takes approvals from (Settings, Devices).";
    const stranger = await testDevice("Stranger");
    const stays = async () => {
      expect(await recordOn(a, sessionId)).toMatchObject({ status: "idle", computer: { kind: "this_mac" } });
      expect((await transcript(a, sessionId)).some((e) => e.type === "session.parked")).toBe(false);
      expect(await recordOn(b, sessionId)).toBeUndefined();
      expect(sql(`SELECT computer_id FROM code_workspaces WHERE id = '${workspaceId}'`)).toBe(a.computerId);
    };
    const movesOf = () => sql(`SELECT coalesce(string_agg(state || ':' || coalesce(code, ''), ',' ORDER BY created_at), '') FROM code_session_moves WHERE session_id = '${sessionId}'`);

    // a. Refused, the chat idle on Mac A and never parked: unsigned, signed by a key Mac B never allowed, signed over
    // another target, and Cloud's person route with no device's word (Mac A refuses that itself).
    const refusals: Record<string, string> = {};
    for (const [label, attempt, key] of [
      ["unsigned", () => move(a, "m-unsigned", toB), undefined],
      ["foreign key", () => move(a, "m-foreign", toB, stranger), stranger],
      ["another target", () => move(a, "m-other-to", toB, keyA, toA), keyA],
    ] as const) {
      const refused = await attempt().then(() => "moved", (e: Error) => e.message);
      refusals[label] = refused;
      expect(refused).toBe(notAsked(key));
      await stays();
    }
    const unsignedPerson = await api(me.access_token, "POST", `/api/v1/code/chats/${sessionId}/move`, { to: toB });
    expect(unsignedPerson.body).toMatchObject({ pending: true });
    await until(async () => notified(await transcript(a, sessionId), /A move from Caveman was refused/), 60_000);
    await stays();
    refusals["person route, unsigned"] = "A move from Caveman was refused";
    results.refusals = refusals;
    results.movesAfterRefusals = movesOf();

    // b. From Mac A's own screen, signed by Mac A's key, which Mac B allowed.
    expect((await move(a, "m-to-b", toB, keyA)).pending).toBe(false);
    await landed(b, sessionId);
    expect(await recordOn(a, sessionId)).toMatchObject({ status: "parked", computer: { id: b.computerId, kind: "this_mac", label: "Mac B" } });
    const onA = await transcript(a, sessionId);
    const parkedAt = onA.findLastIndex((e) => e.type === "session.parked");
    expect(onA[parkedAt]).toMatchObject({ payload: { reason: "move", to: "this_mac", cause: "user", name: "Mac B" } });
    let onB = await transcript(b, sessionId);
    const same = (e: SessionEvent) => JSON.stringify([e.cursor, e.type, e.payload]);
    expect(contiguous(onB)).toBe(true);
    expect(onB.slice(0, parkedAt).map(same)).toEqual(onA.slice(0, parkedAt).map(same));
    const bTree = (await recordOn(b, sessionId))!.root_path!;
    expect(out(bTree, "log", "-1", "--format=%s")).toBe("local commit on Mac A");
    expect(fs.readFileSync(path.join(bTree, "notes.txt"), "utf8")).toBe("written on Mac A\n");
    expect(fs.existsSync(path.join(bTree, "gone.txt"))).toBe(false);
    expect(out(bTree, "diff", "--cached", "--name-only")).toBe("");
    await say(b, sessionId, "ask three");
    onB = await waitReply(b, sessionId, /\(on Mac B\)$/);
    expect(replies(onB).at(-1)).toBe("heard: ask one | ask two | ask three (on Mac B)");
    expect(contiguous(onB)).toBe(true);
    results.toB = { parkedOnA: (await recordOn(a, sessionId))?.computer, bWorktree: bTree, reply: replies(onB).at(-1), moves: movesOf() };

    // c. Back from Mac B's own screen, signed by Mac B's key, which Mac A allowed: into Mac A's own worktree.
    fs.writeFileSync(path.join(bTree, "from-b.txt"), "written on Mac B\n");
    expect((await move(b, "m-to-a", toA, keyB)).pending).toBe(false);
    await landed(a, sessionId);
    const home = (await recordOn(a, sessionId))!;
    expect(home.root_path).toBe(worktree);
    expect(fs.readFileSync(path.join(worktree, "from-b.txt"), "utf8")).toBe("written on Mac B\n");
    expect(fs.readFileSync(path.join(worktree, "notes.txt"), "utf8")).toBe("written on Mac A\n");
    expect(out(worktree, "log", "-1", "--format=%s")).toBe("local commit on Mac A");
    expect(out(worktree, "diff", "--cached", "--name-only")).toBe("");
    expect(await recordOn(b, sessionId)).toMatchObject({ status: "parked", computer: { id: a.computerId, label: "Mac A" } });
    await say(a, sessionId, "ask four");
    let back = await waitReply(a, sessionId, /ask four \(on Mac A\)$/);
    expect(replies(back).at(-1)).toBe("heard: ask one | ask two | ask three | ask four (on Mac A)");
    expect(contiguous(back)).toBe(true);
    results.toA = { parkedOnB: (await recordOn(b, sessionId))?.computer, reply: replies(back).at(-1), moves: movesOf() };

    // And to Mac B from a phone both Macs allowed, through Cloud's person route: Mac A checks the phone's signature
    // before it lets the chat go, Mac B before it takes it.
    const asked = { session_id: sessionId, request_id: "phone-to-b", to: toB };
    const byPhone = await api(me.access_token, "POST", `/api/v1/code/chats/${sessionId}/move`, { to: toB, request_id: asked.request_id, device: await signMove(phone, asked) });
    expect(byPhone.status, JSON.stringify(byPhone.body)).toBeLessThan(300);
    await landed(b, sessionId);
    await say(b, sessionId, "ask five");
    back = await waitReply(b, sessionId, /ask five \(on Mac B\)$/);
    expect(replies(back).at(-1)).toBe("heard: ask one | ask two | ask three | ask four | ask five (on Mac B)");
    expect(contiguous(back)).toBe(true);
    results.byPhone = { answer: byPhone.body, reply: replies(back).at(-1), moves: movesOf() };

    // d. One session in Cloud, the same id all the way; nothing pushed to GitHub.
    const sessions = (await api(me.access_token, "GET", `/api/v1/code/sessions?workspace_id=${workspaceId}`)).body.sessions as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toEqual([sessionId]);
    expect(refs()).toBe(refsBefore);
    results.cloudSessions = sessions.map((s) => s.id);
    results.githubRefs = refs();
    results.transcript = back.map((e) => `${e.cursor} ${e.type}${e.type === "message.done" ? `: ${(e.payload as { text: string }).text.slice(0, 80)}` : ""}`);
    if (process.env.CAVEMAN_E2E_RESULTS) fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
  },
  900_000,
);
