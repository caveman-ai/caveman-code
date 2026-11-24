import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { BuilderError, parseControl, type BuilderStart, type ScheduleControl } from "./builders.ts";
import { cloudNextRunAt, cloudScheduleProblem, makeCloudScheduleStore } from "./cloudSchedules.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");

const harness = (options: { readonly startFails?: boolean } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const starts: Array<BuilderStart> = [];
    const controls: Array<ScheduleControl> = [];
    const store = yield* makeCloudScheduleStore({
      sql,
      now: () => NOW,
      chatOf: (threadId) =>
        Effect.succeed(
          threadId === "caveman:lead"
            ? { workspaceId: "lead", projectId: "project", engine: "codex" }
            : undefined,
        ),
      start: (input) =>
        options.startFails
          ? Effect.fail(
              new BuilderError({ reason: "unavailable", message: "Sign in to Caveman first." }),
            )
          : Effect.sync(
              () => (
                starts.push(input),
                {
                  workspaceId: "builder-ws",
                  where: "cloud" as const,
                  title: input.title ?? "",
                  engine: "codex",
                }
              ),
            ),
      control: (_id, control) => Effect.sync(() => void controls.push(control)),
    });
    const create = (
      by: "agent" | "person",
      schedule: Record<string, unknown> = { type: "interval", everyMs: 3_600_000 },
    ) =>
      store.service.create({
        threadId: "caveman:lead",
        title: "Sweep",
        prompt: "sweep",
        schedule,
        requestKey: `${by}-${starts.length}-${Math.random()}`,
        by,
      });
    return { store, starts, controls, create };
  });

describe("Cloud schedules", () => {
  it.effect(
    "an agent's waits for the person: nothing starts until they allow it, then a builder holds the schedule",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const made = yield* h.create("agent");
        expect(made).toMatchObject({ state: "awaiting_approval", nextRunAt: null });
        expect(h.starts).toEqual([]);
        const allowed = yield* h.store.service.allow(made.id);
        expect(allowed).toMatchObject({
          state: "active",
          builderWorkspaceId: "builder-ws",
          nextRunAt: "2026-11-06T13:00:00.000Z",
        });
        expect(h.starts).toEqual([
          {
            parentThreadId: "caveman:lead",
            task: "sweep",
            title: "Sweep",
            requestKey: `schedule:${made.id}`,
            schedule: { type: "interval", everyMs: 3_600_000 },
          },
        ]);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("the person's own starts at once", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* h.create("person")).toMatchObject({ state: "active" });
      expect(h.starts).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "one that could not start still waits for the person, with why, so allowing it again retries",
    () =>
      Effect.gen(function* () {
        const failing = yield* harness({ startFails: true });
        const made = yield* failing.create("agent");
        const refused = yield* failing.store.service.allow(made.id).pipe(Effect.flip);
        expect(refused.message).toBe("Sign in to Caveman first.");
        expect(yield* failing.store.service.get(made.id)).toMatchObject({
          state: "awaiting_approval",
          nextRunAt: null,
          lastError: "Sign in to Caveman first.",
          builderWorkspaceId: null,
        });
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "an agent's change to its work, or turning it back on, waits again and pauses it meanwhile; pausing never waits",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const made = yield* h.create("agent");
        yield* h.store.service.allow(made.id);
        expect(yield* h.store.service.update(made.id, { enabled: false }, "agent")).toMatchObject({
          state: "active",
          enabled: false,
        });
        expect(h.controls.at(-1)).toMatchObject({ enabled: false });
        expect(yield* h.store.service.update(made.id, { enabled: true }, "agent")).toMatchObject({
          state: "awaiting_approval",
        });
        yield* h.store.service.allow(made.id);
        expect(
          yield* h.store.service.update(made.id, { prompt: "sweep harder" }, "agent"),
        ).toMatchObject({ state: "awaiting_approval", prompt: "sweep harder" });
        expect(h.controls.at(-1)).toEqual({ enabled: false });
        // A title alone changes no work: it goes straight through.
        yield* h.store.service.allow(made.id);
        expect(
          yield* h.store.service.update(made.id, { title: "Nightly sweep" }, "agent"),
        ).toMatchObject({ state: "active" });
        // The person's own change goes straight to its builder.
        const changed = yield* h.store.service.update(
          made.id,
          { schedule: { type: "fixed_time", timeOfDay: "02:00" } },
          "person",
        );
        expect(changed).toMatchObject({ state: "active", nextRunAt: "2026-11-07T02:00:00.000Z" });
        expect(h.controls.at(-1)).toEqual({
          enabled: true,
          title: "Nightly sweep",
          prompt: "sweep harder",
          schedule: { type: "fixed_time", timeOfDay: "02:00" },
        });
        expect(h.starts).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("each run is recorded; deleting it ends it on its computer", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const made = yield* h.create("person");
      expect(yield* h.store.ran(made.id, { status: "failed", text: "the tests did not run" })).toBe(
        "live",
      );
      expect(yield* h.store.service.get(made.id)).toMatchObject({
        runCount: 1,
        lastStatus: "failed",
        lastError: "the tests did not run",
      });
      yield* h.store.service.remove(made.id);
      expect(h.controls.at(-1)).toEqual({ delete: true });
      expect(yield* h.store.service.get(made.id)).toBeUndefined();
      expect(yield* h.store.ran(made.id, { status: "completed", text: "late" })).toBe("done");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("needs a chat to wake, and never takes a webhook", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const noChat = yield* h.store.service
        .create({
          threadId: "caveman:else",
          title: "x",
          prompt: "x",
          schedule: { type: "interval", everyMs: 60_000 },
          requestKey: "k",
          by: "agent",
        })
        .pipe(Effect.flip);
      expect(noChat.reason).toBe("invalid_request");
      expect((yield* h.create("agent", { type: "webhook" }).pipe(Effect.flip)).reason).toBe(
        "invalid_request",
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

describe("a Cloud schedule's times", () => {
  it("counts on its Cloud computer's clock, UTC, as that computer will", () => {
    expect(cloudNextRunAt({ type: "fixed_time", timeOfDay: "09:00" }, true, NOW)).toBe(
      "2026-11-07T09:00:00.000Z",
    );
    expect(cloudNextRunAt({ type: "interval", everyMs: 60_000 }, false, NOW)).toBeNull();
    expect(cloudNextRunAt({ type: "lunar" }, true, NOW)).toBeNull();
    expect(cloudScheduleProblem({ type: "lunar" })).toMatch(/not one this computer can read/);
  });
});

describe("a schedule control", () => {
  it("keeps only what it knows, and refuses what is no object", () => {
    expect(parseControl('{"enabled":false,"prompt":"  ","run_now":true,"evil":1}')).toEqual({
      enabled: false,
      run_now: true,
    });
    expect(parseControl('{"schedule":{"type":"interval","everyMs":60000},"delete":true}')).toEqual({
      schedule: { type: "interval", everyMs: 60000 },
      delete: true,
    });
    expect(parseControl("[1]")).toBeUndefined();
    expect(parseControl("not json")).toBeUndefined();
  });
});
