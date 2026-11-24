// The copy outbox and segment plan (CONTRACT §2): what a chat owes Cloud survives a restart, a failed upload is tried
// again with backoff and never dropped, a turn boundary copies at once and a running turn within the lag, and a turn
// bigger than Cloud's segment cap copies as several segments (one event too big for any is cut and marked).
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";

import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { makeCopyOutbox, retryDelay, type CopyOutbox, type CopyResult } from "./copyOutbox.ts";
import { cutEvent, decodeSegment, planSegments } from "./copySegments.ts";
import { mergeBundles } from "./moves.ts";

const TABLE = `CREATE TABLE IF NOT EXISTS caveman_sp_copy_outbox (session_id TEXT PRIMARY KEY, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`;
const dbFile = () => `${process.env.TMPDIR ?? "/tmp"}/copy-outbox-${Date.now()}-${Math.random()}.db`;
const withSql = <A>(file: string, body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(TABLE);
      return yield* body(sql);
    }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: file }))) as Effect.Effect<A>,
  );

describe("copy outbox", () => {
  it("a copy owed when the runtime stops is made after it starts; a failure is retried with backoff and never dropped", async () => {
    const file = dbFile();
    let clock = 1_000_000;
    // First life: Cloud is down; the copy fails and stays owed with its attempt counted.
    await withSql(file, (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({ sql, now: () => clock, copy: () => Effect.fail({ message: "Caveman Cloud is not reachable" }), log: () => Effect.void });
        yield* outbox.mark("s1", true);
        const left = yield* outbox.flush(5_000);
        expect(left).toEqual(["s1"]);
        expect((yield* outbox.rows())[0]).toMatchObject({ session_id: "s1", attempts: 1, due_at: clock + 1_000, last_error: "Caveman Cloud is not reachable" });
      }),
    );
    // Second life (a restart): the row is still there and the loop copies it once due.
    const copied: Array<string> = [];
    await withSql(file, (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({ sql, now: () => clock, copy: (id) => Effect.sync(() => (copied.push(id), "copied" as CopyResult)), log: () => Effect.void });
        expect((yield* outbox.rows()).map((r) => r.session_id)).toEqual(["s1"]);
        clock += 1_000;
        const loop = yield* Effect.forkChild(outbox.run);
        yield* Effect.promise(() => until(() => copied.length === 1));
        yield* Effect.promise(() => until(() => Effect.runPromise(outbox.rows()).then((r) => r.length === 0)));
        yield* Fiber.interrupt(loop);
      }),
    );
    expect(copied).toEqual(["s1"]);
    expect([1, 2, 3, 4, 7, 20].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 60_000, 60_000]);
  });

  it("copies a turn boundary at once and a running turn within the lag, and owes a chat again when it grew mid-copy", async () => {
    let clock = 0;
    const copies: Array<{ id: string; at: number }> = [];
    let grow: (() => Effect.Effect<void>) | undefined;
    await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({
          sql,
          now: () => clock,
          lagMs: 15_000,
          copy: (id) =>
            Effect.gen(function* () {
              copies.push({ id, at: clock });
              if (grow) {
                const g = grow;
                grow = undefined;
                yield* g();
              }
              return "copied" as CopyResult;
            }),
          log: () => Effect.void,
        });
        // A running turn's event: owed in 15 s, and later events do not push it back.
        yield* outbox.mark("busy");
        clock = 10_000;
        yield* outbox.mark("busy");
        expect((yield* outbox.rows())[0]!.due_at).toBe(15_000);
        // A boundary hurries it.
        yield* outbox.mark("busy", true);
        expect((yield* outbox.rows())[0]!.due_at).toBe(10_000);
        // It grows while copying: still owed after, within the lag.
        grow = () => outbox.mark("busy");
        yield* outbox.flush(1_000, ["busy"]);
        expect((yield* outbox.rows()).map((r) => r.session_id)).toEqual(["busy"]);
        yield* outbox.flush(1_000, ["busy"]);
        expect(yield* outbox.rows()).toEqual([]);
        expect(copies.map((c) => c.id)).toEqual(["busy", "busy"]);
      }),
    );
  });

  it("owes a copy again in so many ms when one asks it during a copy (a boundary whose snapshot failed), kept across a restart, and a sooner mark still pulls it earlier", async () => {
    const file = dbFile();
    let clock = 0;
    const box: { outbox?: CopyOutbox } = {};
    await withSql(file, (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({
          sql,
          now: () => clock,
          lagMs: 15_000,
          // The copy lands, and asks to be made again in 4 s (its snapshot failed).
          copy: (id) => Effect.suspend(() => box.outbox!.mark(id, 4_000)).pipe(Effect.as("copied" as CopyResult)),
          log: () => Effect.void,
        });
        box.outbox = outbox;
        yield* outbox.mark("locked", true);
        yield* outbox.flush(1_000, ["locked"]);
        expect(yield* outbox.rows()).toEqual([{ session_id: "locked", due_at: 4_000, attempts: 0, last_error: null }]);
      }),
    );
    // A restart keeps it; a plain mark (15 s) does not push it later, a boundary's pulls it earlier.
    await withSql(file, (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({ sql, now: () => clock, lagMs: 15_000, copy: () => Effect.succeed("unchanged" as CopyResult), log: () => Effect.void });
        expect((yield* outbox.rows())[0]!.due_at).toBe(4_000);
        clock = 1_000;
        yield* outbox.mark("locked");
        expect((yield* outbox.rows())[0]!.due_at).toBe(4_000);
        yield* outbox.mark("locked", true);
        expect((yield* outbox.rows())[0]!.due_at).toBe(1_000);
      }),
    );
  });

  it("copies a running turn's file change within 2 s, never later than a plain mark asked, and a plain mark still waits the lag (decision 25)", async () => {
    let clock = 0;
    await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({ sql, now: () => clock, lagMs: 15_000, copy: () => Effect.succeed("copied" as CopyResult), log: () => Effect.void });
        // A plain event of the running turn: within the lag.
        yield* outbox.mark("edits");
        expect((yield* outbox.rows())[0]!.due_at).toBe(15_000);
        // A tool that changed files finished: within 2 s.
        clock = 1_000;
        yield* outbox.mark("edits", "soon");
        expect((yield* outbox.rows())[0]!.due_at).toBe(3_000);
        // Another soon, or a plain mark, does not push it later.
        clock = 2_000;
        yield* outbox.mark("edits", "soon");
        yield* outbox.mark("edits");
        expect((yield* outbox.rows())[0]!.due_at).toBe(3_000);
        // A soon mark never comes later than a boundary's.
        yield* outbox.mark("edits", true);
        expect((yield* outbox.rows())[0]!.due_at).toBe(2_000);
        // A soon mark on a chat owing nothing.
        yield* outbox.mark("fresh", "soon");
        expect((yield* outbox.rows()).find((r) => r.session_id === "fresh")!.due_at).toBe(4_000);
      }),
    );
  });

  it("a chat marked while it copies is owed again as the marks asked, counted from the copy's end, and its file changes copy no closer than 5 s apart (decision 25)", async () => {
    let clock = 0;
    let during: (() => Effect.Effect<void>) | undefined;
    await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({
          sql,
          now: () => clock,
          lagMs: 15_000,
          copy: () =>
            Effect.gen(function* () {
              // The copy takes 4 s, and the running turn journals meanwhile.
              if (during) yield* during();
              clock += 4_000;
              return "copied" as CopyResult;
            }),
          log: () => Effect.void,
        });
        // A plain event while it copies: owed again within the lag of the copy's end, not at once.
        yield* outbox.mark("busy");
        clock = 15_000;
        during = () => outbox.mark("busy");
        yield* outbox.flush(1_000, ["busy"]);
        expect(clock).toBe(19_000);
        expect((yield* outbox.rows())[0]!.due_at).toBe(34_000);
        // A file change while it copies: 5 s after the copy's end, not at once and not back to back.
        during = () => outbox.mark("busy", "soon");
        yield* outbox.flush(1_000, ["busy"]);
        expect(clock).toBe(23_000);
        expect((yield* outbox.rows())[0]!.due_at).toBe(28_000);
        // A file change a second after a copy: still 5 s after that copy's end.
        during = undefined;
        yield* outbox.flush(1_000, ["busy"]);
        clock = 28_000;
        yield* outbox.mark("busy", "soon");
        expect((yield* outbox.rows())[0]!.due_at).toBe(32_000);
        // Past that: within 2 s as before.
        clock = 40_000;
        yield* outbox.flush(1_000, ["busy"]);
        clock = 50_000;
        yield* outbox.mark("busy", "soon");
        expect((yield* outbox.rows())[0]!.due_at).toBe(52_000);
        // A turn boundary while it copies: owed again at once.
        during = () => outbox.mark("busy", true);
        yield* outbox.flush(1_000, ["busy"]);
        expect((yield* outbox.rows())[0]!.due_at).toBe(clock);
      }),
    );
  });

  it("a chat's turn boundary copies at once while another chat's slow copy is still uploading", async () => {
    const started: Array<string> = [];
    let releaseSlow = () => {};
    const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
    const result = await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({
          sql,
          // "slow" uploads its work in progress over a slow uplink (minutes); "quick" has a few events.
          copy: (id) => Effect.sync(() => started.push(id)).pipe(Effect.andThen(id === "slow" ? Effect.promise(() => slow) : Effect.void), Effect.as("copied" as CopyResult)),
          log: () => Effect.void,
        });
        const loop = yield* Effect.forkChild(outbox.run);
        yield* outbox.mark("slow", true);
        yield* Effect.promise(() => within(() => started.includes("slow")));
        yield* outbox.mark("quick", true);
        const quickWhileSlow = yield* Effect.promise(() => within(() => started.includes("quick"), 1_000));
        const quickGone = yield* Effect.promise(() => within(() => !Effect.runSync(outbox.rows()).some((r) => r.session_id === "quick"), 1_000));
        releaseSlow();
        const allGone = yield* Effect.promise(() => within(() => Effect.runSync(outbox.rows()).length === 0));
        yield* Fiber.interrupt(loop);
        return { quickWhileSlow, quickGone, allGone, started };
      }),
    );
    expect(result).toEqual({ quickWhileSlow: true, quickGone: true, allGone: true, started: ["slow", "quick"] });
  });

  it("a copy that dies is owed again with backoff like a failed one, and the other chats' copies go on", async () => {
    let dying = 0;
    let copied = 0;
    const result = await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({
          sql,
          copy: (id) =>
            id === "dies"
              ? Effect.sync(() => void dying++).pipe(Effect.andThen(Effect.die(new Error("SQLITE_IOERR: disk I/O error"))))
              : Effect.sleep("150 millis").pipe(Effect.andThen(Effect.sync(() => void copied++)), Effect.as("copied" as CopyResult)),
          log: () => Effect.void,
        });
        yield* outbox.mark("dies", true);
        yield* outbox.mark("other", true);
        const loop = yield* Effect.forkChild(outbox.run);
        const otherCopied = yield* Effect.promise(() => within(() => copied === 1 && !Effect.runSync(outbox.rows()).some((r) => r.session_id === "other"), 2_500));
        // Its first retry is a second after it died, and is counted: the next waits two.
        const dies = () => Effect.runSync(outbox.rows()).find((r) => r.session_id === "dies");
        yield* Effect.promise(() => within(() => dies()?.attempts === 2, 2_500));
        const row = dies();
        yield* Fiber.interrupt(loop);
        return { otherCopied, dying, attempts: row?.attempts, lastError: row?.last_error, waits: row === undefined ? undefined : row.due_at - Date.now() > 1_000 };
      }),
    );
    expect(result).toEqual({ otherCopied: true, dying: 2, attempts: 2, lastError: expect.stringContaining("SQLITE_IOERR: disk I/O error"), waits: true });
  }, 10_000);

  it("a chat whose copy the outbox's own table cannot record backs off like a failed copy, never once a second for good", async () => {
    let copies = 0;
    const result = await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({ sql, copy: () => Effect.sync(() => void copies++).pipe(Effect.as("copied" as CopyResult)), log: () => Effect.void });
        yield* outbox.mark("stuck", true);
        // The copy goes up, but the table refuses to let the chat's row go.
        yield* sql.unsafe(`CREATE TRIGGER stuck BEFORE DELETE ON caveman_sp_copy_outbox WHEN OLD.session_id = 'stuck' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
        const loop = yield* Effect.forkChild(outbox.run);
        const stuck = () => Effect.runSync(outbox.rows()).find((r) => r.session_id === "stuck");
        // A second after the first, the second copy, counted: the next waits two.
        yield* Effect.promise(() => within(() => copies === 2 && stuck()?.attempts === 2, 2_500));
        const row = stuck();
        const waits = row === undefined ? undefined : row.due_at - Date.now() > 1_000;
        const copiesThen = copies;
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 1_500)));
        yield* Fiber.interrupt(loop);
        return { copiesThen, copiesSoonAfter: copies, attempts: row?.attempts, lastError: row?.last_error, waits };
      }),
    );
    expect(result).toEqual({ copiesThen: 2, copiesSoonAfter: 2, attempts: 2, lastError: expect.stringContaining("database or disk is full"), waits: true });
  }, 10_000);

  it("a flush (the lid, SIGTERM) whose outbox table is full still copies every chat and answers the ones still owed, never failing whole", async () => {
    const copied: Array<string> = [];
    const result = await withSql(dbFile(), (sql) =>
      Effect.gen(function* () {
        const outbox = yield* makeCopyOutbox({
          sql,
          copy: (id) => (id === "down" ? Effect.fail({ message: "Caveman Cloud is not reachable" }) : Effect.sync(() => (copied.push(id), "copied" as CopyResult))),
          log: () => Effect.void,
        });
        for (const id of ["full", "down", "fine"]) yield* outbox.mark(id, true);
        // The disk fills as the lid closes: the table takes no write for two of the chats.
        for (const op of ["UPDATE", "DELETE"]) {
          yield* sql.unsafe(`CREATE TRIGGER full_${op} BEFORE ${op} ON caveman_sp_copy_outbox WHEN OLD.session_id IN ('full', 'down') BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
        }
        const exit = yield* Effect.exit(outbox.flush(5_000));
        return { exit: exit._tag === "Success" ? { owed: [...exit.value].sort() } : String(exit.cause), owed: (yield* outbox.rows()).map((r) => r.session_id).sort() };
      }),
    );
    // Cloud took "full" but the table could not let it go, and "down" did not copy: both still owed, here and in the answer.
    expect({ ...result, copied: copied.sort() }).toEqual({ exit: { owed: ["down", "full"] }, owed: ["down", "full"], copied: ["fine", "full"] });
  });
});

const event = (cursor: number, text: string): SessionEvent => ({ session_id: "s1", cursor, at: "2026-10-21T10:00:00.000Z", type: "message.done", payload: { role: "assistant", text } }) as SessionEvent;
const head = { runtime_id: "r1", repo: "acme/web", record: {} as never, epoch: 3 };

describe("copy segments", () => {
  it("an 8 MiB+ turn copies as several segments in cursor order, each under the cap, the last one a boundary", () => {
    // Incompressible text, 1.5 MiB an event, 8 events: 12 MiB.
    const noise = (n: number) => randomBytes(n).toString("base64").slice(0, n);
    const events = Array.from({ length: 8 }, (_, i) => event(11 + i, noise(1_500_000)));
    const { segments, cut } = planSegments({ head, after: 10, events, display: [], boundary: { engine: null, wip: "abc", wip_bundle: "Zm9v" }, lastWip: "old", cap: 4 * 1024 * 1024, budget: 3 * 1024 * 1024 });
    expect(cut).toBe(0);
    expect(segments.length).toBeGreaterThan(2);
    let next = 11;
    for (const [i, segment] of segments.entries()) {
      expect(segment.body.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(segment.from).toBe(next);
      next = segment.through + 1;
      const body = JSON.parse(gunzipSync(segment.body).toString("utf8"));
      expect(body).toMatchObject({ v: 2, epoch: 3, from: segment.from, through: segment.through, after: segment.from - 1, boundary: i === segments.length - 1 });
      // Only the boundary carries the work in progress; the others name the last one.
      expect(body.wip).toBe(i === segments.length - 1 ? "abc" : "old");
      expect(body.wip_bundle).toBe(i === segments.length - 1 ? "Zm9v" : undefined);
      // Readers get the events back whole (decodeBundle).
      expect(decodeSegment(segment.body).events.map((e) => e.cursor)).toEqual(Array.from({ length: segment.through - segment.from + 1 }, (_, k) => segment.from + k));
    }
    expect(next).toBe(19);
  });

  it("cuts an event too big to copy whole and marks it; a boundary too big for one segment goes without its work in progress", () => {
    const huge = event(5, "x".repeat(5 * 1024 * 1024));
    const cut = cutEvent(huge, 4 * 1024 * 1024) as SessionEvent & { copy_truncated?: boolean };
    expect(cut.copy_truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect((huge as { copy_truncated?: boolean }).copy_truncated).toBeUndefined();
    // The work in progress (incompressible) alone overruns a 1 MiB cap.
    const bundle = randomBytes(2 * 1024 * 1024).toString("base64");
    const out = planSegments({ head, after: 4, events: [event(5, "small")], display: [], boundary: { engine: null, wip: "new", wip_bundle: bundle }, lastWip: "old", cap: 1024 * 1024 });
    expect(out).toMatchObject({ wipLost: true, engineLost: false });
    const last = JSON.parse(gunzipSync(out.segments.at(-1)!.body).toString("utf8"));
    // It says so: no computer continues the chat from "old" as if it were its work (F-5).
    expect(last).toMatchObject({ boundary: true, wip: "old", wip_dropped: true });
    expect(out).toMatchObject({ wipLost: true, wipBytes: 2 * 1024 * 1024 });
    expect(last.wip_bundle).toBeUndefined();
    expect(out.segments.flatMap((s) => decodeSegment(s.body).events.map((e) => e.cursor))).toEqual([5]);
    // The same work in progress put up as chunks first (AC-08): the boundary names them and carries "new".
    const ref = { sha256: "a".repeat(64), bytes: 2 * 1024 * 1024, chunks: ["a".repeat(64)] };
    const referred = planSegments({ head, after: 4, events: [event(5, "small")], display: [], boundary: { engine: null, wip: "new", wip_ref: ref }, lastWip: "old", cap: 1024 * 1024 });
    expect(referred).toMatchObject({ wipLost: false, engineLost: false });
    const named = JSON.parse(gunzipSync(referred.segments.at(-1)!.body).toString("utf8"));
    expect(named).toMatchObject({ boundary: true, wip: "new", wip_ref: ref });
    expect(named.wip_dropped).toBeUndefined();
    expect(decodeSegment(referred.segments.at(-1)!.body).wip_ref).toEqual(ref);
  });

  it("a boundary whose work in progress fits a segment only alone copies its events once, then the work in progress, never a cursor twice", () => {
    // Six events and a bundle near the cap: no event fits beside the bundle, which fits alone.
    const events = Array.from({ length: 6 }, (_, i) => event(i + 1, randomBytes(100 * 1024).toString("base64")));
    const out = planSegments({ head, after: 0, events, display: [], boundary: { engine: null, wip: "new", wip_bundle: randomBytes(1000 * 1024).toString("base64") }, lastWip: "old", cap: 1024 * 1024 });
    let next = 1;
    for (const segment of out.segments) {
      expect(segment.from).toBe(next);
      next = segment.through + 1;
    }
    expect(next).toBe(7);
    expect(out.segments.at(-1)).toMatchObject({ boundary: true, from: 7, through: 6 });
    expect(out.wipLost).toBe(false);
  });

  it("a running turn's copy carries its work in progress only inline, saying the cursor it was taken at; one too big goes without, never said dropped and never as chunks (decision 25)", () => {
    const mid = planSegments({ head, after: 4, events: [event(5, "edited"), event(6, "more")], display: [], wip: { engine: null, wip: "mid", wip_bundle: "Zm9v" }, lastWip: "old" });
    expect(mid).toMatchObject({ wipLost: false, engineLost: false, wipCarried: true });
    const body = JSON.parse(gunzipSync(mid.segments.at(-1)!.body).toString("utf8"));
    expect(body).toMatchObject({ boundary: false, engine: null, wip: "mid", wip_bundle: "Zm9v", wip_at: 6 });
    // The same files as the copy already holds: no bundle, still taken at its cursor.
    const same = JSON.parse(gunzipSync(planSegments({ head, after: 4, events: [event(5, "x")], display: [], wip: { engine: null, wip: "old" }, lastWip: "old" }).segments.at(-1)!.body).toString("utf8"));
    expect(same).toMatchObject({ boundary: false, wip: "old", wip_at: 5 });
    expect(same.wip_bundle).toBeUndefined();
    // Past what a segment holds: the events go, naming the work in progress the copy has; nothing says it was dropped.
    const big = planSegments({ head, after: 4, events: [event(5, "small")], display: [], wip: { engine: null, wip: "mid", wip_bundle: randomBytes(2 * 1024 * 1024).toString("base64") }, lastWip: "old", cap: 1024 * 1024 });
    expect(big).toMatchObject({ wipLost: false, wipCarried: false });
    expect(big.segments).toHaveLength(1);
    const plain = JSON.parse(gunzipSync(big.segments[0]!.body).toString("utf8"));
    expect(plain).toMatchObject({ boundary: false, wip: "old" });
    expect(plain.wip_bundle).toBeUndefined();
    expect(plain.wip_ref).toBeUndefined();
    expect(plain.wip_at).toBeUndefined();
    expect(plain.wip_dropped).toBeUndefined();
    // A turn copied in several segments: only its last carries it.
    const many = planSegments({ head, after: 0, events: Array.from({ length: 6 }, (_, i) => event(i + 1, "y".repeat(1024))), display: [], wip: { engine: null, wip: "mid", wip_bundle: "Zm9v" }, lastWip: "old", budget: 2048 });
    expect(many.segments.length).toBeGreaterThan(1);
    const bodies = many.segments.map((segment) => JSON.parse(gunzipSync(segment.body).toString("utf8")));
    expect(bodies.map((b) => b.wip)).toEqual([...bodies.slice(1).map(() => "old"), "mid"]);
    expect(bodies.at(-1)).toMatchObject({ wip_at: 6, wip_bundle: "Zm9v" });
  });

  it("an engine too big for a segment goes without it; the work in progress that fits stays, and is never said dropped", () => {
    const engine = { head_run_id: "run-1", journal: [randomBytes(2 * 1024 * 1024).toString("base64")], model: "{}", runtime_mode: "full-access", interaction_mode: "default" } as never;
    const out = planSegments({ head, after: 4, events: [event(5, "small")], display: [], boundary: { engine, wip: "new", wip_bundle: "Zm9v" }, lastWip: "old", cap: 1024 * 1024 });
    expect(out).toMatchObject({ wipLost: false, engineLost: true });
    const last = JSON.parse(gunzipSync(out.segments.at(-1)!.body).toString("utf8"));
    expect(last).toMatchObject({ boundary: true, engine: null, wip: "new", wip_bundle: "Zm9v" });
    expect(last.wip_dropped).toBeUndefined();
    // Both too big: neither goes, and the copy says its work in progress did not.
    const both = planSegments({ head, after: 4, events: [event(5, "small")], display: [], boundary: { engine, wip: "new", wip_bundle: randomBytes(2 * 1024 * 1024).toString("base64") }, lastWip: "old", cap: 1024 * 1024 });
    expect(both).toMatchObject({ wipLost: true, engineLost: true, wipBytes: 2 * 1024 * 1024 });
    expect(JSON.parse(gunzipSync(both.segments.at(-1)!.body).toString("utf8"))).toMatchObject({ engine: null, wip: "old", wip_dropped: true });
  });

  it("carries the mail a chat ran from another Mac, so where it lands Cloud handing it again runs nothing", () => {
    const seen = [{ signer: "A".repeat(43), message_id: "8a1f6c1e-6f0e-4b9a-9d3c-1f2e3d4c5b6a", at: 1_700_000_000_000 }];
    const out = planSegments({ head: { ...head, mac_seen: seen }, after: 0, events: [event(1, "a"), event(2, "b")], display: [], boundary: { engine: null, wip: "abc" }, lastWip: "old" });
    expect(mergeBundles(out.segments.map((s) => decodeSegment(s.body))).mac_seen).toEqual(seen);
    expect(decodeSegment(planSegments({ head, after: 4, events: [event(5, "a")], display: [], lastWip: "old" }).segments[0]!.body).mac_seen).toBeUndefined();
  });

  it("carries the asks a chat sent to another Mac and has no answer to yet, so the answer finds it where it lands", () => {
    const asks = [{ message_id: "8a1f6c1e-6f0e-4b9a-9d3c-1f2e3d4c5b6a", to_workspace_id: "ws-helper", at: 1_700_000_000_000 }];
    const out = planSegments({ head: { ...head, mac_asks: asks }, after: 0, events: [event(1, "a"), event(2, "b")], display: [], boundary: { engine: null, wip: "abc" }, lastWip: "old" });
    const merged = mergeBundles(out.segments.map((s) => decodeSegment(s.body)));
    expect(merged.mac_asks).toEqual(asks);
    // None to carry: the field is left out.
    expect(decodeSegment(planSegments({ head, after: 4, events: [event(5, "a")], display: [], lastWip: "old" }).segments[0]!.body).mac_asks).toBeUndefined();
  });
});

/** Whether `check` holds within `ms`. */
async function within(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
