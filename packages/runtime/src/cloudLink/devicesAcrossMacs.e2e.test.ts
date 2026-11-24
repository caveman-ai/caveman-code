// A person's Macs share device approvals against a REAL local Caveman Cloud (control-api on Postgres, the relay on
// Valkey): three real runtime processes stand for Macs A, B and C, each with its own state dir, link key and desktop
// key (a software P-256 key in place of the keychain one), and a WebCrypto key is the phone. The Macs allowed each
// other once on their own screens, in a cycle, each joining with the code the other's screen showed (decision 31), so
// each knows the others as Macs; a phone's key that says it is a Mac without a code is only a device on every Mac, and
// a wrong code, or the right one after it, joins nothing (A8). Then: the phone allowed
// once on Mac A's screen is approved at its hello on B and C, which never ask; Remove on Mac C cuts the phone off on
// all three within one wait (the time is recorded, lab-only, with the load); rows written straight into Cloud's table
// (forged, altered, signed by the phone's browser key, another person's or org's, an approval replayed after its
// removal) approve nothing anywhere; removing Mac A's key on Mac B drops what B and C trusted only through A; and
// with the person's allows at Cloud's cap, an Allow Cloud refuses stays on its Mac with the reason while a removal
// still reaches every Mac.
// A second family shows Continue on This Mac (A7): Mac B's own screen pulls a chat it never had from Mac A, on B's
// desktop key, which Mac A trusts only through Mac C; a stranger's key, a Mac without the repository and a sleeping
// Mac A are each refused with nothing parked. Move to's look at a Mac without the repository is refused in the menu's
// words, and one whose runtime names no repositories (an older one) is not filtered (decision 30); a pull from an older
// client, which signs no stop, waits for the turn on Mac A to end and comes at that boundary (decision 32).
//
// A third family shows This Mac is always the window's own Mac (audit C2), with two of the person's Cloud computers
// enrolled by SQL as moves.e2e.test.ts does: a chat Mac A moved to a Cloud computer lands on Mac B when Mac B's own
// screen continues it there, with Mac A awake and with Mac A asleep (SIGSTOP), and a chat one Cloud computer handed to
// another still goes back to Mac A from Mac A's screen, which the chat still names as where it came from. What the
// hosted web reads for such a chat, and for one born on a Cloud computer, is written to CAVEMAN_E2E_WEB_FIXTURE when
// set, for the web's own Move to to read (apps/web moves.e2e.test.ts): it offers no This Mac for either.
//
// Skipped unless CAVEMAN_E2E_DEVICES=1 with CAVEMAN_E2E_CLOUD_URL, CAVEMAN_E2E_RELAY_URL, CAVEMAN_E2E_EMAIL,
// CAVEMAN_E2E_PASSWORD and CAVEMAN_E2E_PSQL (as macToMac.e2e.test.ts). CAVEMAN_E2E_RESULTS names a file for the evidence.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { allowStatementFor, deviceCode, helloPayload, SessionProtocolError, signCall, signMove, signStatement, signStop, statementId, verifyPairAnswer, type DeviceKey, type SessionEvent } from "@caveman-app/session-protocol";
import { afterAll, expect, test } from "vitest";

import { testDevice } from "../session-protocol/devices.testkit.ts";
import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { repoHash } from "./heartbeatRepos.ts";
import { allowOnScreen, api, CLOUD, deviceList, front, github, hello, load, olderMac, person, PSQL, RELAY, removeOnScreen, sql, startBox, startMac, stopAll, trusts, type Mac } from "./macs.e2e.kit.ts";

afterAll(stopAll);

const MODEL = "anthropic/claude-haiku-4-5";
const results: Record<string, unknown> = {};
const save = () => process.env.CAVEMAN_E2E_RESULTS && fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
const live = !!process.env.CAVEMAN_E2E_DEVICES && !!CLOUD && !!RELAY && !!PSQL && !!process.env.CAVEMAN_E2E_EMAIL && !!process.env.CAVEMAN_E2E_PASSWORD;

/**
 * Three Macs that each allowed one other on its own screen, in a cycle: B allowed A, C allowed B, A allowed C, each
 * joining with the code the other's screen showed (allowOnScreen pairs a Mac's desktop key, decision 31).
 */
async function family(origin: string, bearer: string, env: Record<string, string>) {
  const [a, b, c] = [await startMac("Mac A", origin, bearer, env), await startMac("Mac B", origin, bearer, env), await startMac("Mac C", origin, bearer, env)];
  await allowOnScreen(b, a.key);
  await allowOnScreen(c, b.key);
  await allowOnScreen(a, c.key);
  for (const on of [a, b, c]) for (const other of [a, b, c]) if (other !== on) await until(() => trusts(on, other.key), 60_000);
  return { a, b, c };
}

/** A runtime a test talks to: a Mac, or one of the person's Cloud computers (startBox). */
type Runtime = Pick<Mac, "client">;
const transcript = async (rt: Runtime, sessionId: string) => {
  const events: Array<SessionEvent> = [];
  const sub = await rt.client.attach(sessionId, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  return events;
};
const replies = (events: ReadonlyArray<SessionEvent>) => events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []));
const contiguous = (events: ReadonlyArray<SessionEvent>) => events.every((e, i) => e.cursor === i + 1);
const notes = (events: ReadonlyArray<SessionEvent>, title: RegExp) => events.filter((e) => e.type === "notification" && title.test(JSON.stringify(e.payload))).map((e) => JSON.stringify(e.payload));
const recordOn = async (rt: Runtime, sessionId: string) => (await rt.client.call("workspace.list", {})).workspaces.find((w) => w.session_id === sessionId);
/** The transcript once its last answer matches `reply` and its turn is over. */
async function waitReply(rt: Runtime, sessionId: string, reply: RegExp, ms = 60_000) {
  let events: Array<SessionEvent> = [];
  await until(async () => reply.test(replies((events = await transcript(rt, sessionId).catch(() => events))).at(-1) ?? ""), ms);
  await until(async () => (await recordOn(rt, sessionId))?.status === "idle", 30_000);
  return transcript(rt, sessionId);
}
const say = (rt: Runtime, sessionId: string, text: string) => rt.client.call("turn.submit", { request_id: `say-${text.replace(/\W/g, "-")}-${Date.now()}`, session_id: sessionId, kind: "followup", input: { text } });
const out = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test.skipIf(!live)(
  "real Cloud: one Mac's Allow reaches the person's other Macs, Remove on any revokes it everywhere, and Cloud's own rows approve nothing",
  async () => {
    const me = await person();
    const origin = await front();
    const root = tempRoot("devices-macs-e2e-");
    const repo = github(root);
    const { a, b, c } = await family(origin, me.access_token, repo.env);
    // Each Mac lists the other two, never its own key.
    for (const on of [a, b, c]) expect((await deviceList(on)).devices.map((d) => d.name).sort()).toEqual([a, b, c].filter((m) => m !== on).map((m) => m.name));
    results.macs = Object.fromEntries([a, b, c].map((m) => [m.name, { runtime: m.runtimeId, computer: m.computerId, key: m.key.device_id }]));
    results.chain = Object.fromEntries(
      await Promise.all([a, b, c].map(async (m) => [m.name, (await deviceList(m)).devices.map((d) => `${d.name}: ${d.allowed_by ? `through ${d.allowed_by.name}` : d.shared ? "here" : "this Mac only"}`)] as const)),
    );

    // A8 (decision 31). Each Mac joined one other with the code that Mac's screen showed: all three are Macs on all three.
    for (const on of [a, b, c]) for (const d of (await deviceList(on)).devices) expect([on.name, d.name, d.role]).toEqual([on.name, d.name, "mac"]);
    // A phone's page that says, signed, it is a Mac, without a code: it asks as a device; allowed so on Mac A's screen,
    // it drives the person's Macs as a device, and an allow it signs (Cloud carrying it) counts on none of them.
    const posing = await testDevice("Julius's MacBook Pro", "mac");
    expect((await hello(a, posing)).status).toBe("pending");
    expect((await deviceList(a)).requests.find((r) => r.device_id === posing.device_id)).toMatchObject({ role: "device" });
    await allowOnScreen(a, posing, { pair: false });
    for (const on of [b, c]) await until(() => trusts(on, posing), 60_000);
    for (const on of [a, b, c]) expect([on.name, (await deviceList(on)).devices.find((d) => d.device_id === posing.device_id)?.role]).toEqual([on.name, undefined]);
    const smuggled = await testDevice("Smuggled phone");
    const smuggledAllow = await signStatement(posing, { kind: "allow", organization_id: me.user.organization_id, user_id: me.user.id, device_id: smuggled.device_id, public_key: smuggled.public_key, name: smuggled.name, role: "mac" });
    sql(`INSERT INTO code_device_statements (organization_id, user_id, id, body, from_runtime_id) VALUES ('${me.user.organization_id}', '${me.user.id}', '${createHash("sha256").update(randomUUID()).digest("base64url")}', $j$${JSON.stringify(smuggledAllow)}$j$::jsonb, '${randomUUID()}')`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    for (const on of [a, b, c]) expect([on.name, (await hello(on, smuggled)).status]).toEqual([on.name, "pending"]);
    // Each screen says no to it (Don't allow), so it waits on none (a Mac asks about at most three at once).
    for (const on of [a, b, c]) await on.client.call("device.remove", { request_id: `no-${smuggled.device_id}-${on.name}`, device_id: smuggled.device_id });
    // A Mac's app that types a wrong code into Mac C is refused, and the code is used up: the right one after it joins
    // nothing either. (A code past its ten minutes: the hermetic devices.integration test moves the clock.)
    const macD = await testDevice("Mac D", "mac");
    const code = (await c.client.call("device.pair.start", { request_id: `pair-${randomUUID()}` })).code;
    const reason = (said: Awaited<ReturnType<typeof hello>>) => said.status;
    const wrong = await hello(c, macD, { pair: code.startsWith("0") ? "1111-1111-1111" : "0000-0000-0000" });
    expect(reason(wrong)).toMatch(/^error .*invalid_params/);
    const late = await hello(c, macD, { pair: code });
    expect(reason(late)).toMatch(/^error .*invalid_params/);
    expect((await deviceList(c)).requests.some((r) => r.device_id === macD.device_id)).toBe(false);
    results.pairing = { everyMacIsAMacOnEach: true, phoneClaimingMac: "a device on A, B and C; its allow counts on none", wrongCode: wrong.status, rightCodeAfterIt: late.status };
    save();

    // A2. The phone, allowed once on Mac A's screen: its code shows once, on Mac A; Macs B and C answer approved and never ask.
    const phone = await testDevice("iPhone, Safari");
    const asked = { a: a.requests.length, b: b.requests.length, c: c.requests.length };
    const onA = await allowOnScreen(a, phone);
    // The phone reaches the next Mac once Mac A's Allow is in the person's log (Mac A puts it right after the click; a
    // hello that raced that put would find nothing yet and ask). Each hello reads the log itself: no Mac's follow loop
    // has to have heard first.
    await until(() => sql(`SELECT count(*) FROM code_device_statements WHERE user_id = '${me.user.id}' AND body->>'device_id' = '${phone.device_id}' AND body->>'kind' = 'allow'`) === "1", 30_000);
    const onB = await hello(b, phone);
    const onC = await hello(c, phone);
    expect([onB.status, onC.status]).toEqual(["approved", "approved"]);
    expect([a.requests.length - asked.a, b.requests.length - asked.b, c.requests.length - asked.c]).toEqual([1, 0, 0]);
    expect((await onB.call("workspace.list", {})).error).toBeUndefined();
    // A3. How each Mac says it was allowed.
    for (const on of [b, c]) expect((await deviceList(on)).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ allowed_by: { device_id: a.key.device_id, name: "Mac A" } });
    expect((await deviceList(a)).devices.find((d) => d.device_id === phone.device_id)).toMatchObject({ shared: true });
    expect((await deviceList(a)).devices.find((d) => d.device_id === phone.device_id)).not.toHaveProperty("allowed_by");
    results.allowed = { codeShownOn: "Mac A", requests: { a: a.requests.length - asked.a, b: b.requests.length - asked.b, c: c.requests.length - asked.c }, helloOnB: onB.status, helloOnC: onC.status };

    // A chat on Mac A, synced, which the phone drives through Cloud's queue while it is allowed.
    const clone = path.join(root, "mac-a-repo");
    execFileSync("git", ["clone", "-q", repo.url, clone]);
    const w = await a.client.call("workspace.create", { request_id: "w1", repo: { path: clone }, title: "On Mac A", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask one" } });
    const sessionId = w.session_id;
    await until(async () => (await api(me.access_token, "GET", `/api/v1/code/sessions/${sessionId}`)).body?.journal?.segments >= 1, 120_000);
    const queue = async (request_id: string) => {
      const call = { session_id: sessionId, request_id, method: "turn.submit", params: { session_id: sessionId, kind: "followup", input: { text: `ask ${request_id}` } } };
      const posted = await api(me.access_token, "POST", `/api/v1/code/chats/${sessionId}/calls`, { request_id, method: call.method, params: call.params, device: await signCall(phone, call) });
      expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
      const state = async () => (await api(me.access_token, "GET", `/api/v1/code/chats/${sessionId}/calls/${request_id}`)).body as { status: string; error?: { code?: string } };
      await until(async () => ["done", "failed"].includes((await state()).status), 90_000);
      return state();
    };
    expect((await queue("before-remove")).status).toBe("done");

    // A4. Remove on Mac C, signed by its key: the phone's open sealed connections on A and B close within one wait cycle
    // plus 5 s; all three list it removed on Mac C and refuse its hello.
    const loadAtRemove = load();
    const removedAt = Date.now();
    await removeOnScreen(c, phone);
    await until(() => onA.wire.closed() && onB.wire.closed(), 30_000);
    const closedMs = Date.now() - removedAt;
    expect(closedMs).toBeLessThan(30_000);
    for (const on of [a, b, c]) expect([on.name, (await hello(on, phone)).status]).toEqual([on.name, "refused"]);
    for (const on of [a, b]) expect((await deviceList(on)).blocked.find((x) => x.device_id === phone.device_id)).toMatchObject({ removed_by: { device_id: c.key.device_id, name: "Mac C" } });
    expect((await deviceList(c)).blocked.some((x) => x.device_id === phone.device_id)).toBe(true);
    // Mac A refuses a call the phone queued in Cloud, and a move the phone signed.
    expect(await queue("after-remove")).toMatchObject({ status: "failed", error: { code: "device_not_approved" } });
    // (Mac B has the repository open too, so Cloud offers it the move (decision 30) and the move reaches Mac A's check.)
    const bClone = path.join(root, "mac-b-repo");
    execFileSync("git", ["clone", "-q", repo.url, bClone]);
    await b.client.call("project.create", { request_id: "b-open", path: bClone });
    await until(() => sql(`SELECT COALESCE(repos::text, '') FROM code_runtimes WHERE id = '${b.runtimeId}'`).includes(repoHash(repo.url)!), 60_000);
    const asks = { session_id: sessionId, request_id: "phone-move", to: { computer_id: b.computerId } };
    const moved = await api(me.access_token, "POST", `/api/v1/code/chats/${sessionId}/move`, { to: asks.to, request_id: asks.request_id, device: await signMove(phone, asks) });
    expect(moved.body).toMatchObject({ pending: true });
    await until(async () => (await transcript(a, sessionId)).some((e) => e.type === "notification" && JSON.stringify(e.payload).includes("A move from Caveman was refused")), 60_000);
    expect((await a.client.call("workspace.list", {})).workspaces.find((x) => x.session_id === sessionId)).toMatchObject({ computer: { kind: "this_mac" } });
    results.removed = { closedMs, load: loadAtRemove, queuedCall: "device_not_approved", signedMove: "refused on Mac A, the chat stayed" };
    save();

    // A5. Rows written straight into Cloud's table approve nothing on any Mac.
    const mallory = await testDevice("Mallory's laptop", "mac");
    const stranger = await testDevice("Cloud's own key", "mac");
    const { id: user, organization_id: org } = me.user;
    const genuine = JSON.parse(sql(`SELECT body::text FROM code_device_statements WHERE user_id = '${user}' AND body->>'device_id' = '${phone.device_id}' AND body->>'kind' = 'allow' LIMIT 1`)) as Record<string, unknown>;
    const allowMallory = (by: DeviceKey, who: { organization_id?: string; user_id?: string } = {}) =>
      signStatement(by, { kind: "allow", organization_id: who.organization_id ?? org, user_id: who.user_id ?? user, device_id: mallory.device_id, public_key: mallory.public_key, name: mallory.name, role: "mac" });
    const rows: Record<string, unknown> = {
      "a forged signer": await allowMallory(stranger),
      "a genuine statement with its target key swapped": { ...genuine, device_id: mallory.device_id, public_key: mallory.public_key },
      "a statement signed by the phone's browser key": await allowMallory(phone),
      "another person's statement": await allowMallory(a.key, { user_id: randomUUID() }),
      "another org's statement": await allowMallory(a.key, { organization_id: randomUUID() }),
      "the phone's approval replayed after its removal": genuine,
    };
    const before = Number(sql(`SELECT coalesce(max(seq), 0) FROM code_device_statements WHERE user_id = '${user}'`));
    for (const [label, body] of Object.entries(rows)) {
      // A fresh row id every run (the person's log keeps earlier runs' rows).
      const id = createHash("sha256").update(`${label}-${randomUUID()}`).digest("base64url");
      sql(`INSERT INTO code_device_statements (organization_id, user_id, id, body, from_runtime_id) VALUES ('${org}', '${user}', '${id}', $j$${JSON.stringify(body)}$j$::jsonb, '${randomUUID()}')`);
    }
    expect(Number(sql(`SELECT count(*) FROM code_device_statements WHERE user_id = '${user}' AND seq > ${before}`))).toBe(Object.keys(rows).length);
    // Each Mac reads past them (a Valkey nudge never came for psql's rows: its fallback read finds them).
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const refusedRows: Record<string, string> = {};
    for (const on of [a, b, c]) {
      expect([on.name, (await hello(on, mallory)).status]).toEqual([on.name, "pending"]);
      expect([on.name, (await hello(on, phone)).status]).toEqual([on.name, "refused"]);
      expect(await trusts(on, mallory)).toBe(false);
      refusedRows[on.name] = "mallory pending, phone refused";
    }
    results.cloudRows = { rows: Object.keys(rows), outcome: refusedRows };
    save();

    // A6. Mac A is stolen: Mac B's screen removes its key. B and C drop what they trusted only through A (a tablet
    // allowed on A's screen), and its connection to B closes; Mac A's own screen still lists it.
    const tablet = await testDevice("iPad, Safari");
    await allowOnScreen(a, tablet);
    await until(async () => (await trusts(b, tablet)) && (await trusts(c, tablet)), 60_000);
    const tabletOnB = await hello(b, tablet);
    expect(tabletOnB.status).toBe("approved");
    await removeOnScreen(b, a.key);
    await until(async () => !(await trusts(b, tablet)) && !(await trusts(c, tablet)) && tabletOnB.wire.closed(), 60_000);
    expect((await deviceList(c)).blocked.find((x) => x.device_id === a.key.device_id)).toMatchObject({ removed_by: { device_id: b.key.device_id, name: "Mac B" } });
    expect(await trusts(c, b.key)).toBe(true);
    expect(await trusts(a, tablet)).toBe(true);
    expect((await hello(c, tablet)).status).toBe("pending");
    results.macRemoved = { droppedOnB: true, droppedOnC: true, stillOnA: true, cStillTrustsB: true };
    save();

    // T12, a full log: the person's allows reach Cloud's cap (rows written straight into the table). Cloud refuses
    // Mac C's next Allow, which C keeps with Cloud's reason; a removal on Mac B still goes in, and Mac C, holding a
    // statement Cloud refused, still follows the log and cuts the device off.
    const watch = await testDevice("Watch, Safari");
    await allowOnScreen(b, watch);
    await until(() => trusts(c, watch), 60_000);
    const watchOnC = await hello(c, watch);
    expect(watchOnC.status).toBe("approved");
    const filler = randomUUID();
    const allows = Number(sql(`SELECT count(*) FROM code_device_statements WHERE organization_id = '${org}' AND user_id = '${user}' AND body->>'kind' = 'allow'`));
    sql(`INSERT INTO code_device_statements (organization_id, user_id, id, body, from_runtime_id)
         SELECT '${org}', '${user}', translate(rtrim(encode(sha256(convert_to('${filler}:' || i, 'UTF8')), 'base64'), '='), '+/', '-_'), jsonb_build_object('kind', 'allow', 'filler', i), '${filler}'
         FROM generate_series(1, ${Math.max(0, 2000 - allows)}) AS i`);
    try {
      const pixel = await testDevice("Pixel, Chrome");
      await allowOnScreen(c, pixel);
      await until(async () => (await deviceList(c)).devices.find((d) => d.device_id === pixel.device_id)?.not_shared !== undefined, 60_000);
      const kept = (await deviceList(c)).devices.find((d) => d.device_id === pixel.device_id)!;
      expect(kept.not_shared).toMatch(/most device approvals/);
      expect(kept).not.toHaveProperty("shared");
      const loadAtFull = load();
      const removedAt = Date.now();
      await removeOnScreen(b, watch);
      await until(() => watchOnC.wire.closed(), 60_000);
      const closedOnC = Date.now() - removedAt;
      expect((await hello(c, watch)).status).toBe("refused");
      results.fullLog = { allowOnC: kept.not_shared, removalClosedOnCMs: closedOnC, load: loadAtFull };
      save();
    } finally {
      // Later runs share the person's log.
      sql(`DELETE FROM code_device_statements WHERE from_runtime_id = '${filler}'`);
    }
  },
  900_000,
);

test.skipIf(!live)(
  "real Cloud: Continue on This Mac pulls a chat Mac B never had from Mac A, only on a key Mac A takes, and back",
  async () => {
    const me = await person();
    const origin = await front();
    const root = tempRoot("pull-macs-e2e-");
    const repo = github(root);
    const refsBefore = out(repo.bare, "for-each-ref", "--format=%(refname) %(objectname)");
    const { a, b } = await family(origin, me.access_token, repo.env);
    // Mac A takes Mac B's desktop key only through Mac C (C allowed B, A allowed C): B's pull is signed by it.
    expect((await deviceList(a)).devices.find((d) => d.device_id === b.key.device_id)).toMatchObject({ allowed_by: { name: "Mac C" } });
    const pulls: Record<string, unknown> = { bOnA: "Allowed through Mac C" };

    // The chat on Mac A: two turns, copied to Cloud, then work in progress: an unpushed commit, an uncommitted file,
    // a deletion.
    const aRepo = path.join(root, "mac-a-repo");
    execFileSync("git", ["clone", "-q", repo.url, aRepo]);
    const w = await a.client.call("workspace.create", { request_id: "p1", repo: { path: aRepo }, title: "Pulled", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask one" } });
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
    fs.rmSync(path.join(worktree, "README.md"));

    /**
     * Continue on This Mac on `on`'s own screen: signed by its desktop key (or `key`) over exactly that move. `stop`
     * false: as an older client asks, with no stop of the chat's running turn.
     */
    const pull = async (on: Mac, request_id: string, key: DeviceKey = on.key, stop = true) => {
      const to = { computer_id: on.computerId };
      // As the desktop app signs it: the move, and a stop of the chat's running turn there (decision 32).
      return on.client.call("session.move", {
        request_id,
        session_id: sessionId,
        to,
        device: await signMove(key, { session_id: sessionId, request_id, to }),
        ...(stop ? { stop: await signStop(key, { session_id: sessionId, move_request_id: request_id }) } : {}),
      });
    };
    /** Still on Mac A, idle and never parked, Cloud's workspace still Mac A's, and nowhere on `other`. */
    const stays = async (other: Mac) => {
      expect(await recordOn(a, sessionId)).toMatchObject({ status: "idle", computer: { kind: "this_mac" } });
      expect((await transcript(a, sessionId)).some((e) => e.type === "session.parked")).toBe(false);
      expect(sql(`SELECT computer_id FROM code_workspaces WHERE id = '${workspaceId}'`)).toBe(a.computerId);
      expect(await recordOn(other, sessionId)).toBeUndefined();
    };

    // T15: Mac B has no checkout of the repository: it never clones one on Cloud's word, and nothing parks on Mac A.
    // Decision 30: Mac B's heartbeat named its checkouts (by hash), so Cloud refuses the pull itself, before Mac A is
    // offered anything.
    const hash = repoHash(repo.url)!;
    const bRepos = () => sql(`SELECT COALESCE(repos::text, 'null') FROM code_runtimes WHERE id = '${b.runtimeId}'`);
    await until(() => bRepos() !== "null", 60_000);
    expect(bRepos()).not.toContain(hash);
    const movesBefore = sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${sessionId}'`);
    const missing = await pull(b, "pull-no-repo").then(() => "pulled", (e: Error) => e.message);
    expect(missing).toBe(`Open octocat/${repo.name} on Mac B first, then move the chat again.`);
    expect(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${sessionId}'`)).toBe(movesBefore);
    await stays(b);
    pulls.noRepo = { refusal: missing, refusedBy: "Cloud, from Mac B's heartbeat (no move offered)" };

    // Decision 30 at Move to's look: the chat's own Mac asks Cloud of each Mac (session.move.check), and Mac B is refused
    // in the words the menu shows under it, disabled. Mac D, whose runtime names no repositories (one from before them:
    // the link client heartbeating without them), is not filtered: the look leaves it to that Mac's own accept.
    const look = (to: string) =>
      a.client.call("session.move.check", { session_id: sessionId, to: { computer_id: to } }).then(
        (r) => r as unknown,
        (e: unknown) => (e instanceof SessionProtocolError ? { refused: e.message, capability: e.error.data?.capability } : { failed: String(e) }),
      );
    expect(await look(b.computerId)).toEqual({ refused: `Open octocat/${repo.name} on Mac B first, then move the chat again.`, capability: "repo" });
    const older = await olderMac("Mac D", origin, me.access_token);
    expect(sql(`SELECT repos IS NULL FROM code_runtimes WHERE id = '${older.runtimeId}'`)).toBe("t");
    // Offered, its login none (the Caveman engine); the look also carries its preflight (decisions 24, 28).
    expect(await look(older.computerId)).toMatchObject({ login: null });
    older.stop();
    expect(sql(`SELECT count(*) FROM code_session_moves WHERE session_id = '${sessionId}'`)).toBe(movesBefore);
    await stays(b);
    pulls.look = { macB: "refused: no checkout (repo)", olderMacD: "offered (names no repositories)" };

    // Mac B opens the repository (its own clone, a chat of its own in it): a key Mac A never allowed is refused by Mac A
    // itself, then Mac B's screen pulls the chat.
    const bRepo = path.join(root, "mac-b-repo");
    execFileSync("git", ["clone", "-q", repo.url, bRepo]);
    const bOwn = await b.client.call("workspace.create", { request_id: "b-own", repo: { path: bRepo }, title: "Mac B's own", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask on b" } });
    await waitReply(b, bOwn.session_id, /ask on b \(on Mac B\)$/);
    // Its heartbeat names the repository now.
    await until(() => bRepos().includes(hash), 60_000);

    // T14: signed by a key Mac A never allowed: Mac A refuses, the chat stays, and its chat says why. The key is one
    // Mac A has no record of, so its own chat never vouches for that key's code (the mail is only Cloud's word).
    const stranger = await testDevice("Stranger", "mac");
    expect(await pull(b, "pull-stranger", stranger)).toMatchObject({ pending: true, session: { id: sessionId, state: "parked" } });
    let refusedNote: Array<string> = [];
    await until(async () => (refusedNote = notes(await transcript(a, sessionId), /A move from Caveman was refused/)).length > 0, 60_000);
    expect(refusedNote[0]).toContain("A device this Mac doesn't know asked for it, so the chat stays here.");
    expect(refusedNote[0]).not.toContain(deviceCode(stranger.device_id));
    await stays(b);
    pulls.stranger = { answer: "pending on Mac B", noteOnA: JSON.parse(refusedNote[0]!) };

    // Decision 32: Mac A is mid-turn (a turn that runs until it is stopped). Mac B's pull stops it there, on Mac B's
    // signed word, and the chat comes at that boundary.
    await say(a, sessionId, "hang until Mac B pulls it");
    await until(async () => (await recordOn(a, sessionId))?.status === "working", 60_000);
    const loadAtPull = load();
    const pulledAt = Date.now();
    const pulled = await pull(b, "pull-to-b");
    expect(pulled.session.id).toBe(sessionId);
    await until(async () => (await recordOn(b, sessionId))?.status === "idle", 120_000);
    const landedMs = Date.now() - pulledAt;
    expect(await recordOn(a, sessionId)).toMatchObject({ status: "parked", computer: { id: b.computerId, kind: "this_mac", label: "Mac B" } });
    const onA = await transcript(a, sessionId);
    const parkedAt = onA.findLastIndex((e) => e.type === "session.parked");
    expect(onA[parkedAt]).toMatchObject({ payload: { reason: "move", to: "this_mac", name: "Mac B" } });
    expect(notes(onA, /Stopped this turn to move it/)).toHaveLength(1);
    expect(onA.filter((e) => e.type === "turn.done").at(-1)?.payload).toMatchObject({ status: "interrupted" });
    let onB = await transcript(b, sessionId);
    const same = (e: SessionEvent) => JSON.stringify([e.cursor, e.type, e.payload]);
    expect(contiguous(onB)).toBe(true);
    expect(onB.slice(0, parkedAt).map(same)).toEqual(onA.slice(0, parkedAt).map(same));
    const bTree = (await recordOn(b, sessionId))!.root_path!;
    expect(out(bTree, "log", "-1", "--format=%s")).toBe("local commit on Mac A");
    expect(fs.readFileSync(path.join(bTree, "notes.txt"), "utf8")).toBe("written on Mac A\n");
    expect(fs.existsSync(path.join(bTree, "README.md"))).toBe(false);
    expect(out(bTree, "diff", "--cached", "--name-only")).toBe("");
    await say(b, sessionId, "ask three");
    onB = await waitReply(b, sessionId, /\(on Mac B\)$/);
    // The stopped turn's message stays in the chat that moved; the engine's conversation goes on from the turns that ended.
    expect(onB.some((e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === "hang until Mac B pulls it")).toBe(true);
    expect(replies(onB).at(-1)).toBe("heard: ask one | ask two | ask three (on Mac B)");
    expect(contiguous(onB)).toBe(true);
    pulls.toB = { stoppedOnA: "a turn that ran until stopped", sameSession: sessionId, landedMs, load: loadAtPull, reply: replies(onB).at(-1), worktree: "unpushed commit, notes.txt, README.md deleted" };

    // Back to Mac A with the same button, from Mac A's own screen (Mac B allowed Mac A's key): into Mac A's worktree.
    fs.writeFileSync(path.join(bTree, "from-b.txt"), "written on Mac B\n");
    expect(await pull(a, "pull-back")).toMatchObject({ pending: true });
    await until(async () => (await recordOn(a, sessionId))?.status === "idle", 120_000);
    expect((await recordOn(a, sessionId))!.root_path).toBe(worktree);
    expect(fs.readFileSync(path.join(worktree, "from-b.txt"), "utf8")).toBe("written on Mac B\n");
    expect(fs.readFileSync(path.join(worktree, "notes.txt"), "utf8")).toBe("written on Mac A\n");
    expect(await recordOn(b, sessionId)).toMatchObject({ status: "parked", computer: { id: a.computerId, label: "Mac A" } });
    await say(a, sessionId, "ask four");
    const back = await waitReply(a, sessionId, /ask four \(on Mac A\)$/);
    expect(replies(back).at(-1)).toBe("heard: ask one | ask two | ask three | ask four (on Mac A)");
    expect(contiguous(back)).toBe(true);
    pulls.back = { reply: replies(back).at(-1) };
    save();

    // Decision 32, an older client: a pull that signs no stop waits for the turn running on Mac A to end (it is never
    // stopped), and the chat comes at that boundary, with that turn's own answer.
    await say(a, sessionId, "slow work on Mac A");
    await until(async () => (await recordOn(a, sessionId))?.status === "working", 60_000);
    const loadAtWait = load();
    const waitFrom = Date.now();
    // (The pull answers once Mac A accepted it, or after 15 s: it is not waited on while the turn runs.)
    const waiting = pull(b, "pull-no-stop", b.key, false);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await recordOn(a, sessionId)).toMatchObject({ status: "working", computer: { kind: "this_mac" } });
    expect(await waiting).toMatchObject({ pending: true });
    await until(async () => (await recordOn(b, sessionId))?.status === "idle", 120_000);
    const waitedMs = Date.now() - waitFrom;
    const onAWaited = await transcript(a, sessionId);
    expect(onAWaited.filter((e) => e.type === "turn.done").at(-1)?.payload).toMatchObject({ status: "completed" });
    expect(replies(onAWaited).at(-1)).toMatch(/slow work on Mac A \(on Mac A\)$/);
    expect(notes(onAWaited, /Stopped this turn to move it/)).toHaveLength(1);
    expect(contiguous(await transcript(b, sessionId))).toBe(true);
    pulls.noStop = { waitedMs, load: loadAtWait, lastTurnOnA: "completed" };
    // Back to Mac A for what follows.
    expect(await pull(a, "pull-back-again")).toMatchObject({ pending: true });
    await until(async () => (await recordOn(a, sessionId))?.status === "idle", 120_000);
    save();

    // Mac A sleeps (its process stopped: no heartbeat, its lease lapses): Mac B's pull is refused by Cloud
    // (cave_code_source_asleep, in Cloud's words), and nothing parks. Cloud counts a Mac away 75 s after its last heartbeat.
    const loadAtSleep = load();
    process.kill(a.child.pid!, "SIGSTOP");
    let asleep: string;
    try {
      await until(
        () =>
          sql(`SELECT count(*) FROM code_runtimes WHERE computer_id = '${a.computerId}' AND status = 'active' AND last_seen_at > now() - interval '76 seconds'`) === "0" &&
          sql(`SELECT count(*) FROM code_journal_index WHERE session_id = '${sessionId}' AND lease_expires_at > now()`) === "0",
        240_000,
      );
      asleep = await pull(b, "pull-asleep").then(() => "pulled", (e: Error) => e.message);
      expect(sql(`SELECT computer_id FROM code_workspaces WHERE id = '${workspaceId}'`)).toBe(a.computerId);
      expect(await recordOn(b, sessionId)).toMatchObject({ status: "parked", computer: { id: a.computerId } });
    } finally {
      process.kill(a.child.pid!, "SIGCONT");
    }
    expect(asleep).toBe("The chat's Mac is not up: a chat moves to another Mac only from its own Mac while that Mac is up. Wake it, then move the chat again.");
    await until(async () => (await recordOn(a, sessionId))?.status === "idle", 60_000);
    expect((await transcript(a, sessionId)).at(-1)?.type).not.toBe("session.parked");
    pulls.asleep = { refusal: asleep, load: loadAtSleep };

    // One session in Cloud, the same id all the way; nothing pushed to GitHub.
    const sessions = (await api(me.access_token, "GET", `/api/v1/code/sessions?workspace_id=${workspaceId}`)).body.sessions as Array<{ id: string }>;
    expect(sessions.map((x) => x.id)).toEqual([sessionId]);
    expect(out(repo.bare, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);

    // Decision 30, last: Mac B turns its moves off. Cloud keeps the last list a heartbeat named, so Mac B names an empty
    // one, and its runtime's row holds none of its checkouts any more.
    expect(bRepos()).toContain(hash);
    await b.client.call("settings.set", { request_id: "b-moves-off", settings: { sync_chats: false } });
    await until(() => bRepos() === "[]", 60_000);
    pulls.movesOff = { reposOnCloud: bRepos() };
    results.pull = pulls;
    save();
  },
  900_000,
);

test.skipIf(!live)(
  "real Cloud: This Mac is the window's own Mac: Mac B continues a Cloud chat from Mac A on Mac B, Mac A awake or asleep, and a chat Cloud handed on goes back to Mac A (C2)",
  async () => {
    const me = await person();
    const origin = await front();
    const root = tempRoot("c2-macs-e2e-");
    const repo = github(root);
    const clone = (dir: string) => {
      execFileSync("git", ["clone", "-q", repo.url, path.join(root, dir)]);
      return path.join(root, dir);
    };
    const { a, b } = await family(origin, me.access_token, repo.env);
    // Two of the person's Cloud computers, each with its own checkout.
    const box1 = await startBox("Box one", origin, me, clone("box-one"), repo.env);
    const box2 = await startBox("Box two", origin, me, clone("box-two"), repo.env);
    const c2: Record<string, unknown> = {};

    // Mac A's chat, copied to Cloud; Mac B has its own checkout of the repository (a chat of its own in it).
    const w = await a.client.call("workspace.create", { request_id: "c2-1", repo: { path: clone("mac-a-repo") }, title: "This Mac", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask one" } });
    const sessionId = w.session_id;
    await waitReply(a, sessionId, /ask one \(on Mac A\)$/);
    await until(async () => ((await api(me.access_token, "GET", `/api/v1/code/sessions/${sessionId}`)).body?.journal?.segments ?? 0) >= 1, 60_000);
    const workspaceId = (await api(me.access_token, "GET", `/api/v1/code/sessions/${sessionId}`)).body.workspace_id as string;
    const bOwn = await b.client.call("workspace.create", { request_id: "c2-b", repo: { path: clone("mac-b-repo") }, title: "Mac B's own", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask on b" } });
    await waitReply(b, bOwn.session_id, /ask on b \(on Mac B\)$/);

    /** Where Cloud has the chat, and the runtime that holds its lease, if any. */
    const owner = () => sql(`SELECT computer_id FROM code_workspaces WHERE id = '${workspaceId}'`);
    /** Where the chat says it came from on `rt` (Session.moved_from), as Continue on This Mac and Back to <Mac> read it. */
    const movedFrom = async (rt: Runtime) => {
      const sub = await rt.client.attach(sessionId, 0, () => undefined);
      await sub.detach();
      return sub.session.moved_from?.runtime_id;
    };
    /** Live and idle on `rt`, and Cloud has it there. */
    const lands = async (rt: Runtime & { readonly computerId: string }) => {
      await until(async () => {
        const here = await recordOn(rt, sessionId);
        return here?.status === "idle" && owner() === rt.computerId;
      }, 120_000);
    };
    /** Move to <Cloud computer> from `from`'s own screen. */
    const toBox = async (from: Mac, box: typeof box1) => {
      await from.client.call("session.move", { request_id: `c2-to-${box.runtimeId}-${Date.now()}`, session_id: sessionId, to: { computer_id: box.computerId } });
      await lands(box);
    };
    /** Continue on This Mac on `on`'s own screen (Moves.tsx pullToThisMac): its own runtime, its own computer, its desktop key. */
    const pull = async (on: Mac, request_id: string) => {
      const to = { computer_id: on.computerId };
      return on.client.call("session.move", { request_id, session_id: sessionId, to, device: await signMove(on.key, { session_id: sessionId, request_id, to }) });
    };
    const timed = async (on: Mac, request_id: string) => {
      const at = Date.now();
      const loadAt = load();
      await pull(on, request_id);
      await lands(on);
      return { ms: Date.now() - at, load: loadAt };
    };

    // 1. Mac A -> Box one: Box one has it as come from Mac A.
    await toBox(a, box1);
    expect(await movedFrom(box1)).toBe(a.runtimeId);
    // What the hosted web reads of it (the chat's computer, the session's moved_from, Cloud's runtimes and Cloud
    // computers), and of a chat born on Box two, for the web's own Move to (apps/web moves.e2e.test.ts).
    if (process.env.CAVEMAN_E2E_WEB_FIXTURE) {
      const born = await box2.client.call("workspace.create", { request_id: "c2-born", repo: { url: repo.url }, title: "Born on Box two", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask on box two" } });
      await waitReply(box2, born.session_id, /ask on box two \(on Box two\)$/, 120_000);
      const bornSub = await box2.client.attach(born.session_id, 0, () => undefined);
      await bornSub.detach();
      const fromA = await box1.client.call("workspace.get", { workspace_id: (await recordOn(box1, sessionId))!.id });
      const list = await api(me.access_token, "GET", "/api/v1/code/chats?archived=false");
      const computers = await api(me.access_token, "GET", "/api/v1/code/computers?mine=true");
      fs.writeFileSync(
        process.env.CAVEMAN_E2E_WEB_FIXTURE,
        JSON.stringify(
          {
            macA: { runtime_id: a.runtimeId, computer_id: a.computerId, name: "Mac A" },
            macB: { runtime_id: b.runtimeId, computer_id: b.computerId, name: "Mac B" },
            fromMacA: { workspace: fromA, moved_from: await movedFrom(box1) ?? null },
            bornOnBox: { workspace: await box2.client.call("workspace.get", { workspace_id: born.id }), moved_from: bornSub.session.moved_from?.runtime_id ?? null },
            runtimes: list.body?.runtimes ?? [],
            computers: computers.body,
          },
          null,
          1,
        ),
      );
      expect(bornSub.session.moved_from).toBeUndefined();
    }

    // 2. Continue on This Mac on Mac B's screen, Mac A awake: it lands on Mac B, not on the Mac it came from.
    c2.awake = await timed(b, "c2-pull-awake");
    expect(await recordOn(b, sessionId)).toMatchObject({ computer: { kind: "this_mac" } });
    expect(await recordOn(a, sessionId)).toMatchObject({ status: "parked" });
    // Mac B keeps Mac A as where it came from: Box one only handed it on.
    expect(await movedFrom(b)).toBe(a.runtimeId);
    let onB = await transcript(b, sessionId);
    expect(contiguous(onB)).toBe(true);
    await say(b, sessionId, "ask two");
    onB = await waitReply(b, sessionId, /\(on Mac B\)$/);
    expect(replies(onB).at(-1)).toBe("heard: ask one | ask two (on Mac B)");

    // 3. Home to Mac A (its own screen), out to Box one again; Mac A sleeps; Mac B's screen continues it on Mac B.
    await pull(a, "c2-home-1");
    await lands(a);
    await toBox(a, box1);
    const loadAtSleep = load();
    process.kill(a.child.pid!, "SIGSTOP");
    try {
      c2.asleep = { ...(await timed(b, "c2-pull-asleep")), loadAtSleep };
      expect(await recordOn(b, sessionId)).toMatchObject({ status: "idle", computer: { kind: "this_mac" } });
      expect(await movedFrom(b)).toBe(a.runtimeId);
    } finally {
      process.kill(a.child.pid!, "SIGCONT");
    }
    // Mac A, awake, has it as moved away and runs nothing of it.
    await until(async () => (await recordOn(a, sessionId))?.status === "parked", 60_000);

    // 4. Home to Mac A, out to Box one, then Cloud to Cloud: the person moves it on to Box two. Box two still has it as
    // come from Mac A, and Mac A's Bring it back lands it on Mac A.
    await pull(a, "c2-home-2");
    await lands(a);
    await toBox(a, box1);
    const handed = await api(me.access_token, "POST", `/api/v1/code/chats/${sessionId}/move`, { to: { computer_id: box2.computerId } });
    expect(handed.status).toBeLessThan(300);
    await lands(box2);
    expect(await movedFrom(box2)).toBe(a.runtimeId);
    c2.back = await timed(a, "c2-bring-back");
    expect(await recordOn(a, sessionId)).toMatchObject({ status: "idle", computer: { kind: "this_mac" } });
    await say(a, sessionId, "ask three");
    const onA = await waitReply(a, sessionId, /\(on Mac A\)$/);
    expect(replies(onA).at(-1)).toBe("heard: ask one | ask two | ask three (on Mac A)");
    expect(contiguous(onA)).toBe(true);

    // One session in Cloud, the same id all the way, one owner: Mac A.
    const sessions = (await api(me.access_token, "GET", `/api/v1/code/sessions?workspace_id=${workspaceId}`)).body.sessions as Array<{ id: string }>;
    expect(sessions.map((x) => x.id)).toEqual([sessionId]);
    expect(owner()).toBe(a.computerId);
    expect(sql(`SELECT count(*) FROM code_journal_index WHERE session_id = '${sessionId}' AND lease_runtime_id IS NOT NULL AND lease_runtime_id <> '${a.runtimeId}' AND lease_expires_at > now()`)).toBe("0");
    results.thisMac = c2;
    save();
  },
  900_000,
);

test.skipIf(!live)(
  "real Cloud: a relay that swaps a joining Mac's key pairs nothing, a Join waits on the screen's answer, and a Mac that read a flood of removals before it trusted a Mac still counts that Mac's removal after it (A-1, m-13, A-3)",
  async () => {
    const me = await person();
    const origin = await front();
    const repo = github(tempRoot("devices-fixes-e2e-"));
    const [a, d] = [await startMac("Mac A", origin, me.access_token, repo.env), await startMac("Mac D", origin, me.access_token, repo.env)];
    const pairCode = async (on: Mac) => (await on.client.call("device.pair.start", { request_id: `pair-${randomUUID()}` })).code;
    const heard = (wire: Awaited<ReturnType<typeof hello>>["wire"]) => wire.replies().flatMap((r) => (r.method === "device.status" ? [(r.params as { status: string }).status] : []));

    // A-1. Mac D's app joins Mac A with the code A's screen shows. The relay (Cloud) holds D's hello back and sends its
    // signed bytes under a key of its own, with D's proof of the code: refused, the code used up, and nobody asks as a Mac.
    const swappedIn = await testDevice("Mac D", "mac");
    const swapped = await hello(a, d.key, { pair: await pairCode(a), swapKey: swappedIn });
    expect(swapped.status).toMatch(/^error .*invalid_params/);
    expect((await deviceList(a)).requests).toEqual([]);
    expect((await deviceList(a)).pairing).toBeUndefined();
    results.swappedPairing = { status: swapped.status, requests_on_a: 0 };
    save();

    // m-13. D allowed on A's screen as a device (no code), then it joins with A's code: the Join's own connection waits
    // on A's screen; Keep as a device answers it no, and an Allow as a Mac answers it yes. D drives A meanwhile.
    await allowOnScreen(a, d.key, { pair: false });
    const kept = await hello(a, d.key, { pair: await pairCode(a) });
    expect(kept.status).toBe("pending");
    expect((await deviceList(a)).requests.find((r) => r.device_id === d.key.device_id)).toMatchObject({ role: "mac", code: deviceCode(d.key.device_id) });
    expect((await hello(a, d.key)).status).toBe("approved");
    await a.client.call("device.allow", { request_id: `keep-${randomUUID()}`, device_id: d.key.device_id, role: "device" });
    await until(() => heard(kept.wire).includes("refused"), 15_000);
    expect(heard(kept.wire)).not.toContain("approved");
    const joinCode = await pairCode(a);
    const joined = await hello(a, d.key, { pair: joinCode });
    expect(joined.status).toBe("pending");
    // F-1: the code both screens compare is 12 characters, 60 bits of the key's id, through the real relay too.
    expect(joined.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}(-[0-9A-HJKMNP-TV-Z]{3}){3}$/);
    expect(joined.code).toBe(deviceCode(d.key.device_id));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(heard(joined.wire)).toEqual([]);
    const list = await deviceList(a);
    const statement = await allowStatementFor(a.key, list.family, list.requests.find((r) => r.device_id === d.key.device_id)!);
    await a.client.call("device.allow", { request_id: `as-mac-${randomUUID()}`, device_id: d.key.device_id, role: "mac", statement: statement! });
    await until(() => heard(joined.wire).includes("approved"), 15_000);
    expect((await deviceList(a)).devices.find((dev) => dev.device_id === d.key.device_id)).toMatchObject({ role: "mac" });
    // m-h: A's first sealed frame on the Join's connection is its answer, naming the Mac role with a proof under the
    // code A's screen showed, for this very hello: what a joining Mac believes, never the plain "approved" before it.
    await until(async () => (await joined.opened()).length > 0, 15_000);
    const answer = (await joined.opened())[0] as { method?: string; params?: { status?: string; role?: string; proof?: string } };
    expect(answer).toMatchObject({ method: "device.status", params: { status: "approved", role: "mac" } });
    const helloSent = (JSON.parse(joined.helloText) as { params: { key: string } }).params;
    const signedHello = helloPayload({ runtime_id: joined.challenge.runtime_id, nonce: joined.challenge.nonce, runtime_key: joined.challenge.key, device_key: helloSent.key, v2: { kind: "mac", name: d.key.name } });
    expect(await verifyPairAnswer(joinCode, d.key.device_id, signedHello, answer.params?.proof)).toBe(true);
    results.joinWaits = { kept_as_device: heard(kept.wire), allowed_as_mac: heard(joined.wire), sealed_answer: { role: answer.params?.role, proof_verifies: true }, code_chars: joined.code?.replace(/-/g, "").length };
    save();

    // A-3. Mac D's screen has allowed no Mac. A's screen allows a phone; Cloud carries a flood of 2,000 removals signed
    // by a key nobody trusts (one stolen sign-in's runtimes could put them), written straight into its log; then A's
    // screen removes the phone (stolen). D reads all of it before its screen allows A: A's removal came past D's cap.
    const phone = await testDevice("iPhone, Safari");
    await allowOnScreen(a, phone);
    const rogue = await testDevice("Rogue", "mac");
    const filler = await testDevice("Filler");
    const rows: Array<string> = [];
    for (let i = 0; i < 2_000; i++) {
      const s = await signStatement(rogue, { kind: "remove", organization_id: me.user.organization_id, user_id: me.user.id, device_id: filler.device_id });
      rows.push(`('${me.user.organization_id}', '${me.user.id}', '${await statementId(s)}', $j$${JSON.stringify(s)}$j$::jsonb, '${randomUUID()}')`);
    }
    sql(`INSERT INTO code_device_statements (organization_id, user_id, id, body, from_runtime_id) VALUES ${rows.join(",\n")}`);
    await removeOnScreen(a, phone);
    await until(() => sql(`SELECT count(*) FROM code_device_statements WHERE body->>'kind' = 'remove' AND body->>'device_id' = '${phone.device_id}' AND user_id = '${me.user.id}'`) === "1", 60_000);
    // Past a whole wait cycle (25 s): D's long read of the log has carried it all.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const allowedAt = Date.now();
    await allowOnScreen(d, a.key);
    // A's removal of the phone counts on D: D read the log again once it trusted A.
    await until(async () => (await deviceList(d)).blocked.some((b) => b.device_id === phone.device_id && b.removed_by?.name === "Mac A"), 60_000);
    const removedMs = Date.now() - allowedAt;
    expect((await deviceList(d)).devices.map((dev) => dev.device_id)).not.toContain(phone.device_id);
    expect((await hello(d, phone)).status).toBe("refused");
    expect((await deviceList(d)).blocked.map((b) => b.device_id)).not.toContain(filler.device_id);
    results.floodThenTrust = { removal_counted_after_allow_ms: removedMs, phone_on_d: "refused", load: load() };
    save();
    console.log(`devices fixes (real local Cloud, lab-only, ${load()}): Mac D counted Mac A's removal past a 2,000-removal flood ${removedMs} ms after its screen allowed Mac A`);
  },
  900_000,
);
