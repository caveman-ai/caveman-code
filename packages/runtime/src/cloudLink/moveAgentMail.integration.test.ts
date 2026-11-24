// An agent's message (a mail's wake) for a chat that is moving or moved goes with it, once, and as the agent's.
// The move's copies carry what is owed to the chat, matched by request id; a chat that
// comes back after its move did not go runs it once; one on another Mac is told it was not sent, since a Mac runs no
// message passed on to it without a device's signature; and what the chat took in after the copy Cloud moved it from is
// handed on as the agent's, in its kind. Against the test Cloud, the runtime in-process on the stand-in claude.
import { execFileSync } from "node:child_process";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { handedOnAgent } from "../session-protocol/handlers.ts";
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

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A park waits for what its turn owes the journal while `parking.held` is pending; `parking.waiting` counts those waits. */
const parking = { held: Promise.resolve(), waiting: 0 };
const holdingParks = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const real = yield* Orchestrator.OrchestratorV2;
    return Orchestrator.OrchestratorV2.of({
      ...real,
      awaitOwedCheckpoints: (threadId, runIds) =>
        Effect.sync(() => parking.waiting++).pipe(
          Effect.andThen(Effect.promise(() => parking.held)),
          Effect.andThen(real.awaitOwedCheckpoints(threadId, runIds)),
        ),
    });
  }),
);

/** This Mac, enrolled with sync on, a Cloud computer to move to, and a target chat and a sender chat on one repository. */
const setUp = async (
  name: string,
  settings: Record<string, boolean> = {},
  options: { readonly holdParks?: boolean; readonly access?: "ask" } = {},
) => {
  parking.held = Promise.resolve();
  parking.waiting = 0;
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(
    await makeConfig(),
    "fake-claude",
    undefined,
    options.holdParks ? { provide: holdingParks } : undefined,
  );
  cleanups.push(runtime.close);
  const mac = connect(runtime.url, runtime.token);
  cleanups.push(() => mac.close());
  await mac.call("cloud.enroll", {
    request_id: "e1",
    cloud_url: cloud.url,
    token: cloud.state.personToken,
    name: "Test Mac",
  });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true, ...settings } });
  cloud.state.environments.computers = true;
  cloud.state.chats.engineLogins.set("user-1", {
    "claude-agent": { vault_key: true, signed_in_on: [] },
  });
  const box = cloud.enrollRuntime({ kind: "cloud" });
  const repo = makeRepo(tempRoot(`${name}-`), { "README.md": `${name}\n` });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
    cwd: repo,
  });
  const w = await createReady(mac, {
    request_id: "w1",
    repo: { path: repo },
    title: "Target",
    engine: "claude-agent",
    options: { model: MODEL, ...(options.access ? { access: options.access } : {}) },
  });
  const s = await createReady(mac, {
    request_id: "w2",
    repo: { path: repo },
    title: "Sender",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.summaries.has(w.session_id), 20_000);
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  /** The calls this runtime handed on to the chat where it is now. */
  const handedOn = () =>
    [...chats.calls.values()].filter(
      (c) => c.session_id === w.session_id && c.forwarded_by_runtime_id !== undefined,
    );
  const textOf = (call: { readonly params: unknown }) =>
    (call.params as { input: { text: string } }).input.text;
  const mailText = (body: string) => `[task from workspace "Sender" (${s.id})]\n\n${body}`;
  return { cloud, runtime, chats, mac, box, w, s, events, handedOn, textOf, mailText };
};

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux (as moveOwed).
test.skipIf(process.platform === "win32")(
  "an agent's message owed to a moved chat is handed on though its words match a message the move's last copy carried",
  { timeout: 240_000 },
  async () => {
    const { chats, mac, box, w, s, events, handedOn, textOf, mailText } = await setUp("owed-same");
    await mac.call("turn.submit", {
      request_id: "t1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "remember theta" },
    });
    await until(() => events.some((e) => e.type === "turn.done"), 60_000);
    // A long turn, and the sender's mail queued behind it.
    await mac.call("turn.submit", {
      request_id: "t2",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 60000: working as mail comes" },
    });
    await until(() => events.filter((e) => e.type === "turn.started").length === 2, 30_000);
    await mac.call("mail.task", {
      request_id: "m1",
      session_id: s.session_id,
      to_workspace_id: w.id,
      body: "Run the tests.",
    });
    await until(
      async () => (await mac.call("queue.list", { session_id: w.session_id })).turns.length === 1,
      30_000,
    );
    // The person moves it: the park stops the turn, and the last copy carries the queued wake.
    await mac.call("session.move", {
      request_id: "mv",
      session_id: w.session_id,
      to: { computer_id: box.computerId },
    });
    await until(
      async () =>
        (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "caveman_cloud",
      60_000,
    );
    // The sender mails the same words again once the chat moved, then other words: both owed, both handed on.
    await mac.call("mail.task", {
      request_id: "m2",
      session_id: s.session_id,
      to_workspace_id: w.id,
      body: "Run the tests.",
    });
    await mac.call("mail.task", {
      request_id: "m3",
      session_id: s.session_id,
      to_workspace_id: w.id,
      body: "Control: other words.",
    });
    await until(
      () => handedOn().some((c) => textOf(c) === mailText("Control: other words.")),
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(handedOn().map(textOf).sort()).toEqual(
      [mailText("Control: other words."), mailText("Run the tests.")].sort(),
    );
    // Each as the sender's, never the person's.
    expect(handedOn().map((c) => handedOnAgent(Store.forwardedOf(c.request_id) ?? ""))).toEqual([
      "Sender",
      "Sender",
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "an agent's message a lid move carried runs once on the Mac when the chat is handed back to it",
  { timeout: 240_000 },
  async () => {
    const { chats, mac, w, s, events, mailText } = await setUp(
      "owed-back",
      { move_to_cloud: true },
      { holdParks: true },
    );
    await until(
      () =>
        chats.sessions.get(w.session_id)?.movable_flag === true &&
        (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
      30_000,
    );
    // The lid's check never reserves a target (Cloud slow to answer it): Cloud answers the handoff pending, its Cloud
    // computer accepts and then fails the adopt, and Cloud hands the chat back here under the pending move's id.
    chats.delay.check = 10_000;
    chats.handoffPendingMs = 3_000;
    chats.handoffPendingFails = {
      code: "cave_code_adopt_failed",
      message: "the computer's disk is full",
    };
    await mac.call("turn.submit", {
      request_id: "t1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 60000: working as the lid closes" },
    });
    await until(
      async () => (await mac.call("workspace.get", { workspace_id: w.id })).status === "working",
      15_000,
    );
    // The lid's park waits for what the stopped turn owes the journal; the sender's mail reaches the chat meanwhile, so
    // the park refuses its wake and the move's last copy carries it.
    let release = () => {};
    parking.held = new Promise<void>((resolve) => (release = resolve));
    const suspended = mac.call("cloud.suspend", { request_id: "lid-1", budget_ms: 2_000 });
    await until(() => parking.waiting > 0, 30_000);
    await mac.call("mail.task", {
      request_id: "m1",
      session_id: s.session_id,
      to_workspace_id: w.id,
      body: "Run the tests.",
    });
    release();
    expect(await suspended).toMatchObject({ handed_off: [w.session_id] });
    delete chats.delay.check;
    // The lid's budget went on the check, so its last copy is made once the Mac is awake: it carries the wake.
    const carried = () =>
      chats.sessions
        .get(w.session_id)!
        .segments.flatMap(
          (segment) =>
            (segment.body as { queued_items?: ReadonlyArray<{ text: string; from?: string }> })
              .queued_items ?? [],
        )
        .map((item) => [item.text, item.from]);
    await until(() => carried().length > 0, 60_000);
    expect(carried()).toEqual([[mailText("Run the tests."), "Sender"]]);
    // Handed back: live here again, saying why.
    await until(async () => {
      const here = await mac.call("workspace.get", { workspace_id: w.id });
      return here.computer.kind === "this_mac" && here.status !== "parked";
    }, 60_000);
    await until(
      () =>
        events.some(
          (e) => e.type === "notification" && e.payload.title === "Back on this computer",
        ),
      30_000,
    );
    const ran = () =>
      events.filter(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "user" &&
          e.payload.text === mailText("Run the tests."),
      );
    await until(() => ran().length > 0, 60_000);
    // The moves pass settles what is still owed to the chat a few seconds later: nothing, as its copy carried it.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect(ran().map((e) => (e.type === "message.done" ? e.payload.from : undefined))).toEqual([
      { title: "Sender", agent: true },
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "an agent's message for a chat that moved to another Mac is noted here as not sent, never handed on",
  { timeout: 240_000 },
  async () => {
    const { cloud, chats, mac, w, s, events, handedOn } = await setUp("owed-mac");
    // Another of the person's Macs, up (its heartbeat fresh), which accepts the move.
    const other = cloud.enrollRuntime({ kind: "laptop", name: "Mac B" });
    chats.lastHeartbeat.set(other.runtimeId, Date.now() + 60 * 60_000);
    await until(
      () =>
        chats.sessions.get(w.session_id)?.movable_flag === true &&
        (chats.sessions.get(w.session_id)?.segments.length ?? 0) > 0,
      30_000,
    );
    const moved = mac.call("session.move", {
      request_id: "mv",
      session_id: w.session_id,
      to: { computer_id: other.computerId },
    });
    await until(
      () =>
        [...chats.moves.values()].some(
          (m) => m.session_id === w.session_id && m.target === other.computerId,
        ),
      30_000,
    );
    const offered = [...chats.moves.values()].find(
      (m) => m.session_id === w.session_id && m.target === other.computerId,
    )!;
    const answered = await fetch(`${cloud.url}/api/v1/code/runtime/moves/${offered.move_id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "accept", ok: true }),
    });
    expect(answered.status).toBe(204);
    await moved;
    const there = await mac.call("workspace.get", { workspace_id: w.id });
    expect([there.computer.kind, there.computer.id]).toEqual(["this_mac", other.computerId]);
    // Mail for it now: Mac B would refuse it as unsigned, so it is said here, on the chat it left, as not sent.
    await mac.call("mail.task", {
      request_id: "m1",
      session_id: s.session_id,
      to_workspace_id: w.id,
      body: "Run the tests.",
    });
    const notSent = () =>
      events.flatMap((e) =>
        e.type === "notification" && e.payload.title === "Not sent" ? [e.payload.body ?? ""] : [],
      );
    await until(() => notSent().length > 0 || handedOn().length > 0, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect({ handedOn: handedOn().length, notSent: notSent().length }).toEqual({
      handedOn: 0,
      notSent: 1,
    });
    expect(notSent()[0]).toContain("Sender's message \"[task from workspace");
    expect(notSent()[0]).toContain("Mac B");
  },
);

test.skipIf(process.platform === "win32")(
  "what a chat took in after the copy Cloud moved it from is handed on in its kind, an agent's as the agent's",
  { timeout: 240_000 },
  async () => {
    const { cloud, chats, mac, w, s, events, handedOn, textOf, mailText } = await setUp(
      "after-copy",
      {},
      { access: "ask" },
    );
    const headOf = async () => (await mac.call("workspace.get", { workspace_id: w.id })).head ?? -1;
    await until(
      async () =>
        chats.sessions.get(w.session_id)?.movable_flag === true &&
        (chats.copyOf(w.session_id).at(-1)?.cursor ?? 0) === (await headOf()) &&
        chats.sessions.get(w.session_id)!.lease === null,
      30_000,
    );
    // Nothing more reaches Cloud's copy.
    chats.down.journal = 503;
    await mac.call("turn.submit", {
      request_id: "t-long",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "ask: may I run it" },
    });
    await until(() => events.some((e) => e.type === "ask.user"), 20_000);
    // Queued behind the waiting turn: the sender's mail (a follow-up), and the person's message for later.
    await mac.call("mail.task", {
      request_id: "m1",
      session_id: s.session_id,
      to_workspace_id: w.id,
      body: "An agent's words.",
    });
    await mac.call("turn.submit", {
      request_id: "t-later",
      session_id: w.session_id,
      kind: "queue",
      input: { text: "the person's, for later" },
    });
    await until(
      async () => (await mac.call("queue.list", { session_id: w.session_id })).turns.length === 2,
      20_000,
    );
    // Cloud moves it from its copy (the Mac looked gone).
    const session = chats.sessions.get(w.session_id)!;
    for (const r of chats.link?.runtimesOf(session.computer_id) ?? [])
      chats.lastHeartbeat.delete(r);
    if (session.lease) session.lease.expires_at = 0;
    const response = await fetch(`${cloud.url}/api/v1/code/chats/${w.session_id}/move`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cloud.state.personToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: "cloud" }),
    });
    expect(response.status).toBeLessThan(300);
    delete chats.down.journal;
    await until(() => handedOn().length >= 3, 60_000);
    const rows = handedOn().map((c) => ({
      text: textOf(c),
      kind: (c.params as { kind?: string }).kind,
      agent: handedOnAgent(Store.forwardedOf(c.request_id) ?? "") ?? null,
    }));
    expect(rows.filter((r) => r.text !== "ask: may I run it")).toEqual([
      { text: mailText("An agent's words."), kind: "followup", agent: "Sender" },
      { text: "the person's, for later", kind: "queue", agent: null },
    ]);
  },
);
