import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import { createScrubber, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, test } from "vitest";

import { Session } from "../../../agent-sdk/src/session.ts";
import { tool } from "../../../agent-sdk/src/tool.ts";
import type { SessionEvent as SdkEvent, UserEvent } from "../../../agent-sdk/src/types.ts";
import CloudSessionOutbox from "../persistence/Migrations/064_CloudSessionOutbox.ts";
import { BATCH_MAX_BYTES, batchesOf, fitEvent, makeOutbox } from "./eventOutbox.ts";
import { initialMapperState, mapSessionEvent, PUBLIC_PAYLOAD_MAX_BYTES } from "./publicEvents.ts";
import type { PostedEvent } from "./sessions.ts";

const SECRET = "sk-live-0c5e9b2d7f1a4c8e4f9a2c7e1b8d3f6a";
const scrubber = createScrubber([{ name: "API_TOKEN", value: SECRET }]);
const event = (seq: number, data: Record<string, unknown>): PostedEvent => ({ seq, type: "agent.message", created_at: "2026-10-21T10:00:00.000Z", data });

/** One outbox on a database file, as a runtime has across restarts. */
const withOutbox = <A>(file: string, body: (outbox: ReturnType<typeof makeOutbox>) => Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* CloudSessionOutbox;
      return yield* body(makeOutbox(yield* SqlClient.SqlClient));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: file }))) as Effect.Effect<A>,
  );

const start = { kind: "session_start" as const, session_id: "sesn_1", agent: null };

test("events are numbered per session, kept with how far the journal was mapped, and survive a restart until Cloud has them", async () => {
  const file = `${process.env.TMPDIR ?? "/tmp"}/outbox-${Date.now()}-${Math.random()}.db`;
  await withOutbox(file, (outbox) =>
    Effect.gen(function* () {
      yield* outbox.register({ sessionId: "sesn_1", workspaceId: "ws_1", localSessionId: "local_1", origin: "api", start });
      // A second start of the same session keeps the first.
      yield* outbox.register({ sessionId: "sesn_1", workspaceId: "ws_other", localSessionId: "local_2", origin: "api", start });
      const state = { ...initialMapperState(), status: "running" as const };
      const numbered = yield* outbox.enqueue("sesn_1", [{ type: "session.status", created_at: "t", data: { status: "running" } }, { type: "agent.message", created_at: "t", data: { text: "hi" } }], {
        mappedThrough: 7,
        state,
        spans: [{ traceId: "a", spanId: "b", name: "x", kind: 1, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [], status: { code: 1 } }],
      });
      expect(numbered.map((e) => e.seq)).toEqual([1, 2]);
      yield* outbox.posted("sesn_1", 1);
    }),
  );
  // The runtime restarted: the session, its progress and what Cloud does not have yet are all still there.
  await withOutbox(file, (outbox) =>
    Effect.gen(function* () {
      const row = (yield* outbox.byCloudId("sesn_1"))!;
      expect(row).toMatchObject({ workspaceId: "ws_1", localSessionId: "local_1", nextSeq: 3, mappedThrough: 7, state: { status: "running" } });
      expect(yield* outbox.byLocal("local_1")).toMatchObject({ sessionId: "sesn_1" });
      expect((yield* outbox.pending("sesn_1")).map((e) => [e.seq, e.data])).toEqual([[2, { text: "hi" }]]);
      expect(yield* outbox.sessionsWithSpans).toEqual(["sesn_1"]);
      const spans = yield* outbox.pendingSpans("sesn_1");
      yield* outbox.postedSpans("sesn_1", spans.at(-1)!.id);
      expect(yield* outbox.sessionsWithSpans).toEqual([]);
      // mapped_through never goes back.
      yield* outbox.enqueue("sesn_1", [], { mappedThrough: 3 });
      expect((yield* outbox.byCloudId("sesn_1"))!.mappedThrough).toBe(7);
    }),
  );
});

test("a batch is scrubbed and at most 256 KiB; an event too big alone is cut and says so", () => {
  const events = Array.from({ length: 40 }, (_, i) => event(i + 1, { text: `${"y".repeat(20 * 1024)} ${SECRET}` }));
  const batches = batchesOf(events, scrubber);
  expect(batches.length).toBeGreaterThan(1);
  for (const batch of batches) expect(Buffer.byteLength(JSON.stringify({ events: batch }))).toBeLessThanOrEqual(BATCH_MAX_BYTES);
  expect(batches.flat().map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  expect(JSON.stringify(batches)).not.toContain(SECRET);
  expect(JSON.stringify(batches)).toContain("[secret:API_TOKEN]");

  const huge = fitEvent(event(1, { text: "z".repeat(600 * 1024), kind: "message" }));
  expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(BATCH_MAX_BYTES);
  expect(huge.data).toMatchObject({ truncated: true, kind: "message" });
  expect(batchesOf([event(1, { text: "z".repeat(600 * 1024) })], scrubber)).toHaveLength(1);
});

test("a tool's input cut inside a secret value goes out with the value masked, never its start, as its approval does", () => {
  // A command longer than a public event carries, its cut 12 characters into the token (headless.integration.test.ts
  // runs the same for a tool's output, end to end).
  const kept = 12;
  const command = `${"x".repeat(PUBLIC_PAYLOAD_MAX_BYTES - kept)}${SECRET} --and-more`;
  const at = "2026-11-07T10:00:00.000Z";
  const state = initialMapperState();
  const mapped = [
    ...mapSessionEvent(state, { session_id: "s", cursor: 1, at, type: "tool.started", item_id: "c1", payload: { name: "command", title: "long", kind: "command", input: command } } as unknown as SessionEvent, "api"),
    ...mapSessionEvent(state, { session_id: "s", cursor: 2, at, type: "ask.user", item_id: "a1", payload: { kind: "approval", title: "Run it?", tool_item_id: "c1", options: [{ id: "accept", label: "Allow", decision: "allow" }] } } as unknown as SessionEvent, "api"),
  ];
  const posted = batchesOf(mapped.map((e, i) => ({ seq: i + 1, type: e.type, created_at: e.created_at, data: e.data })), scrubber).flat();
  const withInput = posted.filter((e) => e.type !== "session.status");
  expect(withInput.map((e) => [e.type, (e.data as { truncated?: boolean }).truncated])).toEqual([["agent.tool_use", true], ["requires_action", true]]);
  for (const event of withInput) expect(String((event.data as { input: unknown }).input).slice(-12)).toBe("xxxx[secret]");
  expect(JSON.stringify(posted)).not.toContain(SECRET.slice(0, kept));
});

test("a custom tool's ask too big for one request even cut keeps what names it, and the SDK answers it as not run", async () => {
  const ask = (input: unknown) =>
    ({ session_id: "s", cursor: 1, at: "2026-11-07T10:00:00.000Z", type: "ask.user", item_id: "tool:1", payload: { kind: "tool", name: "save_file", input } }) as unknown as SessionEvent;
  const posted = (input: unknown) => {
    const [event] = mapSessionEvent(initialMapperState(), ask(input), "api");
    const batches = batchesOf([{ seq: 1, type: event!.type, created_at: event!.created_at, data: event!.data }], scrubber);
    expect(batches.flat()).toHaveLength(1);
    for (const batch of batches) expect(Buffer.byteLength(JSON.stringify({ events: batch }))).toBeLessThanOrEqual(BATCH_MAX_BYTES);
    return batches[0]![0]!;
  };
  // Five fields of 60 KiB, and thousands of short rows: no one text long enough to cut, too much together.
  const fields = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`part${i}`, "a".repeat(60 * 1024)]));
  const rows = { rows: Array.from({ length: 20_000 }, (_, i) => ({ id: i, sku: `sku-${i}` })) };
  for (const input of [fields, rows]) {
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(BATCH_MAX_BYTES);
    expect(posted(input)).toEqual({ seq: 1, type: "requires_action", created_at: "2026-11-07T10:00:00.000Z", data: { ask_id: "tool:1", kind: "tool", name: "save_file", truncated: true } });
  }

  // The caller's SDK, given that event as Cloud streams it: the agent is told its tool did not run, and nothing runs.
  const ran: Array<unknown> = [];
  const saveFile = tool("save_file", "Save a file", { type: "object" }, (input: unknown) => {
    ran.push(input);
    return "saved";
  });
  const sent: Array<UserEvent> = [];
  let answered = () => {};
  const answer = new Promise<void>((resolve) => (answered = resolve));
  const streamed = (seq: number, type: string, data: unknown) => ({ seq, type, created_at: "2026-11-07T10:00:00.000Z", data: JSON.parse(JSON.stringify(data)) }) as SdkEvent;
  const transport = {
    id: "sesn_1",
    events: (async function* () {
      yield streamed(1, "session.status", { status: "running", stop_reason: null });
      yield streamed(2, "requires_action", posted(fields).data);
      await answer;
      yield streamed(3, "session.status", { status: "terminated", stop_reason: "end_turn" });
    })(),
    message: async (): Promise<string> => {
      throw new Error("this host takes no messages");
    },
    send: async (input: UserEvent) => {
      sent.push(input);
      answered();
    },
    close: async () => {},
    kill: () => {},
  };
  await new Session(transport, { tools: [saveFile] }).result();
  expect({ ran: ran.length, sent }).toEqual({
    ran: 0,
    sent: [{ type: "user.tool_result", ask_id: "tool:1", is_error: true, content: expect.stringContaining("save_file did not run: its input was too large") }],
  });
});
