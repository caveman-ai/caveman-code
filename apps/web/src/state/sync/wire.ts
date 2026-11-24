// Caveman Cloud's view of a person's chats, as its /api/v1/code/chats routes send it (snake_case, CONTRACT §3):
// one summary per synced chat on every computer, the runtimes they run on, and the calls a device queued in Cloud.

export type WhereKind = "laptop" | "cloud";

export interface CallError {
  readonly code: string;
  readonly message: string;
}

/**
 * A call Cloud queued for a chat: one a device queued because the chat's runtime was not reachable (POST
 * /code/chats/{id}/calls), or the start Cloud queued with a chat's placement (POST /code/workspaces with `start`).
 */
export interface CallState {
  readonly id: string;
  readonly request_id: string;
  readonly method: ChatCallMethod | typeof START_METHOD;
  readonly status: "queued" | "delivered" | "done" | "failed" | "expired";
  readonly created_at: string;
  readonly result?: unknown;
  readonly error?: CallError;
  /**
   * Still queued and why (S12): its Mac is asleep and Cloud is moving the chat, or the chat cannot move (its repository
   * is not on GitHub, its engine has no Cloud login) and waits for the Mac.
   */
  readonly waiting?: {
    readonly reason: "laptop_asleep" | "not_movable";
    readonly detail?: string;
    /**
     * With `not_movable`: why the chat cannot move, as a code (the ones a chat's `stays` uses, and Cloud's own
     * `repo_unverified` and `cloud_full`). A client words the codes it knows; `detail` is for one that knows none.
     */
    readonly code?: string;
  };
}

/** The calls a device queues in Cloud for a chat: send, stop and answer. */
export type ChatCallMethod = "turn.submit" | "turn.interrupt" | "ask.respond";

/** The call Cloud queues with a chat it places: the chat's start, which no device queues by itself (CONTRACT §6.8). */
export const START_METHOD = "workspace.create";

export interface ChatPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "draft" | "merged" | "closed";
  readonly checks: "pass" | "fail" | "pending" | "none";
}

export interface PersonState {
  /** Read through this cursor (any device), never moving back. */
  readonly seen_cursor: number;
  readonly pinned: boolean;
  readonly done_at?: string | null;
  readonly snoozed_until?: string | null;
}

export interface ChatSummary {
  readonly session_id: string;
  readonly workspace_id: string;
  /**
   * The runtime the chat's computer runs as now. Cloud sends null while a Cloud computer is not asked to run (asleep,
   * stopped): such a computer has no runtime, and a client follows it by `computer_id` (wake hints, GET
   * /code/computers). Typed as a string still: this file's readers look it up among the listed runtimes, where a
   * null finds none and so reads as asleep (chats-view.ts whereOf); typing the null through them is their owner's.
   */
  readonly runtime_id: string;
  readonly computer_id: string;
  /**
   * `online`: a runtime there was heard from lately, as Cloud read it when it wrote this summary. `sleep_reason`
   * "usage": its Cloud computer sleeps because the plan is used up and nothing pays for its time now; `resets_at`:
   * when the plan resets, absent when nothing says when. Only the reason and the time: never an amount.
   */
  readonly where: { readonly kind: WhereKind; readonly name: string; readonly online?: boolean; readonly sleep_reason?: "usage"; readonly resets_at?: string };
  readonly title: string;
  readonly engine: string;
  readonly model?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly base_branch?: string;
  readonly kind: "chat" | "chief" | "builder" | "setup" | "automation";
  readonly parent_session_id?: string;
  /** The chat on another of the person's Macs whose mail this chat's turn runs: that chat tells the person. */
  readonly asked_by_session_id?: string;
  readonly status: "idle" | "working" | "needs_you" | "error";
  readonly needs_you?: { readonly kind: "approval" | "question" | "plan"; readonly summary: string };
  readonly last_activity_at: string;
  readonly preview?: string;
  readonly epoch: number;
  readonly head: number;
  readonly synced_through: number | null;
  readonly pull_request?: ChatPullRequest;
  readonly archived: boolean;
  /**
   * Whether the chat can run somewhere else than where it is, as its runtime said and Cloud's own rows allow. Absent:
   * its runtime has not said (one from before the field), and a client asks that runtime as it did. `stays` is there
   * exactly when `movable` is false: why, as a code a client words (never a sentence). Cloud's refusal of a move
   * (409 cave_code_session_not_movable) stays the backstop.
   */
  readonly movable?: boolean;
  readonly stays?: { readonly code: string };
  /**
   * The chat is on its way to another place, whoever started the move (its runtime, or Cloud): `to` is "cloud" or
   * the computer id of one of the person's Macs (never a Cloud computer's id or name), `waiting_turn` that the move
   * is asked and waits for the chat's turn to end, `since` when it was asked. Gone once the chat landed or the move
   * ended.
   */
  readonly moving?: { readonly to: string; readonly waiting_turn: boolean; readonly since: string };
  readonly person: PersonState;
  readonly calls: ReadonlyArray<CallState>;
  readonly seq: number;
}

export interface RuntimeState {
  readonly runtime_id: string;
  readonly computer_id: string;
  readonly kind: WhereKind;
  readonly name: string;
  /** Heartbeat within 75 s and its relay link up. */
  readonly online: boolean;
  /**
   * A Cloud computer's state. The list names a Cloud computer's runtime only while it is `running` or `starting`; a
   * stream event that says `suspended`, `stopped` or `deleted` means that computer has no runtime now.
   */
  readonly computer_state?: "running" | "starting" | "suspended" | "stopped" | "deleted";
  /**
   * When Cloud last heard from it; null until its first heartbeat (a Mac's link runs only once sync or Remote control is
   * on, so a Mac signed in during the first run stays null until then). Compare with heardAt (chats-view.ts).
   */
  readonly last_seen_at: string | null;
  readonly image_current?: boolean;
  /** Its change number: when it last came on line or went off it. */
  readonly seq?: number;
}

export interface ChatList {
  readonly chats: ReadonlyArray<ChatSummary>;
  readonly runtimes: ReadonlyArray<RuntimeState>;
  readonly seq: number;
  /** What the install says about the direct path to laptops (S14); absent from a Cloud that says nothing. */
  readonly direct?: DirectAdvert;
}

/**
 * The install's word on direct channels to laptops (Helm): `enabled` false keeps every device on the relay;
 * `stun_servers` (`stun:host:port`) are the STUN servers devices and laptops use, [] for none (the same network only).
 */
export interface DirectAdvert {
  readonly enabled: boolean;
  readonly stun_servers: ReadonlyArray<string>;
}

/** PUT /code/chats/{id}/state: the person's own marks on a chat. */
export interface PersonStatePatch {
  readonly seen_cursor?: number;
  readonly pinned?: boolean;
  readonly done?: boolean;
  readonly snoozed_until?: string | null;
}

/** GET /code/chats/{id}/events: a page of Cloud's copy of a chat's journal. */
export interface CopyPage {
  readonly epoch: number;
  /** The copy's last cursor. */
  readonly through: number;
  readonly events: ReadonlyArray<{ readonly cursor: number; readonly type: string; readonly at: string; readonly event: unknown }>;
  readonly more: boolean;
  /** The copy is on another epoch than the one asked for: drop what you hold and read from 0. */
  readonly reset?: boolean;
}

/** cloud.client_token's answer (desktop): a short-lived bearer for the relay and /code/chats, never the refresh token. */
export interface ClientToken {
  readonly token: string;
  readonly expires_at: string;
  readonly api_url: string;
  readonly relay_url: string;
}
