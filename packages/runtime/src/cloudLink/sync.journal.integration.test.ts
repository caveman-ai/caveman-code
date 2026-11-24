// Sync's copies (sync.testkit.ts): a chat's journal copied to Cloud as it runs, rebuilt from Cloud's copy after a crash
// under a new epoch, held while Cloud cannot check it, and handed on as queued calls when Cloud moves the chat.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, test } from "vitest";

import { carriedOnto } from "../session-protocol/handlers.ts";
import type { DraftEvent } from "../session-protocol/projector.ts";
import * as Store from "../session-protocol/store.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { DeviceApproval } from "./calls.ts";
import { KEY_FILE, RECORD_FILE } from "./identity.ts";
import { linkDirOf } from "./index.ts";
import {
  cleanups,
  closeEachTestsRuntimes,
  cloudMovesIt,
  crashMidTurn,
  cutBehindOlderCopy,
  grabbing,
  headOf,
  journalOf,
  movableChat,
  personCall,
  sameAt,
  shown,
  syncedMac,
} from "./sync.testkit.ts";
import { startTestCloud } from "./testCloud.ts";

closeEachTestsRuntimes();

test("a chat on any engine copies as it runs; a crash before the upload catches up at the next start; a failed upload is retried, never dropped", async () => {
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
  // Signed in, not answered: nothing copies, and a chat asks once.
  expect((await mac.client.call("cloud.status", {})).sync).toEqual({
    available: true,
    on: false,
    ask: true,
  });
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  expect((await mac.client.call("cloud.status", {})).sync).toEqual({ available: true, on: true });
  const repo = makeRepo(tempRoot("sync-repo-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Synced chat",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "first words for every device" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  // Every event as the runtime journaled it, gap-free, and the summary every device lists.
  expect(chats.copyOf(w.session_id).map((e) => e.cursor)).toEqual(
    events.filter((e) => e.cursor <= chats.copyOf(w.session_id).length).map((e) => e.cursor),
  );
  // The summary that registered the chat claimed no epoch (its copy was not counted yet); the one after its copy does.
  await until(
    () =>
      chats.summaries.get(w.session_id)?.status === "idle" &&
      chats.summaries.get(w.session_id)?.head === chats.copyOf(w.session_id).length &&
      chats.summaries.get(w.session_id)?.epoch === 1,
    10_000,
  );
  expect(chats.summaries.get(w.session_id)).toMatchObject({
    engine: "claude-agent",
    kind: "chat",
    title: "Synced chat",
    epoch: 1,
  });
  expect(chats.summaries.get(w.session_id)!.preview).toContain("first words for every device");
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).synced_through).toBe(
    chats.copyOf(w.session_id).length,
  );
  // The copy's lease went with the idle chat (S12).
  expect(chats.sessions.get(w.session_id)!.lease).toBeNull();

  // Cloud refuses segments for the next turn: the copy stays owed, tried again, never dropped.
  chats.down.segments = 503;
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "second turn while Cloud is down" },
  });
  await until(() => events.filter((e) => e.type === "turn.done").length === 2, 60_000);
  await until(() => chats.segmentPuts.filter((p) => p.status === 503).length >= 2, 20_000);
  const owedHead = await headOf(mac.client, w.id);
  expect(chats.copyOf(w.session_id).at(-1)!.cursor).toBeLessThan(owedHead);
  // The runtime stops with the copy still owed (its last flush fails too): a crash after turn.done, before the upload.
  await mac.close();
  delete chats.down.segments;
  mac = await syncedMac(cloud, config);
  await until(() => (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) >= owedHead, 30_000);
  expect(chats.copyOf(w.session_id).map((e) => e.cursor)).toEqual(
    Array.from({ length: chats.copyOf(w.session_id).length }, (_, i) => i + 1),
  );
  // The summary converged too.
  await until(() => (chats.summaries.get(w.session_id)?.head ?? 0) >= owedHead, 10_000);
}, 180_000);

test("a turn past Cloud's segment cap copies as several segments, an event too big is cut and marked, and later turns keep copying", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const { box, layer } = grabbing();
  const mac = await syncedMac(cloud, config, layer);
  cleanups.push(() => mac.close());
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-big-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Big turn",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.summaries.has(w.session_id), 20_000);
  // 3 MiB of incompressible output five times, and one 6 MiB event: past one segment, and past what one event may be.
  const store = box.store!;
  const big = (title: string, bytes: number): DraftEvent =>
    ({
      at: new Date().toISOString(),
      type: "notification",
      payload: {
        level: "info",
        title,
        body: randomBytes(bytes).toString("base64").slice(0, bytes),
      },
    }) as DraftEvent;
  for (let i = 0; i < 5; i++)
    await Effect.runPromise(
      store.append(w.session_id, () =>
        Effect.succeed({ events: [big(`chunk ${i}`, 3 * 1024 * 1024)], value: undefined }),
      ),
    );
  await Effect.runPromise(
    store.append(w.session_id, () =>
      Effect.succeed({ events: [big("huge", 6 * 1024 * 1024)], value: undefined }),
    ),
  );
  const bigHead = await headOf(mac.client, w.id);
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the big output" },
  });
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      (await headOf(mac.client, w.id)) > bigHead,
    60_000,
  );
  const accepted = chats.segmentPuts.filter(
    (p) => p.session_id === w.session_id && p.status === 200,
  );
  expect(accepted.length).toBeGreaterThan(2);
  expect(accepted.every((p) => p.bytes <= 8 * 1024 * 1024 && p.gzip)).toBe(true);
  expect(chats.segmentPuts.some((p) => p.status === 413)).toBe(false);
  const copied = chats.copyOf(w.session_id);
  expect(copied.map((e) => e.cursor)).toEqual(
    Array.from({ length: copied.length }, (_, i) => i + 1),
  );
  const huge = copied.find(
    (e) => (e.event as { payload?: { title?: string } }).payload?.title === "huge",
  )!;
  expect((huge.event as { copy_truncated?: boolean }).copy_truncated).toBe(true);
  // A later turn still copies.
  const before = copied.length;
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "and one more" },
  });
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      chats.copyOf(w.session_id).length > before + 2,
    60_000,
  );
}, 180_000);

test("a journal that lost its tail here is rebuilt from Cloud's copy under a new epoch, and carries on", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-tail-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Tail",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  // An OS crash ate the last three commits (synchronous=NORMAL): the journal here ends three events early.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    head - 3,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(head - 3, w.session_id);
  db.close();
  // It was a crash: the runtime's synced note of the chats it journaled is still there (a clean stop removes it).
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  // Back up while Cloud cannot be reached: nothing is written to the chat before its copy was checked (X-4).
  chats.down.journal = 503;
  mac = await syncedMac(cloud, config);
  await expect(
    mac.client.call("turn.submit", {
      request_id: "t-early",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "too early" },
    }),
  ).rejects.toThrow(/waiting for Caveman/);
  expect(await headOf(mac.client, w.id)).toBe(head - 3);
  delete chats.down.journal;
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  expect(await headOf(mac.client, w.id)).toBe(head);
  expect(chats.epochBumps).toContainEqual({ session_id: w.session_id, epoch: 2, why: "rebuild" });
  // A device that saw the lost events is told to start again; the chat carries on and keeps copying.
  const seen: Array<SessionEvent> = [];
  let reset = 0;
  await mac.client.attach(w.session_id, head, (e) => seen.push(e), {
    epoch: 1,
    onReset: () => void reset++,
  });
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the rebuild" },
  });
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      (await headOf(mac.client, w.id)) > head,
    60_000,
  );
  expect(reset).toBe(1);
  expect(seen[0]?.cursor).toBe(1);
  expect(fs.existsSync(config.dbPath)).toBe(true);
}, 180_000);

test("a journal is never rebuilt from a copy Cloud no longer holds: it stays whole under a new epoch, and copies again from its first event (M-9)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-purged-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Purged",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  const before = journalOf(config.dbPath, w.session_id);
  expect(before).toHaveLength(head);
  // A rebuild here stopped between Cloud's new epoch and the rewrite (M-9), and Cloud then took the copy out (its
  // purge keeps the epoch and starts the copy again from cursor 1): Cloud's epoch is newer, and its copy holds nothing.
  const session = chats.sessions.get(w.session_id)!;
  session.epoch += 1;
  session.segments = [];
  session.cursor_seq = 0;
  session.size_bytes = 0;
  session.lease = null;
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  mac = await syncedMac(cloud, config);
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch !== 1,
    30_000,
  ).catch(() => undefined);
  expect(shown(journalOf(config.dbPath, w.session_id).slice(0, head))).toBe(shown(before));
  expect(await headOf(mac.client, w.id)).toBe(head);
  // A new epoch from Cloud, so every device drops what it held and reads the journal again; the copy starts over.
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(3);
  expect(chats.sessions.get(w.session_id)!.epoch).toBe(3);
  await until(() => (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === head, 30_000);
  expect(shown(chats.copyOf(w.session_id))).toBe(shown(before));
  // It carries on and copies at the new epoch.
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the purge" },
  });
  await until(
    async () =>
      (await headOf(mac.client, w.id)) > head &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    60_000,
  );
  expect(
    chats.segmentPuts.filter((p) => p.session_id === w.session_id && p.code !== undefined),
  ).toEqual([]);
}, 180_000);

test("a turn an OS crash cut mid-turn still ends in the journal rebuilt from Cloud's copy, after the events the crash ate", async () => {
  const r = await crashMidTurn(2);
  expect({
    copy: shown(r.journal.slice(0, r.copied.length)),
    ended: r.ended.length,
    end: r.journal.indexOf(r.ended[0]!) + 1,
  }).toEqual({
    copy: shown(r.copied),
    ended: 1,
    end: r.copied.length + 1,
  });
}, 240_000);

test("after an OS crash cut a turn, Cloud's copy holds this computer's journal, cursor for cursor", async () => {
  // The crash ate one commit, and the turn's end took its cursor here: the journal is not behind Cloud's copy.
  const r = await crashMidTurn(1);
  expect({ copy: shown(r.copy), ended: r.ended.length }).toEqual({
    copy: shown(r.journal),
    ended: 1,
  });
}, 240_000);

test("a rebuilt journal keeps what this run journaled since the stop after the copy, but not what it only journaled again", () => {
  const event = (cursor: number, type: string, at: string, item_id?: string) =>
    ({
      session_id: "s",
      cursor,
      type,
      at,
      ...(item_id ? { item_id } : {}),
      payload: {},
    }) as unknown as SessionEvent;
  const copy = [
    event(1, "turn.started", "t1"),
    event(2, "message.done", "t2", "m"),
    event(3, "context.updated", "t3"),
  ];
  // All new: after the copy.
  expect(shown(carriedOnto(copy, [event(2, "turn.done", "t9")]))).toBe("4:turn.done");
  // The projector journaled the copy's second event again, then the turn's end: only the end is new.
  expect(
    shown(carriedOnto(copy, [event(2, "message.done", "t2", "m"), event(3, "turn.done", "t9")])),
  ).toBe("4:turn.done");
  // All of the copy again and more: what is past the copy, where it was.
  expect(
    shown(
      carriedOnto(copy, [
        event(2, "message.done", "t2", "m"),
        event(3, "context.updated", "t3"),
        event(4, "turn.done", "t9"),
      ]),
    ),
  ).toBe("4:turn.done");
  // Nothing new.
  expect(carriedOnto(copy, [event(2, "message.done", "t2", "m")])).toEqual([]);
  expect(carriedOnto(copy, [])).toEqual([]);
});

test("a copied chat that crashed stays held across a crash or a restart before Cloud answered, and still takes Cloud's recovery epoch (X-4, CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-held-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Held",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  // An OS crash ate the last three commits, which Cloud's copy holds.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    head - 3,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(head - 3, w.session_id);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);

  // Back up with no network: held.
  cloud.state.unreachable = true;
  mac = await syncedMac(cloud, config);
  await expect(
    mac.client.call("turn.submit", {
      request_id: "t-early",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "too early" },
    }),
  ).rejects.toThrow(/waiting for Caveman/);
  // Another OS crash now leaves the disk as it is: the crash marker as it stands, and what this run recorded of the
  // hold lost with the database's last commits (synchronous=NORMAL). The chat is still held after it.
  const marker = `${config.dbPath}.journaled`;
  const onDisk = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : undefined;
  await mac.close();
  if (onDisk === undefined) fs.rmSync(marker, { force: true });
  else fs.writeFileSync(marker, onDisk);
  const lost = new DatabaseSync(config.dbPath);
  lost.prepare("DELETE FROM caveman_sp_kv WHERE key = ?").run(`moves:${w.session_id}:unchecked`);
  lost.close();
  mac = await syncedMac(cloud, config);
  await expect(
    mac.client.call("turn.submit", {
      request_id: "t-crashed-again",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "after another crash" },
    }),
  ).rejects.toThrow(/waiting for Caveman/);
  // Then the person quits and opens the app again, still offline.
  await mac.close();
  mac = await syncedMac(cloud, config);
  await expect(
    mac.client.call("turn.submit", {
      request_id: "t-restarted",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "after the restart" },
    }),
  ).rejects.toThrow(/waiting for Caveman/);
  expect(await headOf(mac.client, w.id)).toBe(head - 3);

  // Cloud answers: the journal is rebuilt from the copy under Cloud's new epoch, and the chat takes messages again.
  cloud.state.unreachable = false;
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  expect(await headOf(mac.client, w.id)).toBe(head);
  expect(chats.epochBumps).toContainEqual({ session_id: w.session_id, epoch: 2, why: "rebuild" });
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the rebuild" },
  });
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      (await headOf(mac.client, w.id)) > head,
    60_000,
  );

  // Checked once: the next start holds nothing.
  await mac.close();
  mac = await syncedMac(cloud, config);
  await mac.client.call("turn.submit", {
    request_id: "t3",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "and on" },
  });
}, 240_000);

test("a copied chat that crashed stays held while signed out and while Cloud fails, and the next sign-in still checks it against Cloud's copy (X-4, CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-held-out-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Held",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  // An OS crash ate the last three commits, which Cloud's copy holds.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    head - 3,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(head - 3, w.session_id);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  const passes = () => new Promise((resolve) => setTimeout(resolve, 7_000));
  const send = (request_id: string) =>
    mac.client.call("turn.submit", {
      request_id,
      session_id: w.session_id,
      kind: "followup",
      input: { text: request_id },
    });

  // Back up with no network: held. The person signs out to get past it, and Cloud does not hear of it.
  cloud.state.unreachable = true;
  mac = await syncedMac(cloud, config);
  await expect(send("t-early")).rejects.toThrow(/waiting for Caveman/);
  const link = linkDirOf(config.stateDir);
  const linked = [RECORD_FILE, KEY_FILE].map(
    (file) => [path.join(link, file), fs.readFileSync(path.join(link, file))] as const,
  );
  await mac.client.call("cloud.signout", { request_id: "out", delete_cloud_copies: false });
  await passes();
  await expect(send("t-signed-out")).rejects.toThrow(/signed in to Caveman again/);
  expect(await headOf(mac.client, w.id)).toBe(head - 3);

  // Signed in again on this computer while Cloud fails to say what the copy holds: the link the sign-out removed comes
  // back and enrolls again (a new runtime on the same computer, so every copy registers again under it).
  for (const [file, bytes] of linked) fs.writeFileSync(file, bytes, { mode: 0o600 });
  chats.down.journal = 503;
  cloud.state.unreachable = false;
  await mac.client.call("cloud.enroll", {
    request_id: "e2",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await passes();
  await expect(send("t-cloud-failing")).rejects.toThrow(/It continues once Caveman answers/);
  expect(await headOf(mac.client, w.id)).toBe(head - 3);

  // Cloud answers: the journal is rebuilt from the copy under Cloud's new epoch, and it carries on at that epoch, Cloud's
  // copy and the journal here the same events.
  delete chats.down.journal;
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  expect(await headOf(mac.client, w.id)).toBe(head);
  expect(chats.epochBumps).toEqual([{ session_id: w.session_id, epoch: 2, why: "rebuild" }]);
  await send("t2");
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      (await headOf(mac.client, w.id)) > head,
    60_000,
  );
  expect(
    chats.segmentPuts.filter(
      (p) => p.session_id === w.session_id && p.code === "cave_code_journal_epoch",
    ),
  ).toEqual([]);
  const here: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => here.push(e), { epoch: 2 });
  // A copy leaves as the turn starts, so Cloud's copy can reach the head above while the turn still writes: the two
  // are compared once the journal here stands still and Cloud's copy holds as many events.
  await until(
    async () =>
      here.length === (await headOf(mac.client, w.id)) &&
      chats.copyOf(w.session_id).length === here.length,
    30_000,
  );
  expect(chats.copyOf(w.session_id).map((e) => [e.cursor, e.type])).toEqual(
    here.map((e) => [e.cursor, e.type]),
  );
}, 240_000);

test("a copied chat that crashed stays held when sync goes off, and its copy is checked before it leaves Cloud (X-4, CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-held-off-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Held",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  // An OS crash ate the last three commits, which Cloud's copy holds.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    head - 3,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(head - 3, w.session_id);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  const send = (request_id: string) =>
    mac.client.call("turn.submit", {
      request_id,
      session_id: w.session_id,
      kind: "followup",
      input: { text: request_id },
    });

  // Back up with no network: held. Sync goes off, and its copy cannot leave Cloud yet: the chat still waits for it.
  cloud.state.unreachable = true;
  mac = await syncedMac(cloud, config);
  await expect(send("t-early")).rejects.toThrow(/waiting for Caveman/);
  await mac.client.call("settings.set", { request_id: "s-off", settings: { sync_chats: false } });
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  await expect(send("t-sync-off")).rejects.toThrow(/waiting for Caveman/);
  expect(await headOf(mac.client, w.id)).toBe(head - 3);

  // Cloud answers: the lost tail comes back from the copy under Cloud's new epoch, and only then does the copy go.
  cloud.state.unreachable = false;
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  expect(await headOf(mac.client, w.id)).toBe(head);
  expect(chats.epochBumps).toEqual([{ session_id: w.session_id, epoch: 2, why: "rebuild" }]);
  await until(() => chats.copyOf(w.session_id).length === 0, 30_000);
  // It carries on here, copied nowhere.
  const after: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, head, (e) => after.push(e), { epoch: 2 });
  await send("t2");
  await until(() => after.some((e) => e.type === "turn.done"), 60_000);
  expect(chats.copyOf(w.session_id)).toEqual([]);
}, 240_000);

test("a copied chat that crashed and whose copy Cloud no longer has takes its new epoch here (X-4, CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-held-gone-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Held",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  cloud.state.unreachable = true;
  mac = await syncedMac(cloud, config);
  await expect(
    mac.client.call("turn.submit", {
      request_id: "t-early",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "too early" },
    }),
  ).rejects.toThrow(/waiting for Caveman/);
  // Cloud no longer knows the chat (and takes no summary that would register it again): nothing there to check it
  // against, so devices read it again under an epoch from here.
  chats.sessions.delete(w.session_id);
  chats.down.summaries = 503;
  cloud.state.unreachable = false;
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  expect(chats.epochBumps).toEqual([]);
  expect(await headOf(mac.client, w.id)).toBe(head);
  const after: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, head, (e) => after.push(e), { epoch: 2 });
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the check" },
  });
  await until(() => after.some((e) => e.type === "turn.done"), 60_000);
}, 180_000);

test("the lid flushes every synced chat and hands a working one to Cloud, which continues it; an idle one stays", async () => {
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
  // The lid moves chats only with moves on, where Cloud runs Cloud computers, and a Claude Agent chat only with a Cloud
  // login for it (the lid's checks, handlers moveCheck).
  await mac.client.call("settings.set", {
    request_id: "s1",
    settings: { sync_chats: true, move_to_cloud: true },
  });
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  cloud.state.environments.computers = true;
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repoOf = (name: string) => {
    const repo = makeRepo(tempRoot(`sync-lid-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
      cwd: repo,
    });
    return repo;
  };
  const working = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repoOf("busy") },
    title: "Working",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const idle = await createReady(mac.client, {
    request_id: "w2",
    repo: { path: repoOf("quiet") },
    title: "Idle",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  // Working too, but its repository is not on GitHub: no Cloud computer can take it, so it is never handed off (M-4).
  const local = await createReady(mac.client, {
    request_id: "w3",
    repo: { path: makeRepo(tempRoot("sync-lid-local-"), { "README.md": "local\n" }) },
    title: "Local",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(working.session_id, 0, (e) => events.push(e));
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.summaries.has(idle.session_id) &&
      chats.summaries.has(working.session_id) &&
      chats.summaries.has(local.session_id),
    20_000,
  );
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: working.session_id,
    kind: "followup",
    input: { text: "slow 30000: keep going after the lid" },
  });
  await mac.client.call("turn.submit", {
    request_id: "t3",
    session_id: local.session_id,
    kind: "followup",
    input: { text: "slow 30000: this one stays" },
  });
  await until(
    () => events.some((e) => e.type === "message.done" && e.payload.role === "assistant"),
    30_000,
  );
  await until(
    () =>
      chats.summaries.get(working.session_id)?.status === "working" &&
      chats.summaries.get(local.session_id)?.status === "working",
    10_000,
  );
  const headAtLid = await headOf(mac.client, working.id);
  // A far Cloud: the handoff is made at once and answered 700 ms later (X-9: no shared 500 ms cut-off).
  chats.delay.handoff = 700;
  const started = Date.now();
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 5_000 });
  // Within its budget, Cloud's slow answer included (the answer itself is never cut off).
  expect(Date.now() - started).toBeLessThan(7_000);
  expect(out).toMatchObject({ handed_off: [working.session_id], paused: [local.session_id] });
  // Moved by then when the lid's work fits its budget; past it the move goes on (K5), and what it did is read once done.
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: working.id })).computer.kind ===
      "caveman_cloud",
    30_000,
  );
  // Stopped and parked before its last copy, a turn boundary with the work in progress, handed off through its end.
  const through = chats.copyOf(working.session_id).at(-1)!.cursor;
  expect(through).toBeGreaterThan(headAtLid);
  expect(chats.handoffs).toEqual([
    { session_id: working.session_id, through, reason: "lid", moved: true },
  ]);
  const copied = chats.copyOf(working.session_id).map((e) => e.type);
  expect(copied.at(-1)).toBe("session.parked");
  expect(copied.slice(copied.lastIndexOf("turn.started"))).toContain("turn.done");
  const last = chats.sessions.get(working.session_id)!.segments.at(-1)!;
  expect(last).toMatchObject({ boundary: true, through });
  expect(typeof (last.body as { wip?: unknown }).wip).toBe("string");
  expect((last.body as { interrupted?: boolean }).interrupted).toBe(true);
  expect(chats.sessions.get(working.session_id)).toMatchObject({
    computer_id: box.computerId,
    epoch: 2,
    returns_to: expect.any(String),
  });
  // While it moved, Cloud heard `moving`, never idle (K5): a Mac that sleeps mid-move still has it moved.
  const reported = cloud.state.sessions.runStates
    .filter((r) => r.workspace === chats.sessions.get(working.session_id)!.workspace_id)
    .map((r) => r.run_state);
  expect(reported.at(-1)).toBe("moving");
  expect(reported.slice(reported.lastIndexOf("working"))).not.toContain("idle");
  // It comes back to this Mac by itself once awake (K7): the return is marked here.
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  expect(
    db
      .prepare("SELECT key FROM caveman_sp_kv WHERE key = ?")
      .all(`moves:${working.session_id}:returns`),
  ).toHaveLength(1);
  db.close();
  // Here it is parked as moved, and stays so: nothing of the turn runs or is written past the copy Cloud continues from
  // (one writer). Only the stopped turn's own bookkeeping may still land here (its checkpoint and diff).
  expect((await mac.client.call("workspace.get", { workspace_id: working.id })).computer.kind).toBe(
    "caveman_cloud",
  );
  await new Promise((r) => setTimeout(r, 1_500));
  expect(
    events
      .filter(
        (e) => e.cursor > through && e.type !== "checkpoint.created" && e.type !== "diff.changed",
      )
      .map((e) => e.type),
  ).toEqual([]);
  // The idle chat stays here, released; the one no Cloud computer can take stays here with its turn stopped.
  expect((await mac.client.call("workspace.get", { workspace_id: idle.id })).computer.kind).toBe(
    "this_mac",
  );
  expect(chats.sessions.get(idle.session_id)!.lease).toBeNull();
  expect((await mac.client.call("workspace.get", { workspace_id: local.id })).computer.kind).toBe(
    "this_mac",
  );
  expect(chats.refused).toEqual([]);
}, 180_000);

test("a turn on a chat Cloud may move that cannot take its journal lease stops within a minute (M-3)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-lease-"), { "README.md": "lease\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/lease.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Lease",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0 &&
      chats.sessions.get(w.session_id)!.lease === null,
    30_000,
  );
  // The Mac's network goes (a train): Cloud takes no journal write, so no lease, while a turn starts here.
  chats.down.journal = 503;
  chats.down.segments = 503;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  const started = Date.now();
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 120000: a long turn offline" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 100_000);
  const took = Date.now() - started;
  expect(took).toBeGreaterThan(55_000);
  expect(took).toBeLessThan(90_000);
}, 180_000);

test("sync off then on again brings an idle chat back into every list (F-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-again-"), { "README.md": "again\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Again",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () => chats.summaries.has(w.session_id) && chats.copyOf(w.session_id).length > 0,
    30_000,
  );
  await mac.client.call("settings.set", { request_id: "s2", settings: { sync_chats: false } });
  await until(
    () => chats.deleted.includes(w.session_id) && !chats.summaries.has(w.session_id),
    30_000,
  );
  // Nothing changes in the chat; sync comes back on.
  await mac.client.call("settings.set", { request_id: "s3", settings: { sync_chats: true } });
  await until(() => chats.summaries.has(w.session_id), 30_000);
  expect(chats.sessions.get(w.session_id)!.follow).toBe(true);
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  expect(chats.refused).toEqual([]);
}, 180_000);

test("move mail waits on Cloud's long poll: an idle followed chat takes no mail every 3 s (M-11)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-wait-"), { "README.md": "wait\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/wait.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Wait",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      chats.sessions.get(w.session_id)?.follow === true &&
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
    30_000,
  );
  await until(() => chats.waits.some((x) => x.channel === "move"), 20_000);
  const takes = () => cloud.state.sessions.takes.filter((t) => t.channel === "move").length;
  const before = takes();
  await new Promise((r) => setTimeout(r, 12_000));
  expect(takes() - before).toBeLessThanOrEqual(1);
}, 120_000);

test("a turn's end reaches Cloud's list at once, even while Cloud is slow to take run state (S14, proof 9)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-fast-"), { "README.md": "fast\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/fast.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Fast",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    () =>
      (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0 &&
      chats.summaries.has(w.session_id),
    30_000,
  );
  // Every run-state write takes 1.5 s to answer.
  cloud.state.sessions.runStateDelayMs = 1_500;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  const seen = new Map<string, number>();
  const watch = setInterval(() => {
    const status = chats.summaries.get(w.session_id)?.status;
    if (status !== undefined && !seen.has(status)) seen.set(status, Date.now());
  }, 5);
  cleanups.push(() => clearInterval(watch));
  seen.clear();
  const submitted = Date.now();
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a quick one" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const doneAt = Date.now();
  await until(
    () =>
      chats.summaryPuts.some(
        (p) =>
          p.session_id === w.session_id &&
          p.status === "idle" &&
          p.head >= events.find((e) => e.type === "turn.done")!.cursor,
      ),
    10_000,
  );
  const idleAfter = Date.now() - doneAt;
  const workingAfter = (seen.get("working") ?? Infinity) - submitted;
  process.stderr.write(
    `A1 summary latency: working ${workingAfter} ms after the send, idle ${idleAfter} ms after turn.done (run state answers in 1500 ms)\n`,
  );
  // Neither waits on the run-state write (1.5 s) nor any debounce.
  expect(workingAfter).toBeLessThan(1_000);
  expect(idleAfter).toBeLessThan(1_000);
}, 120_000);

test("after an unclean stop every chat the run journaled takes a new epoch, synced or not, so no device keeps a replaced event (CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-crash-"), { "README.md": "crash\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Crash",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  // While the journal runs, the runtime keeps a synced note of the chats it wrote; a clean stop removes it.
  expect(fs.existsSync(`${config.dbPath}.journaled`)).toBe(true);
  await mac.close();
  expect(fs.existsSync(`${config.dbPath}.journaled`)).toBe(false);
  // A crash leaves it: devices may hold events the journal lost and Cloud never had.
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  mac = await syncedMac(cloud, config);
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  expect(chats.epochBumps).toContainEqual({ session_id: w.session_id, epoch: 2, why: "rebuild" });
  // A device that saw it at epoch 1 starts again from the first event.
  let reset = 0;
  const seen: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, await headOf(mac.client, w.id), (e) => seen.push(e), {
    epoch: 1,
    onReset: () => void reset++,
  });
  expect(reset).toBe(1);
  // It carries on and copies at the new epoch.
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the crash" },
  });
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      seen.some((e) => e.type === "turn.done"),
    60_000,
  );
  expect(
    chats.segmentPuts.filter(
      (p) => p.session_id === w.session_id && p.code === "cave_code_journal_epoch",
    ),
  ).toEqual([]);

  // A chat that only lives here (no sign-in) takes its new epoch at once.
  const local = await makeConfig();
  let alone = await startRuntime(local, "fake-claude");
  let client = connect(alone.url, alone.token);
  const lw = await createReady(client, {
    request_id: "lw",
    repo: { path: makeRepo(tempRoot("sync-crash-local-"), { "README.md": "x\n" }) },
    title: "Alone",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  client.close();
  await alone.close();
  fs.writeFileSync(`${local.dbPath}.journaled`, `${lw.session_id}\n`);
  alone = await startRuntime(local, "fake-claude");
  cleanups.push(() => alone.close());
  client = connect(alone.url, alone.token);
  cleanups.push(() => client.close());
  expect((await client.call("workspace.get", { workspace_id: lw.id })).epoch).toBe(2);
}, 180_000);

test("a chat that took its own epoch after an unclean stop while sync was off syncs once sync is on: Cloud's copy moves up to that epoch (CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: false } });
  const repo = makeRepo(tempRoot("sync-own-epoch-"), { "README.md": "own epoch\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Own epoch",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await mac.close();
  // The Mac stopped without a clean quit while the chat journaled: with no copy in Cloud, it takes epoch 2 here at once.
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  mac = await syncedMac(cloud, config);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(2);
  expect(chats.sessions.has(w.session_id)).toBe(false);
  // Sync goes on: Cloud registers the chat at its own first epoch, which is not this journal's.
  await mac.client.call("settings.set", { request_id: "s2", settings: { sync_chats: true } });
  const head = await headOf(mac.client, w.id);
  await until(
    () =>
      chats.summaries.has(w.session_id) &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === head,
    30_000,
  ).catch(() => undefined);
  expect({
    listed: chats.summaries.has(w.session_id),
    copied: chats.copyOf(w.session_id).at(-1)?.cursor ?? 0,
    epoch: chats.sessions.get(w.session_id)?.epoch,
  }).toEqual({ listed: true, copied: head, epoch: 2 });
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(2);
  expect(
    chats.segmentPuts.filter(
      (p) => p.session_id === w.session_id && p.code === "cave_code_journal_epoch",
    ),
  ).toEqual([]);
  // It carries on and copies at that epoch.
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after sync" },
  });
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "idle" &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    60_000,
  );
  expect(chats.summaries.get(w.session_id)?.epoch).toBe(2);
}, 180_000);

test("an idle chat that took its own epoch with no copy counted here syncs again: Cloud's copy, which holds this journal, moves up to that epoch (CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-idle-epoch-"), { "README.md": "idle\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Idle",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  await mac.close();
  const journal = journalOf(config.dbPath, w.session_id);
  // This computer's count of the copy is gone (another sign-in forgets it; Cloud's copy stays), and it stopped without
  // a clean quit while the chat journaled, with nothing lost: with no copy counted, the chat takes epoch 2 here at once.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_kv WHERE key = ?").run(`moves:${w.session_id}`);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  mac = await syncedMac(cloud, config);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(2);
  // Its copy is registered again and counted here, as of this journal's epoch.
  const countedAt = () => {
    const kv = new DatabaseSync(config.dbPath);
    try {
      const row = kv
        .prepare("SELECT value FROM caveman_sp_kv WHERE key = ?")
        .get(`moves:${w.session_id}`) as { value: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.value) as { epoch?: number }).epoch;
    } finally {
      kv.close();
    }
  };
  await until(() => countedAt() === 2, 30_000);
  // The chat stays idle; the person renames it, which every device lists.
  await mac.client.call("workspace.rename", {
    request_id: "r1",
    workspace_id: w.id,
    title: "Renamed while idle",
  });
  await until(
    () =>
      chats.summaries.get(w.session_id)?.title === "Renamed while idle" &&
      chats.sessions.get(w.session_id)?.epoch === 2,
    30_000,
  ).catch(() => undefined);
  expect({
    title: chats.summaries.get(w.session_id)?.title,
    cloud: chats.sessions.get(w.session_id)?.epoch,
    summary: chats.summaries.get(w.session_id)?.epoch,
  }).toEqual({
    title: "Renamed while idle",
    cloud: 2,
    summary: 2,
  });
  expect(shown(journalOf(config.dbPath, w.session_id))).toBe(shown(journal));
  expect(shown(chats.copyOf(w.session_id))).toBe(shown(journal));
  // It carries on and copies at that epoch.
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the rename" },
  });
  await until(
    async () =>
      (await headOf(mac.client, w.id)) > journal.length &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    60_000,
  );
  expect(
    chats.segmentPuts.filter((p) => p.session_id === w.session_id && p.code !== undefined),
  ).toEqual([]);
}, 180_000);

test("a chat whose journal parted from Cloud's older-epoch copy, with no copy counted here, is rebuilt from that copy and keeps its own events after it: the copy never mixes the two (CHAOS-5)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-parted-"), { "README.md": "parted\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Parted",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "remember this turn" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  const copied = journalOf(config.dbPath, w.session_id);
  // This computer's count of the copy is gone (another sign-in forgets it; Cloud's copy stays), and then an OS crash ate
  // the journal's last three commits, which that copy holds.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_kv WHERE key = ?").run(`moves:${w.session_id}`);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    head - 3,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(head - 3, w.session_id);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  // With no copy counted, the chat takes epoch 2 here at once, and its next turn journals over the cursors the crash
  // ate while Cloud cannot be reached.
  chats.down.journal = 503;
  mac = await syncedMac(cloud, config);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(2);
  const later: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, head - 3, (e) => later.push(e), { epoch: 2 });
  await mac.client.call("turn.submit", {
    request_id: "t2",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the crash" },
  });
  await until(() => later.some((e) => e.type === "turn.done"), 60_000);
  const ours = journalOf(config.dbPath, w.session_id).slice(head - 3);
  expect(ours.length).toBeGreaterThan(3);
  delete chats.down.journal;
  const same = (
    journal: ReadonlyArray<{ readonly cursor: number; readonly type: string; readonly at: string }>,
  ) => journal.map((e) => `${e.cursor}:${e.type}:${e.at}`);
  const settled = async () => {
    const journal = journalOf(config.dbPath, w.session_id);
    return (
      journal.length === head + ours.length &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === journal.length
    );
  };
  await until(settled, 60_000).catch(() => undefined);
  const journal = journalOf(config.dbPath, w.session_id);
  // What the crash ate comes back from the copy, every event journaled since goes on after it, and Cloud's copy is this
  // journal, cursor for cursor.
  expect({
    copy: same(journal.slice(0, head)),
    since: journal.slice(head).map((e) => `${e.type}:${e.at}`),
    cloud: same(chats.copyOf(w.session_id)),
  }).toEqual({
    copy: same(copied),
    since: ours.map((e) => `${e.type}:${e.at}`),
    cloud: same(journal),
  });
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(
    chats.sessions.get(w.session_id)!.epoch,
  );
}, 180_000);

test("a chat with no copy counted here whose journal an OS crash cut back behind Cloud's older-epoch copy gets the lost turns back from it, its own after them, under a new epoch (CHAOS-5)", async () => {
  const r = await cutBehindOlderCopy();
  expect({
    copy: sameAt(r.journal.slice(0, r.head)),
    since: r.journal.slice(r.head).map((e) => `${e.type}:${e.at}`),
    cloud: sameAt(r.copy),
  }).toEqual({
    copy: sameAt(r.copied),
    since: r.ours.map((e) => `${e.type}:${e.at}`),
    cloud: sameAt(r.journal),
  });
  // A new epoch past the one this journal took on its own, so every device that read either drops it and reads again.
  expect({ epoch: r.epoch, cloud: r.cloudEpoch }).toEqual({ epoch: 3, cloud: 3 });
}, 240_000);

test("a check for moved chats that read Cloud's copy while a copy rebuilt the journal never rebuilds it again from what it read: the turns journaled since stay (CHAOS-5)", async () => {
  const r = await cutBehindOlderCopy({ gated: true });
  expect({
    since: r.journal.slice(r.head).map((e) => `${e.type}:${e.at}`),
    cloud: sameAt(r.copy),
    epoch: r.epoch,
    cloudEpoch: r.cloudEpoch,
  }).toEqual({
    since: r.ours.map((e) => `${e.type}:${e.at}`),
    cloud: sameAt(r.journal),
    epoch: 3,
    cloudEpoch: 3,
  });
}, 240_000);

test("a turn's end copies as a boundary with its work in progress, its checkpoint and diff at once, so Cloud can move the chat (CHAOS-3, CHAOS-11)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-boundary-"), { "README.md": "boundary\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/boundary.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Boundary",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a turn to move from" },
  });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  const doneAt = Date.now();
  // Everything the turn journaled, its checkpoint and diff included (journaled before or just after its end), is in
  // Cloud's copy within moments, never the 15 s a mid-turn copy waits.
  await until(async () => {
    const head = await headOf(mac.client, w.id);
    return (
      events.some((e) => e.type === "diff.changed") &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === head &&
      chats.sessions.get(w.session_id)!.segments.at(-1)!.boundary
    );
  }, 10_000);
  expect(Date.now() - doneAt).toBeLessThan(5_000);
  // The last segment is a boundary with the engine's conversation and the work in progress: what a move adopts from.
  const last = chats.sessions.get(w.session_id)!.segments.at(-1)!;
  expect(last.boundary).toBe(true);
  expect(typeof (last.body as { wip?: unknown }).wip).toBe("string");
  expect(
    chats.sessions
      .get(w.session_id)!
      .segments.some((s) => s.boundary && (s.body as { engine?: unknown }).engine !== null),
  ).toBe(true);
}, 120_000);

test("sync off takes a followed chat's copy out of Cloud too, so Cloud cannot move it; on again it follows from the first event", async () => {
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
  cloud.state.environments.computers = true;
  cloud.enrollRuntime({ kind: "cloud" });
  // Sync kept on, "Move chats to Cloud" never answered: moves follow sync (CHAOS-8).
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-follow-off-"), { "README.md": "follows\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/follows.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Follows",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  const copied = async () =>
    (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id));
  await until(
    async () => chats.sessions.get(w.session_id)?.movable_flag === true && (await copied()),
    30_000,
  );
  // Sync off: the followed chat is registered again with follow off, so its copy leaves and it no longer moves.
  await mac.client.call("settings.set", { request_id: "s2", settings: { sync_chats: false } });
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === undefined &&
      chats.copyOf(w.session_id).length === 0,
    30_000,
  );
  const move = await fetch(`${cloud.url}/api/v1/code/chats/${w.session_id}/move`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cloud.state.personToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: "cloud" }),
  });
  expect(move.status).toBe(409);
  // On again: it follows once more and copies from the first event.
  await mac.client.call("settings.set", { request_id: "s3", settings: { sync_chats: true } });
  await until(
    async () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.copyOf(w.session_id)[0]?.cursor ?? 0) === 1 &&
      (await copied()),
    30_000,
  );
  expect(chats.refused).toEqual([]);
}, 180_000);

test("a send queued behind a running turn reaches Cloud's copy at once, before a sleep without warning could strand it (CHAOS-12)", async () => {
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
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot("sync-queued-"), { "README.md": "queued\n" });
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
  const chats = cloud.state.chats;
  await until(() => chats.sessions.get(w.session_id)?.movable_flag === true, 30_000);
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 30000: a long turn" },
  });
  await until(() => events.some((e) => e.type === "turn.started"), 30_000);
  const lastQueued = () => chats.sessions.get(w.session_id)?.segments.at(-1)?.body.queued;
  // Past the turn's start copy: what goes up next is the queue change alone.
  await new Promise((r) => setTimeout(r, 1_500));
  expect(
    await mac.client.call("turn.submit", {
      request_id: "t2",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "and then this" },
    }),
  ).toMatchObject({ disposition: "queued" });
  const queuedAt = Date.now();
  // Within the 15 s a mid-turn copy may lag, a queue change goes up at once.
  await until(() => JSON.stringify(lastQueued()) === JSON.stringify(["and then this"]), 5_000);
  expect(Date.now() - queuedAt).toBeLessThan(5_000);
  await mac.client.call("turn.interrupt", { request_id: "stop", session_id: w.session_id });
}, 120_000);

test("what the Mac took in after its last copy goes on as the person's queued calls, handed on under their own request ids, when Cloud moves the chat (CHAOS-14)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  const w = await movableChat(cloud, mac, "taken-in", "ask");
  const chats = cloud.state.chats;
  // Cloud cannot take a copy now: what comes in stays on the Mac.
  chats.down.journal = 503;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // A turn that waits on the person before its engine does anything, and a follow-up queued behind it.
  await mac.client.call("turn.submit", {
    request_id: "t-long",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "ask: may I run it" },
  });
  await until(() => events.some((e) => e.type === "ask.user"), 20_000);
  expect(
    (
      await mac.client.call("turn.submit", {
        request_id: "t-next",
        session_id: w.session_id,
        kind: "followup",
        input: { text: "and then this" },
      })
    ).disposition,
  ).toBe("queued");
  await cloudMovesIt(cloud, w.session_id);
  // The Mac hears it moved once Cloud answers again: both messages go to where the chat is, handed on under the Mac's
  // own ids for them that keep the person's (CHAOS-19), once.
  delete chats.down.journal;
  await until(
    () =>
      ["t-long", "t-next"].every((id) =>
        [...chats.calls.values()].some(
          (c) => c.session_id === w.session_id && Store.forwardedOf(c.request_id) === id,
        ),
      ),
    60_000,
  );
  const forwarded = [...chats.calls.values()].filter((c) => c.session_id === w.session_id);
  expect(
    forwarded.map((c) => [
      c.request_id,
      (c.params as { input: { text: string } }).input.text,
      c.forwarded_by_runtime_id !== undefined,
    ]),
  ).toEqual([
    [
      Store.forwardedRequestId(forwarded[0]!.forwarded_by_runtime_id!, "t-long"),
      "ask: may I run it",
      true,
    ],
    [
      Store.forwardedRequestId(forwarded[0]!.forwarded_by_runtime_id!, "t-next"),
      "and then this",
      true,
    ],
  ]);
  expect(chats.forwardRefusals).toEqual([]);
  expect(chats.refused).toEqual([]);
}, 180_000);

test("turns that ran on the Mac after its last copy are kept as their own chat there, not replayed, when Cloud moves the chat (CHAOS-14)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  const w = await movableChat(cloud, mac, "ran-here");
  const chats = cloud.state.chats;
  chats.down.journal = 503;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  await mac.client.call("turn.submit", {
    request_id: "t-work",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "worked on offline" },
  });
  await until(
    () =>
      events.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "assistant" &&
          e.payload.text.includes("worked on offline"),
      ),
    30_000,
  );
  await until(
    () =>
      events.findLastIndex((e) => e.type === "turn.done") >
      events.findLastIndex((e) => e.type === "message.done" && e.payload.role === "assistant"),
    30_000,
  );
  await cloudMovesIt(cloud, w.session_id);
  delete chats.down.journal;
  // Its own chat on the Mac, saying where it came from; nothing replayed where the chat went.
  await until(
    async () =>
      (await mac.client.call("workspace.list", {})).workspaces.some(
        (x) => x.title === "ran-here (kept on this Mac)",
      ),
    60_000,
  );
  const kept = (await mac.client.call("workspace.list", {})).workspaces.find(
    (x) => x.title === "ran-here (kept on this Mac)",
  )!;
  const keptEvents: Array<SessionEvent> = [];
  const sub = await mac.client.attach(kept.session_id, 0, (e) => keptEvents.push(e));
  await until(
    () =>
      keptEvents.some(
        (e) =>
          e.type === "notification" &&
          JSON.stringify(e.payload).includes("Kept here when the chat moved"),
      ),
    10_000,
  );
  expect(
    keptEvents.some(
      (e) =>
        e.type === "message.done" &&
        e.payload.role === "user" &&
        e.payload.text === "worked on offline",
    ),
  ).toBe(true);
  await sub.detach();
  await until(
    () =>
      events.some(
        (e) =>
          e.type === "notification" &&
          JSON.stringify(e.payload).includes("Work kept in its own chat"),
      ),
    10_000,
  );
  expect([...chats.calls.values()].filter((c) => c.session_id === w.session_id)).toEqual([]);
}, 180_000);

test("a send the Mac answered as the person's queued call still runs where Cloud moved the chat from a copy without it, and a restart before it went on still owes it (CHAOS-19)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  // This Mac runs what the person's phone queues in Cloud (S13).
  const phone = Layer.succeed(DeviceApproval, {
    approved: (id: string | undefined) => Effect.succeed(id === "phone-1"),
  }) as Layer.Layer<any>;
  let mac = await syncedMac(cloud, config, phone);
  cleanups.push(() => mac.close());
  const w = await movableChat(cloud, mac, "answered", "ask");
  const chats = cloud.state.chats;
  chats.down.journal = 503;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // The phone's send, queued in Cloud: the Mac takes it, starts its turn (it waits on the person) and answers the call.
  const params = {
    session_id: w.session_id,
    kind: "followup",
    input: { text: "ask: may I run it" },
  };
  await personCall(cloud, "POST", `chats/${w.session_id}/calls`, {
    request_id: "q-ask",
    method: "turn.submit",
    params,
    device_id: "phone-1",
  });
  await until(
    async () =>
      (await personCall(cloud, "GET", `chats/${w.session_id}/calls/q-ask`)).status === "done",
    20_000,
  );
  await until(() => events.some((e) => e.type === "ask.user"), 20_000);
  // Cloud moves the chat from its copy, which never had that send; at first Cloud cannot take what the Mac hands on.
  await cloudMovesIt(cloud, w.session_id);
  chats.down.forward = 503;
  delete chats.down.journal;
  const owed = () => {
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      return (
        db
          .prepare("SELECT value FROM caveman_sp_kv WHERE key = ?")
          .get(`moves:${w.session_id}:after-copy-owed`) as { value: string } | undefined
      )?.value;
    } finally {
      db.close();
    }
  };
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "parked" &&
      owed() !== undefined,
    60_000,
  );
  // Asked and asked again meanwhile (the moves pass), never given up on: still owed, nothing queued, no "Not sent".
  await new Promise((r) => setTimeout(r, 7_000));
  const handedOn = () =>
    [...chats.calls.values()].filter(
      (c) => c.session_id === w.session_id && Store.forwardedOf(c.request_id) === "q-ask",
    );
  expect(owed()).toBeDefined();
  expect(handedOn()).toEqual([]);
  // This Mac restarts; Cloud takes hand-ons again.
  await mac.close();
  delete chats.down.forward;
  mac = await syncedMac(cloud, config, phone);
  await until(() => handedOn().length > 0 && owed() === undefined, 60_000);
  // One hand-on, the Mac's own call for it; the person's call keeps the answer it had.
  expect(
    handedOn().map((c) => [
      c.request_id,
      (c.params as { input: { text: string } }).input.text,
      c.forwarded_by_runtime_id,
    ]),
  ).toEqual([
    [
      Store.forwardedRequestId(handedOn()[0]!.forwarded_by_runtime_id!, "q-ask"),
      "ask: may I run it",
      handedOn()[0]!.forwarded_by_runtime_id,
    ],
  ]);
  expect((await personCall(cloud, "GET", `chats/${w.session_id}/calls/q-ask`)).status).toBe("done");
  expect(chats.forwardRefusals).toEqual([]);
  const after: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => after.push(e));
  await until(() => after.some((e) => e.type === "session.parked"), 10_000);
  expect(
    after.some((e) => e.type === "notification" && JSON.stringify(e.payload).includes("Not sent")),
  ).toBe(false);
}, 240_000);

test("a follow-up the copy carried is not handed on again when Cloud moves the chat from that copy: it is queued there already (CHAOS-12, CHAOS-19)", async () => {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const config = await makeConfig();
  const mac = await syncedMac(cloud, config);
  cleanups.push(() => mac.close());
  const w = await movableChat(cloud, mac, "carried", "ask");
  const chats = cloud.state.chats;
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // A turn that waits on the person, and a follow-up behind it that the next copy carries (a queue change copies at once).
  await mac.client.call("turn.submit", {
    request_id: "t-ask",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "ask: may I run it" },
  });
  await until(() => events.some((e) => e.type === "ask.user"), 20_000);
  expect(
    (
      await mac.client.call("turn.submit", {
        request_id: "t-carried",
        session_id: w.session_id,
        kind: "followup",
        input: { text: "carried in the copy" },
      })
    ).disposition,
  ).toBe("queued");
  await until(
    () =>
      JSON.stringify(chats.sessions.get(w.session_id)?.segments.at(-1)?.body.queued) ===
      JSON.stringify(["carried in the copy"]),
    10_000,
  );
  // One more follow-up that no copy has; then Cloud moves the chat from the copy that carried only the first.
  chats.down.journal = 503;
  expect(
    (
      await mac.client.call("turn.submit", {
        request_id: "t-after",
        session_id: w.session_id,
        kind: "followup",
        input: { text: "after the copy" },
      })
    ).disposition,
  ).toBe("queued");
  await cloudMovesIt(cloud, w.session_id);
  delete chats.down.journal;
  const handedOn = () =>
    [...chats.calls.values()]
      .filter((c) => c.session_id === w.session_id)
      .map((c) => Store.forwardedOf(c.request_id));
  await until(() => handedOn().includes("t-after"), 60_000);
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "parked",
    10_000,
  );
  await new Promise((r) => setTimeout(r, 2_000));
  expect(handedOn()).toEqual(["t-after"]);
  expect(chats.forwardRefusals).toEqual([]);
}, 180_000);
