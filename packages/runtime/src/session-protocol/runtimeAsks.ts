// Asks the runtime journals itself (a grill round, a custom tool call), not an engine's requests: an ask.user it
// appends to the session with its thread's projector state, and the ask.resolved that closes it. While one is open
// the workspace shows needs_input, as the daemon shows for an engine's ask; an interrupted turn resolves it
// (projector.ts), and so does the waiting tool call ending.
import type { AskResponse as AskResponseSchema, SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { emptyThreadState, threadActivity, type DraftEvent, type ThreadState } from "./projector.ts";
import type * as Store from "./store.ts";
import type { WorkspaceRecord } from "./store.ts";

export type AskResponse = typeof AskResponseSchema.Type;
export type AskUserEvent = Extract<SessionEvent, { type: "ask.user" }>;

const now = () => new Date().toISOString();

export const makeRuntimeAsks = (store: Store.SessionStore["Service"]) => {
  const { sql } = store;

  /** In the store's transaction: the thread's projector state, changed by `change`, plus the drafts it appends. */
  const withState = <A>(record: WorkspaceRecord, change: (state: ThreadState, current: WorkspaceRecord) => { value: A; drafts: ReadonlyArray<DraftEvent> }) =>
    store.transact(
      Effect.gen(function* () {
        const current = (yield* store.getByThread(record.internal.threadId)) ?? record;
        const row = yield* sql<{ state: string }>`SELECT state FROM caveman_sp_thread_state WHERE thread_id = ${current.internal.threadId}`;
        const state: ThreadState = row[0] ? JSON.parse(row[0].state) : emptyThreadState();
        const { value, drafts } = change(state, current);
        // The workspace shows needs_input while an ask waits, as the daemon does for engine asks.
        const activity = threadActivity(state);
        const held = current.workspace.status === "archived" || current.workspace.status === "parked";
        const statusChanged = !held && current.workspace.status !== activity;
        const next = statusChanged ? { ...current, workspace: { ...current.workspace, status: activity, updated_at: now() } } : current;
        const appended = yield* store.appendInTx(next, drafts);
        // An ask is what a row shows (Workspace.activity), folded as it is appended.
        const active = appended.record.workspace.activity !== next.workspace.activity;
        yield* sql`INSERT INTO caveman_sp_thread_state (thread_id, state) VALUES (${current.internal.threadId}, ${JSON.stringify(state)})
                   ON CONFLICT (thread_id) DO UPDATE SET state = excluded.state`;
        return { value, published: appended.events, changed: statusChanged || active ? [appended.record.workspace] : [] };
      }).pipe(Effect.orDie),
    );

  const askEvent = (sessionId: string, askId: string) =>
    sql<{ event: string }>`SELECT event FROM caveman_sp_events
      WHERE session_id = ${sessionId} AND type = 'ask.user' AND json_extract(event, '$.item_id') = ${askId}`.pipe(
      Effect.map((rows) => (rows[0] ? (JSON.parse(rows[0].event) as AskUserEvent) : undefined)),
      Effect.orDie,
    );

  const resolvedOutcome = (sessionId: string, askId: string) =>
    sql<{ outcome: string | null }>`SELECT json_extract(event, '$.payload.outcome') AS outcome FROM caveman_sp_events
      WHERE session_id = ${sessionId} AND type = 'ask.resolved' AND json_extract(event, '$.item_id') = ${askId}`.pipe(
      Effect.map((rows) => rows[0]?.outcome ?? undefined),
      Effect.orDie,
    );

  /** ask.resolved for an open ask; false when it was already resolved. */
  const close = (record: WorkspaceRecord, ask: { readonly item_id?: string; readonly turn_id?: string }, outcome: "answered" | "cancelled", response?: AskResponse) =>
    withState(record, (state) => {
      if (state.asks[ask.item_id!] !== "open") return { value: false, drafts: [] };
      state.asks[ask.item_id!] = "resolved";
      const draft = { at: now(), type: "ask.resolved", item_id: ask.item_id, ...(ask.turn_id ? { turn_id: ask.turn_id } : {}), payload: { outcome, ...(response ? { response } : {}) } };
      return { value: true, drafts: [draft as DraftEvent] };
    });

  /** The thread's running turn, which an ask it posts belongs to. */
  const runningTurn = (threadId: string) =>
    sql<{ state: string }>`SELECT state FROM caveman_sp_thread_state WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => {
        const runs = rows[0] ? (JSON.parse(rows[0].state) as ThreadState).runs : {};
        return Object.entries(runs).find(([, run]) => run.started && !run.done)?.[0];
      }),
      Effect.orDie,
    );

  return { withState, askEvent, resolvedOutcome, close, runningTurn };
};
