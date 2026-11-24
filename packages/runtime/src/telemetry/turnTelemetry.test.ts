// telemetry.turns on a real runtime (docs/ "The data path"): real turns,
// journaled by the real projector, come out as facts once settled; they stay until acknowledged, and a new
// disclosure moment starts over.
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";

const root = tempRoot("turn-telemetry-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let dbPath: string;

beforeAll(async () => {
  const config = await makeConfig();
  dbPath = config.dbPath;
  runtime = await startRuntime(config, "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a real turn is one fact once the next turn starts, waits until acknowledged, and a new since starts over", async () => {
  const since = new Date(Date.now() - 1_000).toISOString();
  // Nothing has run: nothing to say, and asking twice is harmless.
  expect((await client.call("telemetry.turns", { since })).facts).toEqual([]);

  const repo = makeRepo(root, { "README.md": "telemetry\n" });
  const w = await createReady(client, { request_id: "tt-w", repo: { path: repo }, title: "Telemetry", engine: "claude-agent", task: { text: "say hi" }, options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const done = () => events.filter((e) => e.type === "turn.done").length;
  await until(() => done() === 1, 30_000);
  // Finished, but held: what the person does next is not known yet.
  expect((await client.call("telemetry.turns", { since })).facts).toEqual([]);

  await client.call("turn.submit", { request_id: "tt-2", session_id: w.session_id, kind: "followup", input: { text: "say hi" } });
  await until(() => done() === 2, 30_000);
  const { facts } = await client.call("telemetry.turns", { since });
  expect(facts).toHaveLength(1);
  const fact = facts[0]!;
  expect(fact).toMatchObject({
    seq: 1,
    index: 1,
    engine: "claude-agent",
    model: MODEL,
    origin: "person",
    status: "completed",
    prompt_chars: 4,
    next: "followup",
    next_same_prompt: true,
  });
  expect(fact.id).toMatch(/^[0-9a-f]{32}$/);
  expect(fact.duration_ms).toBeGreaterThan(0);
  expect(JSON.stringify(fact)).not.toContain(w.session_id);

  // Unacknowledged, it comes again; acknowledged, it is gone, and the same ack again changes nothing.
  expect((await client.call("telemetry.turns", { since })).facts.map((f) => f.seq)).toEqual([1]);
  expect((await client.call("telemetry.turns", { since, ack: 1 })).facts).toEqual([]);
  expect((await client.call("telemetry.turns", { since, ack: 1 })).facts).toEqual([]);

  // Telemetry went off and on again: a new since. The second turn, held from before it, is never counted.
  const again = new Date().toISOString();
  await client.call("turn.submit", { request_id: "tt-3", session_id: w.session_id, kind: "followup", input: { text: "and again" } });
  await until(() => done() === 3, 30_000);
  expect((await client.call("telemetry.turns", { since: again })).facts).toEqual([]);
  await client.call("turn.submit", { request_id: "tt-4", session_id: w.session_id, kind: "followup", input: { text: "once more" } });
  await until(() => done() === 4, 30_000);
  const after = (await client.call("telemetry.turns", { since: again })).facts;
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ seq: 2, index: 3, next: "followup", next_same_prompt: false });

  // The outbox holds the facts alone: no prompt, no real id.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stored = db.prepare("SELECT fact FROM caveman_sp_turn_facts").all() as Array<{ fact: string }>;
    for (const row of stored) for (const secret of [w.session_id, "and again", "once more", repo]) expect(row.fact).not.toContain(secret);
  } finally {
    db.close();
  }
}, 120_000);

test("asked only after a new chat's turns ran, its first turn still has its prompt (journaled before the turn)", async () => {
  const since = new Date().toISOString();
  const repo = makeRepo(root, { "README.md": "late ask\n" });
  const w = await createReady(client, { request_id: "tt-late-w", repo: { path: repo }, title: "Late", engine: "claude-agent", task: { text: "same words" }, options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const done = () => events.filter((e) => e.type === "turn.done").length;
  await until(() => done() === 1, 30_000);
  await client.call("turn.submit", { request_id: "tt-late-2", session_id: w.session_id, kind: "followup", input: { text: "same words" } });
  await until(() => done() === 2, 30_000);
  const facts = (await client.call("telemetry.turns", { since })).facts.filter((f) => f.index === 1);
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ prompt_chars: 8, next: "followup", next_same_prompt: true });
}, 120_000);
