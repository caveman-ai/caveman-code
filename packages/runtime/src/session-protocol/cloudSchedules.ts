// Cloud schedules: work an agent in a chat here scheduled to run on Cloud, so it runs while this computer is closed.
// Each is a builder on a Cloud computer of its own (builders.ts) that holds the schedule
// on its own chat as a scheduled task; Cloud wakes that computer for each run (cloudLink/scheduleWake.ts), and each
// run's last answer comes back by mail and wakes the chat that set it. This computer keeps the record, listed beside
// its own scheduled tasks wherever they show: the agent's schedule_task, list_scheduled_tasks and
// delete_scheduled_task, and the Automations page.
//
// It spends computer time and credits while nobody watches, so an agent's schedule waits for the person: it is made
// awaiting approval and starts only once they allow it in the app (automation.allow). An agent's later change to what
// it runs or when puts it back to waiting, paused meanwhile. Pausing, deleting and the person's own changes never
// wait. The schedule is kept as it was given, so the Cloud computer reads every kind its build knows.
import { randomUUID } from "node:crypto";

import { ScheduledTaskSchedule } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import {
  SCHEDULE_KEY,
  type BuilderError,
  type BuilderStart,
  type BuilderStarted,
  type ScheduleControl,
} from "./builders.ts";

/** Every Cloud schedule's id starts so, which tells it from a scheduled task or an automation file. */
export const CLOUD_SCHEDULE_ID = "cloud-schedule:";

export type CloudScheduleState = "awaiting_approval" | "starting" | "active" | "failed";
export type Actor = "agent" | "person";

export interface CloudSchedule {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  /** As given: any kind a scheduled task takes, but a webhook. */
  readonly schedule: Record<string, unknown>;
  readonly enabled: boolean;
  readonly state: CloudScheduleState;
  /** The chat here that set it, which each run wakes. */
  readonly leadWorkspaceId: string;
  readonly leadThreadId: string;
  readonly projectId: string;
  readonly engine: string;
  readonly createdBy: Actor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: "never" | "running" | "succeeded" | "failed";
  readonly lastError: string | null;
  readonly runCount: number;
  /** Its builder's workspace in Cloud, once it started. */
  readonly builderWorkspaceId: string | null;
}

export class CloudScheduleError extends Schema.TaggedError<CloudScheduleError>()(
  "CloudScheduleError",
  {
    reason: Schema.Literals(["invalid_request", "not_found", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface CloudSchedulesShape {
  readonly create: (input: {
    readonly threadId: string;
    readonly title: string;
    readonly prompt: string;
    readonly schedule: Record<string, unknown>;
    readonly requestKey: string;
    readonly by: Actor;
  }) => Effect.Effect<CloudSchedule, CloudScheduleError>;
  /** Only what is given changes. An agent's change to the prompt or the schedule waits for the person again. */
  readonly update: (
    id: string,
    patch: {
      readonly title?: string;
      readonly prompt?: string;
      readonly schedule?: Record<string, unknown>;
      readonly enabled?: boolean;
    },
    by: Actor,
  ) => Effect.Effect<CloudSchedule, CloudScheduleError>;
  /** The person allows it: it starts on Cloud, or its builder takes the version allowed. Never an agent's to call. */
  readonly allow: (id: string) => Effect.Effect<CloudSchedule, CloudScheduleError>;
  readonly runNow: (id: string) => Effect.Effect<CloudSchedule, CloudScheduleError>;
  readonly remove: (id: string) => Effect.Effect<void, CloudScheduleError>;
  readonly list: () => Effect.Effect<ReadonlyArray<CloudSchedule>>;
  readonly get: (id: string) => Effect.Effect<CloudSchedule | undefined>;
}

export class CloudSchedules extends Context.Service<
  CloudSchedules,
  CloudSchedulesShape & {
    /** The route's implementation (handlers.ts); the last bind wins. */
    readonly bind: (impl: CloudSchedulesShape) => Effect.Effect<void>;
  }
>()("caveman/session-protocol/CloudSchedules") {}

const unbound = () =>
  new CloudScheduleError({
    reason: "unavailable",
    message: "Cloud schedules are not available in this runtime.",
  });

export const layer = Layer.sync(CloudSchedules, () => {
  let bound: CloudSchedulesShape | undefined;
  return CloudSchedules.of({
    create: (input) => (bound ? bound.create(input) : Effect.fail(unbound())),
    update: (id, patch, by) => (bound ? bound.update(id, patch, by) : Effect.fail(unbound())),
    allow: (id) => (bound ? bound.allow(id) : Effect.fail(unbound())),
    runNow: (id) => (bound ? bound.runNow(id) : Effect.fail(unbound())),
    remove: (id) => (bound ? bound.remove(id) : Effect.fail(unbound())),
    list: () => (bound ? bound.list() : Effect.succeed([])),
    get: (id) => (bound ? bound.get(id) : Effect.succeed(undefined)),
    bind: (impl) => Effect.sync(() => void (bound = impl)),
  });
});

// ------------------------------------------------------------------ the store

const SCHEMA = `CREATE TABLE IF NOT EXISTS caveman_sp_cloud_schedules (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  state TEXT NOT NULL,
  lead_workspace_id TEXT NOT NULL,
  lead_thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  builder_workspace_id TEXT)`;

interface Row {
  readonly id: string;
  readonly request_key: string;
  readonly title: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly enabled: number;
  readonly state: string;
  readonly lead_workspace_id: string;
  readonly lead_thread_id: string;
  readonly project_id: string;
  readonly engine: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_run_at: string | null;
  readonly last_status: string;
  readonly last_error: string | null;
  readonly run_count: number;
  readonly builder_workspace_id: string | null;
}

const decodeSchedule = Schema.decodeUnknownOption(ScheduledTaskSchedule);

/**
 * When it runs next, as its Cloud computer will count it: on that computer's clock (UTC) unless the schedule names a
 * zone. Null when it runs no more, or is a kind this build cannot read.
 */
export function cloudNextRunAt(
  schedule: Record<string, unknown>,
  enabled: boolean,
  nowMs: number,
): string | null {
  if (!enabled) return null;
  const decoded = decodeSchedule(schedule);
  if (decoded._tag === "None") return null;
  try {
    const next = nextScheduledRunAt(
      decoded.value,
      DateTime.makeZonedUnsafe(nowMs, { timeZone: "UTC" }),
    );
    return next === null ? null : DateTime.formatIso(DateTime.toUtc(next));
  } catch {
    return null;
  }
}

/** Why a schedule cannot run on Cloud, or undefined when it can. */
export function cloudScheduleProblem(schedule: Record<string, unknown>): string | undefined {
  if (schedule.type === "webhook")
    return "A webhook schedule runs where its URL is: schedule it here, not on Cloud.";
  if (decodeSchedule(schedule)._tag === "None")
    return "That schedule is not one this computer can read.";
  return undefined;
}

export interface CloudScheduleDeps {
  readonly sql: SqlClient.SqlClient;
  /** The chat a thread is, when it is one of this runtime's. */
  readonly chatOf: (
    threadId: string,
  ) => Effect.Effect<
    | { readonly workspaceId: string; readonly projectId: string; readonly engine: string }
    | undefined
  >;
  /** builders.ts start: a builder on a Cloud computer of its own that holds `schedule`. */
  readonly start: (input: BuilderStart) => Effect.Effect<BuilderStarted | undefined, BuilderError>;
  /** builders.ts controlSchedule: undefined when the schedule's builder never started. */
  readonly control: (
    scheduleId: string,
    control: ScheduleControl,
    requestId: string,
  ) => Effect.Effect<unknown, BuilderError>;
  readonly now?: () => number;
}

export const makeCloudScheduleStore = (deps: CloudScheduleDeps) =>
  Effect.gen(function* () {
    const { sql } = deps;
    const now = deps.now ?? Date.now;
    yield* sql.unsafe(SCHEMA).pipe(Effect.orDie);

    const view = (row: Row): CloudSchedule => {
      const schedule = JSON.parse(row.schedule) as Record<string, unknown>;
      const enabled = row.enabled === 1;
      return {
        id: row.id,
        title: row.title,
        prompt: row.prompt,
        schedule,
        enabled,
        state: row.state as CloudScheduleState,
        leadWorkspaceId: row.lead_workspace_id,
        leadThreadId: row.lead_thread_id,
        projectId: row.project_id,
        engine: row.engine,
        createdBy: row.created_by === "person" ? "person" : "agent",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Only a running one has a next run: one waiting for the person, or failed to start, runs nothing.
        nextRunAt:
          row.state === "active" || row.state === "starting"
            ? cloudNextRunAt(schedule, enabled, now())
            : null,
        lastRunAt: row.last_run_at,
        lastStatus: (["never", "running", "succeeded", "failed"].includes(row.last_status)
          ? row.last_status
          : "never") as CloudSchedule["lastStatus"],
        lastError: row.last_error,
        runCount: row.run_count,
        builderWorkspaceId: row.builder_workspace_id,
      };
    };

    const rowOf = (id: string) =>
      sql<Row>`SELECT * FROM caveman_sp_cloud_schedules WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      );
    const found = (id: string) =>
      rowOf(id).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.fail(
                new CloudScheduleError({
                  reason: "not_found",
                  message: `Cloud schedule ${id} was not found.`,
                }),
              )
            : Effect.succeed(row),
        ),
      );
    const iso = () => new Date(now()).toISOString();
    const builderFailure = (error: BuilderError) =>
      new CloudScheduleError({
        reason: error.reason === "invalid_request" ? "invalid_request" : "unavailable",
        message: error.message,
      });

    /** Its builder takes the version this row holds (or starts with it): what the person allowed. */
    const sendCurrent = (row: Row) =>
      Effect.gen(function* () {
        const schedule = JSON.parse(row.schedule) as Record<string, unknown>;
        if (row.builder_workspace_id === null) {
          const started = yield* deps
            .start({
              parentThreadId: row.lead_thread_id,
              task: row.prompt,
              title: row.title,
              requestKey: `${SCHEDULE_KEY}${row.id}`,
              schedule,
            })
            .pipe(Effect.mapError(builderFailure));
          if (started === undefined)
            return yield* new CloudScheduleError({
              reason: "unavailable",
              message: "This chat cannot start work on Cloud.",
            });
          yield* sql`UPDATE caveman_sp_cloud_schedules SET builder_workspace_id = ${started.workspaceId}, state = 'active', updated_at = ${iso()} WHERE id = ${row.id}`.pipe(
            Effect.orDie,
          );
          return;
        }
        yield* deps
          .control(
            row.id,
            { enabled: row.enabled === 1, title: row.title, prompt: row.prompt, schedule },
            `schedule-version:${row.id}:${row.updated_at}`,
          )
          .pipe(Effect.mapError(builderFailure));
        yield* sql`UPDATE caveman_sp_cloud_schedules SET state = 'active' WHERE id = ${row.id}`.pipe(
          Effect.orDie,
        );
      });

    const service: CloudSchedulesShape = {
      create: (input) =>
        Effect.gen(function* () {
          const again =
            (yield* sql<Row>`SELECT * FROM caveman_sp_cloud_schedules WHERE request_key = ${input.requestKey}`.pipe(
              Effect.orDie,
            ))[0];
          if (again !== undefined) return view(again);
          const problem = cloudScheduleProblem(input.schedule);
          if (problem !== undefined)
            return yield* new CloudScheduleError({ reason: "invalid_request", message: problem });
          const chat = yield* deps.chatOf(input.threadId);
          if (chat === undefined)
            return yield* new CloudScheduleError({
              reason: "invalid_request",
              message:
                "A Cloud schedule wakes the chat that set it, so it needs an agent running in a Caveman Code chat.",
            });
          const at = iso();
          const id = `${CLOUD_SCHEDULE_ID}${randomUUID()}`;
          // The person's own schedule needs no one's leave; an agent's waits for theirs.
          const state: CloudScheduleState =
            input.by === "person" ? "starting" : "awaiting_approval";
          yield* sql`INSERT INTO caveman_sp_cloud_schedules (id, request_key, title, prompt, schedule, enabled, state, lead_workspace_id, lead_thread_id, project_id, engine, created_by, created_at, updated_at)
            VALUES (${id}, ${input.requestKey}, ${input.title}, ${input.prompt}, ${JSON.stringify(input.schedule)}, 1, ${state}, ${chat.workspaceId}, ${input.threadId}, ${chat.projectId}, ${chat.engine}, ${input.by}, ${at}, ${at})`.pipe(
            Effect.orDie,
          );
          if (state === "starting")
            yield* sendCurrent((yield* rowOf(id))!).pipe(Effect.tapError(() => markFailed(id)));
          return view((yield* rowOf(id))!);
        }),
      update: (id, patch, by) =>
        Effect.gen(function* () {
          const row = yield* found(id);
          const schedule = patch.schedule ?? (JSON.parse(row.schedule) as Record<string, unknown>);
          if (patch.schedule !== undefined) {
            const problem = cloudScheduleProblem(patch.schedule);
            if (problem !== undefined)
              return yield* new CloudScheduleError({ reason: "invalid_request", message: problem });
          }
          const changesWork =
            (patch.prompt !== undefined && patch.prompt !== row.prompt) ||
            (patch.schedule !== undefined && JSON.stringify(patch.schedule) !== row.schedule);
          // An agent may pause it, but turning it back on spends again: that, and new work, wait for the person.
          const resumes = patch.enabled === true && row.enabled === 0;
          const waits =
            by === "agent" && (changesWork || resumes || row.state === "awaiting_approval");
          const enabled = patch.enabled ?? row.enabled === 1;
          const state: CloudScheduleState = waits
            ? "awaiting_approval"
            : row.state === "awaiting_approval"
              ? "awaiting_approval"
              : (row.state as CloudScheduleState);
          const next: Row = {
            ...row,
            title: patch.title ?? row.title,
            prompt: patch.prompt ?? row.prompt,
            schedule: JSON.stringify(schedule),
            enabled: enabled ? 1 : 0,
            state,
            updated_at: iso(),
          };
          yield* sql`UPDATE caveman_sp_cloud_schedules SET title = ${next.title}, prompt = ${next.prompt}, schedule = ${next.schedule}, enabled = ${next.enabled}, state = ${next.state}, updated_at = ${next.updated_at} WHERE id = ${id}`.pipe(
            Effect.orDie,
          );
          if (row.builder_workspace_id !== null) {
            // Waiting again: its builder pauses until the person allows the new version. Otherwise it takes the change.
            const control: ScheduleControl = waits
              ? { enabled: false }
              : { enabled, title: next.title, prompt: next.prompt, schedule };
            yield* deps
              .control(id, control, `schedule-version:${id}:${next.updated_at}`)
              .pipe(Effect.mapError(builderFailure));
          } else if (!waits && state === "failed" && by === "person") {
            yield* sendCurrent(next).pipe(Effect.tapError(() => markFailed(id)));
          }
          return view((yield* rowOf(id))!);
        }),
      allow: (id) =>
        Effect.gen(function* () {
          yield* found(id);
          yield* sql`UPDATE caveman_sp_cloud_schedules SET state = 'starting', enabled = 1, updated_at = ${iso()} WHERE id = ${id}`.pipe(
            Effect.orDie,
          );
          // Not started (signed out, Cloud away): it still waits for the person, who allows it again once they can.
          yield* sendCurrent({ ...(yield* rowOf(id))!, enabled: 1 }).pipe(
            Effect.tapError((error) =>
              sql`UPDATE caveman_sp_cloud_schedules SET state = 'awaiting_approval', last_error = ${error.message}, updated_at = ${iso()} WHERE id = ${id}`.pipe(
                Effect.orDie,
              ),
            ),
          );
          yield* sql`UPDATE caveman_sp_cloud_schedules SET last_error = NULL WHERE id = ${id} AND last_status <> 'failed'`.pipe(
            Effect.orDie,
          );
          return view((yield* rowOf(id))!);
        }),
      runNow: (id) =>
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.state !== "active" || row.builder_workspace_id === null)
            return yield* new CloudScheduleError({
              reason: "invalid_request",
              message: "It runs on Cloud once the person allows it.",
            });
          yield* deps
            .control(id, { run_now: true }, `schedule-run:${id}:${iso()}`)
            .pipe(Effect.mapError(builderFailure));
          return view(row);
        }),
      remove: (id) =>
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.builder_workspace_id !== null)
            yield* deps
              .control(id, { delete: true }, `schedule-delete:${id}`)
              .pipe(Effect.mapError(builderFailure));
          yield* sql`DELETE FROM caveman_sp_cloud_schedules WHERE id = ${id}`.pipe(Effect.orDie);
        }),
      list: () =>
        sql<Row>`SELECT * FROM caveman_sp_cloud_schedules ORDER BY created_at DESC, id`.pipe(
          Effect.map((rows) => rows.map(view)),
          Effect.orDie,
        ),
      get: (id) => rowOf(id).pipe(Effect.map((row) => (row === undefined ? undefined : view(row)))),
    };

    const markFailed = (id: string, state: CloudScheduleState = "failed") =>
      sql`UPDATE caveman_sp_cloud_schedules SET state = ${state}, updated_at = ${iso()} WHERE id = ${id}`.pipe(
        Effect.orDie,
      );

    /** builders.ts: one run ended on Cloud. A one-off is then done and gone; anything else lives on. */
    const ran = (id: string, result: { readonly status: string; readonly text: string }) =>
      Effect.gen(function* () {
        const row = yield* rowOf(id);
        if (row === undefined) return "done" as const;
        const ok = result.status === "completed";
        yield* sql`UPDATE caveman_sp_cloud_schedules SET last_run_at = ${iso()}, last_status = ${ok ? "succeeded" : "failed"}, last_error = ${ok ? null : result.text.slice(0, 2000)},
          run_count = run_count + 1, updated_at = ${iso()} WHERE id = ${id}`.pipe(Effect.orDie);
        const schedule = JSON.parse(row.schedule) as Record<string, unknown>;
        if (schedule.type === "once" && ok) {
          yield* sql`DELETE FROM caveman_sp_cloud_schedules WHERE id = ${id}`.pipe(Effect.orDie);
          return "done" as const;
        }
        return "live" as const;
      });

    return { service, ran } as const;
  });
