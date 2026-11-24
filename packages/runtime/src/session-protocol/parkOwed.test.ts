// A park waits for the checkpoint of the turn it parks (one it stopped, or the person's Stop right before it did), so a
// move's last copy holds that turn whole. It waits for that turn only: an older run's capture still on its way never
// keeps a chat from parking, and T3 not answering what is owed never keeps it from parking by hand (a move waits then:
// moveOwed.integration.test.ts), nor says a stopped turn's checkpoint is missing when no turn was stopped. The real runtime on the stand-in claude; the route's T3 answers what is owed as the test
// says (a capture that never settles, or a read that fails).
import * as fs from "node:fs";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

/** What T3 answers for what runs owe: as it is, never for a run named in `stuck`, or a failed read. */
const owed = {
  stuck: new Set<string>(),
  unreadable: false,
  asked: [] as Array<ReadonlyArray<string>>,
};
const answering = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const real = yield* Orchestrator.OrchestratorV2;
    return Orchestrator.OrchestratorV2.of({
      ...real,
      awaitOwedCheckpoints: (threadId, runIds) =>
        Effect.suspend(() => {
          owed.asked.push(runIds);
          if (owed.unreadable)
            return Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }));
          return runIds.some((id) => owed.stuck.has(id))
            ? Effect.never
            : real.awaitOwedCheckpoints(threadId, runIds);
        }),
    });
  }),
);

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-park-owed-");
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, {
    provide: answering,
  });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A chat with `turns` turns done. */
const chatWith = async (id: string, turns: number) => {
  const w = await createReady(client, {
    request_id: id,
    repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const runs: Array<string> = [];
  for (let n = 1; n <= turns; n++) {
    runs.push(
      (
        await client.call("turn.submit", {
          request_id: `${id}-${n}`,
          session_id: w.session_id,
          kind: "followup",
          input: { text: `turn ${n}` },
        })
      ).turn_id,
    );
    await until(() => events.filter((e) => e.type === "turn.done").length === n, 60_000);
  }
  return { w, events, runs };
};

test("a park waits for the turn it parks, never for an older run's capture still on its way", async () => {
  const { w, runs } = await chatWith("old", 2);
  // The first turn's capture never settles (T3 still retrying it, say); the chat's last turn has its checkpoint.
  owed.stuck = new Set([runs[0]!]);
  const started = Date.now();
  const parked = await client
    .call("session.park", { request_id: "old-park", session_id: w.session_id })
    .then(
      (session) => session.state,
      (error: Error) => `refused: ${error.message}`,
    );
  owed.stuck = new Set();
  expect(parked).toBe("parked");
  expect(Date.now() - started).toBeLessThan(20_000);
  // What it waited for: the turn it parks.
  expect(owed.asked.at(-1)).toEqual([runs[1]]);
}, 120_000);

test("T3 not answering what is owed never keeps a chat from parking by hand, nor says a stopped turn's checkpoint is missing", async () => {
  const { w } = await chatWith("unreadable", 1);
  owed.unreadable = true;
  const parked = await client
    .call("session.park", { request_id: "unreadable-park", session_id: w.session_id })
    .then(
      (session) => session.state,
      (error: Error) => `refused: ${error.message}`,
    );
  owed.unreadable = false;
  expect(parked).toBe("parked");
}, 120_000);
