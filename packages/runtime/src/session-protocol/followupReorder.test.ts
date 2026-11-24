// A follow-up goes ahead of the queue after T3 took it in (queued-run.reorder). The queue moves meanwhile: the follow-up's
// own turn can start first, or the run it goes ahead of can. Chaos seed 1 at load 110 failed a phone's send that way
// ("Run … is not queued", its Cloud call failed invalid_state) though the message ran, so a resend would run it twice.
// The real runtime on the stand-in claude; the route's T3 holds each reorder until the test lets it go, as that busy
// machine held it.
import * as fs from "node:fs";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { leftQueueAs } from "./handlers.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

/** Reorders wait while `held` is pending; `reorders` counts the ones that reached T3. */
const gate = { held: Promise.resolve(), reorders: 0 };
const holdReorders = () => {
  let release!: () => void;
  gate.held = new Promise<void>((resolve) => (release = resolve));
  return () => release();
};
const holding = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const real = yield* Orchestrator.OrchestratorV2;
    return Orchestrator.OrchestratorV2.of({
      ...real,
      dispatch: (command) =>
        command.type === "queued-run.reorder"
          ? Effect.promise(() => gate.held).pipe(
              Effect.andThen(Effect.sync(() => gate.reorders++)),
              Effect.andThen(real.dispatch(command)),
            )
          : real.dispatch(command),
    });
  }),
);

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-followup-reorder-");
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: holding });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const userTexts = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) =>
    e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : [],
  );
const started = (events: ReadonlyArray<SessionEvent>, text: string) => {
  const turn = events.find(
    (e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text,
  )?.turn_id;
  return turn !== undefined && events.some((e) => e.type === "turn.started" && e.turn_id === turn);
};

/** A chat working on a turn, with one message queued behind it (kind queue: no reorder). */
const busyChat = async (id: string, queuedText: string) => {
  const w = await createReady(client, {
    request_id: id,
    repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", {
    request_id: `${id}-a`,
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 1500: working" },
  });
  await until(() => started(events, "slow 1500: working"), 30_000);
  expect(
    await client.call("turn.submit", {
      request_id: `${id}-b`,
      session_id: w.session_id,
      kind: "queue",
      input: { text: queuedText },
    }),
  ).toMatchObject({ disposition: "queued" });
  return { w, events };
};

test("a follow-up whose turn starts before it goes ahead of the queue is answered as taken (started), and runs once", async () => {
  const { w, events } = await busyChat("own", "slow 100: queued first");
  const release = holdReorders();
  const reordersBefore = gate.reorders;
  const text = "slow 100: the follow-up";
  const sent = client.call("turn.submit", {
    request_id: "own-c",
    session_id: w.session_id,
    kind: "followup",
    input: { text },
  });
  // T3 has it queued; its turn starts once the two ahead of it end, all before its reorder reaches T3.
  await until(() => started(events, text), 60_000);
  release();
  const answer = await sent.then(
    (value) => value,
    (error: Error) => ({ refused: error.message }),
  );
  expect(gate.reorders).toBeGreaterThan(reordersBefore);
  expect(answer).toMatchObject({ disposition: "started" });
  await until(
    () =>
      events.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "assistant" &&
          e.payload.text.includes("the follow-up"),
      ),
    30_000,
  );
  expect(userTexts(events).filter((t) => t === text)).toHaveLength(1);
}, 180_000);

test("a follow-up whose queue moved before it went ahead of it is answered as queued, and runs once", async () => {
  // A long run queued ahead: it starts and works while the follow-up's reorder waits.
  const { w, events } = await busyChat("ahead", "slow 4000: queued first");
  const release = holdReorders();
  const text = "slow 100: behind the one that started";
  const sent = client.call("turn.submit", {
    request_id: "ahead-c",
    session_id: w.session_id,
    kind: "followup",
    input: { text },
  });
  await until(() => started(events, "slow 4000: queued first"), 60_000);
  release();
  const answer = await sent.then(
    (value) => value,
    (error: Error) => ({ refused: error.message }),
  );
  expect(answer).toMatchObject({ disposition: "queued" });
  await until(
    () =>
      events.some(
        (e) =>
          e.type === "message.done" &&
          e.payload.role === "assistant" &&
          e.payload.text.includes("behind the one that started"),
      ),
    60_000,
  );
  expect(userTexts(events).filter((t) => t === text)).toHaveLength(1);
}, 180_000);

/** The texts in the order their turns started. */
const startOrder = (events: ReadonlyArray<SessionEvent>, texts: ReadonlyArray<string>) => {
  const startedAt = (text: string) => {
    const turn = events.find(
      (e) => e.type === "message.done" && e.payload.role === "user" && e.payload.text === text,
    )?.turn_id;
    return events.findIndex((e) => e.type === "turn.started" && e.turn_id === turn);
  };
  return [...texts].sort((a, b) => startedAt(a) - startedAt(b));
};
const answered = (events: ReadonlyArray<SessionEvent>, text: string) =>
  events.some(
    (e) =>
      e.type === "message.done" &&
      e.payload.role === "assistant" &&
      e.payload.text.includes(text.replace(/^slow \d+: /, "")),
  );

/** Sends `sends` one after another behind a running turn, then answers the order their turns started in. */
const sentBehindATurn = async (
  id: string,
  sends: ReadonlyArray<{ readonly text: string; readonly kind: "followup" | "queue" }>,
) => {
  const w = await createReady(client, {
    request_id: id,
    repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", {
    request_id: `${id}-running`,
    session_id: w.session_id,
    kind: "followup",
    input: { text: "slow 4000: working" },
  });
  await until(() => started(events, "slow 4000: working"), 30_000);
  for (const [i, send] of sends.entries()) {
    expect(
      await client.call("turn.submit", {
        request_id: `${id}-${i}`,
        session_id: w.session_id,
        kind: send.kind,
        input: { text: send.text },
      }),
    ).toMatchObject({ disposition: "queued" });
  }
  await until(() => sends.every((send) => answered(events, send.text)), 60_000);
  return startOrder(
    events,
    sends.map((send) => send.text),
  );
};

test("two follow-ups sent behind a running turn start in the order they were sent", async () => {
  const sends = ["slow 50: the first follow-up", "slow 50: the second follow-up"];
  expect(
    await sentBehindATurn(
      "two",
      sends.map((text) => ({ text, kind: "followup" as const })),
    ),
  ).toEqual(sends);
}, 120_000);

test("three follow-ups sent behind a running turn start in the order they were sent", async () => {
  const sends = ["slow 50: follow-up one", "slow 50: follow-up two", "slow 50: follow-up three"];
  expect(
    await sentBehindATurn(
      "three",
      sends.map((text) => ({ text, kind: "followup" as const })),
    ),
  ).toEqual(sends);
}, 120_000);

test("a follow-up goes behind the follow-ups sent before it and ahead of a message queued between them", async () => {
  const order = await sentBehindATurn("mixed", [
    { text: "slow 50: an early follow-up", kind: "followup" },
    { text: "slow 50: queued for later", kind: "queue" },
    { text: "slow 50: a later follow-up", kind: "followup" },
  ]);
  expect(order).toEqual([
    "slow 50: an early follow-up",
    "slow 50: a later follow-up",
    "slow 50: queued for later",
  ]);
}, 120_000);

test("a follow-up that left the queue before it was placed is answered as started only when its turn began", () => {
  const at = DateTime.makeUnsafe("2026-11-07T09:00:00Z");
  // Its turn began: running, done, or stopped once it ran.
  for (const status of ["starting", "running", "waiting", "completed", "interrupted"] as const)
    expect(leftQueueAs({ status, startedAt: null })).toBe("started");
  expect(leftQueueAs({ status: "failed", startedAt: at })).toBe("started");
  // It never ran: T3 could not start it (failed from the queue), it was taken out, or it is gone.
  expect(leftQueueAs({ status: "failed", startedAt: null })).toBe("queued");
  expect(leftQueueAs({ status: "cancelled", startedAt: null })).toBe("queued");
  expect(leftQueueAs(undefined)).toBe("queued");
});
