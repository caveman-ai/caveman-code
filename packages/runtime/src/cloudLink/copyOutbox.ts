// The Cloud copy's outbox (Caveman Cloud the spec, CONTRACT §2 copy policy). A synced chat owes Cloud a copy once its
// journal grows: at once at a turn boundary, at most 15 s behind while a turn runs (2 s once a tool of it changed
// files, decision 25, and no closer than 5 s to its last copy), at once on suspend, SIGTERM and a
// move (flush). What is owed is a row in caveman_sp_copy_outbox, written when the chat first owes something, so a
// copy owed when the runtime stopped is made after it starts (and the start-up sweep adds every chat whose copy is
// behind its journal, whatever the outbox held). A failed copy stays owed and is tried again after 1 s, doubling to
// 60 s; nothing is dropped. One copy of a chat runs at a time, and a copy carries everything owed through the head.
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

/** Longest a running turn's events wait before they copy. */
export const COPY_LAG_MS = 15_000;
/** How soon a running turn's file change copies (decision 25): what the lid has left to carry is then small. */
export const COPY_SOON_MS = 2_000;
/**
 * A chat's file changes copy no closer together than this (decision 25): a turn that edits all the time copies every
 * few seconds, not every 2, within Cloud's segments a runtime may write a minute and its readers' time.
 */
export const COPY_SOON_EVERY_MS = 5_000;
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 60_000;
/** Chats copied at once. */
const CONCURRENCY = 4;

/** What a copy did: skipped (the chat does not sync here, or moved away) owes nothing more. */
export type CopyResult = "copied" | "unchanged" | "skipped" | "moved_away";

export interface OutboxRow {
  readonly session_id: string;
  readonly due_at: number;
  readonly attempts: number;
  readonly last_error: string | null;
}

export const retryDelay = (attempts: number) => Math.min(RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

/** A defect's message and its causes': an SqlError says only which call failed, its cause what went wrong. */
const defectMessage = (defect: unknown) => {
  const said: Array<string> = [];
  for (let at: unknown = defect; at instanceof Error && said.length < 5; at = at.cause) if (!said.includes(at.message)) said.push(at.message);
  return said.length > 0 ? said.join(": ") : String(defect);
};

/**
 * When a mark asks for the chat's copy: within COPY_LAG_MS (`false`), within COPY_SOON_MS (`"soon"`), as soon as it can
 * be (`true`), or in this many ms (a boundary whose snapshot failed, looked at again as a failed copy is: decision 25).
 */
export type CopyDue = boolean | "soon" | number;

export interface CopyOutbox {
  /**
   * The chat's journal grew: copied within COPY_LAG_MS, within COPY_SOON_MS (`"soon"`, a running turn changed files),
   * or as soon as it can be (`true`, a turn boundary); or a copy is owed again in `n` ms. A mark never makes a copy owed
   * later than it was.
   */
  readonly mark: (sessionId: string, now?: CopyDue) => Effect.Effect<void>;
  /** Chats whose copy is behind (the start-up sweep): owed now. */
  readonly sweep: (sessionIds: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Copies what is owed now and waits for it, at most `timeoutMs` (suspend, SIGTERM, a move's last copy): `sessionIds`,
   * or every chat that owes one. Answers the chats still owed after it.
   */
  readonly flush: (timeoutMs: number, sessionIds?: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
  /** The loop: copies each owed chat once it is due. Runs for the runtime's life. */
  readonly run: Effect.Effect<never>;
  readonly rows: () => Effect.Effect<ReadonlyArray<OutboxRow>>;
}

export const makeCopyOutbox = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly copy: (sessionId: string) => Effect.Effect<CopyResult, { readonly message: string }>;
  readonly now?: () => number;
  readonly lagMs?: number;
  readonly log?: (message: string) => Effect.Effect<void>;
}): Effect.Effect<CopyOutbox> =>
  Effect.gen(function* () {
    const { sql } = input;
    const now = input.now ?? Date.now;
    const lag = input.lagMs ?? COPY_LAG_MS;
    const log = input.log ?? ((message: string) => Effect.logWarning(message));
    // The table as this process last wrote it, or meant to when the table failed: a mark that changes nothing writes
    // nothing (a turn journals many events).
    const owed = new Map((yield* sql<OutboxRow>`SELECT session_id, due_at, attempts, last_error FROM caveman_sp_copy_outbox`.pipe(Effect.orDie)).map((r) => [r.session_id, r] as const));
    // Marks since a copy began: a copy that saw none owes nothing more once it succeeds.
    const marks = new Map<string, number>();
    // The most urgent of the marks since a copy began: when the chat is owed again once that copy ends, as they asked.
    const asked = new Map<string, CopyDue>();
    // When each chat's last copy ended: soon marks come no closer to it than COPY_SOON_EVERY_MS.
    const copiedAt = new Map<string, number>();
    const dueFor = (sessionId: string, at: CopyDue) =>
      typeof at === "number"
        ? now() + at
        : at === true
          ? now()
          : at === "soon"
            ? Math.min(now() + lag, Math.max(now() + Math.min(COPY_SOON_MS, lag), (copiedAt.get(sessionId) ?? -Infinity) + COPY_SOON_EVERY_MS))
            : now() + lag;
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (id: string) => {
      let lock = locks.get(id);
      if (lock === undefined) locks.set(id, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };
    // Chats the loop is copying: each holds one of CONCURRENCY slots until its copy ends.
    const copying = new Set<string>();
    // A poke since the loop last looked: it looks again before it sleeps.
    let poked = false;
    let wake: (() => void) | undefined;
    const poke = () => {
      poked = true;
      wake?.();
    };

    const put = (row: OutboxRow) =>
      sql`INSERT INTO caveman_sp_copy_outbox (session_id, due_at, attempts, last_error) VALUES (${row.session_id}, ${row.due_at}, ${row.attempts}, ${row.last_error})
          ON CONFLICT (session_id) DO UPDATE SET due_at = excluded.due_at, attempts = excluded.attempts, last_error = excluded.last_error`.pipe(
        Effect.tap(() => Effect.sync(() => owed.set(row.session_id, row))),
        Effect.orDie,
      );

    const mark = (sessionId: string, at: CopyDue = false) =>
      Effect.suspend(() => {
        marks.set(sessionId, (marks.get(sessionId) ?? 0) + 1);
        const due = dueFor(sessionId, at);
        const was = asked.get(sessionId);
        if (was === undefined || due < dueFor(sessionId, was)) asked.set(sessionId, at);
        const row = owed.get(sessionId);
        // Already owed by then, or waiting out a failure (Cloud is down: a boundary does not hurry it).
        if (row !== undefined && (row.due_at <= due || row.attempts > 0)) return Effect.void;
        return put({ session_id: sessionId, due_at: due, attempts: row?.attempts ?? 0, last_error: row?.last_error ?? null }).pipe(Effect.tap(() => Effect.sync(poke)));
      });

    /** One copy of a chat that owes one, holding its lock: the row goes once a copy that saw every mark succeeded. */
    const copyOne = (sessionId: string) =>
      lockOf(sessionId).withPermits(1)(
        Effect.gen(function* () {
          const row = owed.get(sessionId);
          if (row === undefined) return;
          const seen = marks.get(sessionId) ?? 0;
          asked.delete(sessionId);
          const result = yield* input.copy(sessionId).pipe(
            // A copy that dies failed like any other: counted and backed off, never tried again at once ahead of every chat.
            Effect.catchDefect((defect) => Effect.fail({ message: defectMessage(defect) })),
            Effect.result,
          );
          copiedAt.set(sessionId, now());
          if (result._tag === "Failure") {
            const attempts = row.attempts + 1;
            const delay = retryDelay(attempts);
            yield* log(`copy: ${sessionId} did not copy to Caveman Cloud (attempt ${attempts}, again in ${Math.round(delay / 1000)} s): ${result.failure.message}`);
            return yield* put({ session_id: sessionId, due_at: now() + delay, attempts, last_error: result.failure.message.slice(0, 500) });
          }
          // It grew while it copied: owed again as the marks since it began asked, counted from now (never at the row's
          // old due time, long past: the copies of a running turn would then go back to back).
          const again = () => put({ session_id: sessionId, due_at: dueFor(sessionId, asked.get(sessionId) ?? false), attempts: 0, last_error: null });
          if ((marks.get(sessionId) ?? 0) !== seen && result.success !== "skipped" && result.success !== "moved_away") return yield* again();
          yield* sql`DELETE FROM caveman_sp_copy_outbox WHERE session_id = ${sessionId}`.pipe(Effect.orDie);
          owed.delete(sessionId);
          // A mark that came in while the row went: owed again.
          if ((marks.get(sessionId) ?? 0) !== seen && result.success !== "skipped" && result.success !== "moved_away") yield* again();
          else marks.delete(sessionId);
        }),
      );

    const waiting = () => [...owed.values()].filter((r) => !copying.has(r.session_id));

    /**
     * One copy of a chat whose outbox table may fail: the chat is then owed again with backoff, held here since the table
     * took no write, and the others' copies go on.
     */
    const copyHeld = (sessionId: string) =>
      copyOne(sessionId).pipe(
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            const attempts = (owed.get(sessionId)?.attempts ?? 0) + 1;
            const delay = retryDelay(attempts);
            const message = defectMessage(defect);
            yield* log(`copy: the outbox failed copying ${sessionId} (attempt ${attempts}, again in ${Math.round(delay / 1000)} s): ${message}`);
            owed.set(sessionId, { session_id: sessionId, due_at: now() + delay, attempts, last_error: message.slice(0, 500) });
          }),
        ),
      );

    /** A chat's copy in the loop: its slot is free again, and the loop looks again, once it ends. */
    const copyIn = (sessionId: string) =>
      copyHeld(sessionId).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            copying.delete(sessionId);
            poke();
          }),
        ),
      );

    const run = Effect.gen(function* () {
      while (true) {
        poked = false;
        for (const row of waiting().filter((r) => r.due_at <= now()).sort((a, b) => a.due_at - b.due_at)) {
          if (copying.size >= CONCURRENCY) break;
          copying.add(row.session_id);
          yield* Effect.forkChild(copyIn(row.session_id));
        }
        // Every slot taken: the next to start waits for one to free.
        const next = copying.size >= CONCURRENCY ? Infinity : Math.min(...waiting().map((r) => r.due_at));
        const wait = Number.isFinite(next) ? Math.max(0, next - now()) : 60_000;
        yield* Effect.callback<void>((resume) => {
          if (poked) return resume(Effect.void);
          const timer = setTimeout(() => resume(Effect.void), Math.min(wait, 60_000));
          wake = () => resume(Effect.void);
          return Effect.sync(() => {
            clearTimeout(timer);
            wake = undefined;
          });
        });
        wake = undefined;
      }
    }).pipe(Effect.catchCause((cause) => log(`copy: the outbox loop failed: ${String(cause)}`).pipe(Effect.andThen(Effect.sleep("1 second")))), Effect.forever) as Effect.Effect<never>;

    const flush = (timeoutMs: number, sessionIds?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const ids = sessionIds ?? [...owed.keys()];
        // Owed now, whatever backoff said: this is the last chance before the computer sleeps or stops. A table that takes
        // no write (a full disk) still has the chat owed here, and its copy still goes.
        for (const id of ids) {
          const was = owed.get(id);
          const row = { session_id: id, due_at: now(), attempts: was?.attempts ?? 0, last_error: was?.last_error ?? null };
          yield* put(row).pipe(
            Effect.catchDefect((defect) =>
              log(`copy: the outbox could not record ${id} as owed: ${defectMessage(defect)}`).pipe(Effect.andThen(Effect.sync(() => void owed.set(id, row)))),
            ),
          );
          marks.set(id, (marks.get(id) ?? 0) + 1);
          asked.set(id, true);
        }
        yield* Effect.forEach(ids, copyHeld, { concurrency: CONCURRENCY, discard: true }).pipe(Effect.timeout(timeoutMs), Effect.ignore);
        return ids.filter((id) => owed.has(id));
      });

    return {
      mark,
      sweep: (sessionIds) => Effect.forEach(sessionIds, (id) => mark(id, true), { discard: true }),
      flush,
      run,
      rows: () => Effect.sync(() => [...owed.values()]),
    } satisfies CopyOutbox;
  });
