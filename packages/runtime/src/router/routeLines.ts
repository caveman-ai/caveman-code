// "Routed to <model>" lines for chats on Auto. caveman-proxy logs each call it
// routes in its own SQLite database. While a chat's Auto turn runs, this reads
// that log, locally and read-only, and shows the model a call ran on when it
// changes. The route reason only filters rows; it never leaves this file.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import type { DraftEvent } from "../session-protocol/projector.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { isRouterModel, proxySession, ROUTER_MODEL } from "./cavemanRouter.ts";
import { appProxyHome } from "./proxyLauncher.ts";

/** The app proxies' database, in their own home; undefined before the runtime set it. */
export const routerDatabase = (): string | undefined => {
  const home = appProxyHome();
  return home === undefined ? undefined : NodePath.join(home, "caveman.db");
};

/** Read-only, closed after each read; `none` while the database, table or a column is missing. */
const read = <A>(file: string, body: (db: NodeSqlite.DatabaseSync) => A, none: A): A => {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    return body(db);
  } catch {
    return none;
  } finally {
    db?.close();
  }
};

/** The log's newest row, so a watch starts after what is already there; undefined when it cannot be read. */
export const lastRouteId = (file: string): number | undefined =>
  read(file, (db) => Number((db.prepare("SELECT max(id) AS id FROM requests").get() as { id: number | null } | undefined)?.id ?? 0), undefined);

// ponytail: reads caveman-proxy's requests table directly (id, session_id, route_from, route_to, route_reason); a read-only route endpoint on the proxy when that schema moves.
/**
 * The rows after `after`, each read once: the last one's id, and the chat's
 * own Auto calls among them with the model each ran on. Side requests,
 * subagents and compaction are routed on their own and skipped. Undefined
 * when the log cannot be read.
 */
export const readRoutes = (
  file: string,
  session: string,
  after: number,
): { readonly last: number; readonly routes: ReadonlyArray<{ readonly id: number; readonly model: string }> } | undefined =>
  read(
    file,
    (db) => {
      const rows = db
        .prepare(
          `SELECT id, route_to, (session_id = ? AND route_from = ? AND coalesce(route_to, '') <> ''
             AND coalesce(route_reason, '') NOT LIKE 'auxiliary%'
             AND coalesce(route_reason, '') NOT LIKE 'subagent%'
             AND coalesce(route_reason, '') NOT LIKE 'compaction%') AS mine
           FROM requests WHERE id > ? ORDER BY id`,
        )
        .all(proxySession(session), ROUTER_MODEL, after);
      return {
        last: rows.length === 0 ? after : Number(rows[rows.length - 1]!.id),
        routes: rows.filter((row) => row.mine === 1).map((row) => ({ id: Number(row.id), model: String(row.route_to) })),
      };
    },
    undefined,
  );

/** Polls once an Auto turn is done: the proxy writes a call's row when the call completes. */
const POLLS_AFTER_TURN = 5;
/**
 * A watch whose turn never ends stops after this long without a call of its own. Long: a turn may wait
 * on a 30-minute test run between calls and still owes its route lines (20 minutes dropped them).
 */
const WATCH_IDLE_MS = 6 * 60 * 60_000;

/**
 * While a session has an Auto turn running, and a few seconds after, polls the
 * proxy's log every second and appends `model.routed` (the model only) when
 * the model differs from the last one shown for that session.
 */
export const runRouteLines = (idleMs = WATCH_IDLE_MS) => Effect.gen(function* () {
  const store = yield* SessionStore;
  const scope = yield* Effect.scope;
  /** A watched session: its turn, the polls left once that turn is done, and when it last had a call. */
  type Watch = { turnId: string | undefined; polls: number | undefined; heard: number };
  const watching = new Map<string, Watch>();
  const shown = new Map<string, string>();

  const watch = (sessionId: string, threadId: string, turn: Watch) =>
    Effect.gen(function* () {
      const file = routerDatabase();
      if (file === undefined) return;
      // Unreadable now: found next poll, never a scan from row 0.
      let after = lastRouteId(file);
      while ((turn.polls === undefined || turn.polls-- > 0) && Date.now() - turn.heard < idleMs) {
        yield* Effect.sleep("1 second");
        if (after === undefined) {
          after = lastRouteId(file);
          continue;
        }
        const rows = readRoutes(file, threadId, after);
        if (rows === undefined) continue;
        after = rows.last;
        if (rows.routes.length > 0) turn.heard = Date.now();
        for (const row of rows.routes) {
          if (shown.get(sessionId) === row.model) continue;
          shown.set(sessionId, row.model);
          const event = { at: new Date().toISOString(), ...(turn.turnId ? { turn_id: turn.turnId } : {}), type: "model.routed", payload: { model: row.model } } as DraftEvent;
          yield* store.append(sessionId, () => Effect.succeed({ events: [event], value: undefined }));
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("route lines stopped for a session", { sessionId, cause })),
      Effect.ensuring(Effect.sync(() => watching.delete(sessionId))),
    );

  const events = yield* PubSub.subscribe(store.events);
  return yield* Effect.forever(
    PubSub.take(events).pipe(
      Effect.flatMap((event) =>
        Effect.gen(function* () {
          const turn = watching.get(event.session_id);
          if (event.type === "turn.done") {
            if (turn && turn.turnId === event.turn_id) turn.polls = POLLS_AFTER_TURN;
            return;
          }
          if (event.type !== "turn.started" || !isRouterModel(event.payload.model)) return;
          if (turn) {
            turn.turnId = event.turn_id;
            turn.polls = undefined;
            turn.heard = Date.now();
            return;
          }
          const record = yield* store.getBySession(event.session_id);
          if (record === undefined) return;
          const next: Watch = { turnId: event.turn_id, polls: undefined, heard: Date.now() };
          watching.set(event.session_id, next);
          yield* Effect.forkIn(watch(event.session_id, record.internal.threadId, next), scope);
        }).pipe(
          // One bad event (a failed lookup) is skipped; the subscription keeps being read.
          Effect.catchCause((cause) => Effect.logWarning("route lines skipped a session event", { type: event.type, cause })),
        ),
      ),
    ),
  );
});
