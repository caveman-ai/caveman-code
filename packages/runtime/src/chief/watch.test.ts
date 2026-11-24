import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { ChiefMoment, SessionEvent, Workspace } from "@caveman-app/session-protocol";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, test } from "vitest";

import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import * as Board from "./Board.ts";
import { CHIEF_SCHEMA } from "./schema.ts";
import { makeBoardStore } from "./store.ts";
import { makeWatcher, wakeSummary } from "./watch.ts";

describe("wakeSummary: the line the Chief's transcript shows for a wake", () => {
  test("one chat", () => {
    expect(wakeSummary([{ title: "Docs typo", state: "done" }])).toBe(
      "1 chat changed: Docs typo done",
    );
  });
  test("a few, grouped by state with what needs the person first", () => {
    expect(
      wakeSummary([
        { title: "Docs typo", state: "done" },
        { title: "Clean build", state: "needs_you" },
        { title: "Cloud typo", state: "review" },
      ]),
    ).toBe("3 chats changed: Clean build needs you · Cloud typo for review · Docs typo done");
  });
  test("ten: three named per state, the rest counted, on one line", () => {
    const chats = [
      ...["A", "B", "C", "D", "E", "F"].map((title) => ({ title, state: "done" })),
      ...["G", "H", "I"].map((title) => ({ title, state: "review" })),
      { title: "A title long enough that the line would run on and on and on", state: "needs_you" },
    ];
    expect(wakeSummary(chats)).toBe(
      "10 chats changed: A title long enough that the line would… needs you · G, H and I for review · A, B, C and 3 more done",
    );
  });
  test("an unknown state reads as words", () => {
    expect(wakeSummary([{ title: "X", state: "some_state" }])).toBe("1 chat changed: X some state");
  });
});

const t0 = "2026-11-06T09:00:00.000Z";
const CHIEF_ID = "chief-1";
const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

/** A chat as the session store keeps it: the fields the watcher reads. */
const chat = (id: string, title: string, workspace: Partial<Workspace> = {}) =>
  ({
    workspace: { id, title, updated_at: t0, ...workspace },
    session: { id: `s-${id}` },
  }) as unknown as WorkspaceRecord;

/**
 * The watcher running on the real board store and a real events table (SQLite), its Chief and `chats` in a session
 * store of the reads it makes. Time is the test clock's, so no wake goes on its own: `drain` reads what the Chief has
 * yet to hear. `append` journals and publishes one of a chat's events; `settled` returns once the watcher has handled
 * every event published before it; `journal` journals one without publishing it (the watcher has yet to hear it).
 * `pullRequest` moves a chat's pull request on the host, as the runtime's sync publishes it. `relaunch` quits the
 * runtime, journals `whileDown` (heard by no watcher), and starts a new watcher on the same store and board, returned
 * once it has caught up. `wakes` are the wakes that went, each reaching its Chief; `wait` lets the clock run.
 */
const watching = (chats: ReadonlyArray<WorkspaceRecord>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of CHIEF_SCHEMA) yield* sql.unsafe(statement);
    yield* sql.unsafe(
      `CREATE TABLE caveman_sp_events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (session_id, cursor))`,
    );
    const board = yield* makeBoardStore({ sql });
    yield* board.setHome(CHIEF_ID);
    const chief = chat(CHIEF_ID, "Chief", { kind: "chief" });
    const records = [chief, ...chats];
    const workspaceChanges = yield* PubSub.unbounded<Workspace>();
    const compacted = yield* Queue.unbounded<void>();
    const readmits = yield* Queue.unbounded<void>();
    const ticks = yield* Queue.unbounded<void>();
    const wakes: Array<{ readonly chiefId: string; readonly text: string }> = [];
    const moments: Array<ChiefMoment & { readonly chiefId: string; readonly chat: string }> = [];
    const launch = Effect.gen(function* () {
      // Replayed to a late subscriber, so the first barrier reaches the watcher however late its fiber subscribes.
      const events = yield* PubSub.unbounded<SessionEvent>({ replay: 1 });
      const store = {
        sql,
        events,
        workspaceChanges,
        getWorkspace: (id: string) => Effect.succeed(records.find((r) => r.workspace.id === id)),
        getBySession: (id: string) => Effect.succeed(records.find((r) => r.session.id === id)),
      } as unknown as SessionStore["Service"];
      const watcher = yield* makeWatcher({
        store,
        board,
        wake: (chiefId, _summary, text, heard = Effect.void) =>
          Effect.sync(() => void wakes.push({ chiefId, text })).pipe(Effect.andThen(heard)),
        readmit: Queue.offer(readmits, undefined),
        onCompaction: () => Queue.offer(compacted, undefined).pipe(Effect.asVoid),
        tainted: () => Effect.succeed(false),
        markTainted: () => Effect.void,
        tick: Queue.offer(ticks, undefined).pipe(Effect.asVoid),
        moment: (chiefId, moment, chat) =>
          Effect.sync(() => void moments.push({ chiefId, chat, ...moment })),
      });
      return { events, watcher, fiber: yield* Effect.forkScoped(watcher.run) };
    });
    let running = yield* launch;
    const cursors = new Map<string, number>();
    const journal = (
      record: WorkspaceRecord,
      event: { readonly type: string; readonly [key: string]: unknown },
    ) =>
      Effect.gen(function* () {
        const sessionId = record.session.id;
        const cursor = (cursors.get(sessionId) ?? 0) + 1;
        cursors.set(sessionId, cursor);
        const full = { session_id: sessionId, cursor, at: t0, ...event } as unknown as SessionEvent;
        yield* sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (${sessionId}, ${cursor}, ${full.type}, ${full.at}, ${JSON.stringify(full)})`;
        return full;
      });
    const append = (
      record: WorkspaceRecord,
      event: { readonly type: string; readonly [key: string]: unknown },
    ) =>
      journal(record, event).pipe(Effect.flatMap((full) => PubSub.publish(running.events, full)));
    // The watcher handles events in order: once its Chief's compaction.done is handled, so is everything before it.
    const settled = append(chief, { type: "compaction.done", payload: {} }).pipe(
      Effect.andThen(Queue.take(compacted)),
    );
    yield* settled;
    const pullRequest = (workspaceId: string, pr: NonNullable<Workspace["pull_request"]>) =>
      Effect.gen(function* () {
        const at = records.findIndex((r) => r.workspace.id === workspaceId);
        const next = {
          ...records[at]!,
          workspace: { ...records[at]!.workspace, pull_request: pr },
        } as WorkspaceRecord;
        records[at] = next;
        yield* PubSub.publish(workspaceChanges, next.workspace);
      });
    const relaunch = (whileDown: Effect.Effect<void, unknown> = Effect.void) =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(running.fiber);
        yield* whileDown;
        running = yield* launch;
        yield* settled;
        return running.watcher;
      });
    const wait = (seconds: number) =>
      Effect.gen(function* () {
        for (let s = 0; s < seconds; s++) {
          yield* TestClock.adjust("1 second");
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
        }
      });
    /** One item of the Chief's, started, with `workspaceIds` linked to it. */
    const started = (itemId: string, workspaceIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* board.update("add", (items) =>
          Effect.succeed({
            write: [
              Board.start(
                Board.add(
                  items,
                  {
                    id: itemId,
                    chief_id: CHIEF_ID,
                    text: itemId,
                    source: "composer",
                    state: "queued",
                  },
                  t0,
                ),
                [],
                t0,
              ),
            ],
            value: undefined,
          }),
        );
        for (const id of workspaceIds) yield* board.link(itemId, id);
      });
    /** The Chief takes the turn a wake started, and ends it. */
    const chiefTurn = append(chief, {
      type: "turn.started",
      turn_id: `c${wakes.length}`,
      payload: { engine: "caveman" },
    }).pipe(
      Effect.andThen(
        append(chief, {
          type: "turn.done",
          turn_id: `c${wakes.length}`,
          payload: { status: "completed" },
        }),
      ),
      Effect.andThen(settled),
    );
    return {
      board,
      watcher: running.watcher,
      journal,
      append,
      settled,
      started,
      pullRequest,
      relaunch,
      wakes,
      moments,
      chiefTurn,
      wait,
      readmits,
      ticks,
    };
  });

describe("makeWatcher", () => {
  it.effect(
    "a chat that finished while its sibling still worked reaches its Chief with the move that ends the item",
    () =>
      Effect.gen(function* () {
        const app = chat("wa", "App half", {
          pull_request: { number: 7, url: "https://github.com/o/app/pull/7", state: "open" },
        } as Partial<Workspace>);
        const cloud = chat("wb", "Cloud half");
        const { board, watcher, append, settled, started } = yield* watching([app, cloud]);
        yield* started("ci-x", ["wa", "wb"]);
        yield* board.update("edit", (items) =>
          Effect.succeed({
            write: items
              .filter((i) => i.id === "ci-x")
              .map((i) => Board.mission(i, { done_when: "Both halves pass their tests" }, t0)),
            value: undefined,
          }),
        );

        yield* append(app, { type: "turn.started", turn_id: "ta", payload: { engine: "caveman" } });
        yield* append(cloud, {
          type: "turn.started",
          turn_id: "tb",
          payload: { engine: "caveman" },
        });
        // The app half finishes with its pull request while the cloud half works on.
        yield* append(app, {
          type: "message.done",
          turn_id: "ta",
          payload: {
            role: "assistant",
            text: "Status: review\nPR: https://github.com/o/app/pull/7\nCheck: pnpm test, 41 passed\nLeft: the docs page",
          },
        });
        yield* append(app, {
          type: "diff.changed",
          turn_id: "ta",
          payload: { files: [{ path: "src/a.ts" }] },
        });
        yield* append(app, { type: "turn.done", turn_id: "ta", payload: { status: "completed" } });
        yield* settled;
        expect((yield* board.get("ci-x"))?.state).toBe("started");
        expect((yield* watcher.drain(CHIEF_ID)).lines).toEqual([]);

        yield* append(cloud, {
          type: "message.done",
          turn_id: "tb",
          payload: { role: "assistant", text: "Status: done\nCheck: pnpm test, 12 passed" },
        });
        yield* append(cloud, {
          type: "turn.done",
          turn_id: "tb",
          payload: { status: "completed" },
        });
        yield* settled;
        expect((yield* board.get("ci-x"))?.state).toBe("review");

        const heard = yield* watcher.drain(CHIEF_ID);
        expect([...heard.ids].sort()).toEqual(["wa", "wb"]);
        const appLine = heard.lines.find((line) => line.startsWith('<chat_update workspace="wa"'));
        expect(appLine).toContain('pr="https://github.com/o/app/pull/7"');
        expect(appLine).toContain("Left: the docs page");
        expect(appLine).toContain('done_when="Both halves pass their tests"');
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a pull request merged while a sibling chat still works leaves the item open, and the sibling's finish reaches its Chief",
    () =>
      Effect.gen(function* () {
        const app = chat("wa", "App half");
        const cloud = chat("wb", "Cloud half");
        const { board, watcher, append, settled, started, pullRequest } = yield* watching([
          app,
          cloud,
        ]);
        yield* started("ci-x", ["wa", "wb"]);

        yield* append(app, { type: "turn.started", turn_id: "ta", payload: { engine: "caveman" } });
        yield* append(cloud, {
          type: "turn.started",
          turn_id: "tb",
          payload: { engine: "caveman" },
        });
        yield* append(app, {
          type: "message.done",
          turn_id: "ta",
          payload: {
            role: "assistant",
            text: "Status: review\nPR: https://github.com/o/app/pull/7\nCheck: pnpm test, 41 passed",
          },
        });
        yield* append(app, {
          type: "diff.changed",
          turn_id: "ta",
          payload: { files: [{ path: "src/a.ts" }] },
        });
        yield* append(app, { type: "turn.done", turn_id: "ta", payload: { status: "completed" } });
        yield* settled;

        // The app half's pull request merges while the cloud half works on: the item stays open for it.
        yield* pullRequest("wa", {
          number: 7,
          url: "https://github.com/o/app/pull/7",
          state: "merged",
        });
        while ((yield* board.get("ci-x"))?.pull_request?.state !== "merged") yield* Effect.yieldNow;
        expect((yield* board.get("ci-x"))?.state).toBe("started");

        // The cloud half finishes with nothing to review: both halves are done, and its Chief hears both.
        yield* append(cloud, {
          type: "message.done",
          turn_id: "tb",
          payload: { role: "assistant", text: "Status: done\nCheck: pnpm test, 12 passed" },
        });
        yield* append(cloud, {
          type: "turn.done",
          turn_id: "tb",
          payload: { status: "completed" },
        });
        yield* settled;
        expect((yield* board.get("ci-x"))?.state).toBe("done");
        const heard = yield* watcher.drain(CHIEF_ID);
        expect([...heard.ids].sort()).toEqual(["wa", "wb"]);
        expect(
          heard.lines.find((line) => line.startsWith('<chat_update workspace="wa"')),
        ).toContain('pr_state="merged"');
        expect(
          heard.lines.find((line) => line.startsWith('<chat_update workspace="wb"')),
        ).toContain("12 passed");
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a pull request merged while its own chat still works leaves the item open, and every finish reaches its Chief",
    () =>
      Effect.gen(function* () {
        const app = chat("wa", "App half");
        const cloud = chat("wb", "Cloud half");
        const { board, watcher, append, settled, started, pullRequest } = yield* watching([
          app,
          cloud,
        ]);
        yield* started("ci-w", ["wa", "wb"]);

        yield* append(app, { type: "turn.started", turn_id: "ta", payload: { engine: "caveman" } });
        yield* append(cloud, {
          type: "turn.started",
          turn_id: "tb",
          payload: { engine: "caveman" },
        });
        // The cloud half finishes while the app half works on: its finish waits for the move that ends the item.
        yield* append(cloud, {
          type: "message.done",
          turn_id: "tb",
          payload: { role: "assistant", text: "Status: done\nCheck: pnpm test, 12 passed" },
        });
        yield* append(cloud, {
          type: "turn.done",
          turn_id: "tb",
          payload: { status: "completed" },
        });
        yield* settled;
        expect((yield* board.get("ci-w"))?.state).toBe("started");

        // The app half's pull request merges while it is still in its turn: the item stays open for it.
        yield* pullRequest("wa", {
          number: 7,
          url: "https://github.com/o/app/pull/7",
          state: "merged",
        });
        while ((yield* board.get("ci-w"))?.pull_request?.state !== "merged") yield* Effect.yieldNow;
        expect((yield* board.get("ci-w"))?.state).toBe("started");

        // It finishes: the item closes, and its Chief hears both halves.
        yield* append(app, {
          type: "message.done",
          turn_id: "ta",
          payload: { role: "assistant", text: "Status: done\nCheck: pnpm test, 41 passed" },
        });
        yield* append(app, { type: "turn.done", turn_id: "ta", payload: { status: "completed" } });
        yield* settled;
        expect((yield* board.get("ci-w"))?.state).toBe("done");
        expect([...(yield* watcher.drain(CHIEF_ID)).ids].sort()).toEqual(["wa", "wb"]);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a merge that closes an item brings along a sibling's finish held for the move that ends it",
    () =>
      Effect.gen(function* () {
        const app = chat("wa", "App half");
        const cloud = chat("wb", "Cloud half");
        const { board, journal, append, settled, started, pullRequest, wakes, wait } =
          yield* watching([app, cloud]);
        yield* started("ci-m", ["wa", "wb"]);

        yield* append(app, { type: "turn.started", turn_id: "ta", payload: { engine: "caveman" } });
        yield* append(cloud, {
          type: "turn.started",
          turn_id: "tb",
          payload: { engine: "caveman" },
        });
        yield* append(cloud, {
          type: "message.done",
          turn_id: "tb",
          payload: { role: "assistant", text: "Status: done\nCheck: pnpm test, 12 passed" },
        });
        yield* append(cloud, {
          type: "turn.done",
          turn_id: "tb",
          payload: { status: "completed" },
        });
        yield* settled;
        expect((yield* board.get("ci-m"))?.state).toBe("started");

        // The app half finishes for review and the sync reads its pull request merged before the watcher reads the finish.
        yield* journal(app, {
          type: "message.done",
          turn_id: "ta",
          payload: { role: "assistant", text: "Status: review\nCheck: pnpm test, 41 passed" },
        });
        yield* journal(app, {
          type: "diff.changed",
          turn_id: "ta",
          payload: { files: [{ path: "src/a.ts" }] },
        });
        yield* journal(app, { type: "turn.done", turn_id: "ta", payload: { status: "completed" } });
        yield* pullRequest("wa", {
          number: 7,
          url: "https://github.com/o/app/pull/7",
          state: "merged",
        });
        while ((yield* board.get("ci-m"))?.state !== "done") yield* Effect.yieldNow;

        yield* wait(20);
        // Each update's line; a line naming a playbook to read (prompt.ts chatUpdate) is no chat.
        const told = wakes
          .flatMap((w) => w.text.split("\n"))
          .flatMap((line) => /^<chat_update workspace="(\w+)"/.exec(line)?.[1] ?? []);
        expect(told.sort()).toEqual(["wa", "wb"]);
        expect(wakes).toHaveLength(1);
        const pointer = "Read the result and diagram playbooks before you write.";
        expect(wakes[0]!.text.split("\n").filter((line) => line === pointer)).toHaveLength(1);
        expect(wakes[0]!.text.endsWith(pointer)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a relaunch tells a Chief nothing again about a chat it already heard, and leaves the item as it was",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const editor = chat("w1", "Export to CSV");
        const { board, watcher, append, settled, started, relaunch, wakes, wait } = yield* watching(
          [editor],
        );
        yield* started("ci-r", ["w1"]);

        yield* append(editor, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* append(editor, {
          type: "message.done",
          turn_id: "t1",
          payload: { role: "assistant", text: "Status: review\nCheck: pnpm test, 9 passed" },
        });
        yield* append(editor, {
          type: "diff.changed",
          turn_id: "t1",
          payload: { files: [{ path: "src/csv.ts" }] },
        });
        yield* append(editor, {
          type: "turn.done",
          turn_id: "t1",
          payload: { status: "completed" },
        });
        yield* settled;
        // A note the person typed carried it, and went.
        const told = yield* watcher.drain(CHIEF_ID);
        expect(told.ids).toEqual(["w1"]);
        yield* told.heard;
        const before = yield* board.get("ci-r");
        expect(before?.state).toBe("review");
        const logged = sql<{
          n: number;
        }>`SELECT count(*) AS n FROM chief_board_events WHERE item_id = 'ci-r'`.pipe(
          Effect.map(([row]) => row?.n),
        );
        const loggedBefore = yield* logged;

        // The person relaunches the app; the chat sat in review all along.
        const relaunched = yield* relaunch();
        yield* wait(20);
        expect(wakes).toEqual([]);
        expect((yield* relaunched.drain(CHIEF_ID)).lines).toEqual([]);
        expect(yield* logged).toBe(loggedBefore);
        expect((yield* board.get("ci-r"))?.updated_at).toBe(before?.updated_at);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "an update its Chief had yet to hear when the runtime quit reaches it after the relaunch, once",
    () =>
      Effect.gen(function* () {
        const editor = chat("w1", "Export to CSV");
        const { board, append, settled, started, relaunch, wakes, wait } = yield* watching([
          editor,
        ]);
        yield* started("ci-q", ["w1"]);

        yield* append(editor, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* append(editor, {
          type: "ask.user",
          turn_id: "t1",
          item_id: "ask-1",
          payload: {
            kind: "question",
            questions: [
              {
                id: "q1",
                prompt: "Comma or semicolon?",
                options: [{ id: "c", label: "Comma" }],
                allow_text: true,
                multi_select: false,
              },
            ],
          },
        });
        yield* settled;
        expect(yield* board.get("ci-q")).toMatchObject({
          state: "needs_you",
          detail: "Comma or semicolon?",
        });

        // The person quits inside the wake's quiet spell: the Chief was never told.
        expect(wakes).toEqual([]);
        const relaunched = yield* relaunch();
        yield* wait(20);
        expect(wakes.map((w) => w.chiefId)).toEqual([CHIEF_ID]);
        expect(wakes[0]?.text).toContain('<chat_update workspace="w1"');
        expect(wakes[0]?.text).toContain("Comma or semicolon?");
        expect((yield* relaunched.drain(CHIEF_ID)).ids).toEqual([]);

        // It heard it: the next relaunch tells it nothing again.
        const again = yield* relaunch();
        yield* wait(20);
        expect(wakes).toHaveLength(1);
        expect((yield* again.drain(CHIEF_ID)).ids).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "updates a note took on its way are told after a relaunch when the quit stopped that note",
    () =>
      Effect.gen(function* () {
        const editor = chat("w1", "Export to CSV");
        const { watcher, append, settled, started, relaunch } = yield* watching([editor]);
        yield* started("ci-n", ["w1"]);

        yield* append(editor, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* append(editor, {
          type: "message.done",
          turn_id: "t1",
          payload: { role: "assistant", text: "Status: done\nCheck: pnpm test, 9 passed" },
        });
        yield* append(editor, {
          type: "turn.done",
          turn_id: "t1",
          payload: { status: "completed" },
        });
        yield* settled;
        // A note takes the update, and the runtime quits before the note went.
        expect((yield* watcher.drain(CHIEF_ID)).ids).toEqual(["w1"]);

        const relaunched = yield* relaunch();
        const told = yield* relaunched.drain(CHIEF_ID);
        expect(told.ids).toEqual(["w1"]);
        yield* told.heard;
        expect((yield* (yield* relaunch()).drain(CHIEF_ID)).ids).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a chat whose turn the quit cut off moves its item at relaunch, and its Chief hears it with a sibling's earlier finish",
    () =>
      Effect.gen(function* () {
        const app = chat("wa", "App half");
        const cloud = chat("wb", "Cloud half");
        const { board, append, settled, started, pullRequest, relaunch } = yield* watching([
          app,
          cloud,
        ]);
        yield* started("ci-y", ["wa", "wb"]);
        const at = (seconds: number) => new Date(Date.parse(t0) + seconds * 1_000).toISOString();

        yield* append(app, {
          type: "turn.started",
          turn_id: "ta",
          at: at(1),
          payload: { engine: "caveman" },
        });
        yield* append(cloud, {
          type: "turn.started",
          turn_id: "tb",
          at: at(1),
          payload: { engine: "caveman" },
        });
        yield* append(app, {
          type: "message.done",
          turn_id: "ta",
          at: at(2),
          payload: { role: "assistant", text: "Status: review\nCheck: pnpm test, 41 passed" },
        });
        yield* append(app, {
          type: "diff.changed",
          turn_id: "ta",
          at: at(2),
          payload: { files: [{ path: "src/a.ts" }] },
        });
        yield* append(app, {
          type: "turn.done",
          turn_id: "ta",
          at: at(2),
          payload: { status: "completed" },
        });
        yield* settled;
        // The app half's pull request opens after its turn: the item records it, still started for the cloud half.
        yield* pullRequest("wa", {
          number: 7,
          url: "https://github.com/o/app/pull/7",
          state: "open",
        });
        while ((yield* board.get("ci-y"))?.pull_request === undefined) yield* Effect.yieldNow;
        expect((yield* board.get("ci-y"))?.state).toBe("started");

        // The person quits mid-turn; startup recovery ends the cloud half's cut-off turn before the Chiefs watch again.
        const relaunched = yield* relaunch(
          append(cloud, {
            type: "turn.done",
            turn_id: "tb",
            at: new Date(Date.now() + 1_000).toISOString(),
            payload: { status: "interrupted" },
          }),
        );
        expect(yield* board.get("ci-y")).toMatchObject({
          state: "needs_you",
          detail: "Stopped before it finished.",
        });
        expect([...(yield* relaunched.drain(CHIEF_ID)).ids].sort()).toEqual(["wa", "wb"]);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a chat waiting on a custom tool call says its app must run the tool, never that it needs a secret",
    () =>
      Effect.gen(function* () {
        const editor = chat("w1", "Open the config");
        const { board, append, settled, started } = yield* watching([editor]);
        yield* started("ci-tool", ["w1"]);

        yield* append(editor, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* append(editor, {
          type: "ask.user",
          turn_id: "t1",
          item_id: "tool:abc",
          payload: {
            kind: "tool",
            name: "open_file",
            description: "Opens a file in the editor",
            input: { path: "a.ts" },
          },
        });
        yield* settled;

        expect(yield* board.get("ci-tool")).toMatchObject({
          state: "needs_you",
          detail: "It needs your app to run open_file",
        });
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "the moments: reads then an edit make one plan, a plan and an approval wake nobody, a question card does, and a result wakes its Chief once",
    () =>
      Effect.gen(function* () {
        const editor = chat("w1", "Add farewell");
        const quick = chat("w2", "Fix typo");
        const { board, append, settled, started, wakes, moments, chiefTurn, wait } =
          yield* watching([editor, quick]);
        yield* started("ci-p", ["w1"]);
        yield* started("ci-t", ["w2"]);
        const call = (record: WorkspaceRecord, id: string, kind: string, title: string) =>
          append(record, {
            type: "tool.started",
            turn_id: "t1",
            item_id: id,
            payload: { name: kind, title, kind, input: {} },
          });

        // A stretch of reading (one call started twice counts once), its words, then its first edit: its plan.
        yield* append(editor, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* call(editor, "r1", "read", "src/greet.js");
        yield* call(editor, "r1", "read", "src/greet.js");
        yield* call(editor, "r2", "search", "greet(");
        yield* append(editor, {
          type: "tool.started",
          turn_id: "t1",
          item_id: "r3",
          payload: {
            name: "exec_command",
            title: "rg farewell",
            kind: "command",
            input: { command: "rg farewell src" },
          },
        });
        yield* append(editor, {
          type: "message.done",
          turn_id: "t1",
          payload: {
            role: "assistant",
            text: "greet builds its line inline. I'll add farewell beside it with the same shape, and a README line.",
          },
        });
        yield* call(editor, "e1", "edit", "src/greet.js");
        yield* call(editor, "e2", "edit", "README.md");
        // A chat that edits with no reading first shows no plan, then or later.
        yield* append(quick, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* call(quick, "q1", "read", "README.md");
        yield* call(quick, "q2", "edit", "README.md");
        yield* call(quick, "q3", "read", "a.md");
        yield* call(quick, "q4", "read", "b.md");
        yield* call(quick, "q5", "read", "c.md");
        yield* call(quick, "q6", "edit", "c.md");
        yield* settled;
        expect(moments).toEqual([
          {
            chiefId: CHIEF_ID,
            chat: "Add farewell",
            kind: "plan",
            workspace_id: "w1",
            item_id: "ci-p",
            text: "greet builds its line inline. I'll add farewell beside it with the same shape, and a README line.",
          },
        ]);

        // It asks to run a command: its card says so, and only the person answers it, so nobody is woken.
        yield* append(editor, {
          type: "ask.user",
          turn_id: "t1",
          item_id: "ask-a",
          payload: {
            kind: "approval",
            title: "Run pnpm install",
            options: [{ id: "y", label: "Allow", decision: "allow" }],
          },
        });
        yield* settled;
        expect(moments.at(-1)).toMatchObject({
          kind: "needs_you",
          workspace_id: "w1",
          text: "Approve: Run pnpm install",
          ask: { id: "ask-a", kind: "approval" },
        });
        yield* wait(20);
        expect(wakes).toEqual([]);

        // A question card the Chief may answer: the card, with the option it recommends, and the Chief is woken for it.
        yield* append(editor, {
          type: "ask.resolved",
          turn_id: "t1",
          item_id: "ask-a",
          payload: { outcome: "answered" },
        });
        yield* append(editor, {
          type: "ask.user",
          turn_id: "t1",
          item_id: "ask-q",
          payload: {
            kind: "question",
            questions: [
              {
                id: "q1",
                prompt: "Export it from index.js too?",
                options: [
                  { id: "yes", label: "Yes" },
                  { id: "no", label: "No" },
                ],
                recommended: "yes",
                allow_text: false,
                multi_select: false,
              },
            ],
          },
        });
        yield* settled;
        expect(moments.at(-1)).toMatchObject({
          kind: "needs_you",
          text: "Export it from index.js too?",
          ask: {
            id: "ask-q",
            kind: "question",
            question_id: "q1",
            recommended: { option_id: "yes", label: "Yes" },
          },
        });
        yield* wait(20);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.text).toContain('ask="ask-q"');
        yield* chiefTurn;

        // Its result: a card, then one wake to explain it. Working again in between woke nobody.
        yield* append(editor, {
          type: "ask.resolved",
          turn_id: "t1",
          item_id: "ask-q",
          payload: { outcome: "answered" },
        });
        yield* append(editor, {
          type: "message.done",
          turn_id: "t1",
          payload: {
            role: "assistant",
            text: "Status: review\nFound: farewell(name) returns Goodbye, name.\nHow: it mirrors greet.",
          },
        });
        yield* append(editor, {
          type: "diff.changed",
          turn_id: "t1",
          payload: { files: [{ path: "src/greet.js" }] },
        });
        yield* append(editor, {
          type: "turn.done",
          turn_id: "t1",
          payload: { status: "completed" },
        });
        yield* settled;
        expect((yield* board.get("ci-p"))?.state).toBe("review");
        expect(moments.filter((m) => m.kind === "result")).toEqual([
          {
            chiefId: CHIEF_ID,
            chat: "Add farewell",
            kind: "result",
            workspace_id: "w1",
            item_id: "ci-p",
          },
        ]);
        yield* wait(20);
        expect(wakes).toHaveLength(2);
        expect(wakes[1]?.text).toContain('result="true"');
        expect(wakes[1]?.text).toContain("Found: farewell(name) returns Goodbye, name.");
        yield* chiefTurn;

        // A turn that only answers (no change, no pull request, no report) is no result: no card, no wake.
        yield* append(quick, {
          type: "message.done",
          turn_id: "t1",
          payload: { role: "assistant", text: "It reads fine as it is." },
        });
        yield* append(quick, {
          type: "turn.done",
          turn_id: "t1",
          payload: { status: "completed" },
        });
        yield* settled;
        yield* wait(20);
        expect(moments.filter((m) => m.workspace_id === "w2")).toEqual([]);
        expect(wakes).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a first edit the watcher never handled (journaled just before a quit) still shows its plan, at the next edit, once",
    () =>
      Effect.gen(function* () {
        const editor = chat("w1", "Add farewell");
        const { journal, append, settled, started, relaunch, moments } = yield* watching([editor]);
        yield* started("ci-r", ["w1"]);
        const call = (id: string, kind: string, title: string) => ({
          type: "tool.started",
          turn_id: "t1",
          item_id: id,
          payload: { name: kind, title, kind, input: {} },
        });
        yield* relaunch(
          Effect.gen(function* () {
            yield* journal(editor, {
              type: "turn.started",
              turn_id: "t1",
              payload: { engine: "caveman" },
            });
            for (const [id, title] of [
              ["r1", "src/greet.js"],
              ["r2", "src/index.js"],
              ["r3", "README.md"],
            ] as const)
              yield* journal(editor, call(id, "read", title));
            yield* journal(editor, {
              type: "message.done",
              turn_id: "t1",
              payload: { role: "assistant", text: "I'll add farewell beside greet." },
            });
            yield* journal(editor, call("e1", "edit", "src/greet.js"));
          }),
        );
        yield* append(editor, call("e2", "edit", "README.md"));
        yield* append(editor, call("e3", "edit", "src/index.js"));
        yield* settled;
        expect(moments).toEqual([
          {
            chiefId: CHIEF_ID,
            chat: "Add farewell",
            kind: "plan",
            workspace_id: "w1",
            item_id: "ci-r",
            text: "I'll add farewell beside greet.",
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect("a failed turn wakes its Chief to fix it, and the same failure again does not", () =>
    Effect.gen(function* () {
      const editor = chat("w1", "Export to CSV");
      const { append, settled, started, wakes, moments, wait } = yield* watching([editor]);
      yield* started("ci-f", ["w1"]);
      yield* append(editor, {
        type: "turn.started",
        turn_id: "t1",
        payload: { engine: "caveman" },
      });
      yield* append(editor, {
        type: "turn.done",
        turn_id: "t1",
        payload: { status: "failed", error: "The model refused the request." },
      });
      yield* settled;
      yield* wait(20);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.text).toContain("The model refused the request.");
      // A failure is the Chief's to fix, not a moment of its own.
      expect(moments).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect(
    "a question asked in a report is a card with its words, and wakes its Chief to answer it if it can",
    () =>
      Effect.gen(function* () {
        const editor = chat("w1", "Export to CSV");
        const { board, append, settled, started, wakes, moments, wait } = yield* watching([editor]);
        yield* started("ci-w", ["w1"]);
        yield* append(editor, {
          type: "turn.started",
          turn_id: "t1",
          payload: { engine: "caveman" },
        });
        yield* append(editor, {
          type: "message.done",
          turn_id: "t1",
          payload: {
            role: "assistant",
            text: "Status: question\nFound: the export writes one line per row.\nQuestion: Comma or semicolon as the separator?",
          },
        });
        yield* append(editor, {
          type: "turn.done",
          turn_id: "t1",
          payload: { status: "completed" },
        });
        yield* settled;
        expect((yield* board.get("ci-w"))?.state).toBe("needs_you");
        // No card id and no one-click answer: the person answers in a note or in the chat.
        expect(moments).toEqual([
          {
            chiefId: CHIEF_ID,
            chat: "Export to CSV",
            kind: "needs_you",
            workspace_id: "w1",
            item_id: "ci-w",
            text: "Comma or semicolon as the separator?",
          },
        ]);
        yield* wait(20);
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.text).toContain("Comma or semicolon as the separator?");
      }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );

  it.effect("an item blocked on capacity is retried on the 10 s tick, with no chat ending", () =>
    Effect.gen(function* () {
      const { board, readmits, ticks } = yield* watching([]);
      const proposal: Board.Proposal = {
        project_ids: ["p1"],
        brief: "Wait for a slot.",
        title: "Waiter",
        quotes: [],
      };
      yield* board.update("add", (items) =>
        Effect.succeed({
          write: [
            {
              ...Board.block(
                Board.add(
                  items,
                  {
                    id: "ci-wait",
                    chief_id: CHIEF_ID,
                    text: "Waiter",
                    source: "composer",
                    state: "queued",
                  },
                  t0,
                ),
                { kind: "capacity" },
                t0,
              ),
              proposal,
            },
          ],
          value: undefined,
        }),
      );

      while (Option.isNone(yield* Queue.poll(ticks))) yield* TestClock.adjust("10 seconds");
      // The tick's readmission follows its catch-up at once; the live bound only ends the wait when it never comes.
      const retried = yield* Queue.take(readmits).pipe(
        Effect.timeoutOption("2 seconds"),
        TestClock.withLive,
      );
      expect(Option.isSome(retried), "the tick readmits the capacity-blocked item").toBe(true);
    }).pipe(Effect.scoped, Effect.provide(sqlite)),
  );
});
