// One chat moves between This Mac and Cloud computers against a REAL local
// Caveman Cloud (control-api on Postgres, SeaweedFS for the journal segments),
// as the same session, never a fork. Both kinds of runtime are real processes
// (moves.e2e.runtime.ts) on the real Caveman engine with a scripted model; a
// Cloud computer's runtime is enrolled the way the computers service does it
// (SQL), its "snapshot checkout" a clone. This Mac reaches Cloud through a
// proxy here, so the test can cut its network, and "sleeps" by SIGSTOP.
//
// In order: nothing leaves This Mac before the person answers the notice; the
// lid with moves off pauses a chat; copies never push to GitHub; a move Cloud
// refuses resumes the chat; a network drop mid-turn moves nothing; the lid,
// then sleep before the move is done, lets Cloud move it only once the Mac
// said it was going to sleep, went quiet and its lease lapsed, and the Mac
// stops its own turn when it wakes; Continue on This Mac waits for the Cloud
// computer's turn and brings the right checkout and no more access; the lid
// moves it to a reused, dirty Cloud checkout after the Mac committed again;
// and no segment repeats the conversation.
//
// Skipped unless CAVEMAN_E2E_MOVES=1 with CAVEMAN_E2E_CLOUD_URL (that stack's
// control-api, CAVE_CODE_CLOUD_COMPUTERS=true and a short CAVE_CODE_MOVE_AFTER),
// CAVEMAN_E2E_EMAIL / CAVEMAN_E2E_PASSWORD (a member who may write Code) and
// CAVEMAN_E2E_PSQL (SQL on its database, a shell command reading stdin).
// CAVEMAN_E2E_RESULTS names a file for the evidence.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { onLidClose } from "../../../../apps/desktop/src/lid.ts";
import { git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { loadIdentity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { api, cloudComputer, contiguous, labFunding, MODEL, out, person, proxy, REAL_STACK, recordOn, replies, runtime, sql, staged, stopAll, transcript, waitReply, waitTurns, working } from "./moves.e2e.kit.ts";
import { decodeBundle, getJournal, getSegment, type MoveBundle } from "./moves.ts";

afterAll(stopAll);
// A fresh stack's organization has no plan or credits: Cloud would make no Cloud computer for the chat.
beforeAll(async () => {
  if (REAL_STACK) labFunding(await person());
});

test.skipIf(!REAL_STACK)(
  "real Cloud: one chat moves This Mac -> Cloud -> This Mac -> Cloud as one session, only ever running where its lease is",
  async () => {
    const results: Record<string, unknown> = {};
    const me = await person();
    // A GitHub repository, served from a local bare repo: every git here reads its URL as the bare one.
    const root = tempRoot("moves-e2e-");
    const name = `moves-${randomUUID().slice(0, 8)}`;
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
    const macRepo = path.join(root, "mac-repo");
    execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, macRepo]);
    const pushedRefs = () => out(bare, "for-each-ref", "--format=%(refname)", "refs/caveman/");

    // This Mac: signed in through the proxy, Remote control off.
    const net = await proxy();
    const mac = await runtime("mac", { ...gitEnv, MOVES_CLOUD_URL: net.url, MOVES_BEARER: me.access_token });
    const status = await mac.client.call("cloud.status", {});
    const macComputer = status.computer_id!;
    const macRuntime = status.runtime_id!;

    // 1. Not asked yet: the chat asks once (cloud.status moves "ask"), and its turns copy nothing to Cloud.
    await until(async () => (await mac.client.call("cloud.status", {})).moves === "ask", 30_000);
    const w = await mac.client.call("workspace.create", { request_id: "w1", repo: { path: macRepo }, title: "Moves", engine: "caveman", options: { model: MODEL, access: "auto" }, task: { text: "ask one" } });
    const sessionId = w.session_id;
    const worktree = w.root_path!;
    let events = await waitTurns(mac, sessionId, 1);
    expect(replies(events)).toEqual(["heard: ask one (on mac)"]);
    await new Promise((r) => setTimeout(r, 2_000));
    expect((await api(me.access_token, `/api/v1/code/sessions/${sessionId}`)).status).toBe(404);
    results.notAsked = "moves ask; nothing copied";

    // 2. Turned off: the lid pauses the working chat and moves nothing.
    await mac.client.call("settings.set", { request_id: "off", settings: { move_to_cloud: false } });
    await mac.client.call("turn.submit", { request_id: "t-hang0", session_id: sessionId, kind: "followup", input: { text: "hang zero" } });
    await working(mac, sessionId);
    const paused = await onLidClose(mac.client, () => `lid:${randomUUID()}`);
    expect(paused).toEqual({ moving: 0, paused: 1 });
    await until(async () => (await recordOn(mac, sessionId))?.status === "idle", 30_000);
    expect(await recordOn(mac, sessionId)).toMatchObject({ computer: { kind: "this_mac" } });
    expect((await mac.client.call("cloud.status", {})).moves).toBeUndefined();
    expect((await api(me.access_token, `/api/v1/code/sessions/${sessionId}`)).status).toBe(404);
    results.lidWithMovesOff = paused;

    // 3. Keep on: each turn copies, and nothing is pushed to GitHub.
    await mac.client.call("settings.set", { request_id: "keep", settings: { move_to_cloud: true } });
    expect((await mac.client.call("cloud.status", {})).moves).toBe("on");
    await mac.client.call("turn.submit", { request_id: "t2", session_id: sessionId, kind: "followup", input: { text: "ask two" } });
    events = await waitReply(mac, sessionId, /ask two \(on mac\)$/);
    await until(async () => (await recordOn(mac, sessionId))?.status === "idle", 30_000);
    await until(async () => ((await api(me.access_token, `/api/v1/code/sessions/${sessionId}`)).body.journal?.segments ?? 0) >= 1, 30_000);
    const cloudSession = (await api(me.access_token, `/api/v1/code/sessions/${sessionId}`)).body;
    expect(cloudSession.follow).toBe(true);
    expect(pushedRefs()).toBe("");
    // Work that travels: a commit the Mac never pushed, a file nobody committed, a tracked file deleted.
    fs.writeFileSync(path.join(worktree, "local.txt"), "committed on the mac\n");
    git(worktree, "add", "local.txt");
    git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "local commit on the mac");
    fs.writeFileSync(path.join(worktree, "notes.txt"), "written on the mac\n");
    fs.rmSync(path.join(worktree, "gone.txt"));

    // 4. A move Cloud refuses after the chat parked resumes it here, and says why.
    await expect(mac.client.call("session.move", { request_id: "nowhere", session_id: sessionId, to: { runtime_id: randomUUID() } })).rejects.toThrow();
    expect(await recordOn(mac, sessionId)).toMatchObject({ status: "idle", computer: { kind: "this_mac" } });
    const refusedAt = (await transcript(mac, sessionId)).at(-1)!;
    expect(refusedAt).toMatchObject({ type: "session.resumed", payload: { computer_id: "this-mac" } });
    expect((refusedAt.payload as { move_failed?: string }).move_failed).toBeTruthy();
    results.refusedMove = refusedAt.payload;

    // 5. The network drops mid-turn for longer than the move window (20 s here) but less than the journal lease holds
    // (90 s, S12, Cloud JournalLeaseTTL; renewed every 30 s, and a turn that cannot renew it for 60 s stops, so it never
    // runs twice): Cloud moves nothing (the Mac never said it was going to sleep, and its lease holds), and the Mac keeps
    // its turn and its lease once it is back.
    await mac.client.call("turn.submit", { request_id: "t-hang5", session_id: sessionId, kind: "followup", input: { text: "hang five" } });
    await until(async () => (await api(me.access_token, `/api/v1/code/workspaces/${cloudSession.workspace_id}`)).body.run_state === "working", 30_000);
    await working(mac, sessionId);
    // Cut right after a renewal, so the drop is measured from it.
    await until(() => sql(`SELECT lease_runtime_id = '${macRuntime}' AND lease_expires_at > now() + interval '85 seconds' FROM code_journal_index WHERE session_id = '${sessionId}'`) === "t", 60_000);
    net.state.cut = true;
    await new Promise((r) => setTimeout(r, 40_000));
    expect((await api(me.access_token, `/api/v1/code/workspaces/${cloudSession.workspace_id}`)).body.computer_id).toBe(macComputer);
    expect(await recordOn(mac, sessionId)).toMatchObject({ status: "working", computer: { kind: "this_mac" } });
    net.state.cut = false;
    await until(() => sql(`SELECT lease_runtime_id = '${macRuntime}' AND lease_expires_at > now() + interval '1 minute' FROM code_journal_index WHERE session_id = '${sessionId}'`) === "t", 90_000);
    results.networkDrop = "not moved; the Mac kept its turn and renewed its lease";
    await mac.client.call("turn.interrupt", { request_id: "stop5", session_id: sessionId });
    await until(async () => (await recordOn(mac, sessionId))?.status === "idle", 30_000);

    // 6. The lid closes mid-turn and the Mac sleeps the moment it has said so, before the move is done. Cloud moves the
    // chat once the Mac is quiet and its lease has lapsed (SQL stands in for five minutes); the Cloud computer runs the
    // unfinished message, and the Mac, waking, stops its own turn and shows the chat on Cloud.
    await mac.client.call("turn.submit", { request_id: "t-hang6", session_id: sessionId, kind: "followup", input: { text: "hang six" } });
    await working(mac, sessionId);
    net.state.onSuspend = () => mac.child.kill("SIGSTOP");
    const lidAt = Date.now();
    expect((await onLidClose(mac.client, () => `lid:${randomUUID()}`)).moving).toBe(1);
    expect(net.state.onSuspend).toBeUndefined();
    await until(() => sql(`SELECT count(*) FROM code_runtimes WHERE id = '${macRuntime}' AND suspending_at IS NOT NULL`) === "1", 10_000);
    sql(`UPDATE code_journal_index SET lease_expires_at = now() - interval '1 second' WHERE session_id = '${sessionId}'`);
    let computerId = "";
    await until(async () => {
      computerId = (await api(me.access_token, `/api/v1/code/workspaces/${cloudSession.workspace_id}`)).body.computer_id ?? "";
      return computerId !== "" && computerId !== macComputer;
    }, 120_000);
    results.fallback = { secondsAfterLid: Math.round((Date.now() - lidAt) / 1000) };

    // The computers service's part: the computer's runtime identity, the pod running, its snapshot checkout.
    const box = (computer: string, workspaceRoot: string) => cloudComputer(me, computer, workspaceRoot, gitEnv);
    const boxRoot = path.join(root, "computer-workspace");
    execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, boxRoot]);
    const box1 = await box(computerId, boxRoot);
    events = await waitReply(box1, sessionId, /hang six \(on cloud\)$/, 90_000);
    expect(contiguous(events)).toBe(true);
    expect(replies(events).at(-1)).toMatch(/^heard: ask one .*hang six \(on cloud\)$/);
    expect(events.findLast((e) => e.type === "session.parked")).toMatchObject({ payload: { reason: "move", to: "cloud", cause: "asleep" } });
    // The checkout as the Mac left it: its unpushed commit, its uncommitted file, its deletion, nothing staged.
    expect(out(boxRoot, "log", "-1", "--format=%s")).toBe("local commit on the mac");
    expect(fs.readFileSync(path.join(boxRoot, "notes.txt"), "utf8")).toBe("written on the mac\n");
    expect(fs.existsSync(path.join(boxRoot, "gone.txt"))).toBe(false);
    expect(staged(boxRoot)).toBe("");
    expect(pushedRefs()).toBe("");
    // The Mac wakes: it learns the chat moved and stops its own turn there; it never answers "hang six".
    mac.child.kill("SIGCONT");
    await until(async () => (await recordOn(mac, sessionId))?.computer.kind === "caveman_cloud", 60_000);
    const onMac = await transcript(mac, sessionId);
    expect(await recordOn(mac, sessionId)).toMatchObject({ status: "parked" });
    expect(replies(onMac).some((r) => r.includes("hang six"))).toBe(false);
    results.twoRuntimes = { cloud: replies(events).at(-1), macAfterWaking: (await recordOn(mac, sessionId))?.status };

    // 7. The Cloud computer edits and runs a slow turn with Full access; Continue on This Mac waits for that turn to end,
    // then brings the checkout exactly as Cloud left it, and no more access than the chat had on This Mac.
    fs.writeFileSync(path.join(boxRoot, "notes.txt"), "written on the mac\nand on the cloud\n");
    fs.rmSync(path.join(boxRoot, "keep.txt"));
    await box1.client.call("turn.submit", { request_id: "t7", session_id: sessionId, kind: "followup", input: { text: "slow seven" }, options: { access: "full" } });
    await working(box1, sessionId);
    const pull = await mac.client.call("session.move", { request_id: "back", session_id: sessionId, to: "this_mac" });
    results.continueOnThisMac = { pending: pull.pending };
    expect(pull.pending).toBe(true);
    await until(async () => {
      const here = await recordOn(mac, sessionId);
      return here?.status === "idle" && here.computer.kind === "this_mac";
    }, 90_000);
    events = await transcript(mac, sessionId);
    expect(contiguous(events)).toBe(true);
    expect(replies(events).at(-1)).toMatch(/slow seven \(on cloud\)$/);
    expect(events.session.access).toBe("auto");
    expect(fs.readFileSync(path.join(worktree, "notes.txt"), "utf8")).toBe("written on the mac\nand on the cloud\n");
    expect(fs.existsSync(path.join(worktree, "keep.txt"))).toBe(false);
    expect(fs.existsSync(path.join(worktree, "gone.txt"))).toBe(false);
    expect(out(worktree, "log", "-1", "--format=%s")).toBe("local commit on the mac");
    expect(staged(worktree)).toBe("");
    await mac.client.call("turn.submit", { request_id: "t8", session_id: sessionId, kind: "followup", input: { text: "ask eight" } });
    events = await waitReply(mac, sessionId, /ask eight \(on mac\)$/);
    await until(async () => (await recordOn(mac, sessionId))?.status === "idle", 30_000);

    // 8. The Mac commits again; the lid moves the working chat to Cloud again. The project's computer it left stood
    // empty for less than ten minutes, so Cloud puts the chat back on that one, warm, and makes no new one (CONTRACT
    // §6.4). Its checkout was left dirty since the chat went, and the chat lands on it exactly as the Mac had it.
    fs.writeFileSync(path.join(worktree, "second.txt"), "second commit\n");
    git(worktree, "add", "second.txt");
    git(worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second commit on the mac");
    fs.writeFileSync(path.join(boxRoot, "stray.txt"), "left by another chat\n");
    fs.writeFileSync(path.join(boxRoot, "README.md"), "changed by another chat\n");
    await mac.client.call("turn.submit", { request_id: "t-hang9", session_id: sessionId, kind: "followup", input: { text: "hang nine" } });
    await working(mac, sessionId);
    const movedBefore = mac.notes.filter((n) => n.method === "session.moved").length;
    const computersBefore = sql(`SELECT count(*) FROM code_computers WHERE created_by = '${me.user.id}' AND driver <> 'local'`);
    expect((await onLidClose(mac.client, () => `lid:${randomUUID()}`)).moving).toBe(1);
    await until(() => mac.notes.filter((n) => n.method === "session.moved").length > movedBefore, 20_000);
    const lidMove = mac.notes.findLast((n) => n.method === "session.moved")!.params;
    expect(lidMove.to.open_url).toBe(`${net.url}/code/`);
    expect(lidMove.to.computer_id).toBe(computerId);
    expect(sql(`SELECT count(*) FROM code_computers WHERE created_by = '${me.user.id}' AND driver <> 'local'`)).toBe(computersBefore);
    expect(sql(`SELECT desired_state FROM code_computers WHERE id = '${computerId}'`)).toBe("running");
    results.lidMove = lidMove;
    // The same computer, so the same runtime: it holds the chat's old record and takes the chat back.
    const box2 = box1;
    await until(async () => (await recordOn(box2, sessionId))?.status === "idle", 90_000);
    expect(out(boxRoot, "log", "-1", "--format=%s")).toBe("second commit on the mac");
    expect(fs.existsSync(path.join(boxRoot, "stray.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(boxRoot, "README.md"), "utf8")).toBe("README.md\n");
    expect(fs.readFileSync(path.join(boxRoot, "notes.txt"), "utf8")).toBe("written on the mac\nand on the cloud\n");
    expect(fs.existsSync(path.join(boxRoot, "keep.txt"))).toBe(false);
    expect(staged(boxRoot)).toBe("");
    events = await transcript(box2, sessionId);
    expect(contiguous(events)).toBe(true);
    expect(pushedRefs()).toBe("");

    // 9. Read as the runtime holding the lease: no segment repeats the conversation, and the work in progress rode in them.
    // Cloud takes a runtime's assertion only when it is later than its last (issued_at, whole seconds), and the box's own
    // process may have signed one this second.
    await new Promise((r) => setTimeout(r, 1_100));
    const identity = loadIdentity(box2.linkDir);
    // Signed with that runtime's own key: Cloud takes an assertion only if it is newer than the runtime's last one, to
    // the second (a replay otherwise), so not within the second the runtime itself signed in.
    await until(() => sql(`SELECT last_assertion_at < date_trunc('second', now()) FROM code_runtimes WHERE id = '${identity.runtimeId}'`) === "t", 10_000);
    const state: LinkState = {};
    const index = await getJournal(identity, state, sessionId);
    const segments: Array<MoveBundle> = [];
    for (let n = 0; n < index.segments; n++) segments.push(decodeBundle(await getSegment(identity, state, sessionId, n)));
    const checkpoints = segments.flatMap((s, n) =>
      (s.engine?.journal ?? []).flatMap((line) => {
        const c = (JSON.parse(line) as { conversation?: { messages?: unknown; messages_from: number; messages_tail: Array<unknown> } }).conversation;
        return c ? [{ n, whole: c.messages !== undefined, from: c.messages_from, tail: c.messages_tail.length }] : [];
      }),
    );
    expect(checkpoints.length).toBeGreaterThan(4);
    expect(checkpoints.every((c) => !c.whole)).toBe(true);
    // Each checkpoint adds to the one before it and says nothing twice: it starts where the last one ended. (How many
    // messages one adds is its turn's: the first copy carries what the chat held by then, a turn with a command four.)
    expect(checkpoints.map((c) => c.from)).toEqual(checkpoints.map((_, i) => checkpoints.slice(0, i).reduce((sum, c) => sum + c.tail, 0)));
    expect(checkpoints.at(-1)!.from).toBeGreaterThan(4);
    expect(segments.filter((s) => s.wip_bundle).length).toBeGreaterThan(2);
    results.segments = { count: segments.length, bytes: index.size_bytes, checkpoints, withBundles: segments.filter((s) => s.wip_bundle).length };
    // One session in Cloud, no fork: the same id all the way.
    const sessions = (await api(me.access_token, `/api/v1/code/sessions?workspace_id=${cloudSession.workspace_id}`)).body.sessions as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toEqual([sessionId]);
    results.transcript = events.map((e) => `${e.cursor} ${e.type}${e.type === "message.done" ? `: ${(e.payload as { text: string }).text.slice(0, 80)}` : ""}`);
    if (process.env.CAVEMAN_E2E_RESULTS) fs.writeFileSync(process.env.CAVEMAN_E2E_RESULTS, JSON.stringify(results, null, 1));
  },
  900_000,
);
