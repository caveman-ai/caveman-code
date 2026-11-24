// What the projector journals is scrubbed of every repository's secret values, also a text the runtime cut to a bound
// before the scrub saw it (WireProjection's detail read of a Chief tool's answer, a tool input's one-line summary): a
// cut inside a value leaves its start, which a whole-value scrub cannot recognise, so the journal masks it as /ws does
// (16-SECRETS).
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { EventId, ThreadId, TurnItemId } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { TRUNCATED_FOR_TRANSPORT } from "../orchestration-v2/WireProjection.ts";
import {
  makeConfig,
  makeRepo,
  orchestratorOf,
  startRuntime,
  tempRoot,
  until,
} from "./testHarness.ts";

const root = tempRoot("sp-cut-secrets-");
const CANARY = "cv-deploy-Q7xZ9wPk3mL8vN2rT5yB";
/** What a detail read keeps of a longer text: its bound (WireProjection MAX_ON_DEMAND_BYTES) less the marker it ends with, which counts toward it. */
const DETAIL_BYTES = 256 * 1024 - Buffer.byteLength(TRUNCATED_FOR_TRANSPORT, "utf8");
/** What a tool input's one-line summary keeps before its "…" (WireProjection summarizeDynamicValue). */
const SUMMARY_CHARS = 159;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude");
  client = connect(runtime.url, runtime.token);
  // A project, so it has a Chief.
  await client.call("project.create", {
    request_id: "chief-project",
    path: makeRepo(root, { "README.md": "chief\n" }),
    name: "chief-project",
  });
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A finished Chief tool's item, written to upstream event log as its engine writes one. */
async function writeToolItem(
  threadId: ThreadId,
  providerInstanceId: unknown,
  itemId: string,
  tool: { readonly toolName: string; readonly input: unknown; readonly output: unknown },
) {
  const now = await Effect.runPromise(DateTime.now);
  const eventSink = Context.get(
    runtime.context as unknown as Context.Context<EventSink.EventSinkV2>,
    EventSink.EventSinkV2,
  );
  await Effect.runPromise(
    eventSink.write({
      events: [
        {
          id: EventId.make(`event:${itemId}`),
          type: "turn-item.updated",
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(itemId),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "dynamic_tool",
            ...tool,
          },
        },
      ] as never,
    }),
  );
}

/** The Chief's journal rows on disk, which Cloud's copy and every device read. */
function journaled(sessionId: string) {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT event FROM caveman_sp_events WHERE session_id = ?")
        .all(sessionId) as Array<{ event: string }>
    ).map((row) => row.event);
  } finally {
    db.close();
  }
}

test("a Chief tool's answer cut inside a secret value journals the value masked, never its start", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  await client.call("secret.set", {
    request_id: "set",
    repo: { path: repo },
    secrets: [{ name: "DEPLOY_TOKEN", value: CANARY }],
  });
  const chief = (await client.call("chief.get", {})).workspace;
  const threadId = ThreadId.make(`caveman:${chief.id}`);
  const { thread } = await Effect.runPromise(orchestratorOf(runtime).getThreadProjection(threadId));
  const events: Array<SessionEvent> = [];
  await client.attach(chief.session_id, 0, (event) => events.push(event));

  // A Chief tool answers with more than a detail read sends: the cut falls 12 characters into the token.
  const kept = 12;
  const answer = `${"x".repeat(DETAIL_BYTES - kept)}${CANARY} and what came after it`;
  await writeToolItem(threadId, thread.providerInstanceId, "item:chief-tool-answer", {
    toolName: "memory_sql",
    input: { sql: "SELECT text FROM notes" },
    output: answer,
  });

  await until(
    () => events.some((e) => e.type === "tool.done" && e.item_id === "item:chief-tool-answer"),
    30_000,
  );
  const done = events.find(
    (e) => e.type === "tool.done" && e.item_id === "item:chief-tool-answer",
  )!;
  const result = (done.payload as { result?: unknown }).result;
  // The card still reads the answer, as far as the bound, with the token's start masked where the cut fell.
  expect(typeof result === "string" && result.slice(0, 16)).toBe("x".repeat(16));
  expect((result as string).slice(-TRUNCATED_FOR_TRANSPORT.length - 12)).toBe(
    `xxxx[secret]${TRUNCATED_FOR_TRANSPORT}`,
  );
  const start = CANARY.slice(0, kept);
  expect(JSON.stringify(events).includes(start)).toBe(false);
  // Nor is it in the journal on disk.
  expect(journaled(chief.session_id).filter((row) => row.includes(start))).toEqual([]);
}, 120_000);

test("a tool input's one-line summary cut inside a secret value journals the value masked, never its start", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  await client.call("secret.set", {
    request_id: "set-summary",
    repo: { path: repo },
    secrets: [{ name: "DEPLOY_TOKEN", value: CANARY }],
  });
  const chief = (await client.call("chief.get", {})).workspace;
  const threadId = ThreadId.make(`caveman:${chief.id}`);
  const { thread } = await Effect.runPromise(orchestratorOf(runtime).getThreadProjection(threadId));
  const events: Array<SessionEvent> = [];
  await client.attach(chief.session_id, 0, (event) => events.push(event));

  // A tool input too big to send goes as its first line's summary, cut at 159 characters with "…": here 12 into the
  // token.
  const kept = 12;
  const input = `${"y".repeat(SUMMARY_CHARS - kept)}${CANARY} and the rest of the line\n${"z".repeat(20_000)}`;
  await writeToolItem(threadId, thread.providerInstanceId, "item:long-input", {
    toolName: "memory_sql",
    input,
    output: "ok",
  });

  await until(
    () => events.some((e) => e.type === "tool.started" && e.item_id === "item:long-input"),
    30_000,
  );
  const started = events.find((e) => e.type === "tool.started" && e.item_id === "item:long-input")!;
  const summary = ((started.payload as { input?: { summary?: unknown } }).input?.summary ??
    "") as string;
  expect(summary.slice(0, 16)).toBe("y".repeat(16));
  expect(summary.slice(-13)).toBe("yyyy[secret]…");
  const start = CANARY.slice(0, kept);
  expect(JSON.stringify(events).includes(start)).toBe(false);
  expect(journaled(chief.session_id).filter((row) => row.includes(start))).toEqual([]);
}, 120_000);
