// The Chiefs' one board on disk (chief/schema.ts): items (each on one Chief's board), change sets
// and the chats each item started. Every write logs one board event per item it touched, with its
// Chief, and publishes the whole board (chief.board.updated). Writes take one lock, so a
// read-modify-write never loses another's.
import type { ChiefAttachment, ChiefBoard, ChiefChangeSet, ChiefRoutine } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";

import type { SessionStore } from "../session-protocol/store.ts";
import { byRank, CLOSED_STATES, toWire, type Item } from "./Board.ts";
import { nextNumber, numberItems } from "./schema.ts";

/** Done and dropped items stay on the board this long (Done today). */
export const CLOSED_KEPT_MS = 24 * 60 * 60 * 1000;

interface ItemRow {
  id: string;
  chief_id: string | null;
  text: string;
  title: string | null;
  state: string;
  rank: number;
  pinned: number;
  projects: string;
  change_set_id: string | null;
  blocked_on: string | null;
  not_before: string | null;
  detail: string | null;
  asked: string | null;
  source: string;
  start: number;
  proposal: string | null;
  delivered: number;
  created_at: string;
  updated_at: string;
  seq: number | null;
  pull_request: string | null;
  attachments: string | null;
  updates: string | null;
  proof: string | null;
  heard_in: string | null;
  done_when: string | null;
  check_in: string | null;
  started_at: string | null;
  checked_at: string | null;
  sent_as: string | null;
  sent_in: string | null;
}
interface ChangeSetRow {
  id: string;
  title: string;
  repos: string;
  contract: string;
  merge_order: string;
  state: string;
  created_at: string;
  updated_at: string;
}

const itemOf = (row: ItemRow, workspaceIds: ReadonlyArray<string>, home: string | undefined): Item =>
  ({
    id: row.id,
    ...(row.seq === null ? {} : { number: row.seq }),
    // A row from before Chiefs had profiles is the home Chief's.
    ...((row.chief_id ?? home) === undefined ? {} : { chief_id: row.chief_id ?? home }),
    text: row.text,
    ...(row.title ? { title: row.title } : {}),
    state: row.state,
    rank: row.rank,
    pinned: row.pinned === 1,
    project_ids: JSON.parse(row.projects),
    ...(row.change_set_id ? { change_set_id: row.change_set_id } : {}),
    ...(row.blocked_on ? { blocked_on: JSON.parse(row.blocked_on) } : {}),
    ...(row.not_before ? { not_before: row.not_before } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.pull_request ? { pull_request: JSON.parse(row.pull_request) } : {}),
    ...(row.asked ? { asked: JSON.parse(row.asked) } : {}),
    source: row.source,
    workspace_ids: [...workspaceIds],
    start: row.start === 1,
    ...(row.proposal ? { proposal: JSON.parse(row.proposal) } : {}),
    ...(row.delivered === 1 ? { delivered: true } : {}),
    ...(row.attachments ? { attachments: JSON.parse(row.attachments) } : {}),
    ...(row.updates ? { updates: row.updates } : {}),
    ...(row.proof ? { proof: JSON.parse(row.proof) } : {}),
    ...(row.heard_in ? { heard_in: row.heard_in } : {}),
    ...(row.done_when ? { done_when: row.done_when } : {}),
    ...(row.check_in ? { check_in: row.check_in } : {}),
    ...(row.started_at ? { started_at: row.started_at } : {}),
    ...(row.checked_at ? { checked_at: row.checked_at } : {}),
    ...(row.sent_as ? { sent_as: row.sent_as } : {}),
    ...(row.sent_in ? { sent_in: row.sent_in } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }) as Item;

const changeSetOf = (row: ChangeSetRow): ChiefChangeSet => ({
  id: row.id,
  title: row.title,
  project_ids: JSON.parse(row.repos),
  contract: row.contract,
  merge_order: JSON.parse(row.merge_order),
  state: row.state as ChiefChangeSet["state"],
  created_at: row.created_at,
  updated_at: row.updated_at,
});

interface RoutineRow {
  automation_id: string;
  project_id: string;
  name: string;
  run_id: string;
  ran_at: string;
  status: string;
  decision: string | null;
  summary: string;
  chief_id: string | null;
}

/** A routine's run that found news, until its Chief heard it (chief_routine_news). */
export interface RoutineNews {
  readonly run_id: string;
  readonly automation_id: string;
  readonly project_id: string;
  /** The Chief it reported to (Chief.ts routineReport); absent on news from before routines named their Chief. */
  readonly chief_id?: string | null;
  readonly name: string;
  readonly report: string;
  readonly at: string;
}

/** What a routine's row keeps of its last report: the conversation's news card has all of it. */
export const ROUTINE_SUMMARY_CHARS = 2_000;

const routineOf = (row: RoutineRow): ChiefRoutine => ({
  automation_id: row.automation_id,
  project_id: row.project_id,
  ...(row.chief_id === null ? {} : { chief_id: row.chief_id }),
  name: row.name,
  run_id: row.run_id,
  ran_at: row.ran_at,
  status: row.status === "failed" ? "failed" : "succeeded",
  ...(row.decision === null ? {} : { decision: row.decision }),
  summary: row.summary,
});

export type BoardStore = Effect.Success<ReturnType<typeof makeBoardStore>>;

export const makeBoardStore = (store: Pick<SessionStore["Service"], "sql">) =>
  Effect.gen(function* () {
    const { sql } = store;
    const lock = yield* Semaphore.make(1);
    const changes = yield* PubSub.unbounded<ChiefBoard>();
    /** The home Chief: the owner of rows from before Chiefs had profiles (chief_id NULL). */
    let home: string | undefined;
    /** Names the home Chief, and gives it every item no Chief owns yet (rows from before Chiefs had profiles). */
    const setHome = (id: string) =>
      Effect.gen(function* () {
        home = id;
        // Numbered again on the home Chief's board, after its own.
        yield* sql`UPDATE chief_items SET chief_id = ${id}, seq = NULL WHERE chief_id IS NULL`;
        yield* numberItems(sql);
      }).pipe(Effect.orDie);

    const links = sql<{ item_id: string; workspace_id: string }>`SELECT item_id, workspace_id FROM chief_item_workspaces ORDER BY at, rowid`.pipe(
      Effect.map((rows) => {
        const by = new Map<string, Array<string>>();
        for (const row of rows) by.set(row.item_id, [...(by.get(row.item_id) ?? []), row.workspace_id]);
        return by;
      }),
    );
    /** Every item, in Queue order. */
    const all = Effect.gen(function* () {
      const rows = yield* sql<ItemRow>`SELECT * FROM chief_items`;
      const linked = yield* links;
      return rows.map((row) => itemOf(row, linked.get(row.id) ?? [], home)).sort(byRank);
    }).pipe(Effect.orDie);
    /** The board's items: everything open, and what closed in the last day. */
    const items = all.pipe(
      Effect.map((list) => {
        const since = new Date(Date.now() - CLOSED_KEPT_MS).toISOString();
        return list.filter((item) => !CLOSED_STATES.has(item.state) || item.updated_at >= since);
      }),
    );
    const get = (id: string) => all.pipe(Effect.map((list) => list.find((item) => item.id === id)));
    /** One Chief's items, in Queue order. */
    const of = (chiefId: string) => all.pipe(Effect.map((list) => list.filter((item) => item.chief_id === chiefId)));
    const changeSets = sql<ChangeSetRow>`SELECT * FROM chief_change_sets ORDER BY created_at`.pipe(Effect.map((rows) => rows.map(changeSetOf)), Effect.orDie);
    /** Each routine's last run, newest first. */
    const routines = sql<RoutineRow>`SELECT * FROM chief_routines ORDER BY ran_at DESC`.pipe(Effect.map((rows) => rows.map(routineOf)), Effect.orDie);
    const board = Effect.all({ items, change_sets: changeSets, routines }).pipe(
      Effect.map(({ items, change_sets, routines }): ChiefBoard => ({ items: items.map(toWire), change_sets, ...(routines.length > 0 ? { routines } : {}) })),
    );
    const publish = board.pipe(Effect.flatMap((b) => PubSub.publish(changes, b)), Effect.asVoid);

    const writeItem = (item: Item, kind: string) =>
      Effect.gen(function* () {
        // Never its chats: those are linked as each is made (link), so a stale copy of the item can't relink one.
        // An item never moves to another Chief's board: its chief_id is set once. Its number is the next on that board,
        // set once too.
        const chiefId = item.chief_id ?? home ?? null;
        const known = yield* sql<{ id: string }>`SELECT id FROM chief_items WHERE id = ${item.id}`;
        const seq = known.length > 0 ? null : yield* nextNumber(sql, chiefId);
        yield* sql`INSERT INTO chief_items (id, chief_id, text, title, state, rank, pinned, projects, change_set_id, blocked_on, not_before, detail, asked, source, start, proposal, delivered, created_at, updated_at, seq, pull_request, attachments, updates, proof, done_when, check_in, started_at, checked_at)
          VALUES (${item.id}, ${chiefId}, ${item.text}, ${item.title ?? null}, ${item.state}, ${item.rank}, ${item.pinned ? 1 : 0}, ${JSON.stringify(item.project_ids)},
                  ${item.change_set_id ?? null}, ${item.blocked_on ? JSON.stringify(item.blocked_on) : null}, ${item.not_before ?? null}, ${item.detail ?? null},
                  ${item.asked ? JSON.stringify(item.asked) : null}, ${item.source}, ${item.start ? 1 : 0}, ${item.proposal ? JSON.stringify(item.proposal) : null}, ${item.delivered ? 1 : 0}, ${item.created_at}, ${item.updated_at}, ${seq},
                  ${item.pull_request ? JSON.stringify(item.pull_request) : null}, ${item.attachments?.length ? JSON.stringify(item.attachments) : null}, ${item.updates ?? null}, ${item.proof?.length ? JSON.stringify(item.proof) : null}, ${item.done_when ?? null}, ${item.check_in ?? null}, ${item.started_at ?? null}, ${item.checked_at ?? null})
          ON CONFLICT (id) DO UPDATE SET text = excluded.text, title = excluded.title, state = excluded.state, rank = excluded.rank, pinned = excluded.pinned,
            projects = excluded.projects, change_set_id = excluded.change_set_id, blocked_on = excluded.blocked_on, not_before = excluded.not_before,
            detail = excluded.detail, asked = excluded.asked, source = excluded.source, start = excluded.start, proposal = excluded.proposal, pull_request = excluded.pull_request, attachments = excluded.attachments, updates = excluded.updates, proof = excluded.proof,
            done_when = excluded.done_when, check_in = excluded.check_in, started_at = excluded.started_at, checked_at = excluded.checked_at,
            delivered = MAX(delivered, excluded.delivered), updated_at = excluded.updated_at, chief_id = COALESCE(chief_items.chief_id, excluded.chief_id)`;
        yield* sql`INSERT INTO chief_board_events (at, item_id, kind, chief_id) VALUES (${item.updated_at}, ${item.id}, ${kind}, (SELECT chief_id FROM chief_items WHERE id = ${item.id}))`;
      });

    /**
     * Runs `change` on the current items under the board lock and writes what it returns, in one
     * transaction; then publishes the board. `kind` names the change in the log.
     */
    const update = <A>(kind: string, change: (items: ReadonlyArray<Item>) => Effect.Effect<{ readonly write: ReadonlyArray<Item>; readonly value: A }, never>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const result = yield* sql.withTransaction(
            Effect.gen(function* () {
              const out = yield* change(yield* all);
              for (const item of out.write) yield* writeItem(item, kind);
              return out;
            }),
          );
          if (result.write.length > 0) yield* publish;
          return result.value;
        }).pipe(Effect.orDie),
      );

    const remove = (id: string, kind = "remove") =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const removed = yield* sql.withTransaction(
            Effect.gen(function* () {
              // Its chats stay linked: they still count toward the Chief's limits and today's spend.
              const current = yield* get(id);
              const [owner] = yield* sql<{ chief_id: string | null }>`SELECT chief_id FROM chief_items WHERE id = ${id}`;
              yield* sql`DELETE FROM chief_items WHERE id = ${id}`;
              yield* sql`INSERT INTO chief_board_events (at, item_id, kind, chief_id) VALUES (${new Date().toISOString()}, ${id}, ${kind}, ${owner?.chief_id ?? home ?? null})`;
              return current;
            }),
          );
          yield* publish;
          return removed;
        }).pipe(Effect.orDie),
      );

    /**
     * Items onto other Chiefs' boards, each onto its `chief_id`'s (a gone Chief's open items go to Chiefs that work in
     * their projects): the only way an item changes boards. `plan` picks them from the current items, under the board
     * lock, so a write that landed just before (a note captured, an edit) moves with them, never left behind or
     * overwritten by an older copy. `delivered` is set as given, so a note the new Chief has not heard goes to it, and
     * `heard_in` (set once) keeps where its first Chief heard it. `within` runs in the same transaction (the gone
     * Chief's profile marked removed), so either all of it happens or none.
     */
    const move = <A>(
      plan: (items: ReadonlyArray<Item>) => Effect.Effect<{ readonly moved: ReadonlyArray<Item & { readonly chief_id: string }>; readonly within?: Effect.Effect<void>; readonly value: A }>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const out = yield* sql.withTransaction(
            Effect.gen(function* () {
              const out = yield* plan(yield* all);
              for (const item of out.moved) {
                yield* sql`UPDATE chief_items SET chief_id = ${item.chief_id}, delivered = ${item.delivered ? 1 : 0}, seq = NULL, heard_in = COALESCE(heard_in, ${item.heard_in ?? null}) WHERE id = ${item.id}`;
                yield* writeItem(item, "move");
              }
              // Numbered again on their new boards, after their own.
              yield* numberItems(sql);
              if (out.within !== undefined) yield* out.within;
              return out;
            }),
          );
          if (out.moved.length > 0) yield* publish;
          return out.value;
        }).pipe(Effect.orDie),
      );

    const putChangeSet = (set: ChiefChangeSet) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* sql`INSERT INTO chief_change_sets (id, title, repos, contract, merge_order, state, created_at, updated_at)
            VALUES (${set.id}, ${set.title}, ${JSON.stringify(set.project_ids)}, ${set.contract}, ${JSON.stringify(set.merge_order)}, ${set.state}, ${set.created_at}, ${set.updated_at})
            ON CONFLICT (id) DO UPDATE SET title = excluded.title, repos = excluded.repos, contract = excluded.contract,
              merge_order = excluded.merge_order, state = excluded.state, updated_at = excluded.updated_at`;
          yield* sql`INSERT INTO chief_board_events (at, item_id, kind) VALUES (${set.updated_at}, NULL, 'change_set')`;
          yield* publish;
        }).pipe(Effect.orDie),
      );

    /** A routine's run, as its row: false when that run is its row already (a report handed over again after a restart). */
    const putRoutine = (routine: ChiefRoutine) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const [there] = yield* sql<{ run_id: string }>`SELECT run_id FROM chief_routines WHERE automation_id = ${routine.automation_id}`;
          if (there?.run_id === routine.run_id) return false;
          const summary = routine.summary.length > ROUTINE_SUMMARY_CHARS ? `${routine.summary.slice(0, ROUTINE_SUMMARY_CHARS - 1)}…` : routine.summary;
          yield* sql`INSERT INTO chief_routines (automation_id, project_id, name, run_id, ran_at, status, decision, summary, chief_id)
            VALUES (${routine.automation_id}, ${routine.project_id}, ${routine.name}, ${routine.run_id}, ${routine.ran_at}, ${routine.status}, ${routine.decision ?? null}, ${summary}, ${routine.chief_id ?? null})
            ON CONFLICT (automation_id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, run_id = excluded.run_id, ran_at = excluded.ran_at,
              status = excluded.status, decision = excluded.decision, summary = excluded.summary, chief_id = excluded.chief_id`;
          yield* publish;
          return true;
        }).pipe(Effect.orDie),
      );

    /** A news run, kept until its Chief heard it: true while it still waits (again after a restart), false once heard. */
    const putNews = (news: RoutineNews) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO chief_routine_news (run_id, automation_id, project_id, name, report, at, chief_id)
          VALUES (${news.run_id}, ${news.automation_id}, ${news.project_id}, ${news.name}, ${news.report}, ${news.at}, ${news.chief_id ?? null})
          ON CONFLICT (run_id) DO NOTHING`;
        const [row] = yield* sql<{ heard_at: string | null }>`SELECT heard_at FROM chief_routine_news WHERE run_id = ${news.run_id}`;
        return row?.heard_at === null;
      }).pipe(Effect.orDie);
    /** The news runs no Chief heard yet, oldest first. */
    const unheardNews = sql<RoutineNews>`SELECT run_id, automation_id, project_id, chief_id, name, report, at FROM chief_routine_news WHERE heard_at IS NULL ORDER BY at`.pipe(Effect.orDie);
    const markNewsHeard = (runId: string) => sql`UPDATE chief_routine_news SET heard_at = ${new Date().toISOString()} WHERE run_id = ${runId}`.pipe(Effect.asVoid, Effect.orDie);

    /** A chat made for an item, linked at once. `task`: a held fan-out sibling's task, and `attachments` its images, until release. */
    const link = (
      itemId: string,
      workspaceId: string,
      opts: { readonly runId?: string | undefined; readonly task?: string | undefined; readonly attachments?: ReadonlyArray<ChiefAttachment> | undefined } = {},
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const at = new Date().toISOString();
          const attachments = opts.attachments?.length ? JSON.stringify(opts.attachments) : null;
          yield* sql`INSERT OR IGNORE INTO chief_item_workspaces (item_id, workspace_id, role, at, run_id, task, task_attachments)
            VALUES (${itemId}, ${workspaceId}, ${opts.task === undefined ? "started" : "held"}, ${at}, ${opts.runId ?? null}, ${opts.task ?? null}, ${attachments})`;
          yield* sql`INSERT INTO chief_board_events (at, item_id, kind, chief_id) VALUES (${at}, ${itemId}, 'link', (SELECT chief_id FROM chief_items WHERE id = ${itemId}))`;
          yield* publish;
        }).pipe(Effect.orDie),
      );
    /** A held sibling got its task. */
    const release = (workspaceId: string) => sql`UPDATE chief_item_workspaces SET role = 'started', task = NULL, task_attachments = NULL WHERE workspace_id = ${workspaceId}`.pipe(Effect.asVoid, Effect.orDie);
    /** A chat that never started (an abandoned sibling): no longer the item's. */
    const unlink = (workspaceId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<{ item_id: string }>`SELECT item_id FROM chief_item_workspaces WHERE workspace_id = ${workspaceId}`;
          yield* sql`DELETE FROM chief_item_workspaces WHERE workspace_id = ${workspaceId}`;
          for (const row of rows) yield* sql`INSERT INTO chief_board_events (at, item_id, kind, chief_id) VALUES (${new Date().toISOString()}, ${row.item_id}, 'unlink', (SELECT chief_id FROM chief_items WHERE id = ${row.item_id}))`;
          yield* publish;
        }).pipe(Effect.orDie),
      );
    /** Held siblings and their tasks, with the images each goes with. */
    const held = sql<{ item_id: string; workspace_id: string; task: string; task_attachments: string | null }>`SELECT item_id, workspace_id, task, task_attachments FROM chief_item_workspaces WHERE task IS NOT NULL`.pipe(
      Effect.map((rows) => rows.map(({ task_attachments, ...row }) => ({ ...row, attachments: task_attachments === null ? [] : (JSON.parse(task_attachments) as ReadonlyArray<ChiefAttachment>) }))),
      Effect.orDie,
    );
    /** The chats a Chief turn started. */
    const runChats = (runId: string) =>
      sql<{ workspace_id: string }>`SELECT workspace_id FROM chief_item_workspaces WHERE run_id = ${runId}`.pipe(
        Effect.map((rows) => rows.map((row) => row.workspace_id)),
        Effect.orDie,
      );
    /**
     * The note reached `chiefId` (no board event: nothing the person sees changed). Only while it is still that Chief's:
     * a note moved to another Chief as its Chief went waits to reach that one. Keep the latest accepted session and
     * exact request id together for reactions, and the first heard_in session for quote checks.
     */
    const markDelivered = (id: string, chiefId: string, receipt?: { readonly session: string; readonly request: string }) =>
      sql`UPDATE chief_items SET delivered = 1,
        sent_as = ${receipt?.request ?? null}, sent_in = ${receipt?.session ?? null},
        heard_in = COALESCE(heard_in, ${receipt?.session ?? null})
        WHERE id = ${id} AND chief_id = ${chiefId}`.pipe(Effect.asVoid, Effect.orDie);

    /**
     * Mission check-ins claimed or handed back: each item's checked_at moves from `from` to `to` only where it still is
     * `from`, under the board lock, so no write holding an older copy undoes it. Bookkeeping the person never sees: no
     * board event (the Chief's board changes) and no publish. The ids that moved.
     */
    const moveCheckIns = (moves: ReadonlyArray<{ readonly id: string; readonly from: string | undefined; readonly to: string | undefined }>) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const moved: Array<string> = [];
          for (const { id, from, to } of moves) {
            const rows = yield* sql<{ id: string }>`UPDATE chief_items SET checked_at = ${to ?? null} WHERE id = ${id} AND checked_at IS ${from ?? null} RETURNING id`;
            if (rows.length > 0) moved.push(id);
          }
          return moved;
        }).pipe(Effect.orDie),
      );

    /** The item a chat was started for. */
    const itemOfWorkspace = (workspaceId: string) =>
      sql<{ item_id: string }>`SELECT item_id FROM chief_item_workspaces WHERE workspace_id = ${workspaceId} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.item_id),
        Effect.orDie,
      );
    /** Every chat the Chief started. */
    const linkedWorkspaces = sql<{ workspace_id: string }>`SELECT DISTINCT workspace_id FROM chief_item_workspaces`.pipe(
      Effect.map((rows) => rows.map((row) => row.workspace_id)),
      Effect.orDie,
    );

    /** Where the watcher (chief/watch.ts) stands with each chat it follows (schema.ts), so a relaunch picks up there. */
    const watchMarks = sql<{ workspace_id: string; applied: number | null; held: number | null; heard: number | null; early: number | null }>`SELECT workspace_id,
        MAX(applied) AS applied, MAX(held) AS held, MAX(heard) AS heard, MAX(early) AS early FROM chief_item_workspaces GROUP BY workspace_id`.pipe(
      Effect.map((rows) => rows.map((row) => ({ workspaceId: row.workspace_id, applied: row.applied ?? 0, held: row.held ?? 0, heard: row.heard ?? 0, early: row.early === 1 }))),
      Effect.orDie,
    );
    /** The watcher moved the chat's item by its turn event at `cursor`. */
    const markApplied = (workspaceId: string, cursor: number) =>
      sql`UPDATE chief_item_workspaces SET applied = max(coalesce(applied, 0), ${cursor}) WHERE workspace_id = ${workspaceId}`.pipe(Effect.asVoid, Effect.orDie);
    /** The chat's update is held for its Chief once more: the hold's number, which `markHeard` takes once its Chief has it. */
    const markHeld = (workspaceId: string) =>
      sql<{ held: number }>`UPDATE chief_item_workspaces SET held = coalesce(held, 0) + 1 WHERE workspace_id = ${workspaceId} RETURNING held`.pipe(
        Effect.map((rows) => Math.max(0, ...rows.map((row) => row.held))),
        Effect.orDie,
      );
    /** Its Chief was handed the chat's update as it stood at hold `held`. */
    const markHeard = (workspaceId: string, held: number) =>
      sql`UPDATE chief_item_workspaces SET heard = max(coalesce(heard, 0), ${held}) WHERE workspace_id = ${workspaceId}`.pipe(Effect.asVoid, Effect.orDie);
    /** The chat's finish waits for the move that ends its item, or no longer does. */
    const markEarly = (workspaceId: string, early: boolean) =>
      sql`UPDATE chief_item_workspaces SET early = ${early ? 1 : null} WHERE workspace_id = ${workspaceId}`.pipe(Effect.asVoid, Effect.orDie);
    /** Whether the chat's Chief was handed its result for this item to explain (watch.ts): once per chat and item. */
    const narrated = (workspaceId: string, itemId: string) =>
      sql<{ narrated: string | null }>`SELECT narrated FROM chief_item_workspaces WHERE workspace_id = ${workspaceId} AND item_id = ${itemId}`.pipe(
        Effect.map((rows) => rows.some((row) => row.narrated !== null)),
        Effect.orDie,
      );
    /** Its Chief was handed the chat's result for this item, from its turn `turnId`, to explain. */
    const markNarrated = (workspaceId: string, itemId: string, turnId: string) =>
      sql`UPDATE chief_item_workspaces SET narrated = ${turnId} WHERE workspace_id = ${workspaceId} AND item_id = ${itemId}`.pipe(Effect.asVoid, Effect.orDie);
    /** The log's newest position. */
    const head = sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM chief_board_events`.pipe(Effect.map((rows) => rows[0]?.seq ?? 0), Effect.orDie);
    /** Items the log touched after `seq`: the ones still there, and the ids since removed; `chiefId`: only that Chief's. */
    const touchedSince = (seq: number, chiefId?: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ item_id: string; chief_id: string | null; person: number }>`SELECT item_id, MAX(chief_id) AS chief_id,
          MAX(CASE WHEN kind LIKE 'person:%' THEN 1 ELSE 0 END) AS person FROM chief_board_events WHERE seq > ${seq} AND item_id IS NOT NULL GROUP BY item_id`;
        const current = yield* all;
        const owners = new Map(rows.map((row) => [row.item_id, row.chief_id ?? home] as const));
        const mine = (id: string, owner: string | undefined) => chiefId === undefined || owner === chiefId || (owner === undefined && owners.get(id) === chiefId);
        return {
          changed: current.filter((item) => owners.has(item.id) && mine(item.id, item.chief_id)),
          removed: [...owners.keys()].filter((id) => !current.some((item) => item.id === id) && mine(id, undefined)),
          person: rows.filter((row) => row.person === 1 && mine(row.item_id, current.find((item) => item.id === row.item_id)?.chief_id)).map((row) => row.item_id),
        };
      }).pipe(Effect.orDie);

    return { all, items, get, of, setHome, board, changeSets, routines, putRoutine, putNews, unheardNews, markNewsHeard, update, remove, move, putChangeSet, link, release, unlink, held, runChats, markDelivered, moveCheckIns, itemOfWorkspace, linkedWorkspaces, watchMarks, markApplied, markHeld, markHeard, markEarly, narrated, markNarrated, head, touchedSince, changes, publish };
  });
