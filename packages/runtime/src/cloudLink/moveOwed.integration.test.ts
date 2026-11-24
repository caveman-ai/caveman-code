// A move parks the chat only once the turn it parks has written all it owes the chat's history (its checkpoint and
// diff come after its end): what is not there yet stays on the computer the chat leaves, past the move's last copy. T3
// unable to say what is owed is no answer either: the checkpoint may still be on its way, so a move waits for it as it
// does for one T3 is still writing, and goes when it can. The lid does not wait: it keeps the chat here, paused, and
// says why truly. Against the test Cloud, the runtime in-process on the stand-in claude; the route's T3 answers what is
// owed as the test says (a capture that never settles, or a read that fails).
import { execFileSync } from "node:child_process";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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

/**
 * What T3 answers for what runs owe: as it is, never while `stuck`, or a failed read while `unreadable`; and the chat's
 * thread, unreadable while `threadUnreadable`.
 */
const owed = { stuck: false, unreadable: false, threadUnreadable: false };
const answering = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const real = yield* Orchestrator.OrchestratorV2;
    return Orchestrator.OrchestratorV2.of({
      ...real,
      awaitOwedCheckpoints: (threadId, runIds) =>
        Effect.suspend(() =>
          owed.unreadable
            ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
            : owed.stuck
              ? Effect.never
              : real.awaitOwedCheckpoints(threadId, runIds),
        ),
      getThreadProjection: (threadId) =>
        Effect.suspend(() =>
          owed.threadUnreadable
            ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
            : real.getThreadProjection(threadId),
        ),
    });
  }),
);

/** A synced chat on This Mac, with a Cloud computer to move to. */
const setUp = async (name: string, settings: Record<string, boolean>) => {
  owed.stuck = false;
  owed.unreadable = false;
  owed.threadUnreadable = false;
  const cloud = await startTestCloud();
  cleanups.push(cloud.close);
  const runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
    provide: answering,
  });
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
  const repo = makeRepo(tempRoot(`${name}-`), { "README.md": "owed\n" });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name}.git`], {
    cwd: repo,
  });
  const w = await createReady(mac, {
    request_id: "w1",
    repo: { path: repo },
    title: name,
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const chats = cloud.state.chats;
  await until(() => chats.summaries.has(w.session_id), 20_000);
  const events: Array<SessionEvent> = [];
  await mac.attach(w.session_id, 0, (e) => events.push(e));
  return { cloud, chats, mac, box, w, events };
};

// Skipped on Windows: the chat moves to a Cloud computer, which is Linux (as moveStoppedCheckpoint).
test.skipIf(process.platform === "win32")(
  "a move T3 cannot say the parked turn's history for is refused for now, and goes once T3 says",
  { timeout: 240_000 },
  async () => {
    const { chats, mac, box, w, events } = await setUp("move-unread", {});
    await mac.call("turn.submit", {
      request_id: "t1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "remember theta" },
    });
    await until(() => events.some((e) => e.type === "turn.done"), 60_000);
    await until(
      () =>
        chats.copyOf(w.session_id).some((e) => e.type === "turn.done") &&
        chats.summaries.get(w.session_id)?.status !== "working",
      30_000,
    );
    owed.unreadable = true;
    const refused = await mac
      .call("session.move", {
        request_id: "m1",
        session_id: w.session_id,
        to: { computer_id: box.computerId },
      })
      .then(
        () => "moved",
        (e: Error) => e.message,
      );
    // Refused for now, saying why, never moved past what its last turn may still write here.
    expect(refused).toBe(
      "It did not move: what this chat's last turn still owes its history could not be read. Try again in a moment.",
    );
    const kept = await mac.call("workspace.get", { workspace_id: w.id });
    expect([kept.computer.kind, kept.status === "parked"]).toEqual(["this_mac", false]);
    // T3 answers again: the move goes.
    owed.unreadable = false;
    await mac.call("session.move", {
      request_id: "m2",
      session_id: w.session_id,
      to: { computer_id: box.computerId },
    });
    await until(
      async () =>
        (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "caveman_cloud",
      60_000,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a move whose park cannot read the chat's thread at all is refused for now too, and goes once it reads",
  { timeout: 240_000 },
  async () => {
    const { chats, mac, box, w, events } = await setUp("move-unread-thread", {});
    await mac.call("turn.submit", {
      request_id: "t1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "remember theta" },
    });
    await until(() => events.some((e) => e.type === "turn.done"), 60_000);
    await until(
      () =>
        chats.copyOf(w.session_id).some((e) => e.type === "turn.done") &&
        chats.summaries.get(w.session_id)?.status !== "working",
      30_000,
    );
    // Every read of the thread fails: the park cannot tell which turn ran last, so not what it still owes either.
    owed.threadUnreadable = true;
    const refused = await mac
      .call("session.move", {
        request_id: "m1",
        session_id: w.session_id,
        to: { computer_id: box.computerId },
      })
      .then(
        () => "moved",
        (e: Error) => e.message,
      );
    owed.threadUnreadable = false;
    expect(refused).toBe(
      "It did not move: what this chat's last turn still owes its history could not be read. Try again in a moment.",
    );
    const kept = await mac.call("workspace.get", { workspace_id: w.id });
    expect([kept.computer.kind, kept.status === "parked"]).toEqual(["this_mac", false]);
    await mac.call("session.move", {
      request_id: "m2",
      session_id: w.session_id,
      to: { computer_id: box.computerId },
    });
    await until(
      async () =>
        (await mac.call("workspace.get", { workspace_id: w.id })).computer.kind === "caveman_cloud",
      60_000,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a lid move whose stopped turn is still saving its changes keeps the chat here, paused, saying so",
  { timeout: 240_000 },
  async () => {
    const { cloud, chats, mac, w, events } = await setUp("lid-owed", { move_to_cloud: true });
    await mac.call("turn.submit", {
      request_id: "t1",
      session_id: w.session_id,
      kind: "followup",
      input: { text: "slow 120000: working as the lid closes" },
    });
    await until(() => chats.summaries.get(w.session_id)?.status === "working", 30_000);
    // The turn the lid's park stops never has its checkpoint written (T3 still at it, a loaded machine).
    owed.stuck = true;
    await mac.call("cloud.suspend", { request_id: "lid-1", budget_ms: 3_000 });
    // Paused as any chat the lid does not move, its turn stopped and Cloud told it is kept, saying truly why.
    const paused = () =>
      events.find(
        (e) => e.type === "notification" && e.payload.title === "Paused when the lid closed",
      );
    await until(() => paused() !== undefined, 150_000);
    expect(paused()?.payload).toMatchObject({
      body: "Its turn was still saving its changes when the lid closed, so it stayed on this Mac.",
    });
    expect(
      events.some(
        (e) =>
          e.type === "notification" && e.payload.title === "Kept on this Mac when the lid closed",
      ),
    ).toBe(false);
    await until(
      () => events.some((e) => e.type === "turn.done" && e.payload.status === "interrupted"),
      30_000,
    );
    // Cloud hears it idle (keepByLid). The park waited a minute for the checkpoint, past when this Mac counts itself awake
    // again (no longer suspending), so its heartbeats name no kept chats by then.
    const workspaceId = chats.sessions.get(w.session_id)!.workspace_id;
    await until(
      () =>
        cloud.state.sessions.runStates.findLast((r) => r.workspace === workspaceId)?.run_state ===
        "idle",
      30_000,
    );
    const kept = await mac.call("workspace.get", { workspace_id: w.id });
    expect([kept.computer.kind, kept.status === "parked"]).toEqual(["this_mac", false]);
  },
);
