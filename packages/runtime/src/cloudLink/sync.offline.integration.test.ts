// Sync without a network or an answer (sync.testkit.ts): a working chat parks when the network goes or Cloud takes calls
// and answers none, stops within its journal lease, and resumes by itself once Cloud answers.
import { execFileSync } from "node:child_process";

import { type SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  tempRoot,
  until,
} from "../session-protocol/testHarness.ts";
import { cleanups, closeEachTestsRuntimes, offlineMac, syncedMac } from "./sync.testkit.ts";
import { startTestCloud } from "./testCloud.ts";

closeEachTestsRuntimes();

test("losing the network parks a working chat and never archives it: its own chat resumes by itself on reconnect at an unchanged epoch, its tool never run twice; one moved meanwhile parks as moved, one the person spoke in and one the lid paused stay as they are (decision 26)", async () => {
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
  const elsewhere = cloud.enrollRuntime({ kind: "cloud" });
  const chats = cloud.state.chats;
  const chat = async (name: string) => {
    const repo = makeRepo(tempRoot(`sync-offline-${name}-`), { "README.md": `${name}\n` });
    execFileSync(
      "git",
      ["remote", "add", "origin", `https://github.com/acme/offline-${name}.git`],
      { cwd: repo },
    );
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
  const status = async (w: { readonly id: string }) =>
    (await mac.client.call("workspace.get", { workspace_id: w.id })).status;
  const notes = (w: { readonly events: ReadonlyArray<SessionEvent> }, title: string) =>
    w.events.filter((e) => e.type === "notification" && e.payload.title === title).length;
  // Its one effect: the tool its turn ran (the stand-in's Bash cat of its README), counted as it started.
  const effects = (w: { readonly events: ReadonlyArray<SessionEvent> }) =>
    w.events.filter(
      (e) => e.type === "tool.started" && JSON.stringify(e.payload).includes("cat README.md"),
    ).length;
  const [own, moved, spoken, lid] = [
    await chat("own"),
    await chat("moved"),
    await chat("spoken"),
    await chat("lid"),
  ];
  // Each starts a turn that runs a tool (its one effect), then works on; each holds its journal lease.
  for (const w of [own, moved, spoken])
    await mac.client.call("turn.submit", {
      request_id: `t-${w.id}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text: `cat: README.md ${w.title} hold 600000` },
    });
  await until(
    async () =>
      [own, moved, spoken].every(
        (w) => chats.sessions.get(w.session_id)?.lease !== null && effects(w) === 1,
      ),
    30_000,
  ).catch((error: Error) => {
    throw new Error(
      `${error.message}: ${JSON.stringify([own, moved, spoken].map((w) => [w.title, chats.sessions.get(w.session_id)?.lease ?? null, effects(w), w.events.slice(-6).map((e) => [e.type, JSON.stringify(e.payload).slice(0, 100)])]))}`,
    );
  });
  for (const w of [own, moved, spoken]) expect(await status(w)).toBe("working");
  const epochs = new Map(
    [own, moved, spoken].map((w) => [w.session_id, chats.sessions.get(w.session_id)!.epoch]),
  );
  // The network goes. Within the lease the turns stop here, so none runs on two computers, and each says why.
  cloud.state.unreachable = true;
  await until(
    async () => (await Promise.all([own, moved, spoken].map(status))).every((s) => s === "idle"),
    120_000,
  );
  for (const w of [own, moved, spoken]) expect(notes(w, "Lost the connection to Caveman")).toBe(1);
  // Meanwhile: the person moved one to a Cloud computer (Cloud's copy takes a new epoch there), and spoke in another here.
  const m = chats.sessions.get(moved.session_id)!;
  m.computer_id = elsewhere.computerId;
  m.epoch += 1;
  m.lease = null;
  await mac.client.call("turn.submit", {
    request_id: "t-spoken-2",
    session_id: spoken.session_id,
    kind: "followup",
    input: { text: "a word while offline" },
  });
  await until(
    async () =>
      spoken.events.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "assistant" &&
          /a word while offline/.test(e.payload.text),
      ) && (await status(spoken)) === "idle",
    30_000,
  );
 // The lid closes with no network on a fourth chat: it pauses, and stays paused.
  await mac.client.call("turn.submit", {
    request_id: "t-lid",
    session_id: lid.session_id,
    kind: "followup",
    input: { text: "slow 600000: working as the lid closes" },
  });
  await until(async () => (await status(lid)) === "working", 30_000);
  await mac.client.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
  await until(async () => (await status(lid)) === "idle", 30_000);
  expect(notes(lid, "Paused when the lid closed")).toBe(1);
  // Back online.
  cloud.state.unreachable = false;
  await until(() => notes(own, "Back online, continuing") === 1, 60_000);
  await until(
    async () =>
      own.events.filter((e) => e.type === "turn.done").length >= 2 &&
      (await status(own)) === "idle",
    60_000,
  );
  // Its own chat: the same epoch, its tool run once, told what ran before the stop, never archived.
  expect(chats.sessions.get(own.session_id)!.epoch).toBe(epochs.get(own.session_id));
  expect(effects(own)).toBe(1);
  const continued = own.events
    .filter((e) => e.type === "message.done" && e.payload.role === "user")
    .at(-1)!;
  expect(continued.type === "message.done" && continued.payload.text).toMatch(
    /lost its connection to Caveman[\s\S]*already ran before it stopped/,
  );
  expect(
    own.events.filter((e) => e.type === "message.done" && e.payload.role === "user").length,
  ).toBe(2);
  // Moved meanwhile: parked as moved, not resumed, not archived.
  await until(
    async () =>
      (await mac.client.call("workspace.get", { workspace_id: moved.id })).status === "parked",
    30_000,
  );
  expect(notes(moved, "Back online, continuing")).toBe(0);
  // Spoken in, and paused by the lid: as they are.
  await new Promise((r) => setTimeout(r, 8_000));
  expect(notes(spoken, "Back online, continuing")).toBe(0);
  expect(notes(lid, "Back online, continuing")).toBe(0);
  expect(await status(lid)).toBe("idle");
  for (const w of [own, moved, spoken, lid]) {
    expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).not.toBe(
      "archived",
    );
    expect(chats.summaries.get(w.session_id)?.status).not.toBe("archived");
  }
}, 420_000);

test("Caveman taking calls and answering none (its database paused) still stops each working chat within its lease, and once it answers they resume by themselves at an unchanged epoch, each tool run once (decision 26)", async () => {
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
    const repo = makeRepo(tempRoot(`sync-paused-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/paused-${name}.git`], {
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
  const status = async (w: { readonly id: string }) =>
    (await mac.client.call("workspace.get", { workspace_id: w.id })).status;
  const notes = (w: { readonly events: ReadonlyArray<SessionEvent> }, title: string) =>
    w.events.filter((e) => e.type === "notification" && e.payload.title === title).length;
  const effects = (w: { readonly events: ReadonlyArray<SessionEvent> }) =>
    w.events.filter(
      (e) => e.type === "tool.started" && JSON.stringify(e.payload).includes("cat README.md"),
    ).length;
  const both = [await chat("one"), await chat("two")];
  for (const w of both)
    await mac.client.call("turn.submit", {
      request_id: `t-${w.id}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text: `cat: README.md ${w.title} hold 600000` },
    });
  await until(
    async () =>
      both.every((w) => chats.sessions.get(w.session_id)?.lease !== null && effects(w) === 1),
    30_000,
  );
  const epochs = new Map(both.map((w) => [w.session_id, chats.sessions.get(w.session_id)!.epoch]));
  // Its database pauses: Cloud takes every call and answers none, so no renewal fails, and none succeeds either.
  cloud.state.paused = true;
  const paused = Date.now();
  await until(
    async () => (await Promise.all(both.map(status))).every((s) => s === "idle"),
    120_000,
  ).finally(() => {
    // Whatever happens, Cloud answers again before the next step (the held calls then complete).
    if (Date.now() - paused >= 120_000) cloud.state.paused = false;
  });
  // Within the lease Cloud last renewed (90 s, renewed by the pause at the latest): a turn never runs on two computers.
  expect(Date.now() - paused).toBeLessThan(90_000);
  for (const w of both) expect(notes(w, "Lost the connection to Caveman")).toBe(1);
  cloud.state.paused = false;
  for (const w of both) {
    await until(() => notes(w, "Back online, continuing") === 1, 90_000);
    await until(
      async () =>
        w.events.filter((e) => e.type === "turn.done").length >= 2 && (await status(w)) === "idle",
      60_000,
    );
    expect(chats.sessions.get(w.session_id)!.epoch).toBe(epochs.get(w.session_id));
    expect(effects(w)).toBe(1);
    expect(notes(w, "Lost the connection to Caveman")).toBe(1);
    expect((await mac.client.call("workspace.get", { workspace_id: w.id })).status).not.toBe(
      "archived",
    );
  }
}, 420_000);

test("a chat whose journal calls Cloud takes and never answers stops within its lease, while another working chat, however quiet, keeps its lease and runs on (decision 26)", async () => {
  const { cloud, mac, chats, chat, status, notes, effects } = await offlineMac();
  const [stuck, quiet] = [await chat("stuck"), await chat("quiet")];
  for (const w of [stuck, quiet])
    await mac.client.call("turn.submit", {
      request_id: `t-${w.id}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text: `cat: README.md ${w.title} hold 600000` },
    });
  await until(
    async () =>
      [stuck, quiet].every(
        (w) => chats.sessions.get(w.session_id)?.lease !== null && effects(w) === 1,
      ),
    30_000,
  );
  // One chat's journal calls go into a route that takes them and never answers; the other's turn journals nothing more.
  cloud.state.stalled.push(`/runtime/sessions/${stuck.session_id}/journal`);
  const stalledAt = Date.now();
  const renewedBefore = chats.sessions.get(quiet.session_id)!.lease!.expires_at;
  await until(async () => (await status(stuck)) === "idle", 120_000);
  // Within its lease (90 s at most since its last renewal).
  expect(Date.now() - stalledAt).toBeLessThan(90_000);
  expect(notes(stuck, "Lost the connection to Caveman")).toBe(1);
  // Past where a stop by the lease's age alone would have come: the quiet chat renewed and works on.
  await until(() => Date.now() - stalledAt > 75_000, 90_000);
  expect(await status(quiet)).toBe("working");
  expect(notes(quiet, "Lost the connection to Caveman")).toBe(0);
  expect(chats.sessions.get(quiet.session_id)!.lease!.expires_at > renewedBefore).toBe(true);
  expect(effects(quiet)).toBe(1);
}, 300_000);

test("a network that takes calls and never answers them (Wi-Fi gone mid-request) parks a working chat, holding what was queued behind it; once calls answer, the chat resumes within one call's time, then its queued follow-up runs (decision 26)", async () => {
  const { cloud, mac, chats, chat, status, notes, effects } = await offlineMac();
  const w = await chat("dropped");
  await mac.client.call("turn.submit", {
    request_id: "t-dropped",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "cat: README.md dropped hold 600000" },
  });
  await until(() => chats.sessions.get(w.session_id)?.lease !== null && effects(w) === 1, 30_000);
  const queued = await mac.client.call("turn.submit", {
    request_id: "t-queued",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "queued before the network went" },
  });
  expect(queued.disposition).toBe("queued");
  const epoch = chats.sessions.get(w.session_id)!.epoch;
  // Every call is taken and never answered: nothing fails fast.
  cloud.state.stalled.push("");
  await until(
    async () => (await status(w)) === "idle" && notes(w, "Lost the connection to Caveman") === 1,
    120_000,
  );
  // Parked: the follow-up queued behind it does not start here unleased.
  await new Promise((r) => setTimeout(r, 15_000));
  const started = () => w.events.filter((e) => e.type === "turn.started").length;
  expect(started()).toBe(1);
  expect(await status(w)).toBe("idle");
  // The network is back; calls still hung on it give up within their own time (JOURNAL_CALL_MS).
  cloud.state.stalled.splice(0);
  const back = Date.now();
  await until(() => notes(w, "Back online, continuing") === 1, 120_000);
  const resumedIn = Date.now() - back;
  console.log(`decision 26: resumed ${resumedIn} ms after calls answered again (lab-only)`);
  expect(resumedIn).toBeLessThan(75_000);
  // The continuation, then the follow-up, in that order; the tool ran once; the epoch never changed.
  await until(
    () =>
      w.events.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "assistant" &&
          /queued before the network went/.test(e.payload.text),
      ),
    60_000,
  ).catch((error: Error) => {
    throw new Error(
      `${error.message}: ${JSON.stringify(w.events.slice(-14).map((e) => [e.cursor, e.type, JSON.stringify(e.payload).slice(0, 140)]))}`,
    );
  });
  const users = w.events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : [],
  );
  const continued = users.findIndex((text) => /lost its connection to Caveman/.test(text));
  expect(continued).toBeGreaterThan(0);
  expect(users.findIndex((text) => text === "queued before the network went")).toBeGreaterThan(
    continued,
  );
  expect(effects(w)).toBe(1);
  expect(chats.sessions.get(w.session_id)!.epoch).toBe(epoch);
}, 360_000);
