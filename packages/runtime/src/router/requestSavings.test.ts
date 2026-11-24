import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, test } from "vitest";

import { makeRequestSavingsReader } from "./requestSavings.ts";

let dir: string;
let file: string;
let readRequestSavings: ReturnType<typeof makeRequestSavingsReader>;
beforeEach(() => {
  readRequestSavings = makeRequestSavingsReader();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-savings-"));
  file = path.join(dir, "caveman.db");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("missing database or old schema contributes no evidence and creates nothing", () => {
  expect(readRequestSavings(file)).toEqual([]);
  expect(fs.existsSync(file)).toBe(false);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE requests (id INTEGER PRIMARY KEY, session_id TEXT)");
  db.close();
  expect(readRequestSavings(file)).toEqual([]);
  fs.unlinkSync(file); // The reader closed its handle.
});

test("measured deltas use proxy pricing first, then observed cache blend; correlated side requests count", () => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, provider TEXT, ts TEXT, label TEXT,
    input_tokens INTEGER, cached_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    cache_creation_1h_tokens INTEGER, request_tokens_before INTEGER, request_tokens_after INTEGER,
    request_estimated_input_delta_usd REAL, request_measurement_status TEXT)`);
  const add = (session: string | null, model: string, day: string, delta: number, usd: number | null, status = "measured", label = "chat") =>
    db.prepare("INSERT INTO requests VALUES (NULL, ?, ?, ?, ?, ?, 1000, 500, 300, 100, 1000, ?, ?, ?)")
      .run(session, model, model.startsWith("claude-") ? "anthropic" : "openai", `${day} 12:00:00.000`, label, 1000 - delta, usd, status);
  add("caveman:t1", "claude-opus-5-5", "2026-10-17", 100, null);
  add("caveman:t1", "claude-opus-5-5", "2026-10-17", 100, 0.25, "measured", "subagent_explore");
  add("caveman:t1", "claude-opus-5-5", "2026-10-17", 100, null, "estimated");
  add(null, "claude-opus-5-5", "2026-10-17", 900, 1, "measured", "auxiliary");
  add("caveman:t2", "gpt-6.1-sol", "2026-10-18", 100, null);
  add("caveman:t1", "unknown", "2026-10-17", 100, null);
  add("caveman:t1", "claude-opus-5-5", "2026-10-16", 0, null);
  add("caveman:t1", "unknown", "2026-10-18", -10, -0.1);
  db.close();
  const rows = readRequestSavings(file, "2026-10-17T00:00:00.000Z", "2026-10-18T23:59:59.999Z");
  const opus = rows.find((r) => r.model === "claude-opus-5-5")!;
  expect(opus).toMatchObject({ session: "caveman:t1", day: "2026-10-17", saved_tokens: 200, basis: "inferred" });
  // Opus: 200 fresh × $4 + 500 read × $0.2 + 200 write × $5 + 100 one-hour write × $8.
  expect(opus.saved_usd).toBeCloseTo(0.25 + 0.00027);
  expect(rows.find((r) => r.session === "caveman:t2")!.saved_usd).toBeGreaterThan(0);
  expect(rows.find((r) => r.model === "unknown" && r.day === "2026-10-17")).toMatchObject({ saved_tokens: 100, saved_usd: null });
  expect(rows.find((r) => r.day === "2026-10-18" && r.model === "unknown")).toMatchObject({ saved_tokens: -10, saved_usd: -0.1 });
  expect(rows).toHaveLength(4);
  expect(readRequestSavings(file, "2027-01-01T00:00:00.000Z")).toEqual([]);
  expect(readRequestSavings(file, "2026-10-17T12:00:00.001Z", "2026-10-17T23:59:59.999Z")).toEqual([]);
});

test("bounded incremental reads count each row once, track partial prices, and reset after replacement", () => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, provider TEXT, ts TEXT,
    input_tokens INTEGER, cached_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    cache_creation_1h_tokens INTEGER, request_tokens_before INTEGER, request_tokens_after INTEGER,
    request_estimated_input_delta_usd REAL, request_measurement_status TEXT)`);
  const insert = db.prepare("INSERT INTO requests VALUES (NULL, ?, 'unknown', 'custom', '2026-10-18 12:00:00', 1000, 0, 0, 0, 1000, 900, ?, 'measured')");
  db.exec("BEGIN");
  for (let i = 0; i < 5001; i++) insert.run("session", 0.01);
  db.exec("COMMIT");
  expect(readRequestSavings(file)[0]).toMatchObject({ saved_tokens: 500_000, saved_usd_partial: false });
  db.exec("UPDATE requests SET request_tokens_after = 0 WHERE id = 1");
  expect(readRequestSavings(file)[0]!.saved_tokens).toBe(500_100);
  expect(readRequestSavings(file)[0]!.saved_tokens).toBe(500_100);
  insert.run("session", null);
  const partial = readRequestSavings(file)[0]!;
  expect(partial).toMatchObject({ saved_tokens: 500_200, saved_usd_partial: true });
  expect(partial.saved_usd).toBeCloseTo(50.01);
  // Uncorrelated rows still advance the bounded cursor.
  db.exec("BEGIN");
  for (let i = 0; i < 5000; i++) insert.run(null, 1);
  insert.run("session", 1);
  db.exec("COMMIT");
  expect(readRequestSavings(file)[0]!.saved_tokens).toBe(500_200);
  expect(readRequestSavings(file)[0]!.saved_tokens).toBe(500_300);
  db.exec("DELETE FROM requests");
  insert.run("replacement", 1);
  expect(readRequestSavings(file)).toMatchObject([{ session: "replacement", saved_tokens: 100, saved_usd: 1 }]);
  db.close();
});

test("request input selects the catalog's long-context rate", () => {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE requests (
    id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, provider TEXT, ts TEXT,
    input_tokens INTEGER, cached_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    cache_creation_1h_tokens INTEGER, request_tokens_before INTEGER, request_tokens_after INTEGER,
    request_estimated_input_delta_usd REAL, request_measurement_status TEXT);
    INSERT INTO requests VALUES (1, 's', 'claude-haiku-5-5', 'anthropic', '2026-10-18 12:00:00',
      100001, 0, 0, 0, 1000, 900, NULL, 'measured')`);
  db.close();
  expect(readRequestSavings(file)[0]!.saved_usd).toBeCloseTo(100 * 2.5 / 1e6);
});
