// The Chief's board tools on the real board store (in-memory SQLite): a tool's write keeps what another writer committed
// while it ran, and an item whose chats run never goes back to waiting.
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { Workspace } from "@caveman-app/session-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, test } from "vitest";

import * as Board from "./Board.ts";
import type { OneChief } from "./profiles.ts";
import { type PlaybookName, PLAYBOOKS } from "./prompt.ts";
import { applyPullRequest } from "./pullRequests.ts";
import { CHIEF_SCHEMA } from "./schema.ts";
import { makeBoardStore } from "./store.ts";
import { makeChiefTools, type ChiefToolsContext } from "./tools.ts";

const t0 = "2026-11-06T09:00:00.000Z";
const me = { profile: { id: "chief-a", name: "Chief A" }, record: {} } as unknown as OneChief;
const call = { callId: "c1", runId: "r1" };

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of CHIEF_SCHEMA) yield* sql.unsafe(statement);
  const board = yield* makeBoardStore({ sql });
  yield* board.setHome("chief-a");
  // A started item, its chat w1 linked, and a queued one.
  yield* board.update("add", (items) =>
    Effect.succeed({
      write: [
        Board.start(
          Board.add(
            items,
            {
              id: "X",
              chief_id: "chief-a",
              text: "fix the login",
              source: "composer",
              state: "queued",
            },
            t0,
          ),
          ["w1"],
          t0,
        ),
      ],
      value: undefined,
    }),
  );
  yield* board.link("X", "w1");
  yield* board.update("add", (items) =>
    Effect.succeed({
      write: [
        Board.add(
          items,
          {
            id: "Y",
            chief_id: "chief-a",
            text: "tidy the docs",
            source: "composer",
            state: "queued",
          },
          t0,
        ),
      ],
      value: undefined,
    }),
  );
  // The Chief's projects read, held open while `gate` is closed (in production a read on SQLite's reader worker).
  const entered = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  yield* Deferred.succeed(gate, undefined);
  let held: { readonly entered: Deferred.Deferred<void>; readonly gate: Deferred.Deferred<void> } =
    { entered, gate };
  const ctx = {
    board,
    store: {},
    deps: { projects: Effect.succeed([]) },
    chiefOf: () => Effect.succeed(me),
    isLive: () => Effect.succeed(true),
    projectsOf: () =>
      Deferred.succeed(held.entered, undefined).pipe(
        Effect.andThen(Deferred.await(held.gate)),
        Effect.as([]),
      ),
    admit: () => Effect.void,
    runPromise: Effect.runPromise,
    markTainted: () => Effect.void,
    taintedSince: () => Effect.succeed(undefined),
    askWaitMinutes: Effect.succeed(0),
    overCap: Effect.succeed(false),
    capReason: "",
    reachable: () => Effect.succeed(true),
  } as unknown as ChiefToolsContext;
  const tools = makeChiefTools(ctx);
  const run = (name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.run("chief-thread" as never, args, call);
  const use = (name: string, args: Record<string, unknown>) =>
    Effect.promise(() => run(name, args));
  /** What the Chief reads when the tool refuses. */
  const refusal = (name: string, args: Record<string, unknown>) =>
    Effect.promise(() =>
      run(name, args).then(
        (answer) => `not refused: ${JSON.stringify(answer)}`,
        (error: Error) => error.message,
      ),
    );
  /** queue_update with `meanwhile` committed while its projects read is in flight. */
  const raced = (args: Record<string, unknown>, meanwhile: Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      held = { entered: yield* Deferred.make<void>(), gate: yield* Deferred.make<void>() };
      const running = yield* Effect.forkChild(use("queue_update", args));
      yield* Deferred.await(held.entered);
      yield* meanwhile;
      yield* Deferred.succeed(held.gate, undefined);
      return yield* Fiber.join(running);
    });
  return { board, use, refusal, raced };
});

const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))));

describe("mission fields on queue tools", () => {
  test("add and update accept proof and day/week pace; empty proof and null pace clear them", () =>
    run(
      Effect.gen(function* () {
        const { board, use } = yield* harness;
        const added = (yield* use("queue_add", {
          text: "Keep CI green",
          done_when: "  CI green for a week  ",
          check_in: "day",
        })) as { item_id: string };
        expect(yield* board.get(added.item_id)).toMatchObject({
          done_when: "CI green for a week",
          check_in: "day",
        });
        const first = (yield* board.get(added.item_id))!;
        expect(first.checked_at).toBeDefined();
        expect(Board.checkInDue(first, Date.now())).toBe(false);
        // An old mission gets a whole pace from the tool write, not from creation or its last check-in.
        yield* board.update("age", () =>
          Effect.succeed({ write: [{ ...first, checked_at: t0 }], value: undefined }),
        );
        yield* use("queue_update", {
          item_id: added.item_id,
          done_when: "x".repeat(280),
          check_in: "week",
        });
        expect(yield* board.get(added.item_id)).toMatchObject({
          done_when: "x".repeat(280),
          check_in: "week",
        });
        const changed = (yield* board.get(added.item_id))!;
        expect(changed.checked_at).not.toBe(t0);
        expect(Board.checkInDue(changed, Date.now())).toBe(false);
        yield* use("queue_update", { item_id: added.item_id, title: "CI" });
        expect(yield* board.get(added.item_id)).toMatchObject({
          done_when: "x".repeat(280),
          check_in: "week",
        });
        yield* use("queue_update", { item_id: added.item_id, done_when: " \n ", check_in: null });
        expect(yield* board.get(added.item_id)).not.toHaveProperty("done_when");
        expect(yield* board.get(added.item_id)).not.toHaveProperty("check_in");
        expect((yield* board.get(added.item_id))?.checked_at).toBe(changed.checked_at);
      }),
    ));

  test("invalid proof or pace refuses add/update before writing anything", () =>
    run(
      Effect.gen(function* () {
        const { board, refusal } = yield* harness;
        const before = yield* board.all;
        for (const tool of ["queue_add", "queue_update"]) {
          for (const done_when of ["x".repeat(281), 42, null]) {
            expect(yield* refusal(tool, { item_id: "Y", text: "CI", done_when })).toContain(
              "done_when must be a string of at most 280 characters",
            );
          }
          for (const check_in of ["hour", "daily", "", 7, true]) {
            expect(yield* refusal(tool, { item_id: "Y", text: "CI", check_in })).toContain(
              "check_in must be day, week or null",
            );
          }
        }
        expect(yield* board.all).toEqual(before);
      }),
    ));
});

describe("react", () => {
  test("refuses another Chief's item and a note that was never delivered", () =>
    run(
      Effect.gen(function* () {
        const { board, refusal } = yield* harness;
        yield* board.update("add", (items) =>
          Effect.succeed({
            write: [
              Board.add(
                items,
                { id: "other", chief_id: "chief-b", text: "their note", source: "composer" },
                t0,
              ),
            ],
            value: undefined,
          }),
        );
        expect(yield* refusal("react", { item_id: "other", emoji: "👍" })).toContain(
          "No item other on the board.",
        );
        expect(yield* refusal("react", { item_id: "Y", emoji: "👍" })).toContain(
          "no delivered message to react to",
        );
      }),
    ));
});

describe("queue_update keeps a board write that landed while it ran", () => {
  test("the watcher moves the item to review as its chat finishes while the Chief retitles it: it stays in review, retitled", () =>
    run(
      Effect.gen(function* () {
        const { board, raced } = yield* harness;
        const watcher = board.update("watch", (items) =>
          Effect.succeed({
            write: [
              Board.watched(
                items.find((i) => i.id === "X")!,
                { kind: "review" },
                new Date().toISOString(),
              ),
            ],
            value: undefined,
          }),
        );
        yield* raced({ item_id: "X", title: "Login fix" }, watcher);
        expect(yield* board.get("X")).toMatchObject({ title: "Login fix", state: "review" });
      }),
    ));

  test("its pull request merges while the Chief retitles it: it stays done, with the pull request", () =>
    run(
      Effect.gen(function* () {
        const { board, raced } = yield* harness;
        const merged = {
          id: "w1",
          title: "chat w1",
          updated_at: t0,
          pull_request: { number: 7, url: "https://github.com/o/r/pull/7", state: "merged" },
        } as unknown as Workspace;
        yield* raced({ item_id: "X", title: "Login fix" }, applyPullRequest({ board }, merged));
        expect(yield* board.get("X")).toMatchObject({
          title: "Login fix",
          state: "done",
          pull_request: { number: 7, state: "merged" },
        });
      }),
    ));
});

describe("an item whose chats run never goes back to waiting", () => {
  test("a check-in on it is refused, and its chat finishing still moves it", () =>
    run(
      Effect.gen(function* () {
        const { board, refusal } = yield* harness;
        expect(
          yield* refusal("schedule", { item_id: "X", at: "2026-11-06T09:30:00.000Z" }),
        ).toMatch(/X is started/);
        expect(yield* board.get("X")).toMatchObject({ state: "started", workspace_ids: ["w1"] });
        expect((yield* board.get("X"))?.not_before).toBeUndefined();
        yield* board.update("watch", (items) =>
          Effect.succeed({
            write: [
              Board.watched(
                items.find((i) => i.id === "X")!,
                { kind: "done" },
                new Date().toISOString(),
              ),
            ],
            value: undefined,
          }),
        );
        expect((yield* board.get("X"))?.state).toBe("done");
      }),
    ));

  test("queue_update can't queue it again or make it wait for another item; a title, done or dropped still land", () =>
    run(
      Effect.gen(function* () {
        const { board, use, refusal } = yield* harness;
        expect(yield* refusal("queue_update", { item_id: "X", state: "queued" })).toMatch(
          /X is started/,
        );
        expect(yield* refusal("queue_update", { item_id: "X", after_item_id: "Y" })).toMatch(
          /X is started/,
        );
        expect(yield* board.get("X")).toMatchObject({ state: "started" });
        expect((yield* board.get("X"))?.blocked_on).toBeUndefined();
        expect(yield* use("queue_update", { item_id: "X", title: "Login fix" })).toMatchObject({
          item_id: "X",
          state: "started",
        });
        expect(yield* use("queue_update", { item_id: "X", state: "done" })).toMatchObject({
          item_id: "X",
          state: "done",
        });
      }),
    ));

  test("an item that waits is still scheduled, queued or made to wait", () =>
    run(
      Effect.gen(function* () {
        const { board, use } = yield* harness;
        expect(yield* use("schedule", { item_id: "Y", at: "2026-11-06T10:30:00+01:00" })).toEqual({
          item_id: "Y",
          not_before: "2026-11-06T09:30:00.000Z",
        });
        expect(yield* board.get("Y")).toMatchObject({
          state: "scheduled",
          not_before: "2026-11-06T09:30:00.000Z",
        });
        expect(yield* use("queue_update", { item_id: "Y", state: "queued" })).toMatchObject({
          item_id: "Y",
          state: "queued",
        });
        expect(yield* use("queue_update", { item_id: "Y", after_item_id: "X" })).toMatchObject({
          item_id: "Y",
          state: "blocked",
        });
      }),
    ));
});

describe("playbook", () => {
  test("reads any playbook whole by its name, and refuses a name that is none", () =>
    run(
      Effect.gen(function* () {
        const { use, refusal } = yield* harness;
        for (const name of Object.keys(PLAYBOOKS) as ReadonlyArray<PlaybookName>)
          expect(yield* use("playbook", { name })).toBe(PLAYBOOKS[name]);
        expect(yield* refusal("playbook", { name: "toString" })).toMatch(
          /^No playbook toString: one of result, /,
        );
      }),
    ));
});
