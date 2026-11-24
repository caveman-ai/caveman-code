// Caveman Cloud's chat sync routes (Caveman Cloud the spec): the shapes a runtime writes and a device reads, so the
// runtime, the web and the test Cloud agree on them. Not Session Protocol: these go over HTTPS to Cloud, snake_case.
//
// A runtime copies each synced chat's journal to Cloud as segments and keeps a summary row per chat; a device lists
// the summaries (GET /api/v1/code/chats), follows their changes (GET /api/v1/code/chats/stream, SSE), reads a chat's
// copy (GET /api/v1/code/chats/{id}/events) and queues calls for a runtime that is asleep (POST .../calls).
import * as Schema from "effect/Schema";

import { CallDevice, Cursor, Id, IsoDateTime, RequestId, SessionEvent } from "./protocol.ts";

const { optionalKey } = Schema;
const S = Schema.Struct;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Longest summary preview and needs-you line Cloud keeps (runtime-side cut, scrubbed of secret values first). */
export const PREVIEW_MAX = 280;
export const NEEDS_YOU_MAX = 200;

export const ChatKind = Schema.Literals(["chat", "chief", "builder", "setup", "automation"]);
export type ChatKind = typeof ChatKind.Type;
export const ChatStatus = Schema.Literals(["idle", "working", "needs_you", "error"]);
export type ChatStatus = typeof ChatStatus.Type;

export const ChatPullRequest = S({
  number: Count,
  url: Schema.String,
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  checks: Schema.Literals(["pass", "fail", "pending", "none"]),
});
export type ChatPullRequest = typeof ChatPullRequest.Type;

/** What the runtime that owns a chat writes (PUT /api/v1/code/runtime/chats/{session_id}). */
export const ChatSummaryInput = S({
  session_id: Id,
  workspace_id: Id,
  title: Schema.String,
  /** The engine's own id (caveman, claude, codex, an ACP agent's): Cloud keeps it as text. */
  engine: Schema.String,
  model: optionalKey(Schema.String),
  repo: optionalKey(Schema.String),
  branch: optionalKey(Schema.String),
  base_branch: optionalKey(Schema.String),
  kind: ChatKind,
  /** A builder's lead, a delegated agent's parent. */
  parent_session_id: optionalKey(Id),
  /** The chat on another of the person's Macs whose mail its turn runs: that chat tells the person, this one is quiet. */
  asked_by_session_id: optionalKey(Id),
  status: ChatStatus,
  needs_you: optionalKey(S({ kind: Schema.Literals(["approval", "question", "plan"]), summary: Schema.String })),
  last_activity_at: IsoDateTime,
  preview: optionalKey(Schema.String),
  epoch: Count,
  head: Cursor,
  pull_request: optionalKey(ChatPullRequest),
  archived: Schema.Boolean,
  /** The runtime keeps the chat in sync: true turns it back on in Cloud after sync was off (false takes it out). */
  sync: optionalKey(Schema.Boolean),
  /**
   * A summary that registers a chat on a Cloud computer: the workspace Cloud placed for it, which the registration
   * takes up, or "" when nobody placed it. `workspace_id` above is the runtime's own id for the chat's workspace.
   */
  placed_workspace_id: optionalKey(Schema.String),
  /**
   * Whether the chat can run somewhere else than where it is, as its runtime reads it (CONTRACT §11). Cloud narrows it
   * by its own rows and never grants a move on it. Absent from a runtime that predates it: Cloud then says nothing.
   */
  movable: optionalKey(Schema.Boolean),
  /** With `movable` false: why, as a code clients word (never a sentence). */
  stays: optionalKey(S({ code: Schema.String })),
  /**
   * A move of the chat is asked: `to` is "cloud" or the computer id of one of the person's Macs, `waiting_turn` that it
   * waits for the chat's turn to end, `since` when it was asked. A device reads Cloud's own moves here too.
   */
  moving: optionalKey(S({ to: Schema.String, waiting_turn: Schema.Boolean, since: IsoDateTime })),
});
export type ChatSummaryInput = typeof ChatSummaryInput.Type;

/** One chat of a batch of summaries, as Cloud answers it: its seq, or why it refused that one (the rest still land). */
export interface SummaryBatchItem {
  readonly session_id: string;
  readonly seq?: number;
  readonly error?: { readonly code: string; readonly message: string };
}

/** What a device queues for a chat (POST .../calls): a send, a stop and an answer. */
export const CallMethod = Schema.Literals(["turn.submit", "turn.interrupt", "ask.respond"]);
export type CallMethod = typeof CallMethod.Type;

/**
 * The call Cloud queues with a chat's placement (POST /api/v1/code/workspaces with `start`): the runtime's
 * workspace.create for the chat it placed. No device queues it for a chat; only a placement does.
 */
export const START_METHOD = "workspace.create";
/** Every method a runtime runs from Cloud's queue: what a device queues, and a placement's start. */
export const QueuedMethod = Schema.Literals(["turn.submit", "turn.interrupt", "ask.respond", START_METHOD]);
export type QueuedMethod = typeof QueuedMethod.Type;

/**
 * A chat's start as a placement carries it: the request id its runtime runs it under (a device's own live
 * workspace.create under that id makes the same workspace) and workspace.create's params without
 * `placed_workspace_id`, which Cloud sets to the workspace it placed.
 */
export const WorkspaceStart = S({ request_id: RequestId.check(Schema.isMaxLength(150)), params: Schema.Record(Schema.String, Schema.Unknown) });
export type WorkspaceStart = typeof WorkspaceStart.Type;

/** A call queued in Cloud for a chat whose runtime could not take it live: a device's, or its placement's start. */
export const CallState = S({
  id: Id,
  request_id: RequestId,
  method: QueuedMethod,
  status: Schema.Literals(["queued", "delivered", "done", "failed", "expired"]),
  created_at: IsoDateTime,
  result: optionalKey(Schema.Unknown),
  error: optionalKey(S({ code: Schema.String, message: Schema.String })),
  /**
   * Still queued and why: its Mac is asleep and holds the chat, or the chat cannot move. `code`, with `not_movable`:
   * why it cannot, in the codes a chat's `stays` uses (clients word it); `detail` is the sentence older clients show.
   */
  waiting: optionalKey(S({ reason: Schema.Literals(["laptop_asleep", "not_movable"]), detail: Schema.String, code: optionalKey(Schema.String) })),
});
export type CallState = typeof CallState.Type;

/** A chat as every device lists it. */
/** What a runtime says of a chat that a device also reads: all of it but what only its registration is for. */
const { placed_workspace_id: _registrationOnly, ...listedFields } = ChatSummaryInput.fields;
export const ChatSummary = S({
  ...listedFields,
  /**
   * The runtime the chat's computer runs as now. Cloud sends null while a Cloud computer is not asked to run (CONTRACT
   * §11): it has no runtime then, and a reader that looks the id up among the listed runtimes finds none.
   */
  runtime_id: Id,
  computer_id: Id,
  /**
   * `sleep_reason` "usage": its Cloud computer sleeps because the plan is used up and nothing pays for its time now;
   * `resets_at`: when the plan resets, absent when nothing says when. Never an amount.
   */
  where: S({
    kind: Schema.Literals(["laptop", "cloud"]),
    name: Schema.String,
    online: optionalKey(Schema.Boolean),
    sleep_reason: optionalKey(Schema.Literal("usage")),
    resets_at: optionalKey(IsoDateTime),
  }),
  /** Cloud's copy's last cursor in `epoch`. */
  synced_through: Cursor,
  person: S({ seen_cursor: Cursor, pinned: Schema.Boolean, done_at: optionalKey(IsoDateTime), snoozed_until: optionalKey(IsoDateTime) }),
  calls: Schema.Array(CallState),
  seq: Count,
});
export type ChatSummary = typeof ChatSummary.Type;

export const RuntimeState = S({
  runtime_id: Id,
  computer_id: Id,
  kind: Schema.Literals(["laptop", "cloud"]),
  name: Schema.String,
  online: Schema.Boolean,
  computer_state: optionalKey(Schema.Literals(["running", "starting", "suspended", "stopped", "deleted"])),
  /** Null until Cloud first hears from the runtime (a Mac enrolled at sign-in, before its link runs). */
  last_seen_at: Schema.NullOr(IsoDateTime),
  image_current: optionalKey(Schema.Boolean),
});
export type RuntimeState = typeof RuntimeState.Type;

/** GET /api/v1/code/chats. */
export const ChatList = S({ chats: Schema.Array(ChatSummary), runtimes: Schema.Array(RuntimeState), seq: Count });
export type ChatList = typeof ChatList.Type;

/** One journal event as Cloud's copy holds it: the Session Protocol event whole, with its position beside it. */
export const CopiedEvent = S({ cursor: Cursor, type: Schema.String, at: IsoDateTime, event: SessionEvent });
export type CopiedEvent = typeof CopiedEvent.Type;

/** GET /api/v1/code/chats/{session_id}/events?epoch=&after=&limit=. `reset`: the epoch asked for is not the copy's. */
export const ChatEventsPage = S({ epoch: Count, through: Cursor, events: Schema.Array(CopiedEvent), more: Schema.Boolean, reset: optionalKey(Schema.Boolean) });
export type ChatEventsPage = typeof ChatEventsPage.Type;

/** PUT /api/v1/code/chats/{session_id}/state. */
export const PersonStatePatch = S({
  seen_cursor: optionalKey(Cursor),
  pinned: optionalKey(Schema.Boolean),
  done: optionalKey(Schema.Boolean),
  snoozed_until: optionalKey(Schema.NullOr(IsoDateTime)),
});
export type PersonStatePatch = typeof PersonStatePatch.Type;

/** POST /api/v1/code/chats/{session_id}/calls. */
export const CallRequest = S({
  request_id: RequestId,
  method: CallMethod,
  params: Schema.Record(Schema.String, Schema.Unknown),
  device: optionalKey(CallDevice),
  /** Older clients named only the device. */
  device_id: optionalKey(Schema.String),
});
export type CallRequest = typeof CallRequest.Type;

/**
 * A queued call as its runtime takes it: mail on channel `call` to the chat's workspace, `body` this as JSON. `method`
 * is a QueuedMethod, read as text: one this runtime does not know (a Cloud newer than it) is answered as such
 * (`method_not_found`), which its device acts on, and never dropped unread.
 */
export const CallDelivery = S({
  call_id: Id,
  session_id: Id,
  request_id: RequestId,
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
  user_id: Id,
  device: optionalKey(CallDevice),
  device_id: optionalKey(Schema.String),
  /** Input the chat's previous computer took in that the copy it moved from lacked (Cloud 53565ffec): no device. */
  forwarded_by_runtime_id: optionalKey(Schema.String),
});
export type CallDelivery = typeof CallDelivery.Type;

/** POST /api/v1/code/runtime/chats/{session_id}/calls/{call_id}/result. */
export const CallResult = S({ ok: Schema.Boolean, result: optionalKey(Schema.Unknown), error: optionalKey(S({ code: Schema.String, message: Schema.String })) });
export type CallResult = typeof CallResult.Type;

/** The device stream's events (SSE `event:` names), each `data:` one JSON value. */
export type ChatStreamEvent =
  | { readonly event: "chat"; readonly data: ChatSummary }
  | { readonly event: "gone"; readonly data: { readonly session_id: string } }
  | { readonly event: "runtime"; readonly data: RuntimeState }
  | { readonly event: "reset"; readonly data: Record<string, never> };

/** Cloud's cap on one journal segment's body as sent (gzip), and decompressed. */
export const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
export const SEGMENT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
/** One event over this is copied with its text cut and `copy_truncated: true` inside it; the owner keeps it whole. */
export const EVENT_COPY_MAX_BYTES = 4 * 1024 * 1024;
