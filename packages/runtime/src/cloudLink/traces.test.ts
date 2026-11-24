import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { initialTraceState, otlpRequest, stepSpan, traceEvent, traceIdOf, type TraceContext } from "./traces.ts";

let cursor = 0;
const ev = (type: string, payload: unknown, at: string, extra: Partial<{ item_id: string; turn_id: string }> = {}) =>
  ({ session_id: "s", cursor: ++cursor, at, type, payload, ...extra }) as unknown as SessionEvent;
const ctx: TraceContext = { sessionId: "sesn_1", origin: "api", engine: "caveman", model: "claude-sonnet-5-5", agentName: "reviewer", caveSession: "sesn_1" };
const attrs = (span: { attributes: ReadonlyArray<{ key: string; value: Record<string, unknown> }> }) =>
  Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

test("a turn is a gen_ai invoke_agent span with its tools under it and its usage on it; a stopped tool ends with the turn", () => {
  const state = initialTraceState("sesn_1");
  const spans = [
    ev("turn.started", { engine: "caveman" }, "2026-10-21T10:00:00.000Z", { turn_id: "t1" }),
    ev("tool.started", { name: "command", title: "npm test", kind: "command", input: {} }, "2026-10-21T10:00:01.000Z", { item_id: "c1" }),
    ev("tool.done", { status: "failed", error: "exit 1" }, "2026-10-21T10:00:03.000Z", { item_id: "c1" }),
    ev("tool.started", { name: "worktree", title: "git", kind: "command", input: {} }, "2026-10-21T10:00:03.000Z", { item_id: "worktree:w" }),
    ev("tool.started", { name: "read", title: "a", kind: "read", input: {} }, "2026-10-21T10:00:04.000Z", { item_id: "c2" }),
    ev("usage", { model: "claude-sonnet-5-5", input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 0, cost: { usd: 0.01, basis: "list_price" } }, "2026-10-21T10:00:05.000Z"),
    ev("turn.done", { status: "completed" }, "2026-10-21T10:00:06.000Z", { turn_id: "t1" }),
  ].flatMap((e) => traceEvent(state, e, ctx));
  expect(spans.map((s) => s.name)).toEqual(["execute_tool command", "execute_tool read", "invoke_agent reviewer"]);
  const [tool, cut, turn] = spans;
  expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([traceIdOf("sesn_1")]));
  expect(tool!.parentSpanId).toBe(turn!.spanId);
  expect(tool!.status).toEqual({ code: 2, message: "exit 1" });
  expect(cut!.status).toEqual({ code: 2, message: "the turn ended first" });
  expect(Number(BigInt(turn!.endTimeUnixNano) - BigInt(turn!.startTimeUnixNano)) / 1e6).toBe(6000);
  expect(attrs(turn!)).toMatchObject({
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "reviewer",
    "gen_ai.usage.input_tokens": "100",
    "gen_ai.usage.output_tokens": "20",
    "gen_ai.response.model": "claude-sonnet-5-5",
    "x-cave-session": "sesn_1",
    "caveman.turn.outcome": "completed",
  });
  expect(attrs(tool!)).toMatchObject({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "command", "gen_ai.tool.call.id": "c1" });
  // The state round-trips through JSON (the outbox keeps it), and nothing is left open.
  expect(JSON.parse(JSON.stringify(state)).open).toEqual({});
  const request = otlpRequest(spans, { sessionId: "sesn_1", origin: "api" });
  expect(request.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(3);
});

test("an automation step is one span named <automation>__<step>, its session the run", () => {
  const span = stepSpan({ sessionId: "sesn_2", automation: "triage", step: "label", runId: "r_1", attempt: 2, engine: "codex", start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T10:01:00.000Z", status: "succeeded", costUsd: 0.2 });
  expect(span.name).toBe("invoke_agent triage__label");
  expect(attrs(span)).toMatchObject({ "gen_ai.agent.name": "triage__label", "x-cave-session": "r_1", "caveman.automation.step.attempt": "2", "caveman.cost_usd": 0.2 });
  expect(span.traceId).toBe(traceIdOf("sesn_2"));
});
