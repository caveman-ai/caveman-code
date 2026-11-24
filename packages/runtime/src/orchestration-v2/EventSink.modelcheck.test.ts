/**
 * Model check of EventSink's delivery promise over every schedule of two or three writers and one or two subscribers.
 *
 * The real EventSink and stores run on a real SQLite file inside an @caveman-app/model-check harness, either through
 * SqlitePersistence.layerFromPath (the production layer: WAL, reader worker, checkpoint worker) or through the
 * single-connection client layerMemory uses. Gates sit only in test wrappers around real services:
 *   - a writer parks before it starts, and inside EventStore.publishCommitted: after its COMMIT, before any
 *     subscriber hears of it;
 *   - a subscriber parks before it subscribes, and on either side of EventStore.latestSequence, its replay
 *     high-water read (which runs on the reader worker in production, so writers can move during it).
 * A statement transformer fails a chosen statement of a writer with a real SQLite error. The reference is the
 * committed log read back through a second, read-only connection, which never sees an open transaction.
 *
 * Skill: .claude/skills/event-sink-delivery/SKILL.md
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@caveman-app/protocol";
import {
  type Action,
  type AsyncSpec,
  assertHolds,
  checkAsync,
  FaultPlan,
  formatTrace,
  macrotask,
  replay,
  type Verdict,
} from "@caveman-app/model-check";
import { Gates, gate, openHarness, type Harness } from "@caveman-app/model-check/effect";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

/** Which writer or subscriber a fiber is, so the wrappers know whose gate to park it at. */
const Actor = Context.Reference<string>("EventSink.modelcheck/Actor", { defaultValue: () => "" });

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const isoAt = "2026-11-06T12:00:00.000Z";
const at = DateTime.makeUnsafe(isoAt);
const threadA = ThreadId.make("thread:a");
const threadB = ThreadId.make("thread:b");
const threadC = ThreadId.make("thread:c");
const threadD = ThreadId.make("thread:d");
const runR = RunId.make("run:r");
const runR2 = RunId.make("run:r2");
const attemptX = RunAttemptId.make("attempt:x");

const appThread = (id: ThreadId): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: ProjectId.make(`project:${id}`),
  title: `Thread ${id}`,
  providerInstanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const startingRun: OrchestrationV2Run = {
  id: runR,
  threadId: threadA,
  ordinal: 1,
  providerInstanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:r"),
  rootNodeId: null,
  activeAttemptId: attemptX,
  status: "starting",
  queuePosition: null,
  requestedAt: at,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

/** The next turn on thread A, queued behind R. */
const queuedRun: OrchestrationV2Run = {
  ...startingRun,
  id: runR2,
  ordinal: 2,
  userMessageId: MessageId.make("message:r2"),
  activeAttemptId: null,
  status: "queued",
  queuePosition: 1,
};

const threadCreated = (id: ThreadId, eventId: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(eventId),
  type: "thread.created",
  threadId: id,
  providerInstanceId,
  occurredAt: at,
  payload: appThread(id),
});

const threadRenamed = (id: ThreadId, eventId: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(eventId),
  type: "thread.metadata-updated",
  threadId: id,
  providerInstanceId,
  occurredAt: at,
  payload: { ...appThread(id), title: `Renamed ${id}` },
});

const runCreated = (eventId: string, run: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(eventId),
  type: "run.created",
  threadId: run.threadId,
  runId: run.id,
  providerInstanceId,
  occurredAt: at,
  payload: run,
});

const runUpdated = (eventId: string, run: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
  id: EventId.make(eventId),
  type: "run.updated",
  threadId: run.threadId,
  runId: run.id,
  providerInstanceId,
  occurredAt: at,
  payload: run,
});

const cleanup = (id: string, commandId: string, threadId: ThreadId) => ({
  id,
  commandId: CommandId.make(commandId),
  threadId,
  request: { type: "terminal.cleanup" as const },
});

/**
 * Committed in the template every run starts from: thread A (sequence 1), its run R, starting (sequence 2), and the
 * next run R2, queued behind R (sequence 3).
 */
const seed: ReadonlyArray<OrchestrationV2DomainEvent> = [
  threadCreated(threadA, "event:a:created"),
  runCreated("event:r:created", startingRun),
  runCreated("event:r2:created", queuedRun),
];

interface Services {
  readonly sink: EventSink.EventSinkV2Shape;
  readonly sql: SqlClient.SqlClient;
}

interface ReturnedReceipt {
  readonly threadId: string;
  readonly status: string;
  readonly resultSequence: number;
}

/** What a writer's call returned: whether it says it committed, and for command calls the receipt and events. */
interface Outcome {
  readonly committed: boolean;
  readonly receipt?: ReturnedReceipt;
  readonly events?: ReadonlyArray<string>;
}

interface Writer {
  readonly name: string;
  /** Events it appends: it committed exactly when they are in the log. */
  readonly eventIds: ReadonlyArray<string>;
  readonly effectIds: ReadonlyArray<string>;
  readonly command?: { readonly id: string; readonly threadId: ThreadId };
  readonly run: (services: Services) => Effect.Effect<Outcome, unknown, Gates>;
}

interface Subscriber {
  readonly name: string;
  readonly options: NonNullable<Parameters<EventSink.EventSinkV2Shape["stream"]>[0]>;
}

interface Scenario {
  readonly database: "reader worker" | "single connection";
  readonly writers: ReadonlyArray<Writer>;
  readonly subscribers: ReadonlyArray<Subscriber>;
  readonly faults?: boolean;
}

const returned = (
  receipt: CommandReceiptStore.CommandReceiptV2,
  stored: ReadonlyArray<OrchestrationV2StoredEvent>,
) => ({
  receipt: {
    threadId: receipt.threadId,
    status: receipt.status,
    resultSequence: receipt.resultSequence,
  },
  events: stored.map((event) => event.event.id),
});

/** writeIfRunCurrent: run R starting -> running, if it is still starting; enqueues effect:w1. */
const startRun: Writer = {
  name: "w1",
  eventIds: ["event:r:running"],
  effectIds: ["effect:w1"],
  run: ({ sink }) =>
    sink
      .writeIfRunCurrent({
        threadId: threadA,
        runId: runR,
        activeAttemptId: attemptX,
        expectedStatus: "starting",
        events: [
          runUpdated("event:r:running", { ...startingRun, status: "running", startedAt: at }),
        ],
        effects: [cleanup("effect:w1", "command:w1", threadA)],
      })
      .pipe(Effect.map(({ committed }) => ({ committed }))),
};

/**
 * write, one batch of two run.updated events: stop thread A, run R and the queued R2 -> cancelled. Both match every
 * subscriber here (s3 included), so the order and completeness of one batch's publish reach each of them.
 */
const cancelRun: Writer = {
  name: "w2",
  eventIds: ["event:r:cancelled", "event:r2:cancelled"],
  effectIds: [],
  run: ({ sink }) =>
    sink
      .write({
        events: [
          runUpdated("event:r:cancelled", { ...startingRun, status: "cancelled", completedAt: at }),
          runUpdated("event:r2:cancelled", {
            ...queuedRun,
            status: "cancelled",
            queuePosition: null,
            completedAt: at,
          }),
        ],
      })
      .pipe(Effect.as({ committed: true })),
};

/** commitCommand creating thread T and renaming it (two events of different types) under a command id, with one effect. */
const commitCommand = (name: string, commandId: string, threadId: ThreadId): Writer => {
  const created = `event:${name}:${threadId}:created`;
  const renamed = `event:${name}:${threadId}:renamed`;
  return {
    name,
    eventIds: [created, renamed],
    effectIds: [`effect:${name}`],
    command: { id: commandId, threadId },
    run: ({ sink }) =>
      sink
        .commitCommand({
          commandId: CommandId.make(commandId),
          threadId,
          commandType: "thread.create",
          acceptedAt: at,
          events: [threadCreated(threadId, created), threadRenamed(threadId, renamed)],
          effects: [cleanup(`effect:${name}`, commandId, threadId)],
        })
        .pipe(
          Effect.map((result) => ({
            committed: result.committed,
            ...returned(result.receipt, result.storedEvents),
          })),
        ),
  };
};

const commitRejectedCommand = (name: string, commandId: string, threadId: ThreadId): Writer => ({
  name,
  eventIds: [],
  effectIds: [],
  command: { id: commandId, threadId },
  run: ({ sink }) =>
    sink
      .commitRejectedCommand({
        commandId: CommandId.make(commandId),
        threadId,
        commandType: "thread.create",
        rejectedAt: at,
        error: "refused",
      })
      .pipe(
        Effect.map((receipt) => ({ committed: false, receipt: returned(receipt, []).receipt })),
      ),
});

/**
 * LegacyV1ThreadImporter.reconcileShells: eventSink.write inside the importer's own sql.withTransaction, then the
 * importer's INSERT into orchestration_v2_legacy_imports, then the outer COMMIT.
 */
const importThreadC: Writer = {
  name: "w4",
  eventIds: ["event:c:created"],
  effectIds: [],
  run: ({ sink, sql }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sink.write({ events: [threadCreated(threadC, "event:c:created")] });
          yield* gate("w4 outer statement");
          yield* sql`
            INSERT INTO orchestration_v2_legacy_imports (
              thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
              imported_message_count, last_error
            )
            VALUES (${threadC}, ${isoAt}, ${isoAt}, NULL, 0, NULL)
          `;
        }),
      )
      .pipe(Effect.as({ committed: true })),
};

interface Row {
  readonly sequence: number;
  readonly id: string;
  readonly threadId: string;
  readonly type: string;
  readonly commandId: string | null;
  readonly runId: string | null;
  readonly runStatus: string | null;
}

const matches = (subscriber: Subscriber, row: Row) =>
  row.sequence > (subscriber.options.afterSequence ?? 0) &&
  (subscriber.options.threadId === undefined || row.threadId === subscriber.options.threadId) &&
  (subscriber.options.eventType === undefined || row.type === subscriber.options.eventType);

interface Observation {
  /** The committed event log, read through the observer connection. */
  readonly log: ReadonlyArray<Row>;
  readonly projection: {
    readonly lastSequence: number | null;
    /** [run id, status] per projected run, by run id. */
    readonly runs: ReadonlyArray<readonly [string, string]>;
    readonly threads: ReadonlyArray<string>;
  };
  readonly outbox: ReadonlyArray<string>;
  readonly receipts: ReadonlyArray<ReturnedReceipt & { readonly commandId: string }>;
  /** [sequence, event id] in delivery order, per subscriber. */
  readonly delivered: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>>;
  readonly outcomes: Readonly<Record<string, Outcome | "failed">>;
  /** Sum of counts passed to EffectOutbox.notifyAvailable. */
  readonly woken: number;
  readonly fault: string | null;
  readonly parked: ReadonlyArray<string>;
  /**
   * What the rows above cannot show but a subscriber's future depends on: the order of publishes, how many had
   * happened at each of a subscriber's steps (so where it subscribed and read), and the high-water it read.
   */
  readonly published: ReadonlyArray<string>;
  readonly publishesSeen: Readonly<Record<string, ReadonlyArray<number>>>;
  readonly highWater: Readonly<Record<string, number>>;
  /**
   * Where each writer is that no gate shows: statements it has run (0 while it waits for the writer connection;
   * all of its transaction's while it holds the transaction and waits for the publish lane).
   */
  readonly progress: Readonly<Record<string, number>>;
  /**
   * Who waits for the writer connection, first in line first. The client's Semaphore wakes waiters in the order they
   * queued, so this decides which writer commits next and whether a subscriber's read sees that commit.
   */
  readonly queue: ReadonlyArray<string>;
}

interface System {
  readonly scenario: Scenario;
  readonly file: string;
  readonly delivered: Record<string, Array<readonly [number, string]>>;
  readonly outcomes: Record<string, Outcome | "failed">;
  readonly faults: FaultPlan;
  fault: { readonly writer: string; readonly statement: number; fired: boolean } | undefined;
  readonly statements: Record<string, number>;
  woken: number;
  /** Subscriber reads in flight on the reader worker. */
  inflight: number;
  /** Subscribers with a read started and not finished: on a single connection, waiting for the writer connection. */
  readonly reading: Set<string>;
  /** Steps taken so far, and the step at which each actor's latest gate was released (when it joined a queue). */
  tick: number;
  readonly released: Record<string, number>;
  readonly published: Array<string>;
  /** Per subscriber, how many publishes had happened when each of its gates was released. */
  readonly publishesSeen: Record<string, Array<number>>;
  readonly highWater: Record<string, number>;
  harness: Harness<Services>;
  observer: DatabaseSync;
}

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "event-sink-modelcheck-"));
const template = NodePath.join(scratch, "template.sqlite");
let runs = 0;

const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(References.MinimumLogLevel, "None"));

beforeAll(async () => {
  await Effect.runPromise(
    quiet(
      Effect.gen(function* () {
        yield* (yield* EventSink.EventSinkV2).write({ events: seed });
      }).pipe(
        Effect.provide(
          EventSink.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStoreWithV1.layer)),
            Layer.provideMerge(SqlitePersistence.layerFromPath(template)),
          ),
        ),
        Effect.provide(NodeServices.layer),
      ),
    ),
  );
  const db = new DatabaseSync(template);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
});

beforeAll(async () => {
  for (const writer of [startRun, cancelRun, importThreadC]) await countStatements(writer);
});

afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** layerMemory's single-connection client, on a file so the observer can read it; per-connection pragmas as in Sqlite.ts. */
const singleConnection = (file: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA synchronous = NORMAL;`;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: file })));

const servicesFor = (system: System) =>
  Effect.gen(function* () {
    const gates = yield* Gates;
    const subscribers = new Set(system.scenario.subscribers.map((subscriber) => subscriber.name));
    const inflight = (delta: number) =>
      Effect.withFiber((fiber) => {
        const actor = fiber.getRef(Actor);
        system.inflight += delta;
        if (subscribers.has(actor)) {
          if (delta > 0) system.reading.add(actor);
          else system.reading.delete(actor);
        }
        return Effect.void;
      });
    const watchedEventStore = Layer.effect(
      EventStore.EventStoreV2,
      Effect.gen(function* () {
        const real = yield* EventStore.EventStoreV2;
        return EventStore.EventStoreV2.of({
          ...real,
          publishCommitted: (events) =>
            Effect.withFiber((fiber) => {
              const actor = fiber.getRef(Actor);
              return (actor === "" ? Effect.void : gates.gate(`${actor} publish`)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    system.published.push(events.map((event) => event.sequence).join("+"));
                  }),
                ),
                Effect.andThen(real.publishCommitted(events)),
              );
            }),
          latestSequence: (input) =>
            Effect.withFiber((fiber) => {
              const actor = fiber.getRef(Actor);
              const read = Effect.acquireUseRelease(
                inflight(1),
                () => real.latestSequence(input),
                () => inflight(-1),
              );
              return subscribers.has(actor)
                ? gates.gate(`${actor} read high-water`).pipe(
                    Effect.andThen(read),
                    Effect.tap((highWater) =>
                      Effect.sync(() => {
                        system.highWater[actor] = highWater;
                      }),
                    ),
                    Effect.tap(() => gates.gate(`${actor} replay`)),
                  )
                : read;
            }),
          read: (input) =>
            Stream.unwrap(
              Effect.as(inflight(1), real.read(input).pipe(Stream.ensuring(inflight(-1)))),
            ),
        });
      }),
    );
    const watchedOutbox = Layer.effect(
      EffectOutbox.EffectOutboxV2,
      Effect.gen(function* () {
        const real = yield* EffectOutbox.EffectOutboxV2;
        return EffectOutbox.EffectOutboxV2.of({
          ...real,
          notifyAvailable: (count) =>
            Effect.sync(() => {
              system.woken += count ?? 1;
            }).pipe(Effect.andThen(real.notifyAvailable(count))),
        });
      }),
    );
    const database =
      system.scenario.database === "reader worker"
        ? SqlitePersistence.layerFromPath(system.file).pipe(Layer.provide(NodeServices.layer))
        : singleConnection(system.file);
    const context = yield* Layer.build(
      EventSink.layerFromStores.pipe(
        Layer.provide(watchedEventStore),
        Layer.provide(watchedOutbox),
        Layer.provideMerge(
          Layer.mergeAll(
            EventStore.layer,
            ProjectionStoreWithV1.layer,
            EffectOutbox.layer,
            CommandReceiptStore.layer,
            ProjectStore.layer,
            TurnItemPositionStore.layer,
          ),
        ),
        Layer.provideMerge(database),
      ),
    );
    return {
      sink: Context.get(context, EventSink.EventSinkV2),
      sql: Context.get(context, SqlClient.SqlClient),
    } satisfies Services;
  });

/** Fails the armed writer's statement with a real SQLite error ("no such table") when its fault comes due. */
const faultInjector =
  (system: System): Statement.Transformer =>
  (statement, sql, fiber) =>
    Effect.sync(() => {
      const actor = fiber.getRef(Actor);
      system.statements[actor] = (system.statements[actor] ?? 0) + 1;
      const fault = system.fault;
      if (fault === undefined || fault.fired || fault.writer !== actor) return statement;
      try {
        system.faults.hit();
        return statement;
      } catch {
        fault.fired = true;
        return sql.unsafe(`SELECT * FROM "fault injected at statement ${fault.statement}"`);
      }
    });

/**
 * The harness settles fibers, not worker threads. On the reader worker a subscriber's read is real I/O, so wait for
 * it too; it never waits on a writer. On a single connection every statement is synchronous and a read may wait on a
 * writer's lock that only a later step releases, so settling is enough.
 */
const quiesce = async (system: System) => {
  if (system.scenario.database === "single connection") return system.harness.settle();
  do {
    while (system.inflight > 0) await macrotask();
    await system.harness.settle();
  } while (system.inflight > 0);
};

const make = (scenario: Scenario) => async (): Promise<System> => {
  const file = NodePath.join(scratch, `run-${runs++}.sqlite`);
  NodeFS.copyFileSync(template, file);
  const system = {
    scenario,
    file,
    delivered: Object.fromEntries(scenario.subscribers.map((subscriber) => [subscriber.name, []])),
    outcomes: {},
    faults: new FaultPlan(),
    fault: undefined,
    statements: {},
    woken: 0,
    inflight: 0,
    reading: new Set(),
    tick: 0,
    released: {},
    published: [],
    publishesSeen: Object.fromEntries(
      scenario.subscribers.map((subscriber) => [subscriber.name, []]),
    ),
    highWater: {},
  } as Omit<System, "harness" | "observer"> as System;
  system.harness = await openHarness(quiet(servicesFor(system)));
  const { sink } = system.harness.value;
  // Opens the reader worker before any schedule runs, so no step waits on its startup.
  await system.harness.run(sink.latestSequence());
  system.observer = new DatabaseSync(file, { readOnly: true });
  for (const writer of scenario.writers) {
    system.harness.fork(
      writer.name,
      gate(`${writer.name} start`).pipe(
        Effect.andThen(writer.run(system.harness.value)),
        Effect.tap((outcome) =>
          Effect.sync(() => {
            system.outcomes[writer.name] = outcome;
          }),
        ),
        Effect.tapCause(() =>
          Effect.sync(() => {
            system.outcomes[writer.name] = "failed";
          }),
        ),
        Effect.provideService(Actor, writer.name),
        Effect.provideService(Statement.CurrentTransformer, faultInjector(system)),
        quiet,
      ),
    );
  }
  for (const subscriber of scenario.subscribers) {
    system.harness.fork(
      subscriber.name,
      gate(`${subscriber.name} subscribe`).pipe(
        Effect.andThen(
          sink.stream(subscriber.options).pipe(
            Stream.runForEach((stored) =>
              Effect.sync(() => {
                system.delivered[subscriber.name]!.push([stored.sequence, stored.event.id]);
              }),
            ),
          ),
        ),
        Effect.provideService(Actor, subscriber.name),
        quiet,
      ),
    );
  }
  await quiesce(system);
  return system;
};

const observe = (system: System): Observation => {
  const db = system.observer;
  const all = <T>(sql: string, ...params: Array<string>) =>
    (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(
      (row) => ({ ...row }) as T,
    );
  const log = all<Row>(
    `SELECT sequence, event_id AS id, stream_id AS threadId, event_type AS type, command_id AS commandId,
            CASE WHEN event_type IN ('run.created', 'run.updated') THEN json_extract(payload_json, '$.id') END AS runId,
            CASE WHEN event_type IN ('run.created', 'run.updated') THEN json_extract(payload_json, '$.status') END AS runStatus
     FROM orchestration_events
     WHERE application_event_version = 2 AND aggregate_kind = 'thread'
     ORDER BY sequence`,
  );
  const [metadata] = all<{ lastSequence: number }>(
    "SELECT last_sequence AS lastSequence FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'",
  );
  const parked = system.harness.gates.parked();
  const atGate = (actor: string) => parked.some((gateName) => gateName.startsWith(`${actor} `));
  // A writer past its start gate that has run no statement is waiting for the writer connection (BEGIN does not go
  // through the statement transformer); a subscriber read still open at quiescence is too (single connection only:
  // quiesce waits for reader-worker reads).
  const waiting = [
    ...system.scenario.writers
      .map((writer) => writer.name)
      .filter(
        (name) =>
          system.outcomes[name] === undefined &&
          !atGate(name) &&
          (system.statements[name] ?? 0) === 0,
      ),
    ...system.reading,
  ];
  return {
    log,
    projection: {
      lastSequence: metadata?.lastSequence ?? null,
      runs: all<{ id: string; status: string }>(
        "SELECT run_id AS id, status FROM orchestration_v2_projection_runs ORDER BY run_id",
      ).map((row) => [row.id, row.status] as const),
      threads: all<{ id: string }>(
        "SELECT thread_id AS id FROM orchestration_v2_projection_threads ORDER BY thread_id",
      ).map((row) => row.id),
    },
    outbox: all<{ id: string }>(
      "SELECT effect_id AS id FROM orchestration_v2_effect_outbox ORDER BY effect_id",
    ).map((row) => row.id),
    receipts: all<Observation["receipts"][number]>(
      `SELECT command_id AS commandId, aggregate_id AS threadId, status, result_sequence AS resultSequence
       FROM orchestration_command_receipts ORDER BY command_id`,
    ),
    delivered: Object.fromEntries(
      Object.entries(system.delivered).map(([name, events]) => [name, [...events]]),
    ),
    outcomes: { ...system.outcomes },
    woken: system.woken,
    fault:
      system.fault === undefined
        ? null
        : `${system.fault.writer}'s statement ${system.fault.statement} ${system.fault.fired ? "failed" : "armed"}`,
    parked,
    published: [...system.published],
    publishesSeen: Object.fromEntries(
      Object.entries(system.publishesSeen).map(([name, seen]) => [name, [...seen]]),
    ),
    highWater: { ...system.highWater },
    progress: Object.fromEntries(
      system.scenario.writers.map((writer) => [writer.name, system.statements[writer.name] ?? 0]),
    ),
    queue: waiting.sort(
      (a, b) => (system.released[a] ?? 0) - (system.released[b] ?? 0) || a.localeCompare(b),
    ),
  };
};

/** Statements each writer's call runs when nothing fails, counted once by running it alone. */
const statementCounts = new Map<string, number>();
const statementsOf = (writer: Writer) => {
  const count = statementCounts.get(writer.name);
  if (count === undefined) throw new Error(`count ${writer.name}'s statements in beforeAll first`);
  return count;
};
const countStatements = async (writer: Writer) => {
  const system = await make({
    database: "single connection",
    writers: [writer],
    subscribers: [],
  })();
  while (system.harness.gates.parked().length > 0) {
    await system.harness.step(system.harness.gates.parked()[0]!);
  }
  expect(system.outcomes[writer.name], `${writer.name} runs alone`).toMatchObject({
    committed: true,
  });
  statementCounts.set(writer.name, system.statements[writer.name] ?? 0);
  process.stdout.write(
    `[event-sink-delivery] ${writer.name} runs ${statementCounts.get(writer.name)} statements alone\n`,
  );
  await spec({ database: "single connection", writers: [writer], subscribers: [] }).dispose!(
    system,
  );
};

/** Every parked gate is a step; while no fault is armed, so is arming one on any statement of a writer yet to start. */
const actions = (system: System, observation: Observation): ReadonlyArray<Action<System>> => {
  const steps: Array<Action<System>> = observation.parked.map((name) => ({
    name,
    run: async () => {
      const actor = name.split(" ")[0]!;
      system.publishesSeen[actor]?.push(system.published.length);
      system.released[actor] = ++system.tick;
      await system.harness.step(name);
      await quiesce(system);
    },
  }));
  if (system.scenario.faults !== true || system.fault !== undefined) return steps;
  for (const writer of system.scenario.writers) {
    if (!observation.parked.includes(`${writer.name} start`)) continue;
    for (let statement = 1; statement <= statementsOf(writer); statement++) {
      steps.push({
        name: `fault: ${writer.name}'s statement ${statement} fails`,
        run: () => {
          system.fault = { writer: writer.name, statement, fired: false };
          system.faults.arm(statement);
        },
      });
    }
  }
  return steps;
};

const properties = (scenario: Scenario) => {
  const subscriber = (name: string) => scenario.subscribers.find((s) => s.name === name)!;
  const inLog = (o: Observation, id: string) => o.log.some((row) => row.id === id);
  const committed = (o: Observation, writer: Writer) =>
    writer.eventIds.length > 0 && writer.eventIds.every((id) => inLog(o, id));
  const sequences = (events: ReadonlyArray<readonly [number, string]>) =>
    events.map(([sequence]) => sequence).join(",");
  return {
    invariants: {
      "a subscriber receives only committed events, under the sequence they committed at": (
        o: Observation,
      ) =>
        Object.values(o.delivered).every((events) =>
          events.every(([sequence, id]) =>
            o.log.some((row) => row.sequence === sequence && row.id === id),
          ),
        ),
      "a subscriber receives each event once, in increasing sequence": (o: Observation) =>
        Object.values(o.delivered).every((events) =>
          events.every((event, index) => index === 0 || events[index - 1]![0] < event[0]),
        ),
      "a subscriber never skips a committed event it matches": (o: Observation) =>
        Object.entries(o.delivered).every(([name, events]) => {
          const last = events.at(-1)?.[0] ?? 0;
          const due = o.log.filter((row) => matches(subscriber(name), row) && row.sequence <= last);
          return due.map((row) => row.sequence).join(",") === sequences(events);
        }),
      "the projection and its last_sequence match the committed log": (o: Observation) => {
        // Each run's latest status in the log, in log order: a later event of the same run overwrites an earlier one.
        const runs = new Map<string, string>();
        for (const row of o.log) if (row.runId !== null) runs.set(row.runId, row.runStatus ?? "");
        const threads = o.log
          .filter((row) => row.type === "thread.created")
          .map((row) => row.threadId)
          .sort();
        return (
          o.projection.lastSequence === (o.log.at(-1)?.sequence ?? null) &&
          JSON.stringify(o.projection.runs) ===
            JSON.stringify([...runs].sort(([a], [b]) => a.localeCompare(b))) &&
          o.projection.threads.join(",") === threads.join(",")
        );
      },
      "a writer's events, outbox rows and receipt commit together or not at all": (
        o: Observation,
      ) =>
        scenario.writers.every((writer) => {
          const rows = writer.effectIds.filter((id) => o.outbox.includes(id)).length;
          const present = writer.eventIds.filter((id) => inLog(o, id)).length;
          if (present !== 0 && present !== writer.eventIds.length) return false;
          if (!committed(o, writer)) return rows === 0;
          if (rows !== writer.effectIds.length) return false;
          if (writer.command === undefined) return true;
          const receipt = o.receipts.find((r) => r.commandId === writer.command!.id);
          const last = Math.max(
            ...o.log.filter((row) => writer.eventIds.includes(row.id)).map((row) => row.sequence),
          );
          return (
            receipt?.status === "accepted" &&
            receipt.threadId === writer.command.threadId &&
            receipt.resultSequence === last
          );
        }),
      "the effect worker is woken only for committed outbox rows": (o: Observation) =>
        o.woken <= o.outbox.length,
      "a command id commits at most once, and every caller gets its one stored receipt": (
        o: Observation,
      ) =>
        scenario.writers.every((writer) => {
          if (writer.command === undefined) return true;
          const id = writer.command.id;
          const owners = scenario.writers.filter(
            (other) => other.command?.id === id && committed(o, other),
          );
          if (owners.length > 1) return false;
          const outcome = o.outcomes[writer.name];
          if (outcome === undefined || outcome === "failed") return true;
          const stored = o.receipts.find((r) => r.commandId === id);
          const events = o.log.filter((row) => row.commandId === id).map((row) => row.id);
          return (
            stored !== undefined &&
            outcome.receipt?.threadId === stored.threadId &&
            outcome.receipt.status === stored.status &&
            outcome.receipt.resultSequence === stored.resultSequence &&
            (outcome.events === undefined || outcome.events.join(",") === events.join(",")) &&
            outcome.committed === committed(o, writer)
          );
        }),
    },
    atEnd: {
      "every subscriber has every committed event it matches": (o: Observation) =>
        Object.entries(o.delivered).every(
          ([name, events]) =>
            sequences(events) ===
            o.log
              .filter((row) => matches(subscriber(name), row))
              .map((row) => row.sequence)
              .join(","),
        ),
      "every committed outbox row woke the effect worker": (o: Observation) =>
        o.woken === o.outbox.length,
      "only a writer whose statement was failed fails": (o: Observation) =>
        scenario.writers.every(
          (writer) =>
            o.outcomes[writer.name] !== "failed" ||
            (o.fault?.startsWith(`${writer.name}'s statement `) === true &&
              o.fault.endsWith(" failed")),
        ),
    },
  };
};

const spec = (scenario: Scenario): AsyncSpec<System, Observation> => ({
  make: make(scenario),
  actions,
  observe,
  ...properties(scenario),
  dispose: async (system) => {
    // A writer parked at its publish gate is uninterruptible (EventSink commitThenPublish), so release every gate
    // before closing. fairRound would also move the clock and fire the reader worker's startup timeout.
    for (let round = 0; round < 20 && system.harness.gates.parked().length > 0; round++) {
      system.harness.gates.releaseAll();
      await quiesce(system);
    }
    await system.harness.close();
    system.observer.close();
    for (const suffix of ["", "-wal", "-shm"])
      NodeFS.rmSync(`${system.file}${suffix}`, { force: true });
  },
});

const show = (o: Observation) =>
  [
    `log ${o.log.map((row) => `${row.sequence}:${row.id}`).join(" ")}`,
    ...Object.entries(o.delivered).map(
      ([name, events]) =>
        `${name} got ${events.map(([sequence, id]) => `${sequence}:${id}`).join(" ") || "nothing"}`,
    ),
    `outbox [${o.outbox.join(" ")}] woken ${o.woken}`,
    `receipts ${o.receipts.map((r) => `${r.commandId}=${r.threadId}/${r.status}@${r.resultSequence}`).join(" ") || "none"}`,
    `returned ${JSON.stringify(o.outcomes)}`,
    ...(o.fault === null ? [] : [`fault ${o.fault}`]),
  ].join("\n     ");

const check = async (label: string, scenario: Scenario): Promise<Verdict<Observation>> => {
  const started = performance.now();
  const verdict = await checkAsync(spec(scenario));
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    verdict.ok
      ? `[event-sink-delivery] ${label}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}, ${seconds}s\n`
      : `[event-sink-delivery] ${label}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states, ${seconds}s)\n${formatTrace(verdict.trace, show)}\n${verdict.error === undefined ? "" : `  error: ${String(verdict.error)}\n`}`,
  );
  return verdict;
};

const verify = async (label: string, scenario: Scenario) =>
  assertHolds(await check(label, scenario), { show });

const s1: Subscriber = { name: "s1", options: { afterSequence: 0 } };

describe("EventSink delivers each committed event once, in order, and nothing else (every schedule)", () => {
  it("to a worker-style subscriber replaying from 0 on the reader worker", () =>
    verify("unbounded, reader worker", {
      database: "reader worker",
      writers: [startRun, cancelRun],
      subscribers: [s1],
    }));

  it("to a bounded RPC subscriber of thread A after sequence 1", () =>
    verify("bounded thread A, reader worker", {
      database: "reader worker",
      writers: [startRun, cancelRun],
      subscribers: [
        { name: "s2", options: { threadId: threadA, afterSequence: 1, bounded: true } },
      ],
    }));

  it("to a reactor subscribed to one event type", () =>
    verify("typed run.updated, reader worker", {
      database: "reader worker",
      writers: [startRun, cancelRun],
      subscribers: [{ name: "s3", options: { eventType: "run.updated" } }],
    }));

  it("from writeIfRunCurrent, write and commitCommand, on the single connection layerMemory uses", () =>
    verify("three writers, single connection", {
      database: "single connection",
      writers: [startRun, cancelRun, commitCommand("x1", "command:c1", threadB)],
      subscribers: [s1],
    }));

  it("to two subscribers of different kinds at once, on the single connection layerMemory uses", () =>
    verify("two subscribers, single connection", {
      database: "single connection",
      writers: [startRun],
      subscribers: [s1, { name: "s3", options: { eventType: "run.updated" } }],
    }));

  it("when any statement of a writer fails: nothing of it commits, publishes or wakes", () =>
    verify("statement faults, single connection", {
      database: "single connection",
      writers: [startRun, cancelRun],
      subscribers: [s1],
      faults: true,
    }));

  it("for command ids: a retry, a reuse on another thread and a rejection never commit twice", () =>
    verify("command ids, single connection", {
      database: "single connection",
      writers: [
        commitCommand("x1", "command:c1", threadB),
        commitCommand("x2", "command:c1", threadB),
        commitCommand("x3", "command:c1", threadC),
        commitRejectedCommand("x4", "command:c2", threadD),
        commitCommand("x5", "command:c2", threadD),
      ],
      subscribers: [],
    }));

  it("to a subscriber while a command id is retried and reused: only the call that commits publishes", () =>
    verify("command retry with a subscriber, single connection", {
      database: "single connection",
      writers: [
        commitCommand("x1", "command:c1", threadB),
        commitCommand("x2", "command:c1", threadB),
        commitCommand("x3", "command:c1", threadC),
      ],
      subscribers: [s1],
    }));
});

describe("the observation keeps states apart that the code would run differently", () => {
  // w1 committed and parked at its publish holding the lane; w2 holds the transaction and waits for the lane. Then s1's
  // high-water read and x1 queue for the writer connection in either order, and w1 publishes.
  const queued: Scenario = {
    database: "single connection",
    writers: [startRun, cancelRun, commitCommand("x1", "command:c1", threadB)],
    subscribers: [s1],
  };
  it.each([
    { order: ["s1 read high-water", "x1 start"], next: "s1" },
    { order: ["x1 start", "s1 read high-water"], next: "x1" },
  ])(
    "the writer connection goes to $next, the first of $order to queue",
    async ({ order, next }) => {
      const rerun = await replay(spec(queued), [
        "w1 start",
        "w2 start",
        "s1 subscribe",
        ...order,
        "w1 publish",
      ]);
      const waiting = rerun.steps.at(-2)!.state;
      expect(waiting.queue).toEqual(order.map((step) => step.split(" ")[0]));
      expect(waiting.progress.w2, "w2 holds the transaction").toBeGreaterThan(0);
      expect(waiting.progress.x1, "x1 waits for the connection").toBe(0);
      const end = rerun.steps.at(-1)!.state;
      if (next === "s1") {
        expect(end.highWater.s1, "s1 read after w2's COMMIT, before x1 ran").toBe(6);
        expect(end.queue).toEqual([]);
      } else {
        expect(end.highWater.s1, "s1 still waits behind x1's transaction").toBeUndefined();
        expect(end.queue).toEqual(["s1"]);
      }
      expect(end.progress.x1, "x1 got the connection and waits for the lane").toBeGreaterThan(0);
      await spec(queued).dispose!(rerun.system);
    },
  );
});

const nested: Scenario = {
  database: "reader worker",
  writers: [importThreadC, cancelRun],
  subscribers: [s1],
};
const nestedWithFaults: Scenario = { ...nested, faults: true };

describe("finding: eventSink.write inside an outer sql.withTransaction publishes before the outer COMMIT", () => {
  it("the checker finds a subscriber holding an event that is not committed", async () => {
    const verdict = await check("nested writer (finding), reader worker", nested);
    expect(verdict).toMatchObject({
      ok: false,
      kind: "invariant",
      property: "a subscriber receives only committed events, under the sequence they committed at",
    });
  });

  it("an outer rollback leaves the subscriber with a phantom event, and the next commit reuses its sequence", async () => {
    const rerun = await replay(spec(nestedWithFaults), [
      "s1 subscribe",
      "s1 read high-water",
      "s1 replay",
      `fault: w4's statement ${statementsOf(importThreadC)} fails`,
      "w4 start",
      "w4 publish",
      "w4 outer statement",
      "w2 start",
      "w2 publish",
    ]);
    const end = rerun.steps.at(-1)!.state;
    expect(
      end.outcomes.w4,
      "the importer's INSERT failed and the outer transaction rolled back",
    ).toBe("failed");
    expect(end.log.map((row) => `${row.sequence}:${row.id}`)).toEqual([
      "1:event:a:created",
      "2:event:r:created",
      "3:event:r2:created",
      "4:event:r:cancelled",
      "5:event:r2:cancelled",
    ]);
    expect(
      end.delivered.s1,
      "s1 got thread C's creation, which never committed, then a second sequence 4",
    ).toEqual([
      [1, "event:a:created"],
      [2, "event:r:created"],
      [3, "event:r2:created"],
      [4, "event:c:created"],
      [4, "event:r:cancelled"],
      [5, "event:r2:cancelled"],
    ]);
    await spec(nested).dispose!(rerun.system);
  });

  it("a subscriber that joins between the inner publish and the outer COMMIT never gets the event", async () => {
    const rerun = await replay(spec(nested), [
      "w4 start",
      "w4 publish",
      "s1 subscribe",
      "s1 read high-water",
      "s1 replay",
      "w4 outer statement",
      "w2 start",
      "w2 publish",
    ]);
    const end = rerun.steps.at(-1)!.state;
    expect(end.log.map((row) => `${row.sequence}:${row.id}`)).toEqual([
      "1:event:a:created",
      "2:event:r:created",
      "3:event:r2:created",
      "4:event:c:created",
      "5:event:r:cancelled",
      "6:event:r2:cancelled",
    ]);
    expect(
      end.delivered.s1,
      "s1 read high-water 3 before the outer COMMIT and missed the live publish of 4",
    ).toEqual([
      [1, "event:a:created"],
      [2, "event:r:created"],
      [3, "event:r2:created"],
      [5, "event:r:cancelled"],
      [6, "event:r2:cancelled"],
    ]);
    await spec(nested).dispose!(rerun.system);
  });
});
