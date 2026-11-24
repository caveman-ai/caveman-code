import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { DraftEvent } from "../session-protocol/projector.ts";
import { SessionStore, type WorkspaceRecord } from "../session-protocol/store.ts";
import { setAppProxyHome } from "./proxyLauncher.ts";
import { lastRouteId, readRoutes, runRouteLines } from "./routeLines.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-routes-"));
  // The app proxies' own database, in their home.
  file = path.join(dir, "caveman.db");
  setAppProxyHome(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** caveman-proxy's requests table, the columns the reader touches plus its required ones. */
const makeLog = () => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT,
    model TEXT, route_from TEXT, route_to TEXT, route_reason TEXT, basis TEXT NOT NULL)`);
  const insert = db.prepare(
    "INSERT INTO requests (ts, request_id, session_id, model, route_from, route_to, route_reason, basis) VALUES (?, ?, ?, ?, ?, ?, ?, 'inferred')",
  );
  return {
    add: (session: string | null, routeFrom: string | null, routeTo: string | null, reason: string | null) =>
      insert.run("2026-10-15 12:00:00.000", `req-${Math.random()}`, session, routeTo, routeFrom, routeTo, reason),
    close: () => db.close(),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** runRouteLines on a store holding session s1 (thread caveman:t1); a lookup of `bad` dies like a SQL defect. */
const startLines = (idleMs?: number) => {
  const events = Effect.runSync(PubSub.unbounded<SessionEvent>());
  const appended: Array<{ readonly session: string; readonly event: DraftEvent }> = [];
  const record = { internal: { threadId: "caveman:t1" } } as WorkspaceRecord;
  const store = {
    events,
    getBySession: (id: string) => (id === "bad" ? Effect.die(new Error("SQLITE_CORRUPT")) : Effect.succeed(id === "s1" ? record : undefined)),
    append: (session: string, build: (record: WorkspaceRecord) => Effect.Effect<{ readonly events: ReadonlyArray<DraftEvent>; readonly value: unknown }>) =>
      build(record).pipe(
        Effect.map((built) => {
          for (const event of built.events) appended.push({ session, event });
          return { events: [], value: built.value };
        }),
      ),
  } as unknown as SessionStore["Service"];
  const fiber = Effect.runFork(runRouteLines(idleMs).pipe(Effect.provideService(SessionStore, store), Effect.scoped));
  const publish = (session: string, type: "turn.started" | "turn.done", turn: string, model = "caveman-auto") =>
    Effect.runSync(
      PubSub.publish(events, {
        session_id: session,
        cursor: 1,
        at: "",
        type,
        turn_id: turn,
        payload: type === "turn.started" ? { engine: "claude-agent", model } : { status: "completed" },
      } as SessionEvent),
    );
  return {
    publish,
    lines: () => appended.map(({ session, event }) => [session, event.type, event.turn_id, event.payload]),
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

test("the reader keeps the chat's own Auto calls and tolerates a missing database, table or column", () => {
  expect(readRoutes(file, "caveman:t1", 0)).toBeUndefined();
  expect(lastRouteId(file)).toBeUndefined();
  expect(fs.existsSync(file)).toBe(false);

  new DatabaseSync(file).close();
  expect(readRoutes(file, "caveman:t1", 0)).toBeUndefined();
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE requests (id INTEGER PRIMARY KEY, session_id TEXT, route_from TEXT, route_to TEXT)");
  old.exec("INSERT INTO requests (session_id, route_from, route_to) VALUES ('caveman:t1', 'caveman-auto', 'claude-opus-5-5')");
  old.close();
  expect(readRoutes(file, "caveman:t1", 0)).toBeUndefined();
  fs.rmSync(file);

  const log = makeLog();
  expect(lastRouteId(file)).toBe(0);
  log.add("caveman:t1", "caveman-auto", "claude-sonnet-5-5", "ask_xlow");
  log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "subagent_explore");
  log.add("caveman:t2", "caveman-auto", "claude-opus-5-5", "ask_high");
  log.add("caveman:t1", "caveman-auto", "claude-haiku-4-5", "auxiliary_cheapest");
  log.add("caveman:t1", "caveman-auto", "claude-sonnet-5-5", "compaction_current");
  log.add("caveman:t1", null, "claude-opus-5-5", null);
  log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", null);
  log.add("caveman:t1", "caveman-auto", "claude-sonnet-5-5", "timeout");
  log.add("caveman:t1", "caveman-auto", "", "ask_low");
  log.add(null, "caveman-auto", "gpt-6", "ask_low"); // a ChatGPT-route row carries no session: never matched
  log.close();
  expect(readRoutes(file, "caveman:t1", 0)).toEqual({
    last: 10,
    routes: [
      { id: 1, model: "claude-sonnet-5-5" },
      { id: 7, model: "claude-opus-5-5" },
      { id: 8, model: "claude-sonnet-5-5" },
    ],
  });
  // Each row is read once: the next read starts after the last row, the chat's or not.
  expect(readRoutes(file, "caveman:t1", 8)).toEqual({ last: 10, routes: [] });
  expect(readRoutes(file, "caveman:t1", 10)).toEqual({ last: 10, routes: [] });
  expect(lastRouteId(file)).toBe(10);
});

test("an Auto turn gets a line each time its model changes, including calls that land just after it ends", async () => {
  const log = makeLog();
  log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "ask_high"); // before the turn: not shown
  const lines = startLines();
  try {
    lines.publish("s2", "turn.started", "x", "claude-opus-5-5");
    lines.publish("s1", "turn.started", "r1");
    await sleep(200);
    log.add("caveman:t1", "caveman-auto", "claude-sonnet-5-5", "ask_xlow");
    log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "subagent_review");
    log.add("caveman:t1", "caveman-auto", "claude-sonnet-5-5", "ask_low");
    await sleep(1300);
    expect(lines.lines()).toEqual([["s1", "model.routed", "r1", { model: "claude-sonnet-5-5" }]]);

    lines.publish("s1", "turn.done", "r1");
    log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "ask_high");
    await sleep(1300);
    expect(lines.lines()).toEqual([
      ["s1", "model.routed", "r1", { model: "claude-sonnet-5-5" }],
      ["s1", "model.routed", "r1", { model: "claude-opus-5-5" }],
    ]);
  } finally {
    log.close();
    await lines.stop();
  }
});

test("a failed lookup skips its event, a log that appears late starts at its end, a quiet watch stops", async () => {
  const lines = startLines(2500);
  try {
    lines.publish("bad", "turn.started", "b1");
    lines.publish("s1", "turn.started", "r1");
    await sleep(1200);
    // No database when the turn started: what it holds once it appears is history, not this turn.
    const log = makeLog();
    log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "ask_high");
    await sleep(1200);
    log.add("caveman:t1", "caveman-auto", "claude-sonnet-5-5", "ask_xlow");
    await sleep(1200);
    expect(lines.lines()).toEqual([["s1", "model.routed", "r1", { model: "claude-sonnet-5-5" }]]);

    // 2.5 s without a call of its own: the watch is gone, though the turn never ended.
    await sleep(3200);
    log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "ask_high");
    await sleep(1200);
    expect(lines.lines()).toHaveLength(1);
    // The next Auto turn watches again, from the log's end.
    lines.publish("s1", "turn.started", "r2");
    await sleep(200);
    log.add("caveman:t1", "caveman-auto", "claude-opus-5-5", "ask_high");
    await sleep(1300);
    expect(lines.lines()).toEqual([
      ["s1", "model.routed", "r1", { model: "claude-sonnet-5-5" }],
      ["s1", "model.routed", "r2", { model: "claude-opus-5-5" }],
    ]);
    log.close();
  } finally {
    await lines.stop();
  }
});
