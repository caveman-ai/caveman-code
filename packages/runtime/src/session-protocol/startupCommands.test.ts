// A message that reaches a runtime while T3 is still starting waits until T3 takes commands. A Cloud computer's wake
// brings one every time: the message that woke it waits in Cloud's queue and is delivered as the link comes on, tens
// of milliseconds before upstream startup recovery has ended what the last process left (serverRuntimeStartup). Given to
// T3 then, its run looks like one more leftover: T3 answers `started`, the recovery retires the turn's start, and the
// turn never runs, with nothing said. A person's own client never gets there, because the HTTP route waits for upstream
// command gate; the link serves its calls without that route, as this test's connection does (the harness has no
// such wait).
//
// Real Claude adapter and SDK on scripts/smoke-claude.mjs, upstream own command gate (makeCommandGate) and its real
// startup recovery, which the test runs in serverRuntimeStartup's order at the moment a wake runs them.
import * as fs from "node:fs";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import {
  makeCommandGate,
  runOrderedV2StartupPhases,
  ServerRuntimeStartup,
  ServerRuntimeStartupError,
} from "../serverRuntimeStartup.ts";
import {
  createReady,
  makeConfig,
  makeRepo,
  MODEL,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

type Runtime = Awaited<ReturnType<typeof startRuntime>>;
type Done = Extract<SessionEvent, { type: "turn.done" }>;

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
/** The chat the computer held before it stopped: one finished turn, idle. */
let sessionId: string;
/** What the running test opened, closed in reverse once it ends. */
const closing: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  root = tempRoot("sp-startup-commands-");
  config = await makeConfig();
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const runtime = await startRuntime(config, "fake-claude");
  const client = connect(runtime.url, runtime.token);
  try {
    const w = await createReady(client, {
      request_id: "w",
      repo: { path: repo },
      engine: "claude-agent",
      options: { model: MODEL },
      task: { text: "before the stop" },
    });
    sessionId = w.session_id;
    await until(
      async () => (await client.call("workspace.get", { workspace_id: w.id })).status === "idle",
      60_000,
    );
  } finally {
    client.close();
    await runtime.close();
  }
});
// Each test's runtime is gone before the next one starts on the same state.
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => undefined);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * upstream command gate as serverRuntimeStartup makes it, where the route looks for it. The test opens or fails it where
 * upstream startup would; `waits` counts the times something came to wait at it.
 */
const heldGate = () => {
  let gate: Effect.Success<typeof makeCommandGate> | undefined;
  let waits = 0;
  const layer = Layer.effect(
    ServerRuntimeStartup,
    Effect.gen(function* () {
      const made = yield* makeCommandGate;
      gate = made;
      return ServerRuntimeStartup.of({
        awaitCommandReady: Effect.suspend(() => {
          waits++;
          return made.awaitCommandReady;
        }),
        markHttpListening: Effect.void,
        enqueueCommand: made.enqueueCommand,
      });
    }),
  );
  return {
    layer,
    waits: () => waits,
    open: () => Effect.runPromise(gate!.signalCommandReady),
    fail: (cause: string) =>
      Effect.runPromise(
        gate!.failCommandReady(
          new ServerRuntimeStartupError({ mode: "web", host: "127.0.0.1", port: 0, cause }),
        ),
      ),
  };
};

/** The runtime again on the stopped computer's state, T3 not yet taking commands, and a client on the chat. */
const wake = async (options: Parameters<typeof startRuntime>[3]) => {
  const gate = heldGate();
  const runtime = await startRuntime(config, "fake-claude", undefined, {
    ...options,
    provide: gate.layer,
  });
  closing.push(runtime.close);
  const client = connect(runtime.url, runtime.token);
  closing.push(async () => client.close());
  const events: Array<SessionEvent> = [];
  await client.attach(sessionId, 0, (e) => events.push(e));
  return { gate, runtime, client, events };
};

/**
 * What serverRuntimeStartup runs before it opens the gate, in its own order: the startup recovery (the real one, on
 * the runtime's stores), the delegated tasks' recovery, then the effect worker. Answers what the recovery did.
 */
const startT3 = async (runtime: Runtime) => {
  const context = runtime.context as unknown as Context.Context<
    | ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService
    | Orchestrator.OrchestratorV2
    | EffectWorker.OrchestrationEffectWorkerV2
  >;
  const worker = Context.get(context, EffectWorker.OrchestrationEffectWorkerV2);
  const { recovery } = await Effect.runPromise(
    runOrderedV2StartupPhases({
      importLegacyShells: Effect.void,
      recover: Context.get(context, ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService)
        .recover,
      recoverDelegatedTasks: Context.get(context, Orchestrator.OrchestratorV2)
        .recoverDelegatedTasks,
      startEffectWorker: Effect.sync(() => {
        const daemon = Effect.runFork(
          EffectWorker.runDaemon.pipe(
            Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
          ),
        );
        closing.push(() => Effect.runPromise(Fiber.interrupt(daemon)));
      }),
      autoBootstrap: Effect.void,
    }),
  );
  return recovery;
};

test("a message that reaches a starting runtime waits until T3 takes commands: startup recovery no longer retires its turn", async () => {
  const { gate, runtime, client, events } = await wake({ startT3: false });
  const waiting = gate.waits();
  let answered = false;
  const sent = client
    .call("turn.submit", {
      request_id: "woke",
      session_id: sessionId,
      kind: "followup",
      input: { text: "after the wake" },
    })
    .then((answer) => {
      answered = true;
      return answer;
    });
  // The runtime has the message: it waits at the gate (or, before the gate was kept, T3 already answered for it).
  await until(() => answered || gate.waits() > waiting);
  const recovery = await startT3(runtime);
  const answeredBeforeT3TookCommands = answered;
  const shown = events.length;
  await gate.open();
  const answer = await sent;
  const done = () =>
    events.find((e): e is Done => e.type === "turn.done" && e.turn_id === answer.turn_id);
  // A turn whose start was retired may never end: it is waited for as long as a slow machine takes to run one, and
  // what became of it is said below.
  await until(() => done() !== undefined, 30_000).catch(() => undefined);
  const said = events.flatMap((e) =>
    e.type === "message.done" && e.turn_id === answer.turn_id
      ? [`${e.payload.role}: ${e.payload.text}`]
      : [],
  );
  expect({
    answeredBeforeT3TookCommands,
    // The recovery found nothing of this process's to end: the lab's wake logged `retiredEffects: 1` here.
    recovery: {
      retiredEffects: recovery.retiredEffects,
      terminalizedRuns: recovery.terminalizedRuns,
    },
    disposition: answer.disposition,
    turn: done()?.payload.status,
    said,
  }).toEqual({
    answeredBeforeT3TookCommands: false,
    recovery: { retiredEffects: 0, terminalizedRuns: 0 },
    disposition: "started",
    turn: "completed",
    said: ["user: after the wake", "assistant: smoke ok: after the wake"],
  });
  // Nothing of the turn was in the chat before T3 took commands.
  expect(events.slice(0, shown).filter((e) => e.turn_id === answer.turn_id)).toEqual([]);
});

test("a message to a runtime whose start failed is refused in plain words, not left waiting", async () => {
  const { gate, client } = await wake({});
  const waiting = gate.waits();
  let answered = false;
  const sent = client
    .call("turn.submit", {
      request_id: "never-started",
      session_id: sessionId,
      kind: "followup",
      input: { text: "to a runtime that never started" },
    })
    .finally(() => {
      answered = true;
    });
  sent.catch(() => undefined);
  await until(() => answered || gate.waits() > waiting);
  await gate.fail("T3's startup failed");
  await expect(sent).rejects.toMatchObject({
    error: {
      data: { reason: "invalid_state" },
      message:
        "Caveman Code did not finish starting on this computer, or is closing, so this was not done. Try again in a moment.",
    },
  });
  // And one that arrives after the failure, the same.
  await expect(
    client.call("turn.submit", {
      request_id: "never-started-2",
      session_id: sessionId,
      kind: "followup",
      input: { text: "again" },
    }),
  ).rejects.toMatchObject({
    error: { data: { reason: "invalid_state" } },
  });
});
