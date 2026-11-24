// The one place Session Protocol events become an org workload's public events (Caveman Cloud CONTRACT §3.4:
// session.status, user.message, agent.message, agent.thinking, agent.tool_use, agent.tool_result,
// requires_action, agent.subagent, session.usage, session.output, session.error, automation.step, pull_request).
// Only sessions whose origin is `api` or `automation` are mapped; a person's chat never is. The mapper is pure and
// keeps what a later event needs (a tool's name and output so far, a thought being streamed, the usage so far) in a
// state that round-trips through JSON, so the outbox can keep it with the events it already queued. Secrets are
// not this module's job: the outbox runs the egress scrub over every event before it leaves, a cut field's end
// included (CUT_FIELDS).
import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";

import type { TraceState } from "./traces.ts";

/** Who made the session: an API key's caller or an automation. A person's chat (`person`) is never mapped. */
export type SessionOrigin = "api" | "automation";

export const isOrgWorkload = (origin: string | undefined): origin is SessionOrigin => origin === "api" || origin === "automation";

export type PublicStatus = "starting" | "running" | "requires_action" | "idle" | "terminated";
export type StopReason = "end_turn" | "requires_action" | "budget_reached" | "error" | "interrupted";

/** A public event before the outbox numbers it. */
export interface PublicEvent {
  readonly type: string;
  readonly created_at: string;
  readonly data: Record<string, unknown>;
}

/** Inputs and outputs past this are cut, with `truncated: true` (§3.4). */
export const PUBLIC_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface MapperState {
  /** Tools started and not done: name, and output streamed so far (capped). */
  tools: Record<string, { name: string; input?: unknown; output: string }>;
  /** Subagents started and not done, by their item id: title and workspace. */
  subagents: Record<string, { title: string; workspace_id?: string }>;
  /** A thought being streamed, until another item's event (its end) comes. */
  thinking?: { item: string; text: string };
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number };
  /** The last status sent, so the same one is never sent twice in a row. */
  status?: PublicStatus;
  /** The session's open trace spans (traces.ts). */
  trace?: TraceState;
  /** Cloud parked the session's tree (its budget is spent): the turn that stops now stops for that. */
  budget?: true;
  /**
   * The caller's inputs the runtime took and has not said yet: by the item id each one's user message will have, the
   * id the caller knows it by (its mail's, or the one agent exec's input line gave), which its user.message says.
   */
  inputs?: Record<string, string>;
}

export const initialMapperState = (): MapperState => ({ tools: {}, subagents: {}, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 } });

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const headBytes = (text: string, max: number) => Buffer.from(text, "utf8").subarray(0, Math.max(0, max)).toString("utf8").replace(/�+$/, "");

/**
 * The fields `cut` shortens, on an event that says `truncated: true`: a tool's input (agent.tool_use, an approval's
 * requires_action) or its output (agent.tool_result). Such a field ends where the cut fell, which may be inside a value.
 */
export const CUT_FIELDS = ["input", "output"] as const;

/** A tool's input or output within 64 KiB: text is cut at a character boundary; a value too big becomes its JSON, cut. */
export function cut(value: unknown): { readonly value: unknown; readonly truncated: boolean } {
  if (typeof value === "string") return bytes(value) <= PUBLIC_PAYLOAD_MAX_BYTES ? { value, truncated: false } : { value: headBytes(value, PUBLIC_PAYLOAD_MAX_BYTES), truncated: true };
  if (value === undefined) return { value: null, truncated: false };
  const text = JSON.stringify(value) ?? "null";
  return bytes(text) <= PUBLIC_PAYLOAD_MAX_BYTES ? { value, truncated: false } : { value: headBytes(text, PUBLIC_PAYLOAD_MAX_BYTES), truncated: true };
}

/** Output kept while a tool runs: a little past the cap, so the cut still says it was cut. */
const keepOutput = (sofar: string, more: string) => (sofar.length > PUBLIC_PAYLOAD_MAX_BYTES ? sofar : sofar + more);

const STOP_OF: Record<"completed" | "interrupted" | "failed", StopReason> = { completed: "end_turn", interrupted: "interrupted", failed: "error" };

const textOf = (value: unknown) => (value === undefined || value === null ? "" : typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

/** A tool's result as one text: what it returned, else its error, else what it printed. */
function resultOf(done: Extract<SessionEvent, { type: "tool.done" }>["payload"], streamed: string): unknown {
  if (done.result !== undefined && done.result !== null && done.result !== "") return done.result;
  if (done.error !== undefined && done.error !== "") return streamed === "" ? done.error : `${streamed}\n${done.error}`;
  return streamed;
}

/** The runtime's own rows in a transcript (its checkout's `git checkout -b`, its setup run): not the agent's tools. */
export const runtimeRow = (itemId: string | undefined) => itemId !== undefined && /^(worktree|setup):/.test(itemId);

/**
 * Maps one Session Protocol event of an org workload to its public events, updating `state`. `origin` is the
 * session's: a user message it did not get from another agent is the caller's (`api`) or the automation's.
 */
export function mapSessionEvent(
  state: MapperState,
  event: SessionEvent,
  origin: SessionOrigin,
  /** A finished tool's output when its tool.done carries none: the journal never stores a command's output. */
  outputOf: (itemId: string) => unknown = () => undefined,
): ReadonlyArray<PublicEvent> {
  const at = event.at;
  const out: Array<PublicEvent> = [];
  const push = (type: string, data: Record<string, unknown>) => out.push({ type, created_at: at, data });
  const status = (next: PublicStatus, stop: StopReason | null) => {
    if (state.status === next && next !== "idle") return;
    state.status = next;
    push("session.status", { status: next, stop_reason: stop });
  };
  // A thought ends when anything else of the session happens.
  if (state.thinking !== undefined && !(event.type === "reasoning.delta" && event.item_id === state.thinking.item)) {
    if (state.thinking.text.trim() !== "") push("agent.thinking", { text: state.thinking.text });
    delete state.thinking;
  }
  if ((event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.done") && runtimeRow(event.item_id)) return out;
  switch (event.type) {
    case "turn.started":
      // A turn after the park (a person raised the limit) runs on the new budget.
      delete state.budget;
      status("running", null);
      break;
    case "message.done": {
      if (event.payload.role === "assistant") {
        push("agent.message", { text: event.payload.text });
        break;
      }
      const input = event.item_id === undefined ? undefined : state.inputs?.[event.item_id];
      if (input !== undefined) delete state.inputs![event.item_id!];
      push("user.message", { text: event.payload.text, origin: event.payload.from ? "agent" : origin, ...(input === undefined ? {} : { input_id: input }) });
      break;
    }
    case "reasoning.delta": {
      const item = event.item_id ?? "reasoning";
      state.thinking = { item, text: `${state.thinking?.item === item ? state.thinking.text : ""}${event.payload.text}` };
      break;
    }
    case "tool.started": {
      const id = event.item_id ?? "";
      state.tools[id] = { name: event.payload.name, input: event.payload.input, output: "" };
      const input = cut(event.payload.input);
      push("agent.tool_use", { id, name: event.payload.name, input: input.value, ...(input.truncated ? { truncated: true } : {}) });
      break;
    }
    case "tool.output": {
      const tool = state.tools[event.item_id ?? ""];
      if (tool) tool.output = keepOutput(tool.output, event.payload.text);
      break;
    }
    case "tool.done": {
      const id = event.item_id ?? "";
      const tool = state.tools[id];
      delete state.tools[id];
      const output = cut(resultOf(event.payload, tool?.output || textOf(outputOf(id))));
      push("agent.tool_result", { tool_use_id: id, is_error: event.payload.status !== "completed", output: output.value, ...(output.truncated ? { truncated: true } : {}) });
      break;
    }
    case "ask.user": {
      const ask = event.payload;
      const askId = event.item_id ?? "";
      if (ask.kind === "approval") {
        const tool = ask.tool_item_id === undefined ? undefined : state.tools[ask.tool_item_id];
        const input = cut(tool?.input);
        push("requires_action", {
          ask_id: askId,
          kind: "approval",
          question: ask.title,
          ...(tool ? { name: tool.name, input: input.value } : {}),
          ...(input.truncated ? { truncated: true } : {}),
          options: ask.options.map((o) => o.decision),
        });
      } else if (ask.kind === "question") {
        push("requires_action", {
          ask_id: askId,
          kind: "question",
          question: ask.questions.map((q) => q.prompt).join("\n\n"),
          options: ask.questions.flatMap((q) => q.options.map((o) => o.label)),
          questions: ask.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options.map((o) => o.label), multi_select: q.multi_select })),
        });
      } else if (ask.kind === "tool") {
        // Whole, never cut as tool_use is: the caller's handler runs on it (§3.5), and a cut input is not the call.
        push("requires_action", { ask_id: askId, kind: "tool", name: ask.name, input: ask.input ?? null });
      } else {
        // A secret never travels in mail: any answer declines it (headless.ts responseFor), and the caller is told where secrets go.
        push("requires_action", {
          ask_id: askId,
          kind: "question",
          question: `The agent asked for the secret ${ask.name} (${ask.reason}). Grant it to the service account; an answer here only lets it go on without it.`,
        });
      }
      status("requires_action", "requires_action");
      break;
    }
    case "ask.resolved":
      if (state.status === "requires_action") status("running", null);
      break;
    case "subagent.started": {
      const id = event.item_id ?? "";
      state.subagents[id] = { title: event.payload.title, ...(event.payload.workspace_id ? { workspace_id: event.payload.workspace_id } : {}) };
      push("agent.subagent", { workspace_id: event.payload.workspace_id ?? null, title: event.payload.title, status: "running" });
      break;
    }
    case "subagent.done": {
      const id = event.parent_item_id ?? event.item_id ?? "";
      const started = state.subagents[id];
      delete state.subagents[id];
      push("agent.subagent", { workspace_id: started?.workspace_id ?? null, title: started?.title ?? "", status: event.payload.status });
      break;
    }
    case "usage": {
      const u = state.usage;
      u.input_tokens += event.payload.input_tokens;
      u.output_tokens += event.payload.output_tokens;
      u.cache_read_tokens += event.payload.cache_read_tokens;
      u.cost_usd = Math.round((u.cost_usd + (event.payload.cost?.usd ?? 0)) * 1e6) / 1e6;
      push("session.usage", { ...u });
      break;
    }
    case "turn.done":
      // Tools a stopped turn left open never report again.
      state.tools = {};
      if (event.payload.status === "failed") push("session.error", { code: "turn_failed", message: event.payload.error ?? "The turn failed." });
      status("idle", stopReasonOf(state, STOP_OF[event.payload.status]));
      break;
    case "error":
      if (event.payload.retry === undefined) push("session.error", { code: event.payload.reason, message: event.payload.message });
      break;
    default:
      break;
  }
  return out;
}

/** Why a turn or run stopped: a stop after Cloud parked the tree is the budget's, unless it failed on its own. */
export const stopReasonOf = (state: MapperState, stop: StopReason | null): StopReason | null =>
  state.budget === true && stop !== "error" && stop !== "requires_action" ? "budget_reached" : stop;

/** The session ended for good (archived, or it never could start). */
export function terminated(state: MapperState, at: string, stop: StopReason | null): ReadonlyArray<PublicEvent> {
  if (state.status === "terminated") return [];
  state.status = "terminated";
  return [{ type: "session.status", created_at: at, data: { status: "terminated", stop_reason: stop } }];
}

/**
 * The session could not do what it was asked: `agent_invalid` (a bad agent file), and the like. With `inputId`, it
 * refuses that one input of the caller's: the message runs in no turn, and the session goes on.
 */
export const sessionError = (at: string, code: string, message: string, inputId?: string): PublicEvent => ({
  type: "session.error",
  created_at: at,
  data: { code, message, ...(inputId === undefined ? {} : { input_id: inputId }) },
});

/** The caller's input `inputId` is said as the user message `itemId`, whose user.message then carries the id. */
export const expectInput = (state: MapperState, itemId: string, inputId: string): void => {
  state.inputs = { ...state.inputs, [itemId]: inputId };
};

/** A pull request the session opened, when it first shows or changes state. */
export function pullRequestEvent(workspace: Workspace, known: string | undefined): { readonly event?: PublicEvent; readonly key?: string } {
  const pr = workspace.pull_request as { readonly url?: string; readonly state?: string } | undefined;
  if (pr?.url === undefined) return {};
  const state = pr.state === "merged" || pr.state === "closed" ? pr.state : "open";
  const key = `${pr.url}:${state}`;
  if (key === known) return { key };
  return { key, event: { type: "pull_request", created_at: workspace.updated_at, data: { url: pr.url, state } } };
}

/** A file the session wrote under its outputs, once Cloud holds it. */
export const outputEvent = (at: string, fileId: string, path: string, size: number): PublicEvent => ({
  type: "session.output",
  created_at: at,
  data: { file_id: fileId, path, bytes: size },
});

/**
 * What happened to the session's computer when its tools run on a Caveman sandbox (tier linux on the harness pool):
 * made, attached, woke, released or lost, with its id, size, image, network and keep, how long it took to run
 * commands (`ready_ms`), and `slept_without_memory` (Caveman Cloud tier-linux design §3.2).
 */
export const sandboxEvent = (at: string, data: { readonly action: string; readonly computer_id: string }): PublicEvent => ({
  type: "session.sandbox",
  created_at: at,
  data: { ...data },
});

/** An automation step's attempt (A2's runner reports these through the same outbox). */
export const automationStepEvent = (
  at: string,
  step: { readonly run_id: string; readonly step: string; readonly attempt: number; readonly status: string; readonly engine: string; readonly model: string; readonly decision?: string },
): PublicEvent => ({ type: "automation.step", created_at: at, data: { ...step } });
