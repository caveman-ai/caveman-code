import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, test } from "vitest";

import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import * as Board from "./Board.ts";
import { CHIEF_SCHEMA } from "./schema.ts";
import { type BoardStore, makeBoardStore } from "./store.ts";
import { makeWatcher, WAKE_DEBOUNCE_MS } from "./watch.ts";

// Carried over from #52, whose own fix the merged watcher's other guards made redundant (#37's no-move replay, the
// audit's applied cursor and heard marks, #43's heard keys): these check that they do what #52 asked of them.
// The watcher on a real board and a real events table (in-memory SQLite), with the Chief faked: what it is woken with,
// across a restart of the runtime (a new board store and watcher on the same database) and a compaction of its history.
const CHIEF = "chief";
const CHIEF_SESSION = "s-chief";
const t0 = "2026-11-01T09:00:00.000Z";
const REPORT =
  "Status: review\nPR: https://github.com/o/r/pull/37\nCheck: rebased onto main; main itself is red";

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of CHIEF_SCHEMA) yield* sql.unsafe(statement);
  yield* sql.unsafe(
    `CREATE TABLE caveman_sp_events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (session_id, cursor))`,
  );
  const events = yield* PubSub.unbounded<SessionEvent>();
  const workspaceChanges = yield* PubSub.unbounded<Workspace>();
  const records = new Map<string, WorkspaceRecord>();
  const record = (id: string, session: string, extra: Partial<Workspace> = {}) =>
    records.set(id, {
      workspace: { id, title: `chat ${id}`, updated_at: t0, ...extra },
      session: { id: session },
      internal: {},
    } as unknown as WorkspaceRecord);
  record(CHIEF, CHIEF_SESSION, { kind: "chief" });
  const store = {
    sql,
    events,
    workspaceChanges,
    getWorkspace: (id: string) => Effect.succeed(records.get(id)),
    getBySession: (session: string) =>
      Effect.succeed([...records.values()].find((r) => r.session.id === session)),
  } as unknown as SessionStore["Service"];

  let cursor = 0;
  const append = (event: Omit<SessionEvent, "cursor" | "at">) =>
    Effect.gen(function* () {
      const full = {
        ...event,
        cursor: ++cursor,
        at: new Date(Date.parse(t0) + cursor * 1000).toISOString(),
      } as SessionEvent;
      yield* sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (${full.session_id}, ${full.cursor}, ${full.type}, ${full.at}, ${JSON.stringify(full)})`;
      return full;
    });
  /** A chat's turn ends with `text` as its answer; the event is published as the runtime does. */
  const finish = (session: string, turn: string, text: string) =>
    Effect.gen(function* () {
      yield* append({
        session_id: session,
        turn_id: turn,
        type: "turn.started",
        payload: { engine: "caveman" },
      } as never);
      yield* append({
        session_id: session,
        turn_id: turn,
        type: "message.done",
        payload: { role: "assistant", text },
      } as never);
      const done = yield* append({
        session_id: session,
        turn_id: turn,
        type: "turn.done",
        payload: { status: "completed" },
      } as never);
      yield* PubSub.publish(events, done);
      return done;
    });
  /** The Chief's turn for a wake started and ended: it may be woken again. */
  const chiefTurn = Effect.gen(function* () {
    yield* PubSub.publish(
      events,
      yield* append({
        session_id: CHIEF_SESSION,
        turn_id: `ct${cursor}`,
        type: "turn.started",
        payload: { engine: "caveman" },
      } as never),
    );
    yield* PubSub.publish(
      events,
      yield* append({
        session_id: CHIEF_SESSION,
        turn_id: `ct${cursor}`,
        type: "turn.done",
        payload: { status: "completed" },
      } as never),
    );
  });

  const wakes: Array<string> = [];
  /** While set, a wake's outcome waits here instead of arriving at once (a wake still in the delivery queue). */
  let held: Array<Effect.Effect<void, unknown>> | undefined;
  let compactions = 0;
  /** The runtime starting: a board store and a watcher of its own, on the same database. */
  const boot = Effect.gen(function* () {
    const board = yield* makeBoardStore({ sql });
    yield* board.setHome(CHIEF);
    const watcher = yield* makeWatcher({
      store,
      board,
      wake: (_chiefId, _summary, text, heard) =>
        Effect.sync(() => void wakes.push(text)).pipe(
          Effect.andThen(
            held !== undefined && heard !== undefined
              ? Effect.sync(() => void held!.push(heard))
              : (heard ?? Effect.void),
          ),
        ),
      readmit: Effect.void,
      onCompaction: () => Effect.sync(() => void compactions++),
      tainted: () => Effect.succeed(false),
      markTainted: () => Effect.void,
      tick: Effect.void,
      moment: () => Effect.void,
    });
    const fiber = yield* Effect.forkScoped(watcher.run);
    // Subscribed and caught up before the test publishes anything.
    yield* Effect.sleep("100 millis");
    return { board, fiber, watcher };
  });
  /** An item on the Chief's board with this chat, started. */
  const startItem = (board: BoardStore, id: string, chat: string) =>
    Effect.gen(function* () {
      yield* board.update("add", (items) =>
        Effect.succeed({
          write: [
            Board.start(
              Board.add(
                items,
                { id, chief_id: CHIEF, text: `note ${id}`, source: "composer", state: "queued" },
                t0,
              ),
              [chat],
              t0,
            ),
          ],
          value: undefined,
        }),
      );
      yield* board.link(id, chat);
    });
  const until = (done: () => boolean) =>
    Effect.gen(function* () {
      for (let i = 0; i < 400 && !done(); i++) yield* Effect.sleep("25 millis");
      expect(done()).toBe(true);
    });
  /** Past the debounce with room to spare: any wake that was coming has come. */
  const quiet = Effect.sleep(`${WAKE_DEBOUNCE_MS + 1_000} millis`);
  return {
    record,
    records,
    finish,
    chiefTurn,
    append,
    events,
    workspaceChanges,
    wakes,
    boot,
    startItem,
    until,
    quiet,
    compactions: () => compactions,
    hold: () => void (held = []),
    held: () => held ?? [],
  };
});

const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient | Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    ) as Effect.Effect<A, unknown, never>,
  );
const PR = { number: 37, url: "https://github.com/o/r/pull/37", state: "open" } as const;

describe("the watcher wakes the Chief once per update", () => {
  test(
    "an update it heard is not sent again after a compaction or a restart, and its pull request merging wakes nobody",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.record("w1", "s1", { pull_request: PR });
          let { board, fiber } = yield* h.boot;
          yield* h.startItem(board, "a", "w1");
          const done = yield* h.finish("s1", "t1", REPORT);
          yield* h.until(() => h.wakes.length === 1);
          expect(h.wakes[0]).toContain('workspace="w1"');
          expect(h.wakes[0]).toContain('state="review"');
          expect(h.wakes[0]).toContain('pr_state="open"');
          expect(h.wakes[0]).toContain('result="true"');
          yield* h.chiefTurn;

          // The Chief's history is summarized, and the chat's turn.done is seen again: nothing new, no wake.
          yield* PubSub.publish(
            h.events,
            yield* h.append({
              session_id: CHIEF_SESSION,
              type: "compaction.done",
              payload: { status: "completed" },
            } as never),
          );
          yield* PubSub.publish(h.events, done);
          yield* h.quiet;
          expect(h.compactions()).toBe(1);
          expect(h.wakes).toHaveLength(1);

          // The runtime restarts: it plays every running item's latest event through again. Still nothing new.
          yield* Fiber.interrupt(fiber);
          ({ board, fiber } = yield* h.boot);
          yield* h.quiet;
          expect(h.wakes).toHaveLength(1);

          // Its pull request merges: the board moves it to done, and its result was explained already: no wake.
          h.record("w1", "s1", { pull_request: { ...PR, state: "merged" } });
          yield* PubSub.publish(h.workspaceChanges, h.records.get("w1")!.workspace);
          while ((yield* board.get("a"))?.state !== "done") yield* Effect.sleep("50 millis");
          yield* h.quiet;
          expect(h.wakes).toHaveLength(1);

          // Nor after another restart.
          yield* Fiber.interrupt(fiber);
          yield* h.boot;
          yield* h.quiet;
          expect(h.wakes).toHaveLength(1);
        }),
      ),
    30_000,
  );

  test(
    "a result whose wake is still on its way is explained once, whatever the chat reports meanwhile, and a restart sends nothing",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.record("w1", "s1");
          let { board, fiber, watcher } = yield* h.boot;
          yield* h.startItem(board, "a", "w1");
          // The first report's wake is on its way (still in the delivery queue)...
          h.hold();
          yield* h.finish("s1", "t1", "Status: review\nCheck: first");
          yield* h.until(() => h.wakes.length === 1);
          // ...when the chat reports again and a note to the Chief carries the newer update, which arrives first.
          yield* PubSub.publish(
            h.events,
            yield* h.append({
              session_id: "s1",
              turn_id: "t2",
              type: "turn.started",
              payload: { engine: "caveman" },
            } as never),
          );
          yield* h.finish("s1", "t2", "Status: review\nCheck: second");
          yield* Effect.sleep("200 millis");
          // The same request's result is on its way already: its second report is not explained again.
          const note = yield* watcher.drain(CHIEF);
          expect(note.lines).toEqual([]);
          yield* note.heard;
          // The older wake arrives now: the Chief heard the second report last, and a restart must know it.
          for (const heard of h.held()) yield* heard;
          yield* Fiber.interrupt(fiber);
          ({ board, fiber, watcher } = yield* h.boot);
          yield* h.quiet;
          expect(h.wakes).toHaveLength(1);
        }),
      ),
    30_000,
  );

  test(
    "a later turn of the same request is not explained again, even after its Chief's words",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.record("w1", "s1");
          const { board } = yield* h.boot;
          yield* h.startItem(board, "a", "w1");
          yield* h.finish("s1", "t1", REPORT);
          yield* h.until(() => h.wakes.length === 1);
          yield* h.chiefTurn;
          // Its Chief sends it back to rebase: the same request, so what it reports next is no news.
          yield* PubSub.publish(
            h.events,
            yield* h.append({
              session_id: "s1",
              turn_id: "t2",
              type: "message.done",
              payload: { role: "user", text: "Rebase again and re-run the checks." },
            } as never),
          );
          yield* PubSub.publish(
            h.events,
            yield* h.append({
              session_id: "s1",
              turn_id: "t2",
              type: "turn.started",
              payload: { engine: "caveman" },
            } as never),
          );
          yield* h.finish("s1", "t2", REPORT);
          yield* h.quiet;
          expect(h.wakes).toHaveLength(1);
        }),
      ),
    30_000,
  );

  test(
    "chats that finish together still wake it once, naming both",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          h.record("w1", "s1");
          h.record("w2", "s2");
          const { board } = yield* h.boot;
          yield* h.startItem(board, "a", "w1");
          yield* h.startItem(board, "b", "w2");
          yield* h.finish("s1", "t1", "Status: done\nCheck: one");
          yield* h.finish("s2", "t1", "Status: done\nCheck: two");
          yield* h.until(() => h.wakes.length === 1);
          yield* h.quiet;
          expect(h.wakes).toHaveLength(1);
          expect(h.wakes[0]).toContain('workspace="w1"');
          expect(h.wakes[0]).toContain('workspace="w2"');
        }),
      ),
    30_000,
  );
});
