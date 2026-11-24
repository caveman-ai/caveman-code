// Sync's journal lease and a running turn's copies (sync.testkit.ts): who takes a lease and who stops without one, a
// paused chat resuming after an unclean stop, and a running turn's files copied, and copied again when a copy fails.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

import { type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import {
  cleanups,
  closeEachTestsRuntimes,
  grabbing,
  offlineMac,
  syncedMac,
} from "./sync.testkit.ts";
import { startTestCloud } from "./testCloud.ts";

closeEachTestsRuntimes();

test("a chat the record still says is busy after its turn ended never takes a journal lease, nor is it stopped for having none (0b)", async () => {
  const { box, layer } = grabbing();
  const { mac, chats, chat, status, notes } = await offlineMac(layer);
  const w = await chat("ended");
  await mac.client.call("turn.submit", {
    request_id: "t-ended",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "a short turn" },
  });
  await until(() => {
    const done = w.events.findLast((e) => e.type === "turn.done");
    const copied = chats.sessions.get(w.session_id);
    // No lease can also mean the final copy has not started. Wait until it carried this turn's end and released.
    return (
      done !== undefined &&
      copied !== undefined &&
      copied.cursor_seq >= done.cursor &&
      copied.segments.at(-1)?.boundary === true &&
      copied.lease === null
    );
  }, 30_000);
  await until(async () => (await status(w)) === "idle", 30_000);
  // Its turn's end journaled and copied, its lease let go; its status still says working (the race of 0b, held open).
  const store = box.store!;
  const record = (await Effect.runPromise(store.getBySession(w.session_id)))!;
  await Effect.runPromise(
    store.putWorkspace({ ...record, workspace: { ...record.workspace, status: "working" } }),
  );
  const leased: Array<number> = [];
  const since = Date.now();
  while (Date.now() - since < 75_000) {
    const lease = chats.sessions.get(w.session_id)?.lease;
    if (lease !== null && lease !== undefined) leased.push(lease.expires_at);
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(leased).toEqual([]);
  expect(notes(w, "Lost the connection to Caveman")).toBe(0);
}, 180_000);

test("a running turn's tool that names files copies within seconds of its end, carrying the turn's files inline and the cursor they were taken at; a command's end copies them at no extra time (decision 25)", async () => {
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
  const chats = cloud.state.chats;
  const chat = async (name: string) => {
    const repo = makeRepo(tempRoot(`sync-soon-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/soon-${name}.git`], {
      cwd: repo,
    });
    const w = await createReady(mac.client, {
      request_id: `w-${name}`,
      repo: { path: repo },
      title: name,
      engine: "claude-agent",
      options: { model: MODEL, access: "full" },
    });
    await until(
      () =>
        chats.sessions.get(w.session_id)?.movable_flag === true &&
        chats.sessions.get(w.session_id)!.lease === null,
      30_000,
    );
    const events: Array<SessionEvent> = [];
    await mac.client.attach(w.session_id, 0, (e) => events.push(e));
    return { ...w, events };
  };
  const midTurn = (sessionId: string) =>
    (chats.sessions.get(sessionId)?.segments ?? [])
      .map((s) => s.body as { boundary?: boolean; through?: number; wip?: string; wip_at?: number })
      .filter((b) => b.boundary === false);
  const [edits, reads] = [await chat("edits"), await chat("reads")];
  // One turn edits a file with a tool that names it; the other runs a command. Both then work on.
  await mac.client.call("turn.submit", {
    request_id: "t-edits",
    session_id: edits.session_id,
    kind: "followup",
    input: { text: "create: late.txt changed-mid-turn hold 600000" },
  });
  await mac.client.call("turn.submit", {
    request_id: "t-reads",
    session_id: reads.session_id,
    kind: "followup",
    input: { text: "cat: README.md hold 600000" },
  });
  await until(
    () => [edits, reads].every((w) => w.events.some((e) => e.type === "tool.done")),
    30_000,
  );
  const done = edits.events.find((e) => e.type === "tool.done")!;
  const ended = Date.now();
  // Within the debounce (2 s, no closer than 5 s to the turn's first copy) plus a copy's own time, never the 15 s lag.
  const carried = () => midTurn(edits.session_id).find((b) => (b.wip_at ?? 0) >= done.cursor);
  await until(() => carried() !== undefined, 8_000).catch((error: Error) => {
    throw new Error(
      `${error.message}: ${JSON.stringify(midTurn(edits.session_id).map((b) => [b.through, b.wip, b.wip_at]))}`,
    );
  });
  expect(Date.now() - ended).toBeLessThan(8_000);
  expect((await mac.client.call("workspace.get", { workspace_id: edits.id })).status).toBe(
    "working",
  );
  expect(
    execFileSync("git", ["show", `${carried()!.wip}:late.txt`], {
      cwd: edits.root_path!,
      encoding: "utf8",
    }),
  ).toBe("changed-mid-turn\n");
  // The command's turn copies within the lag, never hurried. That copy looks at the files (R3 of
  // cloud-computers-2026-11-09: a command may have written some) and, as this one wrote none, carries no bundle.
  const ran = reads.events.find((e) => e.type === "tool.done")!;
  await until(() => midTurn(reads.session_id).some((b) => (b.through ?? 0) >= ran.cursor), 30_000);
  const looked = midTurn(reads.session_id).filter((b) => b.wip_at !== undefined);
  expect(
    looked.every(
      (b) =>
        (b.wip_at ?? 0) >= ran.cursor && (b as { wip_bundle?: string }).wip_bundle === undefined,
    ),
  ).toBe(true);
}, 120_000);

test("Settings deletes a Cloud computer of the person's through This Mac's runtime: Cloud marks it deleted and archives its chats; another's is not found (C3)", async () => {
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
  const mine = cloud.enrollRuntime({ kind: "cloud", name: "Fix login" });
  const theirs = cloud.enrollRuntime({ kind: "cloud", name: "Colleague's", person: "user-2" });
  cloud.state.chats.summaries.set("s-on-it", {
    session_id: "s-on-it",
    computer_id: mine.computerId,
  } as never);
  const row = await mac.client.call("cloud.computer.delete", {
    request_id: "d1",
    computer_id: mine.computerId,
  });
  expect(row).toMatchObject({ id: mine.computerId, desired_state: "deleted" });
  expect(cloud.state.chats.computers.get(mine.computerId)?.state).toBe("deleted");
  expect(cloud.state.chats.summaries.get("s-on-it")).toMatchObject({ archived: true });
  // Cloud's refusal reaches the client with Cloud's own code (m-21): what a kept-computer limit is told apart by.
  const refused = await mac.client
    .call("cloud.computer.delete", { request_id: "d2", computer_id: theirs.computerId })
    .then(
      () => null,
      (error: { error?: { data?: { reason?: string; cloud_code?: string } } }) =>
        error.error?.data ?? null,
    );
  expect(refused).toMatchObject({ cloud_code: "cave_not_found" });
  expect(cloud.state.chats.computers.get(theirs.computerId)?.state).toBe("running");
}, 60_000);

test("a chat the lease stop paused offline resumes on reconnect though this computer stopped uncleanly meanwhile and took a new epoch for it: its tool never runs twice (decision 26)", async () => {
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
  const chats = cloud.state.chats;
  const repo = makeRepo(tempRoot("sync-offline-crash-"), { "README.md": "crash\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/offline-crash.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Crash offline",
    engine: "claude-agent",
    options: { model: MODEL, access: "full" },
  });
  await until(
    () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      chats.sessions.get(w.session_id)!.lease === null,
    30_000,
  );
  let events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  const status = async () =>
    (await mac.client.call("workspace.get", { workspace_id: w.id })).status;
  const notes = (title: string) =>
    events.filter((e) => e.type === "notification" && e.payload.title === title).length;
  const effects = () =>
    events.filter(
      (e) => e.type === "tool.started" && JSON.stringify(e.payload).includes("cat README.md"),
    ).length;
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "cat: README.md crash hold 600000" },
  });
  await until(() => chats.sessions.get(w.session_id)?.lease !== null && effects() === 1, 30_000);
  const epoch = chats.sessions.get(w.session_id)!.epoch;
  // The network goes; within the lease the turn stops here and says it goes on by itself once Caveman answers.
  cloud.state.unreachable = true;
  await until(
    async () => (await status()) === "idle" && notes("Lost the connection to Caveman") === 1,
    120_000,
  );
  // Then this Mac stops uncleanly, still offline (CHAOS-5: the note of journaled chats a clean stop removes, left).
  await mac.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  mac = await syncedMac(cloud, config);
  events = [];
  // The new epoch replays the journal from its start: what was seen before goes.
  await mac.client.attach(w.session_id, 0, (e) => events.push(e), {
    onReset: () => void (events = []),
  });
  cloud.state.unreachable = false;
  // Its own chat on its own computer: the new epoch is this computer's, so it still goes on.
  const shown = () =>
    JSON.stringify(
      events.slice(-10).map((e) => [e.cursor, e.type, JSON.stringify(e.payload).slice(0, 160)]),
    );
  await until(() => notes("Back online, continuing") === 1, 120_000).catch((error: Error) => {
    throw new Error(`${error.message}: ${shown()}`);
  });
  // Its continuation is under way: the note goes just before its turn is submitted, so the turn may start a moment
  // after it (failed 1 run in 3 at load 36-53 when read at once). (The stand-in's answer to a turn after an unclean
  // stop is a matter of its own: a person's send there waits on it too.)
  await until(async () => (await status()) === "working", 30_000);
  expect(chats.sessions.get(w.session_id)!.epoch).toBe(epoch + 1);
  expect(effects()).toBe(1);
  expect(notes("Didn't continue by itself")).toBe(0);
}, 360_000);

test("a copy that fails here before Cloud answers anything amiss stops a working chat at its lease as a stop, never as a lost connection: no offline note, nothing resumes (decision 26)", async () => {
  const { cloud, mac, chats, chat, status, notes, effects } = await offlineMac();
  const w = await chat("astray");
  // Cloud answers every call, but reads back a count no copy here matches: each copy of this chat fails here.
  chats.journalReadsAstray.set(w.session_id, 0);
  await mac.client.call("turn.submit", {
    request_id: "t-astray",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "cat: README.md astray hold 600000" },
  });
  await until(() => effects(w) === 1, 30_000);
  await until(async () => (await status(w)) === "idle", 120_000);
  expect(notes(w, "Lost the connection to Caveman")).toBe(0);
  // Cloud's count right again: nothing takes the stopped turn up by itself.
  chats.journalReadsAstray.delete(w.session_id);
  await new Promise((r) => setTimeout(r, 15_000));
  expect(notes(w, "Back online, continuing")).toBe(0);
  expect(w.events.filter((e) => e.type === "turn.started").length).toBe(1);
  expect(effects(w)).toBe(1);
  void cloud;
}, 300_000);

test("the lid never waits on a running turn's copy putting its files up over a slow uplink: it stops that upload, parks the working chat within its budget and hands it off with its files (decision 25)", async () => {
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
  const repo = makeRepo(tempRoot("sync-slow-mid-"), { "README.md": "slow\n" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/slow-mid.git"], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Slow uplink mid-turn",
    engine: "claude-agent",
    options: { model: MODEL, access: "full" },
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
  // A slow uplink: the copy that carries the running turn's files hangs on its way up.
  let open!: () => void;
  chats.midWipPutsHeld = { until: new Promise<void>((resolve) => (open = resolve)), waiting: 0 };
  cleanups.push(() => open());
  await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "create: late.txt changed-mid-turn hold 600000" },
  });
  await until(() => chats.midWipPutsHeld!.waiting > 0, 30_000);
  const out = await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
  expect(out.handed_off).toEqual([w.session_id]);
  // Stopped and parked while that upload still hangs: the lid did not wait on it for the chat's move lock.
  await until(() => events.some((e) => e.type === "session.parked"), 2_000);
  expect(events.findLast((e) => e.type === "session.parked")).toMatchObject({
    payload: { reason: "move", cause: "lid" },
  });
  // The lid's own last copy carries the files, and the chat goes to Cloud with them.
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: w.id })).computer.kind ===
      "caveman_cloud",
    60_000,
  );
  expect(chats.sessions.get(w.session_id)?.computer_id).toBe(box.computerId);
  const last = chats.sessions.get(w.session_id)!.segments.at(-1)!;
  expect(last.boundary).toBe(true);
  expect(last.body).toMatchObject({ interrupted: true });
  const wip = (last.body as { wip?: string }).wip!;
  expect(
    execFileSync("git", ["show", `${wip}:late.txt`], { cwd: w.root_path!, encoding: "utf8" }),
  ).toBe("changed-mid-turn\n");
}, 180_000);

test("a running turn's copy that does not land is made again with the turn's files, not without them (decision 25)", async () => {
  const { cloud, mac, chats, chat } = await offlineMac();
  const w = await chat("flaky");
  const midTurn = () =>
    (chats.sessions.get(w.session_id)?.segments ?? [])
      .map((s) => s.body as { boundary?: boolean; wip?: string; wip_at?: number })
      .filter((b) => b.boundary === false);
  // The copy that carries the turn's files meets a network that drops it, once.
  chats.midWipPutsDown = 503;
  await mac.client.call("turn.submit", {
    request_id: "t-flaky",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "create: late.txt changed-mid-turn hold 600000" },
  });
  await until(() => w.events.some((e) => e.type === "tool.done"), 30_000);
  const done = w.events.find((e) => e.type === "tool.done")!;
  await until(() => chats.midWipPutsDown === undefined, 15_000);
  // Made again within its retry, carrying the files the tool wrote.
  await until(() => midTurn().some((b) => (b.wip_at ?? 0) >= done.cursor), 15_000).catch(
    (error: Error) => {
      throw new Error(
        `${error.message}: ${JSON.stringify(midTurn().map((b) => [b.wip, b.wip_at]))}`,
      );
    },
  );
  const carried = midTurn().find((b) => (b.wip_at ?? 0) >= done.cursor)!;
  expect(
    execFileSync("git", ["show", `${carried.wip}:late.txt`], {
      cwd: w.root_path!,
      encoding: "utf8",
    }),
  ).toBe("changed-mid-turn\n");
  void cloud;
}, 120_000);
