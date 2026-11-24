// An org workload's traces (Caveman Cloud CONTRACT §7): OpenTelemetry gen_ai spans for its turns, tool calls,
// subagents and automation steps, posted as OTLP/JSON to /api/v1/code/runtime/traces, which Cloud ingests into the
// service account's project like any other trace. Built from the same Session Protocol events the public events
// are (publicEvents.ts), with the open spans kept in the mapper's state so a restart closes what it opened.
// Only org workloads have traces; a person's chat never does.
import { createHash, randomBytes } from "node:crypto";

import type { SessionEvent } from "@caveman-app/session-protocol";

import { runtimeRow, type SessionOrigin } from "./publicEvents.ts";

/** An open span: when it started, its ids, and what it gathers until it ends. */
export interface OpenSpan {
  readonly spanId: string;
  readonly parent?: string;
  readonly start: string;
  readonly name: string;
  readonly attrs: Record<string, string | number | boolean>;
}

export interface TraceState {
  /** One trace per session: every turn is a root span in it. */
  traceId: string;
  /** Open spans by the item (a tool, a subagent) or turn they belong to. */
  open: Record<string, OpenSpan>;
  /** The running turn's span key, which tools and subagents hang under. */
  turn?: string;
}

/** What a session's spans say about it: who runs it, and for what. */
export interface TraceContext {
  readonly sessionId: string;
  readonly origin: SessionOrigin;
  readonly engine: string;
  readonly model?: string | undefined;
  /** The agent's name, or `<automation>__<step>` for an automation's (CONTRACT §7). */
  readonly agentName: string;
  /** `x-cave-session`: the automation run id, else the session id. */
  readonly caveSession: string;
}

/** A finished span, in OTLP/JSON's own shape. */
export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: Record<string, unknown> }>;
  readonly status: { readonly code: number; readonly message?: string };
}

/** A session's trace id: stable, so every span of it lands in one trace whichever process posts it. */
export const traceIdOf = (sessionId: string) => createHash("sha256").update(`caveman-session\0${sessionId}`).digest("hex").slice(0, 32);
const newSpanId = () => randomBytes(8).toString("hex");
const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;

export const initialTraceState = (sessionId: string): TraceState => ({ traceId: traceIdOf(sessionId), open: {} });

const attribute = (key: string, value: string | number | boolean) => ({
  key,
  value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
});

const STATUS_OK = 1;
const STATUS_ERROR = 2;
const KIND_INTERNAL = 1;

function finish(state: TraceState, key: string, end: string, error: string | undefined, more: Record<string, string | number | boolean> = {}): OtlpSpan | undefined {
  const span = state.open[key];
  if (span === undefined) return undefined;
  delete state.open[key];
  return {
    traceId: state.traceId,
    spanId: span.spanId,
    ...(span.parent ? { parentSpanId: span.parent } : {}),
    name: span.name,
    kind: KIND_INTERNAL,
    startTimeUnixNano: nanos(span.start),
    endTimeUnixNano: nanos(end),
    attributes: Object.entries({ ...span.attrs, ...more }).map(([k, v]) => attribute(k, v)),
    status: error === undefined ? { code: STATUS_OK } : { code: STATUS_ERROR, message: error },
  };
}

const base = (ctx: TraceContext) => ({
  "gen_ai.system": ctx.engine,
  "gen_ai.agent.name": ctx.agentName,
  "x-cave-session": ctx.caveSession,
  "caveman.session.id": ctx.sessionId,
  "caveman.session.origin": ctx.origin,
  ...(ctx.model ? { "gen_ai.request.model": ctx.model } : {}),
});

/** The spans one event finishes, updating `state` (open spans start here and end with their event). */
export function traceEvent(state: TraceState, event: SessionEvent, ctx: TraceContext): ReadonlyArray<OtlpSpan> {
  const out: Array<OtlpSpan> = [];
  if ((event.type === "tool.started" || event.type === "tool.done") && runtimeRow(event.item_id)) return out;
  const turnSpan = state.turn === undefined ? undefined : state.open[state.turn]?.spanId;
  switch (event.type) {
    case "turn.started": {
      const key = `turn:${event.turn_id ?? event.cursor}`;
      state.turn = key;
      state.open[key] = { spanId: newSpanId(), start: event.at, name: `invoke_agent ${ctx.agentName}`, attrs: { ...base(ctx), "gen_ai.operation.name": "invoke_agent", "caveman.engine": event.payload.engine } };
      break;
    }
    case "usage": {
      const span = state.turn === undefined ? undefined : state.open[state.turn];
      if (span === undefined) break;
      const add = (k: string, n: number) => (span.attrs[k] = Number(span.attrs[k] ?? 0) + n);
      add("gen_ai.usage.input_tokens", event.payload.input_tokens);
      add("gen_ai.usage.output_tokens", event.payload.output_tokens);
      add("gen_ai.usage.cache_read_input_tokens", event.payload.cache_read_tokens);
      if (event.payload.cost?.usd !== undefined) span.attrs["caveman.cost_usd"] = Math.round((Number(span.attrs["caveman.cost_usd"] ?? 0) + event.payload.cost.usd) * 1e6) / 1e6;
      span.attrs["gen_ai.response.model"] = event.payload.model;
      break;
    }
    case "tool.started": {
      const key = `tool:${event.item_id ?? event.cursor}`;
      state.open[key] = {
        spanId: newSpanId(),
        ...(turnSpan ? { parent: turnSpan } : {}),
        start: event.at,
        name: `execute_tool ${event.payload.name}`,
        attrs: { ...base(ctx), "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": event.payload.name, "gen_ai.tool.call.id": event.item_id ?? "", "gen_ai.tool.type": event.payload.kind },
      };
      break;
    }
    case "tool.done": {
      const span = finish(state, `tool:${event.item_id ?? ""}`, event.at, event.payload.status === "completed" ? undefined : (event.payload.error ?? event.payload.status));
      if (span) out.push(span);
      break;
    }
    case "subagent.started": {
      const key = `subagent:${event.item_id ?? event.cursor}`;
      state.open[key] = {
        spanId: newSpanId(),
        ...(turnSpan ? { parent: turnSpan } : {}),
        start: event.at,
        name: `invoke_agent ${event.payload.agent ?? event.payload.title}`,
        attrs: { ...base(ctx), "gen_ai.operation.name": "invoke_agent", "caveman.subagent.title": event.payload.title, ...(event.payload.agent ? { "caveman.subagent.agent": event.payload.agent } : {}) },
      };
      break;
    }
    case "subagent.done": {
      const span = finish(state, `subagent:${event.parent_item_id ?? event.item_id ?? ""}`, event.at, event.payload.status === "completed" ? undefined : event.payload.status);
      if (span) out.push(span);
      break;
    }
    case "turn.done": {
      // A stopped turn's tools and subagents end with it.
      for (const key of Object.keys(state.open)) {
        if (key === state.turn) continue;
        const span = finish(state, key, event.at, "the turn ended first");
        if (span) out.push(span);
      }
      if (state.turn !== undefined) {
        const span = finish(state, state.turn, event.at, event.payload.status === "completed" ? undefined : (event.payload.error ?? event.payload.status), { "caveman.turn.outcome": event.payload.status });
        if (span) out.push(span);
      }
      delete state.turn;
      break;
    }
    default:
      break;
  }
  return out;
}

/** An automation step's attempt as one span (A2's runner posts these beside its run record). */
export function stepSpan(input: {
  readonly sessionId: string;
  readonly automation: string;
  readonly step: string;
  readonly runId: string;
  readonly attempt: number;
  readonly engine: string;
  readonly model?: string;
  readonly start: string;
  readonly end: string;
  readonly status: "succeeded" | "failed" | string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}): OtlpSpan {
  const attrs: Record<string, string | number | boolean> = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.system": input.engine,
    "gen_ai.agent.name": `${input.automation}__${input.step}`,
    "x-cave-session": input.runId,
    "caveman.session.id": input.sessionId,
    "caveman.automation.step.attempt": input.attempt,
    "caveman.automation.step.status": input.status,
    ...(input.model ? { "gen_ai.request.model": input.model } : {}),
    ...(input.inputTokens !== undefined ? { "gen_ai.usage.input_tokens": input.inputTokens } : {}),
    ...(input.outputTokens !== undefined ? { "gen_ai.usage.output_tokens": input.outputTokens } : {}),
    ...(input.costUsd !== undefined ? { "caveman.cost_usd": input.costUsd } : {}),
  };
  return {
    traceId: traceIdOf(input.sessionId),
    spanId: newSpanId(),
    name: `invoke_agent ${input.automation}__${input.step}`,
    kind: KIND_INTERNAL,
    startTimeUnixNano: nanos(input.start),
    endTimeUnixNano: nanos(input.end),
    attributes: Object.entries(attrs).map(([k, v]) => attribute(k, v)),
    status: input.status === "succeeded" ? { code: STATUS_OK } : { code: STATUS_ERROR, message: input.status },
  };
}

/** Finished spans as one OTLP/JSON ExportTraceServiceRequest. */
export const otlpRequest = (spans: ReadonlyArray<OtlpSpan>, ctx: { readonly sessionId: string; readonly origin: SessionOrigin }) => ({
  resourceSpans: [
    {
      resource: { attributes: [attribute("service.name", "caveman-runtime"), attribute("caveman.session.id", ctx.sessionId), attribute("caveman.session.origin", ctx.origin)] },
      scopeSpans: [{ scope: { name: "caveman-runtime" }, spans }],
    },
  ],
});
