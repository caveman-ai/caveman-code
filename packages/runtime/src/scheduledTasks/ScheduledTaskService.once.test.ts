// One-time runs, missed runs, run counts and repeat anchors through the real service and its scheduler.
// The first three tests port upstream 4ac97be2b6 (#28104), apps/server/src/scheduledTasks/ScheduledTaskService.interval.test.ts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vitest";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

afterEach(() => vi.unstubAllEnvs());

const folders = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
  namedProjectsRoot: "/projects",
  isScratchProject: () => Effect.succeed(false),
});
const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Scheduler.layer,
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: () => Effect.die("synthetic dispatch failure"),
  }),
  folders,
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = {
  commandId: "once-run",
  title: "Cut the release branch",
  prompt: "Cut the 2.0 release branch from main.",
  enabled: true,
  projectId: "project-once",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

// Each launch takes two minutes, so a manual run can start before the run time and end after it.
const slowLaunchLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.merge(
      dependencies,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () => TestClock.adjust("2 minutes").pipe(Effect.andThen(Effect.die("synthetic"))),
      }),
    ),
  ),
);

it.effect("runs a one-time schedule once and rejects past times", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:59:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({
        ...input,
        schedule: { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
      });
      const created = yield* service.upsert(decoded);
      expect(created.task.schedule).toEqual({ type: "once", runAt: "2026-11-01T08:00:00.000Z" });
      expect(created.task.nextRunAt).toBe("2026-11-01T08:00:00.000Z");

      // A manual run that starts before the time keeps the scheduled run, even if it ends after.
      const early = yield* service.runNow({ id: created.task.id });
      expect(early.task.nextRunAt).toBe("2026-11-01T08:00:00.000Z");

      const due = yield* service.runNow({ id: created.task.id });
      expect(due.task.nextRunAt).toBeNull();
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBeNull();

      yield* service.setEnabled({ id: created.task.id, enabled: false });
      const resumed = yield* service
        .setEnabled({ id: created.task.id, enabled: true })
        .pipe(Effect.flip);
      expect(resumed.message).toBe("The run time has passed. Pick a time in the future.");

      const past = yield* service
        .upsert({ ...decoded, commandId: undefined, title: "Late" })
        .pipe(Effect.flip);
      expect(past.message).toBe("The run time has passed. Pick a time in the future.");
    }).pipe(Effect.provide(slowLaunchLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

const ONCE = { type: "once", runAt: "2026-11-01T08:00:00Z" } as const;
/** A next run that only the simulated concurrent write produces. */
const MOVED = "2030-01-01T00:00:00.000Z";
const onceInput = { ...input, commandId: "once-race", schedule: ONCE };

it.effect.each([
  { change: "a run completes", saved: ONCE, edited: ONCE, pause: false, expected: MOVED },
  {
    change: "a run completes during a padded-time edit",
    saved: { type: "fixed_time", timeOfDay: "9:00" },
    edited: { type: "fixed_time", timeOfDay: "09:00" },
    pause: false,
    expected: MOVED,
  },
  {
    change: "another client pauses the task",
    saved: ONCE,
    edited: ONCE,
    pause: true,
    expected: "2026-11-01T08:00:00.000Z",
  },
] as const)(
  "a title save keeps the stored next run only while nothing else changed: $change",
  ({ saved, edited, pause, expected }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
      // The project check runs between the save's read and write, so it stands in for
      // a concurrent write in that gap.
      const writeMidSave = Layer.unwrap(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () =>
              sql`UPDATE scheduled_tasks SET next_run_at = ${MOVED}, enabled = ${pause ? 0 : 1}`.pipe(
                Effect.as(false),
                Effect.orDie,
              ),
          });
        }),
      );
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(Layer.merge(dependencies, writeMidSave)),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const worktree = { type: "worktree", baseRef: "main" };
        yield* service.upsert(
          yield* decodeInput({
            ...onceInput,
            schedule: saved,
            workspaceStrategy: { type: "root" },
          }),
        );
        const renamed = yield* service.upsert(
          yield* decodeInput({
            ...onceInput,
            schedule: edited,
            workspaceStrategy: worktree,
            title: "Renamed",
          }),
        );
        expect(renamed.task.enabled).toBe(true);
        expect(renamed.task.nextRunAt).toBe(expected);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.provideService(ServerActivation, Effect.never),
      Effect.provide(SqlitePersistence.layerMemory),
    ),
);

it.effect("keeps a one-time run after a restart interrupts an earlier manual run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:59:00.000Z"));
    const sql = yield* SqlClient.SqlClient;
    const created = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* service.upsert(yield* decodeInput(onceInput));
    }).pipe(Effect.provide(serviceLayer));
    yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', last_run_at = '2026-11-01T07:59:00.000Z'`;

    yield* TestClock.setTime(Date.parse("2026-11-01T08:05:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const [task] = (yield* service.list()).tasks;
      expect(task?.id).toBe(created.task.id);
      expect(task?.lastRunStatus).toBe("failed");
      expect(task?.nextRunAt).toBe("2026-11-01T08:00:00.000Z");
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

/**
 * The service with its scheduler live (ticking every 5 s of test time) and launches that succeed and are counted.
 * The clock is set before the scheduler starts: moving it with setTime under a sleeping scheduler stalls the test.
 */
const live = <A, E>(
  startAt: string,
  body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    launches: Ref.Ref<number>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(startAt));
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread-launched") } as never),
              ),
          }),
          folders,
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body(service, launches);
    }).pipe(Effect.provide(layer));
  });

/** Saves a task with the scheduler parked, as the app does before it sleeps or quits. */
const saveParked = (at: string, task: unknown) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(at));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert(yield* decodeInput(task));
    }).pipe(Effect.provide(serviceLayer), Effect.provideService(ServerActivation, Effect.never));
  });

/** Moves test time on in scheduler ticks, letting each tick's run finish. */
const ticks = (count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i += 1) {
      yield* TestClock.adjust("5 seconds");
      for (let j = 0; j < 20; j += 1) yield* Effect.yieldNow;
    }
  });

it.effect("the scheduler fires a one-time task at its time, once", () =>
  live("2026-11-01T07:59:30.000Z", (service, launches) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(yield* decodeInput({ ...input, schedule: ONCE }));
      yield* ticks(2);
      expect(yield* Ref.get(launches)).toBe(0);
      yield* ticks(6);
      expect(yield* Ref.get(launches)).toBe(1);
      const [task] = (yield* service.list()).tasks;
      expect(task?.id).toBe(created.task.id);
      expect(task?.lastRunStatus).toBe("succeeded");
      expect(task?.nextRunAt).toBeNull();
      expect(task?.scheduledRunCount).toBe(1);
      // Visible as done: still listed and enabled, with nothing left to run.
      expect(task?.enabled).toBe(true);
      yield* ticks(20);
      expect(yield* Ref.get(launches)).toBe(1);
    }),
  ).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a one-time run missed by more than ten minutes is recorded as missed, not run", () =>
  Effect.gen(function* () {
    yield* saveParked("2026-11-01T07:59:30.000Z", { ...input, schedule: ONCE });
    // The computer sleeps through the run time and the runtime wakes two hours later.
    yield* live("2026-11-01T10:00:00.000Z", (service, launches) =>
      Effect.gen(function* () {
        yield* ticks(2);
        expect(yield* Ref.get(launches)).toBe(0);
        const [task] = (yield* service.list()).tasks;
        expect(task?.nextRunAt).toBeNull();
        expect(task?.lastRunStatus).toBe("failed");
        expect(task?.lastRunError).toMatch(
          /^Missed: the runtime was asleep or closed at 2026-11-01T08:00:00.000Z/,
        );
        expect(task?.runCount).toBe(0);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a one-time run up to ten minutes late still runs", () =>
  Effect.gen(function* () {
    yield* saveParked("2026-11-01T07:59:30.000Z", { ...input, schedule: ONCE });
    // The runtime wakes nine minutes after the run time.
    yield* live("2026-11-01T08:09:00.000Z", (_service, launches) =>
      Effect.gen(function* () {
        yield* ticks(1);
        expect(yield* Ref.get(launches)).toBe(1);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a repeat stops after maxRuns scheduled runs, and runs by hand do not count", () =>
  live("2026-11-01T08:00:00.000Z", (service, launches) =>
    Effect.gen(function* () {
      const created = yield* service.upsert(
        yield* decodeInput({
          ...input,
          schedule: { type: "interval", everyMs: 60_000, maxRuns: 2 },
        }),
      );
      yield* service.runNow({ id: created.task.id });
      expect(yield* Ref.get(launches)).toBe(1);
      yield* ticks(12 * 4);
      expect(yield* Ref.get(launches)).toBe(3);
      const [task] = (yield* service.list()).tasks;
      expect(task?.scheduledRunCount).toBe(2);
      expect(task?.runCount).toBe(3);
      expect(task?.nextRunAt).toBeNull();

      // A changed schedule counts afresh.
      const edited = yield* service.upsert(
        yield* decodeInput({
          ...input,
          schedule: { type: "interval", everyMs: 60_000, maxRuns: 3 },
        }),
      );
      expect(edited.task.scheduledRunCount).toBe(0);
      expect(edited.task.nextRunAt).not.toBeNull();
    }),
  ).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("anchors every-N-weeks at the first save and keeps the anchor on later saves", () =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "UTC");
    yield* TestClock.setTime(Date.parse("2026-11-04T12:00:00.000Z")); // a Wednesday
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const fortnightly = {
        ...input,
        schedule: {
          type: "fixed_time",
          timeOfDay: "09:00",
          weekdays: [1],
          everyWeeks: 2,
          timeZone: "UTC",
        },
      };
      const created = yield* service.upsert(yield* decodeInput(fortnightly));
      expect(created.task.schedule).toMatchObject({ startAt: "2026-11-04T12:00:00.000Z" });
      // Monday of the anchor's week has passed; the next is two weeks on.
      expect(created.task.nextRunAt).toBe("2026-11-16T09:00:00.000Z");

      yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
      const resaved = yield* service.upsert(
        yield* decodeInput({ ...fortnightly, title: "Renamed" }),
      );
      expect(resaved.task.schedule).toMatchObject({ startAt: "2026-11-04T12:00:00.000Z" });
      expect(resaved.task.nextRunAt).toBe("2026-11-16T09:00:00.000Z");
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("refuses a cron expression croner cannot read", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const failure = yield* service
        .upsert(
          yield* decodeInput({
            ...input,
            schedule: { type: "cron", expression: "0 25 * * *", timeZone: "UTC" },
          }),
        )
        .pipe(Effect.flip);
      expect(failure.message).toMatch(/^The cron expression "0 25 \* \* \*" is not valid/);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);
