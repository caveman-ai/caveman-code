// Model checks of the Session Protocol's call guarantees (README "Idempotency", CONTRACT §6 G13/G14, K3): a mutating
// call runs once per (principal, method, request_id), an ask takes one answer, and a chat's calls on one connection
// run in the order they arrived. Every check drives this runtime's own makeSessionProtocolServer (once, runCall,
// serve, laneOf, the real ask.respond handler and oneAnswerPerAsk) over its real SessionStore on SQLite. The test
// layers only wrap the store's receipt and record reads and upstream orchestrator (the engine) so a caller parks on a
// gate there: the checker then picks which parked caller moves next, and explores every order breadth first.
// The coverage record and how to read a counterexample: .claude/skills/session-call-once-and-asks/SKILL.md.
import {
  assertHolds,
  checkAsync,
  formatTrace,
  macrotask,
  type Action,
  type AsyncSpec,
  type Verdict,
} from "@caveman-app/model-check";
import { gatesFrom, openHarness, type Harness } from "@caveman-app/model-check/effect";
import type { Session, Workspace } from "@caveman-app/session-protocol";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Socket from "effect/socket/Socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ChatSearch from "../search/ChatSearch.ts";
import * as ClientTools from "./clientTools.ts";
import * as Grill from "./grill.ts";
import { ProtocolError } from "./handlers.ts";
import * as Mailbox from "./mailbox.ts";
import { liveOutboxes, makeSessionProtocolServer } from "./server.ts";
import * as Store from "./store.ts";
import { loadTranscript, makeConfig, startRuntime } from "./testHarness.ts";

/** Where a caller's fiber (and the call once() forks for it) parks. The runtime's own fibers carry none and never park. */
interface Hooks {
  readonly beforeReceiptRead?: (who: string, requestId: string) => Effect.Effect<void>;
  readonly afterReceiptRead?: (who: string, requestId: string) => Effect.Effect<void>;
  readonly beforeReceiptWrite?: (who: string, requestId: string) => Effect.Effect<void>;
  /** The handler's first read of its chat (recordBySession): the call's run begins here, and ends as the checker chose. */
  readonly runStarts?: (who: string) => Effect.Effect<Outcome>;
  readonly projection?: (who: string) => Effect.Effect<unknown>;
  readonly dispatch?: (
    who: string,
    command: { readonly type: string },
  ) => Effect.Effect<unknown, Error>;
}
type Outcome = "succeeds" | "fails" | "is interrupted";

class Caller extends Context.Reference<
  { readonly name: string; readonly hooks: Hooks } | undefined
>("callOnce.modelcheck/Caller", {
  defaultValue: () => undefined,
}) {}

let server!: Effect.Success<typeof makeSessionProtocolServer>;
let store!: Store.SessionStore["Service"];
let tools!: ClientTools.ClientTools["Service"];
let runtime: Awaited<ReturnType<typeof startRuntime>>;

const probedStore = Layer.effect(
  Store.SessionStore,
  Effect.map(Store.make, (real): Store.SessionStore["Service"] => {
    store = real;
    return {
      ...real,
      getReceipt: (principal, method, requestId) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          if (caller?.hooks.beforeReceiptRead)
            yield* caller.hooks.beforeReceiptRead(caller.name, requestId);
          const receipt = yield* real.getReceipt(principal, method, requestId);
          if (caller?.hooks.afterReceiptRead)
            yield* caller.hooks.afterReceiptRead(caller.name, requestId);
          return receipt;
        }),
      putReceipt: (principal, method, requestId, receipt, ttlMs) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          if (caller?.hooks.beforeReceiptWrite)
            yield* caller.hooks.beforeReceiptWrite(caller.name, requestId);
          yield* real.putReceipt(principal, method, requestId, receipt, ttlMs);
        }),
      getBySession: (sessionId) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          const outcome = caller?.hooks.runStarts
            ? yield* caller.hooks.runStarts(caller.name)
            : "succeeds";
          if (outcome === "fails") return undefined;
          if (outcome === "is interrupted") return yield* Effect.interrupt;
          return yield* real.getBySession(sessionId);
        }),
    };
  }),
);

const probedOrchestrator = Layer.effect(
  Orchestrator.OrchestratorV2,
  Effect.gen(function* () {
    const real = yield* Orchestrator.OrchestratorV2;
    return {
      ...real,
      getThreadProjection: (threadId) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          if (caller?.hooks.projection === undefined)
            return yield* real.getThreadProjection(threadId);
          return (yield* caller.hooks.projection(caller.name)) as never;
        }),
      dispatch: (command) =>
        Effect.gen(function* () {
          const caller = yield* Caller;
          if (caller?.hooks.dispatch === undefined) return yield* real.dispatch(command);
          return (yield* caller.hooks
            .dispatch(caller.name, command)
            .pipe(Effect.mapError((error) => error as never))) as never;
        }),
    } satisfies Orchestrator.OrchestratorV2["Service"];
  }),
);

/** A second instance of the real server beside the test runtime's own, on the probed store and engine (index.ts layerState). */
const probedServer = Layer.effectDiscard(
  Effect.gen(function* () {
    server = yield* makeSessionProtocolServer;
    tools = yield* ClientTools.ClientTools;
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(Mailbox.layerLocal, Grill.layer, ClientTools.layer, ChatSearch.layer).pipe(
      Layer.provideMerge(probedStore),
    ),
  ),
  Layer.provide(probedOrchestrator),
);

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), await loadTranscript(), undefined, {
    provide: probedServer as never,
  });
});
afterAll(async () => {
  await runtime?.close();
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
let systems = 0;

/**
 * A harness for one explored system. Its callers queue on the runtime's SQLite writer, and on its reader for upstream
 * projections, beside the runtime's own fibers: a statement on each, queued behind them all, is the barrier a step
 * waits through before it calls the system quiet.
 */
const behindTheRuntimesSql = () =>
  run(
    Effect.all([store.sql`SELECT 1`, NodeSqliteClient.readOnly(store.sql`SELECT 1`)], {
      discard: true,
    }),
  );
const openSystem = () => openHarness(Effect.void, { barrier: behindTheRuntimesSql });

/** A chat of its own for one explored system: every system lives beside the others in the one server, keyed apart. */
const putChat = async (id: string) => {
  const at = "2026-11-06T00:00:00.000Z";
  const workspace = {
    id,
    session_id: `s-${id}`,
    title: id,
    status: "idle",
    created_at: at,
    updated_at: at,
  } as unknown as Workspace;
  const session = {
    id: `s-${id}`,
    workspace_id: id,
    head: 0,
    state: "live",
    created_at: at,
    updated_at: at,
  } as unknown as Session;
  await run(
    store.putWorkspace({
      workspace,
      session,
      internal: { threadId: `t-${id}`, worktreePath: null, repoPath: null },
    } as never),
  );
  return { workspace, sessionId: session.id };
};

const answerOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "ok";
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (error instanceof ProtocolError) return `${error.reason}: ${error.message}`;
  return Cause.hasInterruptsOnly(exit.cause)
    ? "interrupted"
    : `died: ${Cause.pretty(exit.cause).split("\n")[0]}`;
};

/** Parked gates as actions; a gate with outcomes is one action per outcome. */
const gateActions = <Sys>(
  harness: Harness<void>,
  offered: (gate: string) => boolean,
  outcomes: (gate: string) => ReadonlyArray<string>,
  decide: (gate: string, outcome: string) => void,
): Array<Action<Sys>> =>
  [...new Set(harness.enabled())].filter(offered).flatMap((gate) => {
    const choices = outcomes(gate);
    if (choices.length === 0) return [{ name: gate, run: () => harness.step(gate) }];
    return choices.map((outcome) => ({
      name: `${gate}: ${outcome}`,
      run: async () => {
        decide(gate, outcome);
        await harness.step(gate);
      },
    }));
  });

/** Lets every parked caller finish before the harness closes: calls once() forked into the server's scope do not leak. */
const finish = async (harness: Harness<void>) => {
  for (let round = 0; round < 30 && (await harness.fairRound()).length > 0; round++);
  await harness.close();
};

const report = (title: string, verdict: Verdict<unknown>) => {
  if (verdict.ok)
    console.log(
      `${title}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}`,
    );
  else
    console.log(
      `${title}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states)\n${formatTrace(verdict.trace)}`,
    );
};

const actionsIn = (verdict: Verdict<unknown>) =>
  verdict.ok ? [] : verdict.trace.map((step) => step.action);

// The explored callers share the runtime's SQLite connections (its writer, and its reader for upstream projections) with the
// runtime's own fibers, which hold them as long as their work takes. A caller waiting there has not parked: a step ends
// only once it reached its next gate, or the checker reads a stale enabled set and replay finds the system changed.
describe("the checker's steps and the runtime's own SQL work", () => {
  for (const connection of ["writer", "reader"] as const) {
    it(`a step ends once a caller queued behind the runtime's work on its ${connection} has reached its next gate`, async () => {
      const on = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        connection === "reader" ? NodeSqliteClient.readOnly(effect) : effect;
      const harness = await openSystem();
      const gate = gatesFrom(harness.gates).gate;
      harness.fork(
        "c",
        gate("c sends").pipe(
          Effect.andThen(on(store.sql`SELECT 1`)),
          Effect.andThen(gate("c has read")),
        ),
      );
      await harness.settle();
      let held!: () => void;
      let release!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const work = run(
        on(
          store.sql.withTransaction(
            Effect.promise(() => (held(), new Promise<void>((resolve) => (release = resolve)))),
          ),
        ),
      );
      await holding;
      const stepped = harness.step("c sends").then(() => harness.enabled());
      for (let turn = 0; turn < 20; turn++) await macrotask();
      release();
      await work;
      expect(await stepped).toEqual(["c has read"]);
      await finish(harness);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// once(): N callers of one (principal, method, request_id), each from its own connection (server.runCall, as a call
// Caveman Cloud queued; handleFrame calls the same once()). The call is turn.interrupt on a chat with no turn: its
// handler reads the chat first (the run's start, where the checker picks success, failure or the runner stopping),
// and answers {}. Each caller sends when the checker says: before, during or after any run.

interface Callers {
  readonly harness: Harness<void>;
  readonly principal: string;
  /** Each run once() started, in order, with how the checker ended it ("starting" while it waits at its gate). */
  readonly runs: Array<{ readonly by: string; outcome: Outcome | "starting" }>;
  readonly decisions: Map<string, Outcome>;
  readonly answers: Record<string, string>;
  readonly receiptWrittenBy: Array<string>;
  /** Callers whose receipt read ran after a run's receipt was written, with the caller whose run wrote the receipt they read (INSERT OR REPLACE: the latest). */
  readonly readAfterSuccess: Record<string, string>;
  /** For each caller that sent, the runs that had already failed when it sent: their failure is no answer for it. */
  readonly failedBeforeSend: Record<string, ReadonlyArray<string>>;
}

interface CallersModel {
  /** Callers and the params group each sends: "same" are one call and its retries, "other" reuses the request_id. */
  readonly callers: Readonly<Record<string, "same" | "other">>;
}

const RUN = "'s call starts";
/** An answer the run gave (its error), as opposed to ok, a receipt's conflict, or a stopped run's "interrupted". */
const isRunError = (answer: string) =>
  answer !== "ok" && answer !== "interrupted" && !answer.startsWith("request_id_conflict: ");

const callersSpec = (model: CallersModel): AsyncSpec<Callers, Record<string, unknown>> => {
  const names = Object.keys(model.callers);
  return {
    make: async () => {
      const id = `once-${++systems}`;
      const [same, other] = [await putChat(id), await putChat(`${id}-b`)];
      const harness = await openSystem();
      const gate = gatesFrom(harness.gates).gate;
      const system: Callers = {
        harness,
        principal: `p-${id}`,
        runs: [],
        decisions: new Map(),
        answers: {},
        receiptWrittenBy: [],
        readAfterSuccess: {},
        failedBeforeSend: {},
      };
      const hooks: Hooks = {
        beforeReceiptRead: (who) =>
          gate(`${who} reads the receipt`).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const writer = system.receiptWrittenBy.at(-1);
                if (writer !== undefined) system.readAfterSuccess[who] = writer;
              }),
            ),
          ),
        afterReceiptRead: (who) => gate(`${who} has read the receipt`),
        beforeReceiptWrite: (who) =>
          gate(`${who}'s call writes the receipt`).pipe(
            Effect.tap(() => Effect.sync(() => system.receiptWrittenBy.push(who))),
          ),
        runStarts: (who) =>
          Effect.gen(function* () {
            const entry = { by: who, outcome: "starting" as Outcome | "starting" };
            system.runs.push(entry);
            yield* gate(`${who}${RUN}`);
            const outcome = system.decisions.get(`${who}${RUN}`) ?? "succeeds";
            system.decisions.delete(`${who}${RUN}`);
            entry.outcome = outcome;
            return outcome;
          }),
      };
      for (const name of names) {
        const params = {
          request_id: "r1",
          session_id: model.callers[name] === "same" ? same.sessionId : other.sessionId,
        };
        harness.fork(
          name,
          gate(`${name} sends`).pipe(
            Effect.tap(() =>
              Effect.sync(
                () =>
                  (system.failedBeforeSend[name] = system.runs
                    .filter((r) => r.outcome === "fails")
                    .map((r) => r.by)),
              ),
            ),
            Effect.andThen(server.runCall(system.principal, "turn.interrupt", params)),
            Effect.exit,
            Effect.tap((exit) => Effect.sync(() => (system.answers[name] = answerOf(exit)))),
            Effect.provideService(Caller, { name, hooks }),
          ),
        );
      }
      await harness.settle();
      return system;
    },
    actions: (system) =>
      gateActions(
        system.harness,
        () => true,
        (gate) => (gate.endsWith(RUN) ? ["succeeds", "fails", "is interrupted"] : []),
        (gate, outcome) => system.decisions.set(gate, outcome as Outcome),
      ),
    observe: async (system) => ({
      runs: system.runs.map((r) => `${r.by}: ${r.outcome}`),
      answers: { ...system.answers },
      receipts: (
        await run(
          store.sql<{
            n: number;
          }>`SELECT count(*) AS n FROM caveman_sp_receipts WHERE principal = ${system.principal}`.pipe(
            Effect.orDie,
          ),
        )
      )[0]!.n,
      receiptWrittenBy: [...system.receiptWrittenBy],
      readAfterSuccess: Object.fromEntries(
        Object.entries(system.readAfterSuccess).sort(([a], [b]) => a.localeCompare(b)),
      ),
      failedBeforeSend: Object.fromEntries(
        Object.entries(system.failedBeforeSend).sort(([a], [b]) => a.localeCompare(b)),
      ),
      ...system.harness.snapshot(),
    }),
    invariants: {
      "one run at a time, and none after a success": (o) => {
        const runs = (o.runs as Array<string>).map((r) => r.split(": ")[1]);
        return runs.every((_, k) =>
          runs.slice(0, k).every((before) => before === "fails" || before === "is interrupted"),
        );
      },
      "an ok answer comes from a successful run of the same params": (o) =>
        Object.entries(o.answers as Record<string, string>).every(
          ([who, answer]) =>
            answer !== "ok" ||
            (o.runs as Array<string>).some((r) => {
              const [by, outcome] = r.split(": ");
              return outcome === "succeeds" && model.callers[by!] === model.callers[who];
            }),
        ),
      "a caller that reads a success's receipt is told its result if it sent that run's params, request_id_conflict if not":
        (o) =>
          Object.entries(o.readAfterSuccess as Record<string, string>).every(([who, writer]) => {
            const answer = (o.answers as Record<string, string>)[who];
            return (
              answer === undefined ||
              (model.callers[who] === model.callers[writer]
                ? answer === "ok"
                : answer.startsWith("request_id_conflict: "))
            );
          }),
      // once()'s doc comment: "Only a success is kept: a retry after a failure runs it again." A caller may share a
      // failure only with a run it could have joined, one that had not yet failed when it sent.
      "a failure reaches only callers that sent before that run failed: a retry after a failure runs the call again":
        (o) =>
          Object.entries(o.answers as Record<string, string>).every(([who, answer]) => {
            if (!isRunError(answer)) return true;
            const stale = (o.failedBeforeSend as Record<string, ReadonlyArray<string>>)[who] ?? [];
            return (o.runs as Array<string>).some((r) => {
              const [by, outcome] = r.split(": ");
              return outcome === "fails" && !stale.includes(by!);
            });
          }),
      // once(): "Its runner was stopped (the runtime is shutting down): this asker runs it instead." Nothing here stops a
      // caller from outside, so only the caller whose own run was stopped hears "interrupted".
      "only a caller whose own run was stopped is told interrupted: a joiner of a stopped run runs the call itself":
        (o) =>
          Object.entries(o.answers as Record<string, string>).every(
            ([who, answer]) =>
              answer !== "interrupted" ||
              (o.runs as Array<string>).includes(`${who}: is interrupted`),
          ),
    },
    atEnd: {
      "every caller is answered": (o) =>
        names.every((name) => (o.answers as Record<string, string>)[name] !== undefined),
      "a success leaves one receipt, written by its run": (o) => {
        const succeeded = (o.runs as Array<string>)
          .filter((r) => r.endsWith(": succeeds"))
          .map((r) => r.split(": ")[0]);
        return (
          o.receipts === (succeeded.length > 0 ? 1 : 0) &&
          (o.receiptWrittenBy as Array<string>).every((who) => succeeded.includes(who))
        );
      },
    },
    dispose: (system) => finish(system.harness),
  };
};

describe("once(): a mutating call runs at most once per (principal, method, request_id)", () => {
  it("a retry of a running call waits for it and never runs the call a second time, whenever it reads the receipt", async () => {
    const verdict = await checkAsync(callersSpec({ callers: { c1: "same", c2: "same" } }));
    report("once, two callers, same params", verdict);
    assertHolds(verdict);
  });

  it("a request_id reused with other params while the first call runs is never told that call's result", async () => {
    const verdict = await checkAsync(callersSpec({ callers: { c1: "same", c2: "other" } }));
    report("once, request_id reused with other params", verdict);
    assertHolds(verdict);
  });

  it("holds for three retries and a reuse with other params, each sent at any point: retries join or replay, failures and stopped runners run again, other params conflict", async () => {
    const verdict = await checkAsync(
      callersSpec({ callers: { c1: "same", c2: "same", c3: "same", c4: "other" } }),
    );
    report("once, three retries and a reuse with other params", verdict);
    assertHolds(verdict);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------
// One answer per ask: answers to one engine approval from several places at once. Each reaches the real ask.respond
// handler (oneAnswerPerAsk around answerAsk) through once(), by server.runCall. The engine is scripted: its record of
// the ask (upstream projection) shows the answer only when the checker says it caught up, and it accepts or refuses each
// answer sent to it. Ten minutes may pass once its record caught up: oneAnswer.ts keeps answers that long because "the
// engine's record has caught up by then", and only that assumption is modelled.

interface Answers {
  readonly harness: Harness<void>;
  readonly decisions: Map<string, string>;
  readonly sent: Array<{ readonly by: string; outcome: string }>;
  readonly answers: Record<string, string>;
  engineShows: "pending" | "answered";
  clockMoved: boolean;
}

const KEEP_MS = 10 * 60_000;
const ALREADY = "invalid_state: this ask was already answered";
const ENGINE = "'s answer reaches the engine";
/**
 * Who answers, from where, with which request_id and decision. "a again" is a's retry on another connection. headless.ts
 * calls the ask.respond handler without once() under `mail:<id>`; here mail goes through once() under its own request_id,
 * which only adds a receipt read before its run and a write after.
 */
const ANSWERERS = {
  a: { principal: "local", requestId: "r-a", option: "accept" },
  "a again": { principal: "local", requestId: "r-a", option: "accept" },
  phone: { principal: "cloud:person", requestId: "r-phone", option: "decline" },
  mail: { principal: "headless", requestId: "mail:m1", option: "accept" },
} as const;

const APPROVAL_OPTIONS = [
  { id: "accept", label: "Allow", decision: "allow" },
  { id: "decline", label: "Deny", decision: "deny" },
];

let clockOffset = 0;
const realNow = Date.now;

const answersSpec = (
  who: ReadonlyArray<keyof typeof ANSWERERS>,
): AsyncSpec<Answers, Record<string, unknown>> => ({
  make: async () => {
    clockOffset = 0;
    const id = `ask-${++systems}`;
    const chat = await putChat(id);
    // The engine's approval as the projector journals it: ask.respond takes only an option it offers.
    const ask = {
      at: "2026-11-06T00:00:00.000Z",
      type: "ask.user",
      item_id: "ask-1",
      payload: { kind: "approval", title: "Allow command?", options: APPROVAL_OPTIONS },
    };
    await run(
      store.append(chat.sessionId, () =>
        Effect.succeed({ events: [ask as never], value: undefined }),
      ),
    );
    const harness = await openSystem();
    const gate = gatesFrom(harness.gates).gate;
    const system: Answers = {
      harness,
      decisions: new Map(),
      sent: [],
      answers: {},
      engineShows: "pending",
      clockMoved: false,
    };
    const hooks: Hooks = {
      projection: (by) =>
        gate(`${by} reads the engine's record`).pipe(
          Effect.andThen(
            Effect.sync(() => ({
              runtimeRequests: [
                {
                  id: "ask-1",
                  kind: "approval",
                  status: system.engineShows === "pending" ? "pending" : "resolved",
                  responseCapability: { type: "live", supportsFeedback: false },
                },
              ],
              turnItems: [],
            })),
          ),
        ),
      dispatch: (by, command) =>
        Effect.gen(function* () {
          if (command.type !== "runtime-request.respond")
            return yield* Effect.die(`unexpected ${command.type}`);
          yield* gate(`${by}${ENGINE}`);
          const outcome = system.decisions.get(`${by}${ENGINE}`) ?? "accepted";
          system.sent.push({ by, outcome });
          if (outcome !== "accepted")
            return yield* Effect.fail(new Error("the engine refused the answer"));
          return {};
        }),
    };
    for (const name of who) {
      const { principal, requestId, option } = ANSWERERS[name];
      // Receipts are keyed by principal and request_id, not by chat: each explored system gets request ids of its own.
      const params = {
        request_id: `${requestId}@${id}`,
        session_id: chat.sessionId,
        ask_id: "ask-1",
        response: { kind: "approval", option_id: option },
      };
      harness.fork(
        name,
        gate(`${name} sends`).pipe(
          Effect.andThen(server.runCall(principal, "ask.respond", params)),
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => (system.answers[name] = answerOf(exit)))),
          Effect.provideService(Caller, { name, hooks }),
        ),
      );
    }
    await harness.settle();
    return system;
  },
  actions: (system) => [
    ...gateActions<Answers>(
      system.harness,
      () => true,
      (gate) => (gate.endsWith(ENGINE) ? ["accepted", "refused"] : []),
      (gate, outcome) => system.decisions.set(gate, outcome),
    ),
    ...(system.engineShows === "pending" && system.sent.some((s) => s.outcome === "accepted")
      ? [
          {
            name: "the engine's record shows the answer",
            run: () => void (system.engineShows = "answered"),
          },
        ]
      : []),
    ...(system.engineShows === "answered" && !system.clockMoved
      ? [
          {
            name: "ten minutes pass",
            run: async () => {
              clockOffset += KEEP_MS + 1;
              system.clockMoved = true;
              await system.harness.settle();
            },
          },
        ]
      : []),
  ],
  observe: (system) => ({
    sent: system.sent.map((s) => `${s.by}: ${s.outcome}`),
    answers: { ...system.answers },
    engineShows: system.engineShows,
    clockMoved: system.clockMoved,
    ...system.harness.snapshot(),
  }),
  invariants: {
    "at most one answer reaches the engine": (o) =>
      (o.sent as Array<string>).filter((s) => s.endsWith(": accepted")).length <= 1,
    "each answer hears the truth: ok only if the engine took it, already answered only if it took another":
      (o) => {
        const sent = (o.sent as Array<string>).map(
          (s) => s.split(": ") as [keyof typeof ANSWERERS, string],
        );
        const requestOf = (by: keyof typeof ANSWERERS) => ANSWERERS[by].requestId;
        const answers = o.answers as Partial<Record<keyof typeof ANSWERERS, string>>;
        return who.every((by) => {
          const answer = answers[by];
          const mine = sent.filter(([sender]) => requestOf(sender) === requestOf(by));
          if (answer === undefined) return true;
          if (answer === "ok") return mine.some(([, outcome]) => outcome === "accepted");
          if (answer === ALREADY)
            return sent.some(
              ([sender, outcome]) => outcome === "accepted" && requestOf(sender) !== requestOf(by),
            );
          return mine.some(([, outcome]) => outcome === "refused");
        });
      },
  },
  atEnd: {
    "every answer is told": (o) =>
      who.every((name) => (o.answers as Record<string, string>)[name] !== undefined),
  },
  dispose: (system) => finish(system.harness),
});

// A custom tool call is an ask the runtime journals itself (clientTools.ts, runtimeAsks.ts): the agent's call waits
// for its answer, and the chat needs input until an answer or the call's end closes it with ask.resolved. Answers come
// through the same ask.respond; the call may end first (the engine gave up, the turn stopped).

interface ToolAsk {
  readonly harness: Harness<void>;
  readonly sessionId: string;
  readonly threadId: string;
  readonly answers: Record<string, string>;
  call: string;
}

const TOOL_ANSWERERS = {
  a: { principal: "local", requestId: "r-a", content: "from a" },
  "a again": { principal: "local", requestId: "r-a", content: "from a" },
  mail: { principal: "headless", requestId: "mail:m1", content: "from mail" },
} as const;
const CALL_ENDS = "the tool call ends";

const toolAskSpec = (
  who: ReadonlyArray<keyof typeof TOOL_ANSWERERS>,
): AsyncSpec<ToolAsk, Record<string, unknown>> => ({
  make: async () => {
    const id = `tool-${++systems}`;
    const chat = await putChat(id);
    const threadId = `t-${id}`;
    await run(
      tools.setTools(threadId, [
        {
          name: "lookup_order",
          description: "Looks up an order.",
          input_schema: { type: "object" },
        },
      ] as never),
    );
    const harness = await openSystem();
    const gate = gatesFrom(harness.gates).gate;
    const system: ToolAsk = {
      harness,
      sessionId: chat.sessionId,
      threadId,
      answers: {},
      call: "waiting",
    };
    harness.fork(
      "tool call",
      tools.call(threadId, "lookup_order", {}).pipe(
        Effect.raceFirst(gate(CALL_ENDS).pipe(Effect.andThen(Effect.fail("ended")))),
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(
            () =>
              (system.call = Exit.isSuccess(exit)
                ? `got "${exit.value.content}"`
                : "ended without an answer"),
          ),
        ),
      ),
    );
    await harness.settle();
    const [ask] = await run(
      store.sql<{
        id: string;
      }>`SELECT json_extract(event, '$.item_id') AS id FROM caveman_sp_events WHERE session_id = ${chat.sessionId} AND type = 'ask.user'`.pipe(
        Effect.orDie,
      ),
    );
    // The answer's handler holds the ask's turn (oneAnswerPerAsk) from its read of the chat until it closes the ask.
    const hooks: Hooks = {
      runStarts: (by) => gate(`${by}'s answer reads the chat`).pipe(Effect.as("succeeds" as const)),
    };
    for (const name of who) {
      const { principal, requestId, content } = TOOL_ANSWERERS[name];
      const params = {
        request_id: `${requestId}@${id}`,
        session_id: chat.sessionId,
        ask_id: ask!.id,
        response: { kind: "tool", content, is_error: false },
      };
      harness.fork(
        name,
        gate(`${name} sends`).pipe(
          Effect.andThen(server.runCall(principal, "ask.respond", params)),
          Effect.exit,
          Effect.tap((exit) => Effect.sync(() => (system.answers[name] = answerOf(exit)))),
          Effect.provideService(Caller, { name, hooks }),
        ),
      );
    }
    await harness.settle();
    return system;
  },
  actions: (system) =>
    gateActions<ToolAsk>(
      system.harness,
      () => true,
      () => [],
      () => undefined,
    ),
  observe: async (system) => {
    const resolved = await run(
      store.sql<{
        outcome: string;
        content: string | null;
      }>`SELECT json_extract(event, '$.payload.outcome') AS outcome, json_extract(event, '$.payload.response.content') AS content
        FROM caveman_sp_events WHERE session_id = ${system.sessionId} AND type = 'ask.resolved' ORDER BY cursor`.pipe(
        Effect.orDie,
      ),
    );
    const [state] = await run(
      store.sql<{
        state: string;
      }>`SELECT state FROM caveman_sp_thread_state WHERE thread_id = ${system.threadId}`.pipe(
        Effect.orDie,
      ),
    );
    const asks = Object.values(
      (JSON.parse(state?.state ?? "{}") as { asks?: Record<string, string> }).asks ?? {},
    );
    return {
      resolved: resolved.map((r) =>
        r.content === null ? r.outcome : `${r.outcome}: ${r.content}`,
      ),
      ask: asks[0] ?? "none",
      answers: { ...system.answers },
      call: system.call,
      ...system.harness.snapshot(),
    };
  },
  invariants: {
    "the journal holds at most one ask.resolved": (o) => (o.resolved as Array<string>).length <= 1,
    "each answer hears the truth: ok only if it closed the ask, refused only once it was closed": (
      o,
    ) => {
      const [closed] = o.resolved as Array<string>;
      const answers = o.answers as Partial<Record<keyof typeof TOOL_ANSWERERS, string>>;
      return who.every((by) => {
        const answer = answers[by];
        const mine = `answered: ${TOOL_ANSWERERS[by].content}`;
        if (answer === undefined) return true;
        if (answer === "ok") return closed === mine;
        if (answer === ALREADY) return closed?.startsWith("answered: ") === true && closed !== mine;
        return (
          answer === "invalid_state: this tool call was cancelled (the turn stopped)" &&
          closed === "cancelled"
        );
      });
    },
  },
  atEnd: {
    "every answer is told": (o) =>
      who.every((name) => (o.answers as Record<string, string>)[name] !== undefined),
    "the chat does not wait on the ask": (o) => o.ask === "resolved",
    "the tool call reads the answer that closed the ask": (o) => {
      const [closed] = o.resolved as Array<string>;
      return closed === "cancelled"
        ? o.call === "ended without an answer"
        : o.call === `got "${closed?.slice("answered: ".length)}"`;
    },
  },
  dispose: (system) => finish(system.harness),
});

describe("one answer per ask, from devices, headless mail and a retry", () => {
  beforeAll(() => {
    Date.now = () => realNow() + clockOffset;
  });
  afterAll(() => {
    Date.now = realNow;
  });

  it("one answer reaches the engine; the rest hear it was already answered, whether or not its record caught up", async () => {
    const verdict = await checkAsync(answersSpec(["a", "a again", "phone", "mail"]));
    report("one answer per ask, four answers", verdict);
    assertHolds(verdict);
  });

  it("a custom tool call's ask is closed once, by the first answer or by the call's end, and the call reads that answer", async () => {
    const verdict = await checkAsync(toolAskSpec(["a", "a again", "mail"]));
    report("one answer per custom tool ask, three answers", verdict);
    assertHolds(verdict);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A chat's calls on one connection (server.serve over a scripted socket): laneOf keys each mutating frame by its chat,
// a call by workspace_id through sessionOfWorkspace, which the server keeps from workspace.changed. Frames arrive one
// at a time in wire order. A frame starts when once() reads its receipt and is answered when its reply is queued on the
// connection; it holds before writing its receipt until the checker lets it go. The server hears of the chats'
// workspaces when the checker says: its workspace.changed subscriber can lag behind the reply that named the chat.
// skill.record is a chat's side work (server.ts SIDE_LANES): it starts after the chat's frames before it, and only
// side work of its kind waits for it. Here it fails once started (the chat has nothing to record), so it is answered
// as soon as the checker lets it read its receipt; while it waits there it is the recording still running. The
// Browser panel's browser.navigate and browser.input are side work of the browser's lane the same way (this runtime
// has no browser, so they fail once started); while a navigation waits there it is the browser still starting.

type Frame = readonly [
  requestId: string,
  method:
    | "turn.interrupt"
    | "workspace.rename"
    | "skill.record"
    | "browser.navigate"
    | "browser.input",
  chat: "x" | "y",
];

/** The side lane of each side-work method (server.ts SIDE_LANES). */
const SIDE: Partial<Record<Frame[1], string>> = {
  "skill.record": "skill",
  "browser.navigate": "browser",
  "browser.input": "browser",
};
/** `frame` starts only once `before` (sent earlier) was answered: the same chat, unless `before` is side work of another lane. */
const waitsOn = (frame: Frame, before: Frame) =>
  before[2] === frame[2] && (SIDE[before[1]] === undefined || SIDE[before[1]] === SIDE[frame[1]]);

interface Lanes {
  readonly harness: Harness<void>;
  readonly log: Array<string>;
  readonly arrive: (frame: Frame) => Promise<void>;
  readonly hear: () => Promise<void>;
  heard: boolean;
  arrived: number;
}

interface LanesModel {
  /** Frames in wire order. turn.interrupt names its chat by session_id, workspace.rename by workspace_id. */
  readonly frames: ReadonlyArray<Frame>;
  /** When true, the server heard of the chats' workspaces before the first frame arrived. */
  readonly heardFirst: boolean;
}

const lanesSpec = (model: LanesModel): AsyncSpec<Lanes, Record<string, unknown>> => ({
  make: async () => {
    const id = `lane-${++systems}`;
    const chats = { x: await putChat(`${id}-x`), y: await putChat(`${id}-y`) };
    const harness = await openSystem();
    const gate = gatesFrom(harness.gates).gate;
    const log: Array<string> = [];
    const frameOf = (requestId: string) => requestId.slice(0, requestId.indexOf("@"));
    const hooks: Hooks = {
      beforeReceiptRead: (_who, requestId) =>
        Effect.sync(() => log.push(`start ${frameOf(requestId)}`)).pipe(
          Effect.andThen(gate(`${frameOf(requestId)} reads the receipt`)),
        ),
      beforeReceiptWrite: (_who, requestId) => gate(`${frameOf(requestId)} writes the receipt`),
      dispatch: () => Effect.succeed({}),
    };
    const inbox: Array<string> = [];
    let wake: (() => void) | undefined;
    const socket = {
      reader: Effect.succeed({
        pull: Effect.callback<ReadonlyArray<string>>((resume) => {
          const take = () => resume(Effect.succeed(inbox.splice(0)));
          if (inbox.length > 0) take();
          else wake = take;
          return Effect.sync(() => void (wake = undefined));
        }),
        upgrade: () => Effect.void,
      }),
      writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
    } as unknown as Socket.Socket;
    const before = new Set(liveOutboxes);
    harness.fork(
      "connection",
      server
        .serve(socket, "local")
        .pipe(Effect.provideService(Caller, { name: "connection", hooks })),
    );
    await harness.settle();
    const outbox = [...liveOutboxes].find((candidate) => !before.has(candidate))!;
    const push = outbox.push.bind(outbox);
    outbox.push = (frame: string) => {
      const reply = JSON.parse(frame) as { id?: unknown };
      if (typeof reply.id === "string") log.push(`answer ${frameOf(reply.id)}`);
      push(frame);
    };
    const pushLatest = outbox.pushLatest.bind(outbox);
    let heardOf = 0;
    let onHeard: (() => void) | undefined;
    outbox.pushLatest = (key: string, frame: string) => {
      if (key.startsWith("workspace:")) heardOf++;
      pushLatest(key, frame);
      onHeard?.();
    };
    const system: Lanes = {
      harness,
      log,
      heard: false,
      arrived: 0,
      arrive: async ([requestId, method, chat]) => {
        log.push(`arrive ${requestId}`);
        const request_id = `${requestId}@${id}`;
        const params =
          method === "turn.interrupt"
            ? { request_id, session_id: chats[chat].sessionId }
            : method === "skill.record"
              ? { request_id, session_id: chats[chat].sessionId, scope: "me" }
              : method === "browser.navigate"
                ? { request_id, workspace_id: chats[chat].workspace.id, url: "https://example.com" }
                : method === "browser.input"
                  ? { request_id, workspace_id: chats[chat].workspace.id, events: [] }
                  : {
                      request_id,
                      workspace_id: chats[chat].workspace.id,
                      title: `renamed by ${requestId}`,
                    };
        inbox.push(JSON.stringify({ jsonrpc: "2.0", id: request_id, method, params }));
        wake?.();
        await harness.settle();
      },
      // The server's subscriber runs on the runtime's own fibers, as long as its reads take: wait until it told this
      // connection of both chats.
      hear: async () => {
        const target = heardOf + 2;
        const heard = new Promise<void>(
          (resolve) => (onHeard = () => void (heardOf >= target && resolve())),
        );
        await run(
          Effect.all([
            store.publishWorkspace(chats.x.workspace),
            store.publishWorkspace(chats.y.workspace),
          ]),
        );
        await heard;
        onHeard = undefined;
        await harness.settle();
      },
    };
    if (model.heardFirst) {
      await system.hear();
      system.heard = true;
    }
    return system;
  },
  actions: (system) => {
    const next = model.frames[system.arrived];
    return [
      ...gateActions<Lanes>(
        system.harness,
        () => true,
        () => [],
        () => undefined,
      ),
      ...(next === undefined
        ? []
        : [
            {
              name: `${next[0]} arrives`,
              run: async () => {
                system.arrived++;
                await system.arrive(next);
              },
            },
          ]),
      ...(system.heard
        ? []
        : [
            {
              name: "the server hears of the chats' workspaces",
              run: async () => {
                system.heard = true;
                await system.hear();
              },
            },
          ]),
    ];
  },
  observe: (system) => ({
    log: [...system.log],
    heard: system.heard,
    ...system.harness.snapshot(),
  }),
  invariants: {
    "a chat's frames start in arrival order, each once the one before it was answered": (o) => {
      const log = o.log as Array<string>;
      return log.every((entry, at) => {
        if (!entry.startsWith("start ")) return true;
        const index = model.frames.findIndex(
          ([candidate]) => candidate === entry.slice("start ".length),
        );
        return model.frames
          .slice(0, index)
          .every(
            (before) =>
              !waitsOn(model.frames[index]!, before) ||
              log.slice(0, at).includes(`answer ${before[0]}`),
          );
      });
    },
  },
  atEnd: {
    "every frame is answered": (o) =>
      model.frames.every(([frame]) => (o.log as Array<string>).includes(`answer ${frame}`)),
  },
  dispose: (system) => finish(system.harness),
});

describe("a chat's calls on one connection run in the order they arrived", () => {
  it("FINDING: a call by workspace_id overtakes the chat's call by session_id while the server has not heard of the workspace", async () => {
    const verdict = await checkAsync(
      lanesSpec({
        frames: [
          ["stop", "turn.interrupt", "x"],
          ["rename", "workspace.rename", "x"],
        ],
        heardFirst: false,
      }),
    );
    report("lanes, before the server heard of the workspace", verdict);
    expect(
      verdict,
      "laneOf keys the rename `workspace:<id>` until sessionOfWorkspace has it (server.ts laneKey)",
    ).toMatchObject({
      ok: false,
      kind: "invariant",
      property: "a chat's frames start in arrival order, each once the one before it was answered",
    });
    expect(actionsIn(verdict), "the shortest overtake").toEqual([
      "init",
      "stop arrives",
      "rename arrives",
    ]);
  });

  it("holds once the server knows the chat: its calls by session_id and workspace_id go one after another, another chat's alongside", async () => {
    const verdict = await checkAsync(
      lanesSpec({
        frames: [
          ["stop", "turn.interrupt", "x"],
          ["other chat", "turn.interrupt", "y"],
          ["rename", "workspace.rename", "x"],
          ["stop again", "turn.interrupt", "x"],
        ],
        heardFirst: true,
      }),
    );
    report("lanes, the server knows the chats", verdict);
    assertHolds(verdict);
  });

  it("holds with the chat's side work: Record a skill starts after the chat's calls before it, and the next calls do not wait for it", async () => {
    const verdict = await checkAsync(
      lanesSpec({
        frames: [
          ["stop", "turn.interrupt", "x"],
          ["record", "skill.record", "x"],
          ["rename", "workspace.rename", "x"],
          ["record again", "skill.record", "x"],
        ],
        heardFirst: true,
      }),
    );
    report("lanes, with side work", verdict);
    assertHolds(verdict);
  });

  // Reachability: the order the side lane exists for. While its chat's lane held every call, no order reached it.
  it("a Stop sent while Record a skill runs starts before the recording is answered", async () => {
    const spec = lanesSpec({
      frames: [
        ["record", "skill.record", "x"],
        ["stop", "turn.interrupt", "x"],
      ],
      heardFirst: true,
    });
    const verdict = await checkAsync({
      ...spec,
      invariants: {
        "the Stop waits for the recording": (o) => {
          const log = o.log as Array<string>;
          return (
            !log.includes("start stop") ||
            (log.includes("answer record") &&
              log.indexOf("answer record") < log.indexOf("start stop"))
          );
        },
      },
    });
    report("lanes, a Stop beside the recording", verdict);
    expect(verdict, "server.ts laneOf puts skill.record on its side lane").toMatchObject({
      ok: false,
      kind: "invariant",
      property: "the Stop waits for the recording",
    });
    expect(actionsIn(verdict)).toEqual(["init", "record arrives", "stop arrives"]);
  });

  it("holds with the browser's side work: typing starts after the navigation before it, and the next Stop waits for neither", async () => {
    const verdict = await checkAsync(
      lanesSpec({
        frames: [
          ["stop", "turn.interrupt", "x"],
          ["navigate", "browser.navigate", "x"],
          ["type", "browser.input", "x"],
          ["stop again", "turn.interrupt", "x"],
        ],
        heardFirst: true,
      }),
    );
    report("lanes, with the browser's side work", verdict);
    assertHolds(verdict);
  });

  // Reachability: a navigation (or a Take over) can launch the browser first, for seconds. While its chat's lane held
  // it, no order reached a Stop starting meanwhile.
  it("a Stop sent while the Browser panel's navigation starts the browser starts before the navigation is answered", async () => {
    const spec = lanesSpec({
      frames: [
        ["navigate", "browser.navigate", "x"],
        ["stop", "turn.interrupt", "x"],
      ],
      heardFirst: true,
    });
    const verdict = await checkAsync({
      ...spec,
      invariants: {
        "the Stop waits for the navigation": (o) => {
          const log = o.log as Array<string>;
          return (
            !log.includes("start stop") ||
            (log.includes("answer navigate") &&
              log.indexOf("answer navigate") < log.indexOf("start stop"))
          );
        },
      },
    });
    report("lanes, a Stop beside the browser starting", verdict);
    expect(verdict, "server.ts laneOf puts the browser's calls on their side lane").toMatchObject({
      ok: false,
      kind: "invariant",
      property: "the Stop waits for the navigation",
    });
    expect(actionsIn(verdict)).toEqual(["init", "navigate arrives", "stop arrives"]);
  });
});
