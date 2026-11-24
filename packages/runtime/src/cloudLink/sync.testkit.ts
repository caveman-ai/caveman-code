// Sync end to end against the test Cloud (Caveman Cloud the spec, CONTRACT §1-§3): This Mac with sync on copies every
// engine's chat to Cloud as it runs and keeps its summary; a crash after a turn and before its upload catches up at the
// next start; an upload that fails is tried again and never dropped; a turn past Cloud's 8 MiB segment cap copies as
// several segments and later turns keep copying; a journal that lost its tail here is rebuilt from Cloud's copy under a
// new epoch, and keeps what this computer journaled since (the end of the turn the crash cut).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect } from "vitest";

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
import { startTestCloud } from "./testCloud.ts";

export const cleanups: Array<() => unknown> = [];

/** The route's own store (Store.layer is memoized), to journal as the runtime does. */
class Grab extends Context.Service<Grab, { readonly ok: true }>()("test/sync/Grab") {}

export const grabbing = () => {
  const box: { store?: Store.SessionStore["Service"] } = {};
  const layer = Layer.effect(
    Grab,
    Effect.gen(function* () {
      box.store = yield* Store.SessionStore;
      return Grab.of({ ok: true });
    }),
  ).pipe(Layer.provide(Store.layer)) as Layer.Layer<Grab>;
  return { box, layer };
};

/** This Mac, enrolled with the test Cloud, sync on. `alsoAs`: engines the stand-in CLI also serves (the Chief's Caveman engine). */
export async function syncedMac(
  cloud: Awaited<ReturnType<typeof startTestCloud>>,
  config: Awaited<ReturnType<typeof makeConfig>>,
  provide?: Layer.Layer<any, never, any>,
  alsoAs?: ReadonlyArray<"caveman">,
) {
  const runtime = await startRuntime(config, "fake-claude", undefined, {
    ...(provide ? { provide } : {}),
    ...(alsoAs ? { alsoAs } : {}),
  });
  const client = connect(runtime.url, runtime.token);
  return { runtime, client, close: async () => (client.close(), await runtime.close()) };
}

/** The Caveman engine's key store, for a runtime whose stand-in claude also serves the `caveman` instance (the Chief's). */
export const keyStore = () => TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

/**
 * The person's own Chief on This Mac, on the Caveman engine and a key of theirs: a project's default Chief, made by
 * chief.get, with its profile. A chat merely marked as a Chief is no Chief (a removed one's thread), and its turn never
 * starts.
 */
export async function homeChief(mac: Awaited<ReturnType<typeof syncedMac>>) {
  await mac.client.call("engine.account.add", {
    request_id: "chief-key",
    engine: "caveman",
    provider: "anthropic",
    key: "sk-" + "ant-lid-test-0123456789abcdef",
  });
  const project = await mac.client.call("project.create", {
    request_id: "chief-project",
    path: makeRepo(tempRoot("sync-chief-"), { "README.md": "chief\n" }),
    name: "chief-project",
  });
  const home = await mac.client.call("chief.get", { project_id: project.id });
  expect(home.availability).toBe("ready");
  return { id: home.workspace.id, session_id: home.workspace.session_id };
}

export const headOf = async (client: ReturnType<typeof connect>, workspaceId: string) =>
  (await client.call("workspace.get", { workspace_id: workspaceId })).head ?? -1;

/**
 * The lid (cloud.suspend), and whether its answer came at the end of its budget. A chat the lid tries to move is
 * answered with what became of it once that settled; one still moving when the budget runs out is answered as on its
 * way (`handed_off`) while the move goes on (handOne, K5), and a move's last copy (a 12 MiB snapshot among it) outlasts
 * any budget on a loaded machine. The lid's timers run on the event loop's millisecond clock, a few ms off Date.now().
 */
export async function suspend(mac: Awaited<ReturnType<typeof syncedMac>>, budgetMs: number) {
  const at = Date.now();
  const out = await mac.client.call("cloud.suspend", {
    request_id: `lid-${at}`,
    budget_ms: budgetMs,
  });
  return { out, late: Date.now() - at >= budgetMs - 50 };
}

/**
 * The lid's answer for a chat it tried to move and kept (its last copy refused the move, F-5, or a check did): paused, or
 * on its way when the lid answered at its budget's end, before that settled. Only then.
 */
export const keptAfterTrying = (lid: Awaited<ReturnType<typeof suspend>>, sessionId: string) =>
  lid.late && lid.out.handed_off.includes(sessionId) ? "handed_off" : "paused";

/** The journal in the runtime's database as it is, read from the file (the runtime may be down). */
export const journalOf = (dbPath: string, sessionId: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare("SELECT event FROM caveman_sp_events WHERE session_id = ? ORDER BY cursor")
        .all(sessionId) as Array<{ event: string }>
    ).map((row) => JSON.parse(row.event) as SessionEvent);
  } finally {
    db.close();
  }
};

export const shown = (events: ReadonlyArray<{ readonly cursor: number; readonly type: string }>) =>
  events.map((e) => `${e.cursor}:${e.type}`).join(" ");

/**
 * A synced chat cut mid-turn by an OS crash that ate the journal's last `cut` commits, which Cloud's copy holds. The Mac
 * comes back before its network does, so upstream recovery ends the cut turn in the journal while the chat waits for its
 * copy to be checked (X-4); then Cloud answers.
 */
export async function crashMidTurn(cut: number) {
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
  const repo = makeRepo(tempRoot("sync-cut-"), { "README.md": "hello\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Cut mid-turn",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  // A long turn: the engine answers, then holds its result (the turn is still running).
  const answer = await mac.client.call("turn.submit", {
    request_id: "t1",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 120000: a turn the crash cuts" },
  });
  await until(
    () =>
      events.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "assistant" &&
          e.turn_id === answer.turn_id,
      ),
    60_000,
  );
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  await mac.close();
  const copied = chats.copyOf(w.session_id).map((e) => ({ cursor: e.cursor, type: e.type }));
  // An OS crash ate the journal's last `cut` commits (synchronous=NORMAL); nothing ended the turn.
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    head - cut,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(head - cut, w.session_id);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  chats.down.journal = 503;
  const runtime = await startRuntime(config, "fake-claude", undefined, { recoverOnStartup: true });
  const client = connect(runtime.url, runtime.token);
  mac = { runtime, client, close: async () => (client.close(), await runtime.close()) };
  const ended = (journal: ReadonlyArray<SessionEvent>) =>
    journal.filter((e) => e.type === "turn.done" && e.turn_id === answer.turn_id);
  await until(() => ended(journalOf(config.dbPath, w.session_id)).length === 1, 30_000);
  // Network back: the chat's copy is checked.
  delete chats.down.journal;
  await until(
    async () => (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch === 2,
    30_000,
  );
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  ).catch(() => undefined);
  const journal = journalOf(config.dbPath, w.session_id);
  return { copied, ended: ended(journal), journal, copy: chats.copyOf(w.session_id) };
}

/**
 * A synced chat with no copy counted here (another sign-in forgets the counts, not Cloud's copy) whose journal an OS
 * crash cut back by its last two turns, which Cloud's copy holds: it takes epoch 2 here at once, and one more turn
 * journals over some of the cursors the crash ate while Cloud cannot be reached, so its journal still ends before Cloud's
 * copy does. Then Cloud answers; `gated`, Cloud holds each new epoch it gives until a check for moved chats has read
 * Cloud's copy as it stood before (it runs every 3 s while a chat is held).
 */
export async function cutBehindOlderCopy(options: { readonly gated?: boolean } = {}) {
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
  const repo = makeRepo(tempRoot("sync-cut-back-"), { "README.md": "cut back\n" });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: "Cut back",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, 0, (e) => events.push(e));
  for (const [i, text] of ["the first turn", "the second turn", "the third turn"].entries()) {
    await mac.client.call("turn.submit", {
      request_id: `t${i}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text },
    });
    await until(() => events.filter((e) => e.type === "turn.done").length === i + 1, 60_000);
  }
  const chats = cloud.state.chats;
  await until(
    async () =>
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)),
    30_000,
  );
  const head = await headOf(mac.client, w.id);
  const kept = events.find((e) => e.type === "turn.done")!.cursor;
  await mac.close();
  const copied = journalOf(config.dbPath, w.session_id);
  const db = new DatabaseSync(config.dbPath);
  db.prepare("DELETE FROM caveman_sp_kv WHERE key = ?").run(`moves:${w.session_id}`);
  db.prepare("DELETE FROM caveman_sp_events WHERE session_id = ? AND cursor > ?").run(
    w.session_id,
    kept,
  );
  db.prepare(
    "UPDATE caveman_sp_workspaces SET session = json_set(session, '$.head', ?) WHERE session_id = ?",
  ).run(kept, w.session_id);
  db.close();
  fs.writeFileSync(`${config.dbPath}.journaled`, `${w.session_id}\n`);
  chats.down.journal = 503;
  mac = await syncedMac(cloud, config);
  expect((await mac.client.call("workspace.get", { workspace_id: w.id })).epoch).toBe(2);
  const later: Array<SessionEvent> = [];
  await mac.client.attach(w.session_id, kept, (e) => later.push(e), { epoch: 2 });
  await mac.client.call("turn.submit", {
    request_id: "t3",
    session_id: w.session_id,
    kind: "followup",
    input: { text: "after the crash" },
  });
  await until(() => later.some((e) => e.type === "turn.done"), 60_000);
  const ours = journalOf(config.dbPath, w.session_id).slice(kept);
  expect(kept + ours.length).toBeLessThan(head);
  let release = () => {};
  if (options.gated) {
    chats.epochGate = new Promise<void>((resolve) => (release = resolve));
    cleanups.push(async () => release());
  }
  delete chats.down.journal;
  if (options.gated) {
    // The copy found where the journal parts from Cloud's copy: the chat is held from there while it waits for its epoch.
    const held = () => {
      const kv = new DatabaseSync(config.dbPath);
      try {
        return (
          kv
            .prepare("SELECT 1 FROM caveman_sp_kv WHERE key = ?")
            .get(`moves:${w.session_id}:unchecked`) !== undefined
        );
      } finally {
        kv.close();
      }
    };
    await until(held, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    release();
  }
  await until(async () => {
    const journal = journalOf(config.dbPath, w.session_id);
    return (
      journal.length === head + ours.length &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === journal.length
    );
  }, 60_000).catch(() => undefined);
  // Every pass that could still rebuild it has had its turn.
  await new Promise((resolve) => setTimeout(resolve, options.gated ? 4_000 : 0));
  return {
    copied,
    ours,
    head,
    journal: journalOf(config.dbPath, w.session_id),
    copy: chats.copyOf(w.session_id),
    epoch: (await mac.client.call("workspace.get", { workspace_id: w.id })).epoch,
    cloudEpoch: chats.sessions.get(w.session_id)!.epoch,
  };
}

export const sameAt = (
  journal: ReadonlyArray<{ readonly cursor: number; readonly type: string; readonly at: string }>,
) => journal.map((e) => `${e.cursor}:${e.type}:${e.at}`);

/** A chat on This Mac, synced and registered to move, with its first copy in Cloud. */
export async function movableChat(
  cloud: Awaited<ReturnType<typeof startTestCloud>>,
  mac: Awaited<ReturnType<typeof syncedMac>>,
  name: string,
  access?: "ask",
) {
  await mac.client.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  cloud.state.environments.computers = true;
  await mac.client.call("settings.set", { request_id: "s1", settings: { sync_chats: true } });
  const repo = makeRepo(tempRoot(`sync-${name}-`), { "README.md": `${name}\n` });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
    cwd: repo,
  });
  const w = await createReady(mac.client, {
    request_id: "w1",
    repo: { path: repo },
    title: name,
    engine: "claude-agent",
    options: { model: MODEL, ...(access ? { access } : {}) },
  });
  const chats = cloud.state.chats;
  await until(
    async () =>
      chats.sessions.get(w.session_id)?.movable_flag === true &&
      (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf(mac.client, w.id)) &&
      chats.sessions.get(w.session_id)!.lease === null,
    30_000,
  );
  return w;
}

/** Cloud moves the chat off This Mac from its copy, as for a send while the Mac sleeps: the Mac looked gone, its lease lapsed. */
export async function cloudMovesIt(
  cloud: Awaited<ReturnType<typeof startTestCloud>>,
  sessionId: string,
) {
  const session = cloud.state.chats.sessions.get(sessionId)!;
  const from = session.computer_id;
  for (const r of cloud.state.chats.link?.runtimesOf(from) ?? [])
    cloud.state.chats.lastHeartbeat.delete(r);
  if (session.lease) session.lease.expires_at = 0;
  const response = await fetch(`${cloud.url}/api/v1/code/chats/${sessionId}/move`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cloud.state.personToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: "cloud" }),
  });
  expect(response.status).toBeLessThan(300);
  await until(() => cloud.state.chats.sessions.get(sessionId)!.computer_id !== from, 10_000);
}

/** The person's own call to Cloud's API, as their device makes it. */
export async function personCall(
  cloud: Awaited<ReturnType<typeof startTestCloud>>,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${cloud.url}/api/v1/code/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cloud.state.personToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, any>;
}

/**
 * Chats working on This Mac, the lid, and what each chat then says of why it stays: its "Paused when the lid closed"
 * note, or the reason a move it tried came back with. Read once each has said it and reads idle: a check the lid's budget
 * cut leaves the chat to the handoff's own refusal (lidMove), past the lid's answer (`late`).
 */
export async function lidNotes(
  mac: Awaited<ReturnType<typeof syncedMac>>,
  chats: ReadonlyArray<{ readonly id: string; readonly session_id: string }>,
) {
  for (const w of chats)
    await mac.client.call("turn.submit", {
      request_id: `slow-${w.id}-${Date.now()}`,
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 60000: working as the lid closes" },
    });
  await until(
    async () =>
      (
        await Promise.all(
          chats.map((w) => mac.client.call("workspace.get", { workspace_id: w.id })),
        )
      ).every((r) => r.status === "working"),
    30_000,
  );
  const lid = await suspend(mac, 5_000);
  const said = new Map<string, Array<string>>();
  for (const w of chats) {
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
    await until(
      async () =>
        why().length > 0 &&
        (await mac.client.call("workspace.get", { workspace_id: w.id })).status === "idle",
      60_000,
    );
    const head = await headOf(mac.client, w.id);
    await until(() => (events.at(-1)?.cursor ?? 0) >= head, 10_000);
    await sub.detach();
    said.set(w.session_id, why());
  }
  return { ...lid, said };
}

/** This Mac, enrolled, sync and moves on, with Claude Agent chats that move (`chat`), as the decision 26 tests use them. */
export async function offlineMac(provide?: Layer.Layer<any, never, any>) {
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const mac = await syncedMac(cloud, await makeConfig(), provide);
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
    const repo = makeRepo(tempRoot(`sync-lease-${name}-`), { "README.md": `${name}\n` });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/lease-${name}.git`], {
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
  return { cloud, mac, chats, chat, status, notes, effects };
}

/** Closes what each test started (its clouds, runtimes and folders), last first, when it ends. */
export function closeEachTestsRuntimes() {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
}
