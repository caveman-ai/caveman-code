// The board follows its chats' pull requests: a published workspace whose pull request merged moves its item to done
// and tells the watcher; one with failing checks flags it; an unchanged one tells nobody, one turning ready again does.
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, test } from "vitest";

import type { SessionStore, WorkspaceRecord } from "../session-protocol/store.ts";
import * as Board from "./Board.ts";
import { applyPullRequest, followPullRequests } from "./pullRequests.ts";
import { CHIEF_SCHEMA } from "./schema.ts";
import { makeBoardStore } from "./store.ts";
import { makeWatcher } from "./watch.ts";

const t0 = "2026-10-29T09:00:00.000Z";
const pr = { number: 31, url: "https://github.com/o/r/pull/31", state: "open" } as const;
const workspace = (id: string, pull_request?: Workspace["pull_request"], kind?: Workspace["kind"]): Workspace =>
  ({ id, title: `chat ${id}`, updated_at: t0, ...(pull_request ? { pull_request } : {}), ...(kind ? { kind } : {}) }) as Workspace;

const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of CHIEF_SCHEMA) yield* sql.unsafe(statement);
  const board = yield* makeBoardStore({ sql });
  yield* board.setHome("chief");
  const changes = yield* PubSub.unbounded<Workspace>();
  const records = new Map<string, WorkspaceRecord>();
  const told: string[] = [];
  const store = {
    workspaceChanges: changes,
    getWorkspace: (id: string) => Effect.succeed(records.get(id)),
  };
  const ctx = { store, board, changed: (id: string) => Effect.sync(() => void told.push(id)) };
  /** An item in review with one chat, linked. */
  const reviewItem = (id: string, chat: string) =>
    Effect.gen(function* () {
      yield* board.update("add", (items) => Effect.succeed({ write: [Board.start(Board.add(items, { id, text: `note ${id}`, source: "composer", state: "queued" }, t0), [chat], t0)], value: undefined }));
      yield* board.link(id, chat);
      yield* board.update("watch", (items) => Effect.succeed({ write: [Board.watched(items.find((i) => i.id === id)!, { kind: "review" }, t0)], value: undefined }));
    });
  return { board, changes, records, told, ctx, reviewItem };
});

const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))));

describe("the board follows pull requests", () => {
  test("merged moves the item to done and is news; an unchanged pull request is not; back to green is ready again, news", () =>
    run(
      Effect.gen(function* () {
        const { board, ctx, reviewItem } = yield* harness;
        yield* reviewItem("a", "w1");
        // The first sync records the open pull request: the board moves (it shows the number), the Chief is not woken.
        expect(yield* applyPullRequest(ctx, workspace("w1", pr))).toBe(false);
        expect((yield* board.get("a"))?.pull_request).toEqual(pr);
        expect(yield* applyPullRequest(ctx, workspace("w1", pr))).toBe(false);
        // Checks go red: needs the person, news.
        expect(yield* applyPullRequest(ctx, workspace("w1", { ...pr, checks: "failing" }))).toBe(true);
        expect(yield* board.get("a")).toMatchObject({ state: "needs_you", detail: "Checks are failing on #31." });
        // Green again: ready for review again, news (the Chief's level decides whether it wakes: chief/updates.ts).
        expect(yield* applyPullRequest(ctx, workspace("w1", { ...pr, checks: "passing" }))).toBe(true);
        expect((yield* board.get("a"))?.state).toBe("review");
        // Merged: done, news.
        expect(yield* applyPullRequest(ctx, workspace("w1", { ...pr, state: "merged", checks: "passing" }))).toBe(true);
        expect(yield* board.get("a")).toMatchObject({ state: "done", pull_request: { ...pr, state: "merged", checks: "passing" } });
        // A chat of no item, a Chief's own workspace, or a chat with no pull request: nothing.
        expect(yield* applyPullRequest(ctx, workspace("w9", { ...pr, state: "merged" }))).toBe(false);
        expect(yield* applyPullRequest(ctx, workspace("w1", { ...pr, state: "merged" }, "chief"))).toBe(false);
        expect(yield* applyPullRequest(ctx, workspace("w1"))).toBe(false);
      }),
    ));

  test("the follower catches up running items at start, then hears each published workspace, telling the watcher only news", () =>
    run(
      Effect.gen(function* () {
        const { board, changes, records, told, ctx, reviewItem } = yield* harness;
        yield* reviewItem("a", "w1");
        yield* reviewItem("b", "w2");
        // Merged while the runtime was down: moved at start.
        records.set("w1", { workspace: workspace("w1", { ...pr, state: "merged" }) } as WorkspaceRecord);
        const fiber = yield* Effect.forkScoped(followPullRequests(ctx));
        yield* Effect.sleep("50 millis");
        expect((yield* board.get("a"))?.state).toBe("done");
        expect(told).toEqual(["w1"]);
        // Published since: an open pull request (recorded, no news), then closed (news).
        yield* PubSub.publish(changes, workspace("w2", { number: 32, url: "u32", state: "open" }));
        yield* PubSub.publish(changes, workspace("w2", { number: 32, url: "u32", state: "open" }));
        yield* Effect.sleep("50 millis");
        expect(told).toEqual(["w1"]);
        yield* PubSub.publish(changes, workspace("w2", { number: 32, url: "u32", state: "closed" }));
        yield* Effect.sleep("50 millis");
        expect(yield* board.get("b")).toMatchObject({ state: "needs_you", detail: "Its pull request #32 was closed without merging." });
        expect(told).toEqual(["w1", "w2"]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.scoped),
    ));

  test("a pull request that went red while its chat worked flags the item once its chats finish, with no later change on the host", () =>
    run(
      Effect.gen(function* () {
        const { board, changes, records, ctx } = yield* harness;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE TABLE caveman_sp_events (session_id TEXT NOT NULL, cursor INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL)`);
        const events = yield* PubSub.unbounded<SessionEvent>();
        const chat = (id: string, pull_request?: Workspace["pull_request"]) =>
          void records.set(id, { workspace: workspace(id, pull_request), session: { id: `s-${id}` } } as unknown as WorkspaceRecord);
        chat("w1");
        chat("w2");
        let cursor = 0;
        /** A chat's events journaled, then published, as the session store does. */
        const journal = (id: string, drafts: ReadonlyArray<Record<string, unknown>>) =>
          Effect.gen(function* () {
            const published: Array<SessionEvent> = [];
            for (const draft of drafts) {
              const event = { session_id: `s-${id}`, cursor: ++cursor, at: t0, ...draft } as unknown as SessionEvent;
              yield* sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event) VALUES (${event.session_id}, ${cursor}, ${event.type}, ${event.at}, ${JSON.stringify(event)})`;
              published.push(event);
            }
            yield* PubSub.publishAll(events, published);
          });
        const store = { ...ctx.store, events, sql, getBySession: (sessionId: string) => Effect.succeed([...records.values()].find((r) => r.session.id === sessionId)) };
        const watcher = yield* makeWatcher({ store: store as unknown as SessionStore["Service"], board, wake: () => Effect.void, readmit: Effect.void, onCompaction: () => Effect.void, tainted: () => Effect.succeed(false), markTainted: () => Effect.void, tick: Effect.void, moment: () => Effect.void });
        // One item, two chats at work.
        yield* board.update("add", (items) => Effect.succeed({ write: [Board.start(Board.add(items, { id: "a", text: "fix the export", source: "composer", state: "queued" }, t0), ["w1", "w2"], t0)], value: undefined }));
        yield* board.link("a", "w1");
        yield* board.link("a", "w2");
        yield* Effect.forkScoped(watcher.run);
        yield* Effect.forkScoped(followPullRequests(ctx));
        yield* Effect.sleep("50 millis");
        yield* journal("w1", [{ type: "turn.started", turn_id: "t1", payload: {} }]);
        yield* journal("w2", [{ type: "turn.started", turn_id: "t2", payload: {} }]);
        // w1's pull request goes red mid-turn: recorded on the started item, which its chat is left to fix.
        const red = { ...pr, checks: "failing" } as const;
        chat("w1", red);
        yield* PubSub.publish(changes, records.get("w1")!.workspace);
        yield* Effect.sleep("50 millis");
        expect(yield* board.get("a")).toMatchObject({ state: "started", pull_request: red });
        // w1 finishes with its checks still red while w2 works on; then w2 finishes, with no pull request of its own.
        yield* journal("w1", [{ type: "diff.changed", payload: { files: [{ path: "export.ts" }] } }, { type: "turn.done", turn_id: "t1", payload: { status: "completed" } }]);
        yield* Effect.sleep("50 millis");
        expect((yield* board.get("a"))?.state).toBe("started");
        yield* journal("w2", [{ type: "diff.changed", payload: { files: [{ path: "csv.ts" }] } }, { type: "turn.done", turn_id: "t2", payload: { status: "completed" } }]);
        yield* Effect.sleep("100 millis");
        expect(yield* board.get("a")).toMatchObject({ state: "needs_you", detail: "Checks are failing on #31.", pull_request: red });
      }).pipe(Effect.scoped),
    ));
});
