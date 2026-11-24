// The lid with sync on (sync.testkit.ts): what it hands to Cloud, what it keeps on this Mac and why, within its budget
// however slow Cloud or the uplink, and what the lid summary and the move check say about each chat.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";

import { lidMoves, lidMovesWrite } from "../../../../apps/web/src/routes/settings/lid-summary.ts";

import * as Store from "../session-protocol/store.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { decodeSegment } from "./copySegments.ts";
import { mergeBundles } from "./moves.ts";
import { CAVEMAN_NOT_ON_CLOUD, CAVEMAN_UNPAID } from "./preflight.ts";
import {
  cleanups,
  closeEachTestsRuntimes,
  grabbing,
  headOf,
  homeChief,
  keptAfterTrying,
  keyStore,
  lidNotes,
  suspend,
  syncedMac,
} from "./sync.testkit.ts";
import { startTestCloud } from "./testCloud.ts";

closeEachTestsRuntimes();

test("a working chat the lid keeps here goes to Cloud as idle within the lid's budget, says nothing busier while this Mac goes to sleep, and every heartbeat names it until this Mac is awake (A-6)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { box, layer } = grabbing();
  const mac = await syncedMac(cloud, await makeConfig(), layer);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  // Chats copy and may move, but the lid's own setting is off: the lid keeps every working chat here.
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: false },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  const repo = makeRepo(tempRoot("sync-lid-kept-"), { "README.md": "kept\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/kept.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Kept",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  const workspaceId = chats.sessions.get(w.session_id)!.workspace_id;
  const reported = () =>
    cloud.state.sessions.runStates
      .filter((r) => r.workspace === workspaceId)
      .map((r) => r.run_state);
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: keep going after the lid" },
  });
  await until(() => reported().at(-1) === "working", 15_000);
  const before = cloud.state.heartbeats.length;
  const sinceLid = reported().length;
  const at = Date.now();
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
  expect(out).toMatchObject({ handed_off: [], paused: [w.session_id] });
  // Within the lid's budget: Cloud reads it idle, and a heartbeat names it as kept.
  expect(Date.now() - at).toBeLessThan(5_000);
  await until(() => reported().at(-1) === "idle", Math.max(0, 3_500 - (Date.now() - at)));
  await until(
    () =>
      cloud.state.heartbeats
        .slice(before)
        .some((h) => h.suspending === true && h.kept?.includes(w.session_id) === true),
    5_000,
  );
  // A turn slow to stop (one still preparing, which the stop does not reach at once) still reads working here: nothing
  // busier than idle reaches Cloud while this Mac goes to sleep, so Cloud's fallback never takes it for a chat at work.
  const store = box.store!;
  const record = (await Effect.runPromise(store.getBySession(w.session_id)))!;
  const stillWorking = {
    ...record,
    workspace: {
      ...record.workspace,
      status: "working" as const,
      updated_at: new Date().toISOString(),
    },
  };
  await Effect.runPromise(
    store
      .putWorkspace(stillWorking)
      .pipe(Effect.andThen(store.publishWorkspace(stillWorking.workspace))),
  );
  await new Promise((r) => setTimeout(r, 1_500));
  expect(reported().slice(sinceLid)).toContain("idle");
  expect(reported().slice(sinceLid)).not.toContain("working");
  // Awake (the person sends from this Mac itself): heartbeats stop saying suspending and stop naming it.
  const awakeAt = cloud.state.heartbeats.length;
  await Effect.runPromise(
    store.putWorkspace({
      ...stillWorking,
      workspace: { ...stillWorking.workspace, status: "idle" },
    }),
  );
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "back at the Mac" },
  });
  await until(
    () => cloud.state.heartbeats.slice(awakeAt).some((h) => h.suspending === undefined),
    5_000,
  );
  expect(
    cloud.state.heartbeats.slice(awakeAt).find((h) => h.suspending === undefined)?.kept,
  ).toBeUndefined();
}, 120_000);

test("a Claude Agent chat the person keeps on this Mac at the lid stays, though its move lock is held past the lid's budget: paused at once, never parked or handed to Cloud once the lock is free (F-3)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  // The lid moves chats, but Claude Agent and Codex chats stay on this Mac.
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true, move_other_engines: false },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-lid-optout-"), { "README.md": "stays\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/stays.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Stays",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      chats.sessions.get(w.session_id)!.lease === null,
    30_000,
  );
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // A slow uplink: the copy the turn's start makes hangs on its way up, holding the chat's move lock.
  let open!: () => void;
  chats.segmentPutsHeld = { until: new Promise<void>((resolve) => (open = resolve)), waiting: 0 };
  cleanups.push(() => open());
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "working",
    15_000,
  );
  await until(() => chats.segmentPutsHeld!.waiting > 0, 30_000);
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 2_000 });
  expect(out).toMatchObject({ handed_off: [], paused: [w.session_id] });
  // The lock comes free past the budget: a move waiting behind it would park the chat and hand it off now.
  chats.segmentPutsHeld = undefined;
  open();
  await new Promise((r) => setTimeout(r, 6_000));
  expect(events.some((e) => e.type === "session.parked")).toBe(false);
  expect(chats.handoffs.filter((h) => h.session_id === w.session_id)).toEqual([]);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).computer.kind).toBe(
    "this_mac",
  );
  expect(
    events
      .filter((e) => e.type === "notification" && e.payload.title === "Paused when the lid closed")
      .map((e) => (e.payload as { body?: string }).body),
  ).toEqual(["Claude Agent chats stay on this Mac when the lid closes (Settings, Computers)"]);
}, 120_000);

test("the lid's pause of a chat it keeps holds the follow-up queued behind its turn: nothing starts as the lid closes (m-b)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: false },
  });
  const repo = makeRepo(tempRoot("sync-lid-queue-"), { "README.md": "queued\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/queued.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Queued",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => cloud.state.chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: the long one" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "working",
    15_000,
  );
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "queued behind it" },
  });
  await until(
    async () =>
      (await mac.client.call("queue.list", { session_id: w.session_id })).turns.length === 1,
    10_000,
  );
  expect(
    await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 }),
  ).toMatchObject({ handed_off: [], paused: [w.session_id] });
  // Long enough for a released queue to have started its run.
  await new Promise((r) => setTimeout(r, 4_000));
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  expect((await mac.client.call("queue.list", { session_id: w.session_id })).turns).toHaveLength(1);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).not.toBe(
    "working",
  );
}, 120_000);

test("a lid handoff Cloud answers pending stays parked, running nowhere, until Cloud hands it over, and then reads as moved (m-10)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-lid-pending-"), { "README.md": "pending\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/pending.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Pending",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  // Cloud asks a Cloud computer that is up to take it, and hands it over 8 s later.
  chats.handoffPendingMs = 8_000;
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "working",
    15_000,
  );
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 5_000 });
  expect(out).toMatchObject({ handed_off: [w.session_id], paused: [] });
  // Meanwhile it runs nowhere: parked here, not carried on, though Cloud has not moved it yet (its park still on its
  // way when the lid answered past its budget, K5).
  expect(chats.sessions.get(w.session_id)?.computer_id).not.toBe(box.computerId);
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "parked",
    30_000,
  );
  expect(chats.sessions.get(w.session_id)?.computer_id).not.toBe(box.computerId);
  // Awake (the person starts another chat here), still before Cloud hands it over: it stays parked.
  await createReady(mac.client, {
    request_id: "w2",
    repo: { path: makeRepo(tempRoot("sync-lid-pending-b-"), { "README.md": "b\n" }) },
    title: "Awake",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await new Promise((r) => setTimeout(r, 2_000));
  if (chats.sessions.get(w.session_id)?.computer_id !== box.computerId)
    expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).toBe("parked");
  // Handed over: it reads as moved to the Cloud computer, never as a chat that carried on here.
  await until(() => chats.sessions.get(w.session_id)?.computer_id === box.computerId, 20_000);
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).computer.kind ===
      "caveman_cloud",
    30_000,
  );
  const events: Array<SessionEvent> = [];
  const sub = await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  expect(
    events.some(
      (e) =>
        e.type === "session.resumed" &&
        (e.payload as { move_failed?: string }).move_failed !== undefined,
    ),
  ).toBe(false);
}, 120_000);

test("a lid handoff Cloud answered pending, which its Cloud computer then cannot adopt, comes back to this Mac under that move: taken back, never refused as a chat this Mac did not ask for (m-a)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-lid-handback-"), { "README.md": "back\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/handback.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Handed back",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  // The lid's check never reserved a target (Cloud slow to answer it): Cloud answers the handoff pending, its Cloud
  // computer accepts and then fails the adopt, and Cloud hands the chat back here under the pending move's id.
  chats.delay.check = 10_000;
  chats.handoffPendingMs = 3_000;
  chats.handoffPendingFails = {
    code: "cave_code_adopt_failed",
    message: "the computer's disk is full",
  };
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "working",
    15_000,
  );
  expect(
    await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 2_000 }),
  ).toMatchObject({ handed_off: [w.session_id] });
  delete chats.delay.check;
  await until(
    () =>
      [...chats.moves.values()].some(
        (m) => m.session_id === w.session_id && m.reassigned === "source",
      ),
    30_000,
  );
  const move = [...chats.moves.values()].find(
    (m) => m.session_id === w.session_id && m.reassigned === "source",
  )!;
  // Taken back, live here, saying why.
  await until(async () => {
    const here = await mac.client.call("workspace.get", { workspace_id: w.id });
    return here.computer.kind === "this_mac" && here.status !== "parked";
  }, 30_000);
  // Its adopt answer reaches Cloud after the chat reads as here again (the answer follows the adopt).
  await until(() => move.answers.some((a) => a.phase === "adopt"), 30_000);
  expect(move.answers.filter((a) => a.code === "cave_code_not_asked")).toEqual([]);
  expect(move.answers).toContainEqual(expect.objectContaining({ phase: "adopt", ok: true }));
  const events: Array<SessionEvent> = [];
  const sub = await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  const titles = events.flatMap((e) => (e.type === "notification" ? [e.payload.title] : []));
  expect(titles).toContain("Back on this computer");
  expect(titles).not.toContain("Caveman sent this chat to this Mac");
}, 120_000);

test("archiving a chat whose lid move has not settled keeps it archived: the move settling later never brings it back without its worktree (m-9)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-lid-archive-"), { "README.md": "archive\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/archive.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Archived meanwhile",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "working",
    15_000,
  );
  // Cloud answers the lid's handoff pending and hands the chat over 10 s later: meanwhile its lid move is unsettled.
  chats.handoffPendingMs = 10_000;
  await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
  // Parked by then, or on its way when the lid answered past its budget (K5).
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "parked",
    30_000,
  );
  expect(chats.sessions.get(w.session_id)?.computer_id).not.toBe(box.computerId);
  await mac.client.call("workspace.archive", { request_id: "a1", workspace_id: w.id });
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).toBe("archived");
  // Awake, and the move settles: the chat stays archived.
  await createReady(mac.client, {
    request_id: "w2",
    repo: { path: makeRepo(tempRoot("sync-lid-archive-b-"), { "README.md": "b\n" }) },
    title: "Awake",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await until(() => chats.sessions.get(w.session_id)?.computer_id === box.computerId, 30_000);
  await new Promise((r) => setTimeout(r, 10_000));
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).toBe("archived");
}, 120_000);

test("the lid's stop never reaches Cloud as idle, however far behind the run-state writes are (K5)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-lid-order-"), { "README.md": "order\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/order.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Order",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  const workspaceId = chats.sessions.get(w.session_id)!.workspace_id;
  const reported = () =>
    cloud.state.sessions.runStates
      .filter((r) => r.workspace === workspaceId)
      .map((r) => r.run_state);
  // Every run-state write takes longer than the whole lid: the turn's `working` is still on its way when the lid
  // stops the turn, so the stopped turn's idle waits behind it until the move is done.
  cloud.state.sessions.runStateDelayMs = 8_000;
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 30000: keep going after the lid" },
  });
  await until(() => reported().at(-1) === "working", 15_000);
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 5_000 });
  expect(out).toMatchObject({ handed_off: [w.session_id] });
  // Moved by then, or on its way when the lid answered past its budget (K5).
  await until(() => chats.sessions.get(w.session_id)?.computer_id === box.computerId, 30_000);
  // Past the slow write ahead of them, and a margin: whatever this Mac still had to say about the chat has been said.
  await new Promise((r) => setTimeout(r, 12_000));
  expect(reported().slice(reported().lastIndexOf("working"))).not.toContain("idle");
}, 120_000);

test("a move whose work in progress doesn't fit never lands on older files: the copy says so, the lid pauses the chat saying why with the fix, and a person's move is refused (F-5)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // Cloud takes no more chunks of this chat's copy (it holds as many large files as a chat may, AC-08).
  cloud.state.chats.blobLimits.chat = 1024 * 1024;
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-big-wip-"), { "README.md": "big\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/big-wip.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Big work",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  const turnDone = async (text: string) => {
    const before = events.filter((e) => e.type === "turn.done").length;
    await mac.client.call("turn.submit", {
      request_id: `t-${before}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text },
    });
    await until(() => events.filter((e) => e.type === "turn.done").length > before, 60_000);
    await until(
      async () =>
        (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
        chats.sessions.get(w.session_id)!.segments.at(-1)!.boundary,
      20_000,
    );
  };
  // A turn whose work in progress fits: what the copy last carried.
  fs.writeFileSync(path.join(w.root_path!, "small.txt"), "small\n");
  await turnDone("a small change");
  const fitted = (chats.sessions.get(w.session_id)!.segments.at(-1)!.body as { wip?: string }).wip;
  expect(typeof fitted).toBe("string");
  // Then 12 MiB nobody can compress: its bundle cannot ride in an 8 MiB segment.
  const blob = randomBytes(12 * 1024 * 1024);
  fs.writeFileSync(path.join(w.root_path!, "big.bin"), blob);
  await turnDone("a big change");
  const dropped = chats.sessions.get(w.session_id)!.segments.at(-1)!.body as {
    wip?: string;
    wip_dropped?: boolean;
    wip_bundle?: string;
  };
  // The copy says it went without the new work, and still names the older one (an old reader moves nothing new).
  expect(dropped.wip_dropped).toBe(true);
  expect(dropped.wip).toBe(fitted);
  expect(dropped.wip_bundle).toBeUndefined();
  expect((dropped as { wip_ref?: unknown }).wip_ref).toBeUndefined();
  expect(chats.blobCalls.filter((c) => c.method === "PUT").map((c) => c.status)).toContain(413);
  // The lid: the working chat pauses here with the size and the fix; nothing is handed to Cloud.
  await mac.client.call("turn.submit", {
    request_id: "t-lid",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
  const atLid = events.length;
  const lid = await suspend(mac, 5_000);
  expect(lid.out).toMatchObject(
    keptAfterTrying(lid, w.session_id) === "paused"
      ? { handed_off: [], paused: [w.session_id] }
      : { handed_off: [w.session_id], paused: [] },
  );
  // Settled once its last copy refused the move (the stopped turn reads idle a moment before that).
  await until(
    async () =>
      events.slice(atLid).some((e) => e.type === "session.resumed") &&
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "idle",
    30_000,
  );
  expect(chats.handoffs).toEqual([]);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).computer.kind).toBe(
    "this_mac",
  );
  // Cloud hears it is idle here, never left with the "moving" the lid told it: Cloud moves a sleeping Mac's working
  // chats once their lease lapses (MoveQuiet), and this one would land on older files than the Mac has.
  const workspaceId = chats.sessions.get(w.session_id)!.workspace_id;
  const reported = () =>
    cloud.state.sessions.runStates
      .filter((r) => r.workspace === workspaceId)
      .map((r) => r.run_state);
  await until(() => reported().at(-1) === "idle", 15_000).catch((error: Error) => {
    throw new Error(`${error.message}: Cloud heard ${reported().join(", ")}`);
  });
  const why = events.findLast((e) => e.type === "session.resumed")?.payload as
    | { move_failed?: string }
    | undefined;
  // Why: Cloud took no more chunks of its copy (said as that, never as changes too big for a move).
  expect(why?.move_failed).toBe(
    "its copy with Caveman holds as many large files as one chat's copy may; commit and push the large files, or keep it on this Mac",
  );
  expect(
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    ),
  ).toMatchObject({
    outcome: "pauses",
    reason: "Its copy with Caveman holds as many large files as one chat's copy may",
  });
  // A person's move: refused before it goes, with the same words, and the chat carries on here.
  await expect(
    mac.client.call("session.move", { request_id: "m1", session_id: w.session_id, to: "cloud" }),
  ).rejects.toThrow(/its copy with Caveman holds as many large files as one chat's copy may/);
  expect(await mac.client.call("workspace.get", { workspace_id: w.id })).toMatchObject({
    status: "idle",
    computer: { kind: "this_mac" },
  });
  expect(chats.sessions.get(w.session_id)?.computer_id).not.toBe(undefined);
  expect(chats.computers.get(chats.sessions.get(w.session_id)!.computer_id)?.kind ?? "laptop").toBe(
    "laptop",
  );
  // The Mac's own files as they were: nothing was put back to the older work in progress.
  expect(fs.readFileSync(path.join(w.root_path!, "big.bin")).equals(blob)).toBe(true);
  expect(fs.readFileSync(path.join(w.root_path!, "small.txt"), "utf8")).toBe("small\n");
}, 240_000);

test("work in progress too big to carry, written mid-turn, pauses the chat at the lid, and the lid's own last copy says it went without it, so no move Cloud makes from the copy while the Mac sleeps lands on older files or runs the turn again (F-5)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  // A Cloud without the copy's chunk routes: work in progress past a segment cannot go at all.
  cloud.state.chats.blobsOff = true;
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-big-mid-turn-"), { "README.md": "big\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/big-mid-turn.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Big mid-turn",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // A turn whose work in progress fits: what the copy last carried.
  fs.writeFileSync(path.join(w.root_path!, "small.txt"), "small\n");
  await mac.client.call("turn.submit", {
    request_id: "t-small",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a small change" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      chats.sessions.get(w.session_id)!.segments.at(-1)!.boundary,
    20_000,
  );
  const fitted = (chats.sessions.get(w.session_id)!.segments.at(-1)!.body as { wip?: string }).wip;
  expect(typeof fitted).toBe("string");
  // Mid-turn, 12 MiB nobody can compress: only the lid's own last copy could carry it, and it cannot.
  await mac.client.call("turn.submit", {
    request_id: "t-lid",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
  const blob = randomBytes(12 * 1024 * 1024);
  fs.writeFileSync(path.join(w.root_path!, "big.bin"), blob);
  const atLid = events.length;
  await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 10_000 });
  // It stays here, paused saying why, never handed to Cloud; its files as they were. Settled once its last copy refused
  // the move: the stopped turn reads idle a moment before that, and the lid may answer past its budget first (K5).
  await until(
    async () =>
      events.slice(atLid).some((e) => e.type === "session.resumed") &&
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "idle",
    60_000,
  );
  expect(chats.handoffs).toEqual([]);
  expect(
    (
      events.findLast((e) => e.type === "session.resumed")?.payload as
        | { move_failed?: string }
        | undefined
    )?.move_failed,
  ).toMatch(/^its uncommitted changes are 12 MiB/);
  expect(fs.readFileSync(path.join(w.root_path!, "big.bin")).equals(blob)).toBe(true);
  // The lid's last copy (it stopped the turn: `interrupted`) landed, a boundary that says it went without that work and
  // names the older one, the turn's message no longer pending: what Cloud moves the chat from while the Mac sleeps.
  const segments = chats.sessions.get(w.session_id)!.segments;
  const lidCopy = segments.findLastIndex(
    (s) => (s.body as { interrupted?: boolean }).interrupted === true,
  );
  expect(lidCopy).toBeGreaterThan(-1);
  expect(segments[lidCopy]!.boundary).toBe(true);
  expect(segments[lidCopy]!.body).toMatchObject({ wip_dropped: true, wip: fitted });
  expect((segments[lidCopy]!.body as { pending?: string }).pending).toBeUndefined();
  // Read as the computer Cloud moved it to reads it: it refuses the copy (handlers' adopt), never lands on `fitted`.
  const read = mergeBundles(segments.slice(0, lidCopy + 1).map((s) => decodeSegment(s.raw)));
  expect(read).toMatchObject({ wip_dropped: true, wip: fitted });
  expect(read.pending).toBeUndefined();
}, 240_000);

test("a chat kept here for work in progress too big to carry says it continues once the person follows the fix, with no turn of its own: its copy is made again (F-5, AC-12)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  cloud.state.chats.blobsOff = true;
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-fix-followed-"), { "README.md": "fix\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/fix-followed.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Fix followed",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  fs.writeFileSync(path.join(w.root_path!, "big.bin"), randomBytes(12 * 1024 * 1024));
  await mac.client.call("turn.submit", {
    request_id: "t-big",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a big change" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      (chats.sessions.get(w.session_id)!.segments.at(-1)!.body as { wip_dropped?: boolean })
        .wip_dropped === true,
    30_000,
  );
  const summary = async () =>
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    )!;
  expect(await summary()).toMatchObject({
    outcome: "pauses",
    reason: "Its uncommitted changes are 12 MiB, more than a move carries",
  });
  // Read again with nothing changed: no copy is made again for it.
  const copiedBefore = chats.sessions.get(w.session_id)!.segments.length;
  expect((await summary()).outcome).toBe("pauses");
  await new Promise((r) => setTimeout(r, 2_000));
  expect(chats.sessions.get(w.session_id)!.segments.length).toBe(copiedBefore);
  // The person takes the large file out of the chat's changes, and runs nothing.
  const head = await headOf(mac.client, w.id);
  fs.rmSync(path.join(w.root_path!, "big.bin"));
  fs.writeFileSync(path.join(w.root_path!, "small.txt"), "small\n");
  await until(async () => (await summary()).outcome.startsWith("continues"), 30_000);
  // Its copy was made again with that work, as a boundary Cloud can move it from; nothing was journaled for it.
  const last = chats.sessions.get(w.session_id)!.segments.at(-1)!;
  expect(last.boundary).toBe(true);
  expect((last.body as { wip_dropped?: boolean }).wip_dropped).toBeUndefined();
  expect(typeof (last.body as { wip_bundle?: string }).wip_bundle).toBe("string");
  expect(await headOf(mac.client, w.id)).toBe(head);
}, 180_000);

test("the lid never waits on a copy putting chunks up over a stalled uplink: it stops that upload, parks the working chat within its budget and hands it off with its work (AC-08)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-stalled-"), { "README.md": "stalled\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/stalled.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Stalled uplink",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // An uplink that stalls: every chunk's PUT waits.
  let open!: () => void;
  chats.blobPutsHeld = new Promise<void>((resolve) => (open = resolve));
  cleanups.push(() => open());
  // A turn ends with 20 MiB nobody can compress: its boundary copy puts chunks up, and they hang.
  fs.writeFileSync(path.join(w.root_path!, "big.bin"), randomBytes(20 * 1024 * 1024));
  await mac.client.call("turn.submit", {
    request_id: "t-big",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a big change" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  await until(
    () => chats.blobCalls.some((c) => c.session_id === w.session_id && c.method === "HEAD"),
    30_000,
  );
  // The next turn runs as the lid closes.
  await mac.client.call("turn.submit", {
    request_id: "t-lid",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 60000: working as the lid closes" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "working",
    30_000,
  );
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 5_000 });
  expect(out.handed_off).toEqual([w.session_id]);
  // Stopped and parked while the uplink is still stalled: its turn runs no further here (the old lid waited on the
  // stalled copy for the chat's move lock, and stopped nothing).
  await until(() => events.some((e) => e.type === "session.parked"), 2_000);
  expect(events.findLast((e) => e.type === "session.parked")).toMatchObject({
    payload: { reason: "move", cause: "lid" },
  });
  // The uplink comes back: the lid's own last copy puts the chunks up, and the chat goes to Cloud with its work.
  chats.blobPutsHeld = undefined;
  open();
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).computer.kind ===
      "caveman_cloud",
    60_000,
  );
  expect(chats.sessions.get(w.session_id)?.computer_id).toBe(box.computerId);
  const last = chats.sessions.get(w.session_id)!.segments.at(-1)!;
  expect(last.boundary).toBe(true);
  expect(last.body).toMatchObject({ interrupted: true, wip_ref: { bytes: expect.any(Number) } });
  expect((last.body as { wip_dropped?: boolean }).wip_dropped).toBeUndefined();
}, 180_000);

test("a boundary's large files going up slowly as chunks never let the next turn's journal lease lapse: that turn runs on, never told Caveman was lost (m-8)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-slow-chunks-"), { "README.md": "chunks\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/slow-chunks.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Slow chunks",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // Three chunks, each 35 s on its way up: the boundary's copy holds the chat's move lock past the lease's 60 s.
  fs.writeFileSync(path.join(w.root_path!, "big.bin"), randomBytes(20 * 1024 * 1024));
  chats.blobPutMs = 35_000;
  const started = () => events.filter((e) => e.type === "turn.started").length;
  const before = started();
  await mac.client.call("turn.submit", {
    request_id: "t-big",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 1000: a big change" },
  });
  // The next turn starts once the boundary's chunks are on their way up (a turn queued behind the first can start
  // before the boundary's copy looks, which then is no boundary).
  await until(
    () => chats.blobCalls.some((c) => c.session_id === w.session_id && c.method === "HEAD"),
    60_000,
  );
  await mac.client.call("turn.submit", {
    request_id: "t-next",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 150000: the next turn" },
  });
  await until(() => started() === before + 2, 30_000);
  await new Promise((r) => setTimeout(r, 85_000));
  // Still running, its lease renewed between chunks, and nothing says Caveman was lost.
  expect(
    events.some((e) => e.type === "notification" && /Lost the connection/.test(e.payload.title)),
  ).toBe(false);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).toBe("working");
  chats.blobPutMs = 0;
}, 300_000);

test("a boundary copy made again after a chunk did not go up puts up only the chunks Cloud lacks: the same files make the same chunks (AC-08)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-wip-again-"), { "README.md": "again\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/wip-again.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Again",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // 20 MiB nobody can compress (three chunks); Cloud stores two, then the third's PUT fails once.
  fs.writeFileSync(path.join(w.root_path!, "big.bin"), randomBytes(20 * 1024 * 1024));
  chats.blobPutsBeforeFailure = 2;
  await mac.client.call("turn.submit", {
    request_id: "t-big",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a big change" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  // The outbox makes the copy again (a second or more later): it lands, naming the chunks Cloud holds.
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      chats.sessions.get(w.session_id)!.segments.at(-1)!.boundary,
    30_000,
  );
  const ref = (
    chats.sessions.get(w.session_id)!.segments.at(-1)!.body as {
      wip_ref?: { bytes: number; chunks: ReadonlyArray<string> };
    }
  ).wip_ref!;
  expect(
    chats.blobCalls.filter(
      (c) => c.session_id === w.session_id && c.method === "PUT" && c.status === 503,
    ),
  ).toHaveLength(1);
  expect(ref.chunks).toHaveLength(Math.ceil(ref.bytes / (8 * 1024 * 1024)));
  // Exactly those: the attempt that failed left none under other names to fill the chat's copy.
  expect([...chats.sessions.get(w.session_id)!.blobs!.keys()].sort()).toEqual(
    [...ref.chunks].sort(),
  );
  expect(
    chats.blobCalls.filter(
      (c) => c.session_id === w.session_id && c.method === "PUT" && c.status === 204,
    ),
  ).toHaveLength(ref.chunks.length);
}, 120_000);

test("every chat the lid keeps here says why in the chat, once: not answered yet, no Cloud computers (D2)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  const repoOf = (name: string) => {
    const repo = makeRepo(tempRoot(`sync-why-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
      cwd: repo,
    });
    return repo;
  };
  const chat = (name: string) =>
    createReady(mac.client, {
      request_id: `w-${name}`,
      repo: { path: repoOf(name) },
      title: name,
      engine: "claude-agent",
      options: { model: MODEL },
    });
  // What the lid summary said of the chat beforehand: the same words its note then says (the lid's own check, moveCheck).
  const summarized = async (w: { readonly session_id: string }) =>
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    )?.reason;
  // Not answered: nothing moves, and the chat says what to answer.
  const unanswered = await chat("unanswered");
  const unansweredSaid = await summarized(unanswered);
  let lid = await lidNotes(mac, [unanswered]);
  expect(lid.out).toMatchObject({ handed_off: [], paused: [unanswered.session_id] });
  expect(lid.said.get(unanswered.session_id)).toEqual([
    "Moving chats to Cloud isn't set up on this Mac yet (Settings, Computers)",
  ]);
  expect(unansweredSaid).toBe(lid.said.get(unanswered.session_id)![0]);
  // This Caveman server runs no Cloud computers.
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  const nowhere = await chat("nowhere");
  await until(
    () => cloud.state.chats.sessions.get(nowhere.session_id)?.movable_flag === true,
    30_000,
  );
  const nowhereSaid = await summarized(nowhere);
  lid = await lidNotes(mac, [nowhere]);
  expect(lid.out).toMatchObject(
    keptAfterTrying(lid, nowhere.session_id) === "paused"
      ? { handed_off: [], paused: [nowhere.session_id] }
      : { handed_off: [nowhere.session_id], paused: [] },
  );
  expect(lid.said.get(nowhere.session_id)).toEqual(["This Caveman server runs no Cloud computers"]);
  expect(nowhereSaid).toBe(lid.said.get(nowhere.session_id)![0]);
}, 240_000);

test("a Caveman chat stays on this Mac where Cloud computers cannot run it: the lid pauses it saying why, as the summary and the move check say (AUDIT-W4-FINAL-CLOUD, Caveman credits)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig(), keyStore(), ["caveman"]);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  await mac.client.call("engine.account.add", {
    request_id: "key",
    engine: "caveman",
    provider: "anthropic",
    key: ("sk-" + "ant-lid-test-0123456789abcdef"),
  });
  // Cloud runs Cloud computers, but nothing carries Caveman credentials to them: it says so (caveman_on_computers false).
  cloud.state.environments.computers = true;
  cloud.state.environments.cavemanOnComputers = false;
  const repo = makeRepo(tempRoot("sync-caveman-"), { "README.md": "caveman\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/caveman.git"], {
    cwd: repo,
  });
  const chat = await createReady(mac.client, {
    request_id: "w-caveman",
    repo: { path: repo },
    title: "Caveman",
    engine: "caveman",
    options: { model: MODEL },
  });
  await until(() => cloud.state.chats.sessions.get(chat.session_id)?.movable_flag === true, 30_000);
  const summary = (await mac.client.call("cloud.lid.summary", {})).chats.find(
    (c) => c.session_id === chat.session_id,
  );
  expect(summary).toMatchObject({ outcome: "pauses", reason: CAVEMAN_NOT_ON_CLOUD });
  await expect(
    mac.client.call("session.move.check", { session_id: chat.session_id, to: "cloud" }),
  ).rejects.toThrow(CAVEMAN_NOT_ON_CLOUD);
  const lid = await lidNotes(mac, [chat]);
  expect(lid.out).toMatchObject(
    keptAfterTrying(lid, chat.session_id) === "paused"
      ? { handed_off: [], paused: [chat.session_id] }
      : { handed_off: [chat.session_id], paused: [] },
  );
  expect(lid.said.get(chat.session_id)).toEqual([CAVEMAN_NOT_ON_CLOUD]);
  expect(cloud.state.chats.handoffs).toEqual([]);
  expect((await mac.client.call("workspace.get", { workspace_id: chat.id })).computer.kind).toBe(
    "this_mac",
  );
}, 240_000);

test("a Caveman chat whose person's plan and credits can't pay on a Cloud computer stays on this Mac: the lid, the summary and the move check say why and what fixes it", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig(), keyStore(), ["caveman"]);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  await mac.client.call("engine.account.add", {
    request_id: "key",
    engine: "caveman",
    provider: "anthropic",
    key: ("sk-" + "ant-lid-test-0123456789abcdef"),
  });
  // Cloud's computers run Caveman chats on the person's credits, and nothing can pay now (caveman_paid false).
  cloud.state.environments.computers = true;
  cloud.state.environments.cavemanOnComputers = true;
  cloud.state.environments.cavemanPaid = false;
  const repo = makeRepo(tempRoot("sync-unpaid-"), { "README.md": "caveman\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/unpaid.git"], {
    cwd: repo,
  });
  const chat = await createReady(mac.client, {
    request_id: "w-unpaid",
    repo: { path: repo },
    title: "Caveman",
    engine: "caveman",
    options: { model: MODEL },
  });
  await until(() => cloud.state.chats.sessions.get(chat.session_id)?.movable_flag === true, 30_000);
  const summary = (await mac.client.call("cloud.lid.summary", {})).chats.find(
    (c) => c.session_id === chat.session_id,
  );
  expect(summary).toMatchObject({
    outcome: "pauses",
    reason: CAVEMAN_UNPAID,
    fix: expect.stringContaining("Settings, Plan"),
  });
  await expect(
    mac.client.call("session.move.check", { session_id: chat.session_id, to: "cloud" }),
  ).rejects.toThrow(CAVEMAN_UNPAID);
  const lid = await lidNotes(mac, [chat]);
  expect(lid.out).toMatchObject(
    keptAfterTrying(lid, chat.session_id) === "paused"
      ? { handed_off: [], paused: [chat.session_id] }
      : { handed_off: [chat.session_id], paused: [] },
  );
  expect(lid.said.get(chat.session_id)).toEqual([CAVEMAN_UNPAID]);
  expect(cloud.state.chats.handoffs).toEqual([]);
  expect((await mac.client.call("workspace.get", { workspace_id: chat.id })).computer.kind).toBe(
    "this_mac",
  );
}, 240_000);

test("every chat the lid keeps here says why in the chat, once: by its kind, its repository, Cloud's refusal, the settings, no network (D2)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const { box, layer } = grabbing();
  const mac = await syncedMac(cloud, await makeConfig(), Layer.mergeAll(layer, keyStore()), [
    "caveman",
  ]);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const chats = cloud.state.chats;
  const repoOf = (name: string, github = true) => {
    const repo = makeRepo(tempRoot(`sync-why-${name}-`), { "README.md": `${name}\n` });
    if (github)
      execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
        cwd: repo,
      });
    return repo;
  };
  const chat = async (name: string, github = true) => {
    const w = await createReady(mac.client, {
      request_id: `w-${name}`,
      repo: { path: repoOf(name, github) },
      title: name,
      engine: "claude-agent",
      options: { model: MODEL },
    });
    await until(() => chats.summaries.has(w.session_id), 20_000);
    if (github) await until(() => chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
    return w;
  };
  const store = box.store!;
  const remake = async (
    w: { readonly session_id: string },
    change: (record: Store.WorkspaceRecord) => Store.WorkspaceRecord,
  ) => {
    const record = (await Effect.runPromise(store.getBySession(w.session_id)))!;
    await Effect.runPromise(store.putWorkspace(change(record)));
  };
  // By what they are: a repository not on GitHub, the Chief, a setup chat, a delegated agent. And Cloud's refusal (no
  // Claude login there yet).
  const chief = await homeChief(mac);
  const [local, setup, delegated, refused] = [
    await chat("local", false),
    await chat("setup"),
    await chat("delegated"),
    await chat("refused"),
  ];
  await remake(setup, (r) => ({ ...r, workspace: { ...r.workspace, kind: "setup" } }));
  await remake(delegated, (r) => ({ ...r, internal: { ...r.internal, delegated: true } }));
  let lid = await lidNotes(mac, [local, chief, setup, delegated, refused]);
  // The two the lid tries to move (the others never move): on their way only when the lid answered at its budget's end.
  expect([...lid.out.handed_off].sort()).toEqual(
    [local, refused]
      .filter((w) => keptAfterTrying(lid, w.session_id) === "handed_off")
      .map((w) => w.session_id)
      .sort(),
  );
  expect(lid.said.get(local.session_id)).toEqual([
    "This chat's repository isn't on GitHub, so a Cloud computer can't check it out",
  ]);
  for (const w of [chief, setup, delegated])
    expect(lid.said.get(w.session_id)).toEqual([
      "This chat stays here: the Chief, setup chats and delegated agents don't move",
    ]);
  expect(lid.said.get(refused.session_id)).toHaveLength(1);
  expect(lid.said.get(refused.session_id)![0]).toMatch(
    /Anthropic key for Cloud computers, or sign Claude in/,
  );
  chats.engineLogins.set("user-1", { "claude-agent": { vault_key: true, signed_in_on: [] } });
  // The lid's own setting off.
  const lidOff = await chat("lid-off");
  await mac.client.call("settings.set", { request_id: "s2", settings: { move_to_cloud: false } });
  lid = await lidNotes(mac, [lidOff]);
  expect(lid.said.get(lidOff.session_id)).toEqual([
    "Moving chats to Cloud when the lid closes is off on this Mac (Settings, Computers)",
  ]);
  // Claude Agent chats kept here by the setting.
  await mac.client.call("settings.set", {
    request_id: "s3",
    settings: { move_to_cloud: true, move_other_engines: false },
  });
  const kept = await chat("kept");
  lid = await lidNotes(mac, [kept]);
  expect(lid.said.get(kept.session_id)).toEqual([
    "Claude Agent chats stay on this Mac when the lid closes (Settings, Computers)",
  ]);
  // No network as the lid closes: nothing moves, and the chat says Cloud could not be reached.
  await mac.client.call("settings.set", {
    request_id: "s4",
    settings: { move_other_engines: true },
  });
  const offline = await chat("offline");
  cloud.state.unreachable = true;
  lid = await lidNotes(mac, [offline]);
  cloud.state.unreachable = false;
  expect(lid.out).toMatchObject(
    keptAfterTrying(lid, offline.session_id) === "paused"
      ? { handed_off: [], paused: [offline.session_id] }
      : { handed_off: [offline.session_id], paused: [] },
  );
  expect(lid.said.get(offline.session_id)).toHaveLength(1);
  expect(lid.said.get(offline.session_id)![0]).toMatch(/reach Caveman: /);
  // None handed to Cloud: a refusal Cloud gave the lid's handoff itself (a check the budget cut) is no move.
  expect(chats.handoffs.filter((h) => h.moved)).toEqual([]);
}, 300_000);

test("the lid never waits on Cloud for why a chat stays: with Cloud's holdings stalled, the chat that moves is handed off within the budget and the Chief pauses saying why", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig(), keyStore(), ["caveman"]);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.enrollRuntime({ kind: "cloud" });
  const chats = cloud.state.chats;
  const chat = async (name: string) => {
    const repo = makeRepo(tempRoot(`sync-stall-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
      cwd: repo,
    });
    const w = await createReady(mac.client, {
      request_id: `w-${name}`,
      repo: { path: repo },
      title: name,
      engine: "claude-agent",
      options: { model: MODEL },
    });
    await until(
      () =>
        chats.summaries.has(w.session_id) &&
        chats.sessions.get(w.session_id)?.movable_flag === true,
      30_000,
    );
    return w;
  };
  const [moves, chief] = [await chat("moves"), await homeChief(mac)];
  for (const w of [moves, chief])
    await mac.client.call("turn.submit", {
      request_id: `slow-${w.id}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 60000: working as the lid closes" },
    });
  await until(
    async () =>
      (
        await Promise.all(
          [moves, chief].map((w) => mac.client.call("workspace.get", { workspace_id: w.id })),
        )
      ).every((r) => r.status === "working"),
    30_000,
  );
  // The person's Cloud logins never answer as the lid closes (nothing fetched them yet on this Mac).
  cloud.state.stalled.push("/runtime/holdings");
  const at = Date.now();
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 5_000 });
  const took = Date.now() - at;
  expect(out.handed_off).toEqual([moves.session_id]);
  expect(out.paused).toEqual([chief.session_id]);
  // Within the lid's budget (and the desktop's 3 s past it): no Cloud call it does not need held it up.
  expect(took).toBeLessThan(8_000);
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: chief.id })).status === "idle",
    30_000,
  );
  const events: Array<SessionEvent> = [];
  const sub = await mac.client.attach(chief.session_id, 0, (e) => events.push(e));
  await until(() => (events.at(-1)?.cursor ?? 0) >= sub.session.head, 10_000);
  await sub.detach();
  expect(
    events.flatMap((e) =>
      e.type === "notification" && e.payload.title === "Paused when the lid closed"
        ? [e.payload.body]
        : [],
    ),
  ).toEqual(["This chat stays here: the Chief, setup chats and delegated agents don't move"]);
}, 240_000);

test("the lid summary says what the lid then does to each chat, in the same words, from one holdings call and no call per chat (AC-12)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig(), keyStore(), ["caveman"]);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.enrollRuntime({ kind: "cloud" });
  const chats = cloud.state.chats;
  const repoOf = (name: string, github = true) => {
    const repo = makeRepo(tempRoot(`sync-summary-${name}-`), { "README.md": `${name}\n` });
    if (github)
      execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
        cwd: repo,
      });
    return repo;
  };
  const chat = async (name: string, github = true) => {
    const w = await createReady(mac.client, {
      request_id: `w-${name}`,
      repo: { path: repoOf(name, github) },
      title: name,
      engine: "claude-agent",
      options: { model: MODEL },
    });
    await until(
      () =>
        chats.summaries.has(w.session_id) &&
        (!github || chats.sessions.get(w.session_id)?.movable_flag === true),
      30_000,
    );
    return w;
  };
  const [moves, local, chief, big] = [
    await chat("moves"),
    await chat("local", false),
    await homeChief(mac),
    await chat("big"),
  ];
  // Its work in progress no longer fits a copy (F-5), on a Cloud without the copy's chunk routes (AC-08).
  chats.blobsOff = true;
  fs.writeFileSync(path.join(big.root_path!, "big.bin"), randomBytes(12 * 1024 * 1024));
  await mac.client.call("turn.submit", {
    request_id: "t-big",
    session_id: big.session_id,
    kind: "followup",
    input: { text: "a big change" },
  });
  await until(
    () =>
      (
        chats.sessions.get(big.session_id)?.segments.at(-1)?.body as
          | { wip_dropped?: boolean }
          | undefined
      )?.wip_dropped === true,
    60_000,
  );
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: big.id })).status === "idle",
    30_000,
  );
  const all = [moves, local, chief, big];
  for (const w of all)
    await mac.client.call("turn.submit", {
      request_id: `slow-${w.id}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 60000: working as the lid closes" },
    });
  await until(
    async () =>
      (
        await Promise.all(all.map((w) => mac.client.call("workspace.get", { workspace_id: w.id })))
      ).every((r) => r.status === "working"),
    30_000,
  );
  // Asked twice within a minute: Cloud's holdings once, and nothing per chat.
  const holdings = () =>
    cloud.state.parity.requests.filter((r) => r.path.endsWith("/runtime/holdings")).length;
  const seenBefore = cloud.state.seen.length;
  const summary = await mac.client.call("cloud.lid.summary", {});
  const again = await mac.client.call("cloud.lid.summary", {});
  expect(again).toEqual(summary);
  expect(holdings()).toBe(1);
  // The copies and summaries going up meanwhile are the outbox's own; the summary asks Cloud nothing about a chat (no
  // move-check, the call the lid's own check makes per chat).
  expect(cloud.state.seen.slice(seenBefore).filter((r) => r.path.endsWith("/move-check"))).toEqual(
    [],
  );
  const of = (w: { readonly session_id: string }) =>
    summary.chats.find((c) => c.session_id === w.session_id)!;
  expect(of(moves), JSON.stringify(of(moves))).toMatchObject({ outcome: "continues" });
  expect(of(local)).toMatchObject({
    outcome: "stays",
    reason: "This chat's repository isn't on GitHub, so a Cloud computer can't check it out",
  });
  expect(of(chief)).toMatchObject({
    outcome: "stays",
    reason: "This chat stays here: the Chief, setup chats and delegated agents don't move",
  });
  expect(of(big)).toMatchObject({
    outcome: "pauses",
    reason: "Its uncommitted changes are 12 MiB, more than a move carries",
    fix: "Commit and push the large files, or keep it on this Mac.",
  });
  for (const c of [of(local), of(chief), of(big)]) expect(c.fix).toBeTruthy();
  // The lid does just that, saying the same: `big` only once its last copy refused the move, so past the budget it may
  // be answered as on its way, and it stays here all the same (below).
  const lid = await suspend(mac, 5_000);
  const bigAnswer = keptAfterTrying(lid, big.session_id);
  expect([...lid.out.handed_off].sort()).toEqual(
    [moves.session_id, ...(bigAnswer === "handed_off" ? [big.session_id] : [])].sort(),
  );
  expect([...lid.out.paused].sort()).toEqual(
    [
      local.session_id,
      chief.session_id,
      ...(bigAnswer === "paused" ? [big.session_id] : []),
    ].sort(),
  );
  for (const w of [local, chief, big]) {
    const events: Array<SessionEvent> = [];
    const sub = await mac.client.attach(w.session_id, 0, (e) => events.push(e));
    const why = () =>
      events.flatMap((e) =>
        e.type === "notification" && e.payload.title === "Paused when the lid closed"
          ? [e.payload.body ?? ""]
          : e.type === "session.resumed" && e.payload.move_failed
            ? [e.payload.move_failed]
            : [],
      );
    // Settled once it says why: `big` reads idle a moment as its turn stops, before its last copy refuses the move, which
    // a lid that answered past its budget has not seen yet.
    await until(
      async () =>
        why().length > 0 &&
        (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "idle",
      60_000,
    );
    await sub.detach();
    expect(why()).toHaveLength(1);
    expect(why()[0]!.toLowerCase()).toContain(of(w).reason!.toLowerCase());
  }
  expect(
    chats.handoffs.filter((h) => [local, chief, big].some((w) => w.session_id === h.session_id)),
  ).toEqual([]);
}, 300_000);

test("Settings' lid switch is what the runtime does: chats that don't copy read moves off, and turning the switch on lets a move go and the lid continue the chat (C1)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  // The sync notice answered Turn off, then the lid's own switch on: chats don't copy, so nothing moves.
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: false, move_to_cloud: true },
  });
  expect((await mac.client.call("cloud.status", {})).moves).not.toBe("on");
  expect(lidMoves(await mac.client.call("settings.get", {}))).toBe("off");
  const repo = makeRepo(tempRoot("sync-c1-"), { "README.md": "c1\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/c1.git"], { cwd: repo });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Lid switch",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  await expect(
    mac.client.call("session.move.check", { session_id: w.session_id, to: "cloud" }),
  ).rejects.toThrow(/off on this Mac/);
  // Settings' switch on: the copy and the lid together.
  await mac.client.call("settings.set", { request_id: "s2", settings: lidMovesWrite(true) });
  expect((await mac.client.call("cloud.status", {})).moves).toBe("on");
  await until(() => cloud.state.chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  await mac.client.call("session.move.check", { session_id: w.session_id, to: "cloud" });
  expect(
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    ),
  ).toMatchObject({ outcome: "continues" });
  // Off again writes the lid's own setting only: chats keep copying, the lid keeps them here.
  await mac.client.call("settings.set", { request_id: "s3", settings: lidMovesWrite(false) });
  expect((await mac.client.call("cloud.status", {})).moves).toBeUndefined();
  expect((await mac.client.call("settings.get", {})).sync_chats).toBe(true);
  expect(
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    ),
  ).toMatchObject({ outcome: "pauses" });
}, 180_000);

test("a boundary whose work in progress could not be snapshotted says it went without it, never names older work, and is made again with it once the snapshot works, a restart meanwhile", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  let mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-wip-lock-"), { "README.md": "lock\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/wip-lock.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Locked",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  type Boundary = {
    wip?: string | null;
    wip_bundle?: string;
    wip_ref?: unknown;
    wip_dropped?: boolean;
  };
  const boundaries = () =>
    (chats.sessions.get(w.session_id)?.segments ?? [])
      .filter((s) => s.boundary)
      .map((s) => s.body as Boundary);
  const landed = async () =>
    (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
    chats.sessions.get(w.session_id)!.segments.at(-1)!.boundary;
  await until(landed, 30_000);
  const before = boundaries().at(-1)!.wip;
  // A stale lock on the chat's work-in-progress ref (a git that died holding it): the next snapshot fails.
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: w.root_path!,
    encoding: "utf8",
  }).trim();
  const lock = path.join(common, "refs", "caveman", "sessions", `${w.session_id}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  fs.writeFileSync(path.join(w.root_path!, "work.txt"), "written while the ref was locked\n");
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a turn whose files cannot be snapshotted" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  await until(landed, 30_000);
  // The boundary says it went without its work in progress: a move from this copy never lands on the older files.
  const failed = boundaries().at(-1)!;
  expect(failed.wip_dropped).toBe(true);
  expect(failed.wip).toBe(before);
  expect(failed.wip_bundle).toBeUndefined();
  const said = (await mac.client.call("cloud.lid.summary", {})).chats.find(
    (c) => c.session_id === w.session_id,
  )!;
  expect(said).toMatchObject({ outcome: "pauses" });
  expect(said.reason).toMatch(/uncommitted changes didn't go into its copy/);
  // Still locked a while (git's lock left by a process that died): the copy keeps trying by itself, backing off; and
  // the runtime restarts meanwhile (a desktop update), which forgets nothing it owes.
  await new Promise((r) => setTimeout(r, 20_000));
  expect(boundaries().at(-1)!.wip_dropped).toBe(true);
  await mac.close();
  mac = await syncedMac(cloud, config);
  // The lock gone, the copy is made again with them, by itself: within the longest wait between tries (60 s).
  fs.rmSync(lock);
  await until(() => {
    const last = boundaries().at(-1)!;
    return last.wip_dropped === undefined && typeof last.wip === "string" && last.wip !== before;
  }, 90_000);
  const carried = boundaries().at(-1)!.wip!;
  expect(
    execFileSync("git", ["show", `${carried}:work.txt`], { cwd: w.root_path!, encoding: "utf8" }),
  ).toBe("written while the ref was locked\n");
  expect(
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    ),
  ).toMatchObject({ outcome: "continues" });
}, 180_000);

test("secret-shaped files git does not ignore stay on this Mac: the copy never carries them, a tracked one goes at HEAD's version, and the move check and lid summary name them (decision 24)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig());
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot("sync-secrets-"), {
    "README.md": "secrets\n",
    ".env.local": "TOKEN=head-version\n",
  });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/secrets.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Secrets",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const MARK = "MARKER-never-leaves-this-mac";
  fs.writeFileSync(path.join(w.root_path!, ".env"), `SECRET=${MARK}-untracked\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(w.root_path!, ".env.local"), `TOKEN=${MARK}-tracked\n`);
  fs.writeFileSync(path.join(w.root_path!, "deploy.pem"), `${MARK}-pem\n`);
  fs.writeFileSync(path.join(w.root_path!, "work.txt"), "ordinary work\n");
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a turn with secrets beside it" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  // The boundary that carried the work (a later one with nothing new names it only by `wip`).
  const last = () =>
    chats.sessions
      .get(w.session_id)!
      .segments.findLast(
        (s) => s.boundary && typeof (s.body as { wip_bundle?: string }).wip_bundle === "string",
      )!;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      last() !== undefined,
    60_000,
  );
  // The bundle applied: the work went, the secrets did not, the tracked one at HEAD's version.
  const scratch = tempRoot("sync-secrets-bundle-");
  fs.writeFileSync(
    path.join(scratch, "wip.bundle"),
    Buffer.from((last().body as { wip_bundle: string }).wip_bundle, "base64"),
  );
  const wip = (last().body as { wip: string }).wip;
  // On a clone of what GitHub has (its branches), as a Cloud computer applies it.
  execFileSync("git", ["clone", "-q", "--no-local", repo, path.join(scratch, "r")]);
  execFileSync("git", [
    "-C",
    path.join(scratch, "r"),
    "fetch",
    "-q",
    path.join(scratch, "wip.bundle"),
    `refs/caveman/sessions/${w.session_id}:refs/heads/wip`,
  ]);
  const shown = (file: string) =>
    execFileSync("git", ["-C", path.join(scratch, "r"), "show", `${wip}:${file}`], {
      encoding: "utf8",
    });
  expect(shown("work.txt")).toBe("ordinary work\n");
  expect(shown(".env.local")).toBe("TOKEN=head-version\n");
  const tree = execFileSync(
    "git",
    ["-C", path.join(scratch, "r"), "ls-tree", "-r", "--name-only", wip],
    { encoding: "utf8" },
  );
  expect(tree).not.toMatch(/^\.env$|deploy\.pem/m);
  expect(
    spawnSync("git", ["-C", path.join(scratch, "r"), "grep", "-c", MARK, "wip"], {
      encoding: "utf8",
    }).stdout,
  ).toBe("");
  // No segment, no chunk on Cloud holds them.
  for (const s of chats.sessions.get(w.session_id)!.segments)
    expect(gunzipSync(s.raw).toString("utf8")).not.toContain(MARK);
  for (const blob of chats.sessions.get(w.session_id)!.blobs?.values() ?? [])
    expect(blob.toString("latin1")).not.toContain(MARK);
  // The move check and the lid summary name them, as the last copy found them.
  const checked = await mac.client.call("session.move.check", {
    session_id: w.session_id,
    to: "cloud",
  });
  expect(checked.preflight?.work.left).toEqual([".env", ".env.local", "deploy.pem"]);
  expect(
    (await mac.client.call("cloud.lid.summary", {})).chats.find(
      (c) => c.session_id === w.session_id,
    ),
  ).toMatchObject({
    outcome: "continues_with_gaps",
    gaps: ["leaves .env, .env.local, deploy.pem on this Mac"],
  });
  // Nothing here changed.
  expect(fs.readFileSync(path.join(w.root_path!, ".env.local"), "utf8")).toBe(
    `TOKEN=${MARK}-tracked\n`,
  );
  expect(fs.statSync(path.join(w.root_path!, ".env")).mode & 0o777).toBe(0o600);
}, 180_000);
