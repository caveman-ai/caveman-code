// Moves (Caveman Cloud the spec): a followed chat's copy in Caveman Cloud and
// its moves between computers, with the runtime's own token. After each turn
// the chat's bundle goes up as one journal segment, under the journal lease,
// holding only what is new since the last one: the events, the latest record,
// the Caveman engine's head run (its conversation as what it adds to the one
// already sent) and the work in progress as a git bundle of the objects the
// last segments and origin lack. Segments are append-only; the computer it
// moves to reads them all, in order, and rebuilds the chat as the same session.
// The work in progress travels only there, sealed, never to GitHub. A Claude Agent or Codex chat carries its CLI's
// own session file instead of a run journal (nativeSessions.ts), and resumes it natively where it lands.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { SEGMENT_MAX_BYTES, type Session, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";

import type { BlobRef } from "./blobs.ts";
import type { ToolIntent } from "./toolIntents.ts";
import { CALL_TIMEOUT_MS, withRuntimeToken } from "./computers.ts";
import { decodeSegment, type CarriedReceipt } from "./copySegments.ts";
import { isEngineKeyName, engineKeyName, type KeyedEngine } from "./engineKeys.ts";
import { CloudError, cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { mergeNative, type NativeCopy } from "./nativeSessions.ts";

/** Cloud's journal index for a session (Caveman Cloud API). */
export interface JournalIndex {
  readonly session_id: string;
  /** The journal's epoch (CONTRACT §1): a move bumps it. Absent from a Cloud from before 2026-10-21. */
  readonly epoch?: number;
  readonly cursor_seq: number;
  readonly segments: number;
  readonly size_bytes: number;
  readonly lease_runtime_id: string | null;
  readonly lease_expires_at: string | null;
}

export interface Moved {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly computer_id: string;
  readonly runtime_id: string | null;
  readonly pending: boolean;
}

/**
 * A move's mail, from Cloud (mailbox channel "move"): `accept` asks this computer whether it can take the chat now
 * (two-phase moves: answered with answerMove before the source parks), `adopt` hands it the chat, `move` asks its
 * owner to let it go.
 */
export interface MoveMail {
  readonly action: "accept" | "adopt" | "move";
  /** Two-phase moves: the move this mail belongs to (answerMove). */
  readonly move_id?: string;
  /** An adopt that sends the chat back to the computer it left, because the target could not adopt it (and why). */
  readonly failed?: { readonly code?: string; readonly message?: string };
  readonly session_id: string;
  /** The chat's title (accept mail), for where it would go on the target. */
  readonly title?: string;
  /** The chat's engine (accept mail): a Mac takes a Claude Agent or Codex chat only where that engine is signed in. */
  readonly engine?: string;
  /** The chat's repository on GitHub, owner/name (accept mail): a Mac takes a chat it has no worktree for only into a checkout it already has. */
  readonly repo?: string;
  /** "returned": handed back to the computer it left after its adopt failed there; "reassigned": to another Cloud computer. */
  readonly reason: "lid" | "user" | "asleep" | "returned" | "reassigned";
  readonly to_runtime_id?: string;
  readonly from_runtime_id?: string;
  /** What the computer of `from_runtime_id` is (adopt mail; an older Cloud names none): only a Mac is where a chat came from. */
  readonly from_kind?: "laptop" | "cloud";
  readonly to_cloud?: boolean;
  readonly to_computer_id?: string;
  /** A person's move (Cloud's person route): who asked, the request id and `to` as they sent them, and the device's signature over them. */
  readonly user_id?: string;
  readonly request_id?: string;
  readonly to?: "cloud" | { readonly computer_id: string };
  readonly device?: { readonly device_id: string; readonly at: string; readonly signature: string };
  /** Continue on This Mac (decision 32): the same device's signed stop of the chat's running turn here (signStop). */
  readonly stop?: MoveStop;
}

/** A device's signed stop of a chat's running turn for one move, carried with a pull (devices.ts signStop): its request id and signature. */
export interface MoveStop {
  readonly request_id: string;
  readonly device: { readonly device_id: string; readonly at: string; readonly signature: string };
}

/**
 * Where a chat adopted here came from, for Continue on This Mac and Back to <Mac>: the runtime it left when that is a
 * Mac's; a chat a Cloud computer hands on keeps the Mac its copy names (`carried`), so the way back never names a Cloud
 * computer (audit C2). An adopt from an older Cloud, which names no kind, takes the runtime it left, as before.
 */
export function movedFromAfter(carried: string | undefined, mail: Pick<MoveMail, "from_runtime_id" | "from_kind">): string | undefined {
  if (mail.from_runtime_id === undefined || mail.from_kind === "cloud") return carried;
  return mail.from_runtime_id;
}

/** One segment: what changed since the last one, and the latest of everything else. */
export interface MoveBundle {
  /** Its format: 1 (this shape) or 2 (copySegments.ts encodeSegment); a reader refuses one it does not know. */
  readonly v: 1 | 2;
  /** The protocol revision of the runtime that wrote it (absent before runtimes said: 0); a reader refuses a newer one. */
  readonly revision?: number;
  /** That runtime's build, for the refusal's words. */
  readonly runtime_version?: string;
  /** The runtime it was copied from. */
  readonly runtime_id: string;
  /** Its events come after this cursor. */
  readonly after: number;
  /** The chat's repository on GitHub (owner/name). */
  readonly repo: string;
  readonly record: {
    readonly workspace: Workspace;
    readonly session: Session;
    /** Runtime-only facts that travel; paths never do (the target re-keys them). */
    readonly internal: { readonly threadId: string; readonly goal?: { readonly objective: string; readonly native: boolean } };
  };
  readonly events: ReadonlyArray<SessionEvent>;
  /** What the person typed for messages the engine got with more (caveman_sp_display_text). */
  readonly display: ReadonlyArray<{ readonly message_id: string; readonly text: string }>;
  /**
   * The Caveman engine's conversation: its native thread and the head run's journal, which checkpoints all of it.
   * null when the head run is as the last segment had it. Its conversation checkpoints travel packed
   * (packJournal): each says only what it adds to the one before it, the last segments' included.
   */
  readonly engine: {
    readonly native_thread_id: string;
    readonly head_run_id: string | null;
    readonly journal: ReadonlyArray<string>;
    readonly model: string;
    readonly runtime_mode: string;
    readonly interaction_mode: string;
    /**
     * Claude Agent and Codex: the CLI's own session file, as what this segment adds to the ones before it (merged
     * whole by mergeBundles). Absent for the Caveman engine, and for a chat whose session file could not be read:
     * that chat hands over its context where it lands.
     */
    readonly native?: NativeCopy;
    /** The session file stopped travelling (it grew past what a segment holds): the parts before this one are stale. */
    readonly native_dropped?: true;
    /** Merged copies only: the segments carry parts of a session file that do not make it whole; the chat hands over its context. */
    readonly native_incomplete?: true;
    /**
     * Claude Agent and Codex: the session file heard the conversation only through this cursor (turns after it ran on
     * another computer, K15). Where it resumes, its next message tells it the rest.
     */
    readonly heard?: number;
  } | null;
  /** The work-in-progress commit (refs/caveman/sessions/<id>). */
  readonly wip: string | null;
  /**
   * base64 git bundle bringing `wip` to a checkout that has origin's commits and the earlier segments' bundles:
   * `<wip> --not --remotes=origin <the last segment's wip>`. Absent when `wip` is the last segment's.
   */
  readonly wip_bundle?: string;
  /** `wip_bundle` uploaded as chunks of the chat's copy instead (blobs.ts, AC-08): fetched and checked where it lands. */
  readonly wip_ref?: BlobRef;
  /**
   * A boundary whose own work in progress did not fit its segment (copySegments): `wip` is the last one the copy
   * carried, older than the chat's. Merged copies: the last boundary's word. No computer continues a chat from it.
   */
  readonly wip_dropped?: true;
  /**
   * A running turn's segment that carried its work in progress (decision 25): the cursor it was taken at (its
   * `through`). A boundary's is its own `through`; merged copies: the last segment that carried one.
   */
  readonly wip_at?: number;
  /**
   * A Cloud computer's turn checkpoints journaled since the last boundary that carried any (checkpoint.created's `ref`):
   * each ref's commit, and a base64 git bundle of the commits a checkout with `wip` and the earlier segments lacks
   * (absent when it lacks none). A Cloud computer rebuilt from the copy sets the refs again, so a turn that ended before
   * the rebuild can still be restored to; a runtime from before them ignores the field.
   */
  readonly checkpoints?: CarriedCheckpoints;
  /** The move stopped a turn mid-way: the target carries on with it. */
  readonly interrupted?: true;
  /** The follow-ups the person queued behind the turn as the last copy was made, in order; they run where the chat lands. */
  readonly queued?: ReadonlyArray<string>;
  /**
   * `queued` as the target queues it again: each message's kind and, for an agent's, who wrote it (a copy from before
   * these has `queued` alone: follow-ups, the person's).
   */
  readonly queued_items?: ReadonlyArray<CarriedQueued>;
  /** The person's message a turn was running when this was copied: runs again where the chat lands, should this computer vanish mid-turn. */
  readonly pending?: string;
  /** Queued calls it answered lately (copySegments.ts CarriedReceipt): answered again where it lands, never run twice. */
  readonly receipts?: ReadonlyArray<CarriedReceipt>;
  /** Asks it sent a chat on another of the person's Macs and has no answer to yet: their answers find it where it lands. */
  readonly mac_asks?: ReadonlyArray<CarriedAsk>;
  /** Mail from the person's other Macs it ran or acted on lately: where it lands, Cloud handing one again runs nothing. */
  readonly mac_seen?: ReadonlyArray<CarriedSeen>;
  /**
   * A copy from a Cloud computer: the secret-shaped files git does not ignore that are new there and stayed (decision
   * 24), as its last work in progress found them; where the chat lands it says so, since that computer and its disk
   * go once the chat has settled (A-5). This Mac's copies never name its own.
   */
  readonly left?: ReadonlyArray<string>;
  /**
   * The steps that were about to run, or ran, and whose result the copy does not hold (toolIntents.ts, R11): where
   * the chat lands, the engine is told each may or may not have finished. A copy from before them has none.
   */
  readonly intents?: ReadonlyArray<ToolIntent>;
}

/**
 * A message waiting in a chat's queue, as a move carries it. `followup`: sent to go next, behind the follow-ups ahead
 * of it (a later follow-up goes behind it too); `queue`: queued for later, behind everything. `from`: an agent wrote it
 * (another chat's, a builder's), named so; never the person's words where it lands. `request_id`: an agent's message
 * owed to the chat, not yet in its queue (session-protocol handlers owe): it is queued where the chat lands under this
 * id, so it runs once there, and the computer it left knows by this id which of those its copy carried.
 */
export interface CarriedQueued {
  readonly text: string;
  readonly kind: "followup" | "queue";
  readonly from?: string;
  readonly request_id?: string;
}

/** Turn checkpoints as a copy carries them: ref name to commit, and the bundle that brings the commits. */
export interface CarriedCheckpoints {
  readonly refs: Readonly<Record<string, string>>;
  readonly bundle?: string;
}

/** An ask a chat sent and has no answer to yet, as its copy carries it (session-protocol/macMail.ts caveman_sp_mac_mail_sent). */
export interface CarriedAsk {
  readonly message_id: string;
  readonly to_workspace_id: string;
  readonly at: number;
}

/** Mail a chat ran or acted on, as its copy carries it (session-protocol/macMail.ts caveman_sp_mac_mail_seen): by its signer and id. */
export interface CarriedSeen {
  readonly signer: string;
  readonly message_id: string;
  readonly at: number;
}

/** The receipt a device's signed move leaves once a Mac acted on it: no protocol method, so never a call's receipt. */
export const SIGNED_MOVE = "moves.signed";
/** The receipt a device's signed stop of a running turn (a pull's, decision 32) leaves once a Mac acted on it. */
export const SIGNED_STOP = "session.stop";
/** Receipts of a device's signed word (a move, a pull's stop): never a call's, never answered again. */
export const signedReceipt = (method: string) => method === SIGNED_MOVE || method === SIGNED_STOP;
/** The signed receipts a chat's copy carries at most (beside CARRIED_RECEIPTS of calls). */
export const CARRIED_SIGNED = 20;
/**
 * The calls a chat's copy says it answered where it was, still in date: answered again where it lands, never run twice
 * (M-8). Never a signed move's or stop's receipt: those are taken as spent where it lands (carriedSigned), never as
 * answers, and never shortening the landing Mac's own record.
 */
export const carriedReceipts = (receipts: ReadonlyArray<CarriedReceipt> | undefined, now: number) => (receipts ?? []).filter((r) => r.expires_at > now && !signedReceipt(r.method));
/**
 * The devices' signed moves and stops a chat's earlier computers acted on or asked with, as its copy carries them, still
 * in date (m-11): every Mac it lands on takes them as spent, so Cloud can never pass one again to a Mac that never saw
 * it within its day. Deduplicated, the latest copy of each last, at most CARRIED_SIGNED.
 */
export const carriedSigned = (receipts: ReadonlyArray<CarriedReceipt> | undefined, now: number): ReadonlyArray<CarriedReceipt> => {
  const kept = new Map<string, CarriedReceipt>();
  for (const r of receipts ?? []) {
    if (!signedReceipt(r.method) || r.expires_at <= now || typeof r.principal !== "string" || typeof r.request_id !== "string") continue;
    const key = `${r.principal}\n${r.method}\n${r.request_id}`;
    const was = kept.get(key);
    kept.delete(key);
    kept.set(key, was !== undefined && was.expires_at > r.expires_at ? was : r);
  }
  return [...kept.values()].slice(-CARRIED_SIGNED);
};

export const encodeBundle = (bundle: MoveBundle) => gzipSync(JSON.stringify(bundle));
/** A segment as Cloud hands it back: v1 (this shape, gzipped) or v2 (copySegments.ts: events with their position, gzipped or not). */
export const decodeBundle = (raw: Uint8Array): MoveBundle => decodeSegment(raw);

/**
 * Segments 0..n-1 as one bundle: every event once, in cursor order, the last segment's everything else, the engine
 * unpacked, and every WIP bundle in order (base64 as the segments carry them; placeRefs adds the chunked ones as
 * bytes). `wip_at`: the cursor its work in progress was taken at (the last turn boundary's, or a running turn's
 * segment that carried its own, decision 25), absent for a copy from before segments said.
 */
export function mergeBundles(
  segments: ReadonlyArray<MoveBundle & { readonly through?: number; readonly boundary?: boolean }>,
): MoveBundle & {
  readonly wip_bundles: ReadonlyArray<string | Buffer>;
  readonly wip_refs?: ReadonlyArray<{ readonly at: number; readonly ref: BlobRef }>;
  /** Every segment's checkpoint bundle, in order (they build on the work in progress before them). */
  readonly checkpoint_bundles: ReadonlyArray<string>;
} {
  const last = segments.at(-1);
  if (last === undefined) throw new Error("no segments to merge");
  const events = new Map<number, SessionEvent>();
  const display = new Map<string, string>();
  const bundles: Array<string> = [];
  // Bundles a segment named by ref (AC-08): where each goes among the inline ones, fetched before they apply.
  const refs: Array<{ readonly at: number; readonly ref: BlobRef }> = [];
  // A copy made before the running turn's engine run had journaled its start carries none: the last one that did stands.
  let engine: MoveBundle["engine"] = null;
  let known: ReadonlyArray<unknown> = [];
  // Claude Agent's or Codex's session file, a part per segment that changed it.
  const natives: Array<NativeCopy> = [];
  let wipAt: number | undefined;
  let wipDropped = false;
  // Turn checkpoints, a part per boundary that journaled any: a ref named again takes its later commit.
  const checkpointRefs: Record<string, string> = {};
  const checkpointBundles: Array<string> = [];
  for (const segment of segments) {
    if (segment.checkpoints !== undefined) {
      Object.assign(checkpointRefs, segment.checkpoints.refs);
      if (segment.checkpoints.bundle) checkpointBundles.push(segment.checkpoints.bundle);
    }
    if (segment.boundary === true && segment.through !== undefined) wipAt = segment.through;
    else if (segment.wip_at !== undefined) wipAt = segment.wip_at;
    if (segment.boundary === true) wipDropped = segment.wip_dropped === true;
    for (const event of segment.events) events.set(event.cursor, event);
    for (const row of segment.display) display.set(row.message_id, row.text);
    if (segment.wip_bundle) bundles.push(segment.wip_bundle);
    if (segment.wip_ref) refs.push({ at: bundles.length + refs.length, ref: segment.wip_ref });
    if (segment.engine === null) continue;
    const unpacked = unpackJournal(segment.engine.journal, known);
    known = unpacked.known;
    if (segment.engine.native_dropped) natives.length = 0;
    if (segment.engine.native) natives.push(segment.engine.native);
    const { native: _native, native_dropped: _dropped, ...rest } = segment.engine;
    engine = { ...rest, journal: unpacked.journal };
  }
  const native = mergeNative(natives);
  if (engine !== null && native !== undefined) engine = { ...engine, native };
  else if (engine !== null && natives.length > 0) engine = { ...engine, native_incomplete: true };
  const ordered = [...events.values()].sort((a, b) => a.cursor - b.cursor);
  ordered.forEach((event, i) => {
    if (event.cursor !== i + 1) throw new Error(`the copy is missing event ${i + 1}`);
  });
  const { wip_bundle: _bundle, wip_ref: _ref, through: _through, boundary: _boundary, wip_dropped: _dropped, wip_at: _at, checkpoints: _checkpoints, ...rest } = last;
  return {
    ...rest,
    after: 0,
    checkpoint_bundles: checkpointBundles,
    ...(Object.keys(checkpointRefs).length > 0 ? { checkpoints: { refs: checkpointRefs } } : {}),
    events: ordered,
    display: [...display].map(([message_id, text]) => ({ message_id, text })),
    engine,
    wip_bundles: bundles,
    ...(refs.length > 0 ? { wip_refs: refs } : {}),
    ...(wipAt !== undefined ? { wip_at: wipAt } : {}),
    ...(wipDropped ? { wip_dropped: true as const } : {}),
  };
}

/** A merged copy's bundles in segment order: its inline ones with `fetched` (bytes, one per ref) where its refs stood. */
export function placeRefs(bundle: ReturnType<typeof mergeBundles>, fetched: ReadonlyArray<Buffer>): ReturnType<typeof mergeBundles> {
  const refs = bundle.wip_refs ?? [];
  if (refs.length === 0) return bundle;
  const ordered: Array<string | Buffer> = [];
  let inline = 0;
  for (let at = 0; at < bundle.wip_bundles.length + refs.length; at++) {
    const ref = refs.findIndex((r) => r.at === at);
    ordered.push(ref >= 0 ? fetched[ref]! : bundle.wip_bundles[inline++]!);
  }
  const { wip_refs: _refs, ...rest } = bundle;
  return { ...rest, wip_bundles: ordered };
}

// ------------------------------------------------------- the engine's conversation, packed

/** A journal line's conversation checkpoint ({sessionId, messagesSha256, messages}), when it has one. */
const conversationOf = (line: Record<string, unknown>) => {
  const conversation = line.conversation;
  return conversation !== null && typeof conversation === "object" && Array.isArray((conversation as { messages?: unknown }).messages)
    ? (conversation as { messages: ReadonlyArray<unknown> } & Record<string, unknown>)
    : undefined;
};

const parsed = (line: string) => {
  try {
    const value = JSON.parse(line) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A message's identity for packing: 64 bits of its JSON's sha256. */
const messageHash = (message: unknown) => createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 16);

/**
 * The head run's journal lines with each conversation checkpoint as what it adds to the one before it (`known`: the
 * hashes of the last checkpoint already sent): `messages` becomes `messages_from` (how many it keeps) and
 * `messages_tail`. Answers the lines and the hashes of the last checkpoint in them.
 */
export function packJournal(lines: ReadonlyArray<string>, known: ReadonlyArray<string>) {
  let prior = known;
  const journal = lines.map((line) => {
    const event = parsed(line);
    const conversation = event && conversationOf(event);
    if (!event || !conversation) return line;
    const hashes = conversation.messages.map(messageHash);
    let from = 0;
    while (from < hashes.length && from < prior.length && hashes[from] === prior[from]) from++;
    prior = hashes;
    const { messages, ...kept } = conversation;
    return JSON.stringify({ ...event, conversation: { ...kept, messages_from: from, messages_tail: messages.slice(from) } });
  });
  return { journal, known: prior };
}

/** packJournal undone, given the last checkpoint's messages the earlier segments carried. */
export function unpackJournal(lines: ReadonlyArray<string>, known: ReadonlyArray<unknown>) {
  let prior = known;
  const journal = lines.map((line) => {
    const event = parsed(line);
    const packed = event?.conversation as { messages_from?: unknown; messages_tail?: unknown } | undefined;
    if (!event || packed === null || typeof packed !== "object" || typeof packed.messages_from !== "number" || !Array.isArray(packed.messages_tail)) return line;
    if (packed.messages_from > prior.length) throw new Error("the copy is missing part of the engine's conversation");
    const { messages_from: from, messages_tail: tail, ...kept } = packed as { messages_from: number; messages_tail: Array<unknown> } & Record<string, unknown>;
    const messages = [...prior.slice(0, from), ...tail];
    prior = messages;
    return JSON.stringify({ ...event, conversation: { ...kept, messages } });
  });
  return { journal, known: prior };
}

/** The hashes of the last conversation checkpoint in unpacked `lines` (what a copy made from here packs against). */
export function journalKnown(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  for (const line of [...lines].reverse()) {
    const event = parsed(line);
    const conversation = event && conversationOf(event);
    if (conversation) return conversation.messages.map(messageHash);
  }
  return [];
}

/**
 * How long a call on a chat's journal may take (its lease, its index): a Cloud that takes calls and answers none (its
 * database paused, a network that drops packets) must not hold a chat's lease, its move lock or the moves pass past it.
 */
export const JOURNAL_CALL_MS = 20_000;
/** A segment's call: JOURNAL_CALL_MS, and a second more for every 256 KiB it carries (a full one on a slow uplink). */
export const segmentCallMs = (bytes: number) => JOURNAL_CALL_MS + Math.ceil(bytes / (256 * 1024)) * 1_000;

interface CallInit {
  readonly json?: unknown;
  readonly body?: Uint8Array;
  readonly headers?: Record<string, string>;
  /** Gives up after this long, headers and body (each send its own, a token refreshed on 401 included). */
  readonly timeoutMs?: number;
  /** Gives up once this aborts too (the lid stopping a copy that holds the chat's move lock). */
  readonly signal?: AbortSignal;
}

/** One call with the runtime's token to `path` under /api/v1/code/, answered as Cloud answered it (a refusal too). */
export async function rawCall(identity: Identity, state: LinkState, method: string, path: string, init: CallInit = {}, fetchImpl: typeof fetch = fetch) {
  const send = (token: string) =>
    fetchImpl(`${identity.cloudUrl}/api/v1/code/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { "content-type": "application/json", accept: "application/json" } : {}),
        ...(init.body !== undefined ? { "content-type": "application/octet-stream" } : {}),
        ...init.headers,
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
      ...(init.timeoutMs !== undefined || init.signal !== undefined
        ? { signal: AbortSignal.any([...(init.timeoutMs !== undefined ? [AbortSignal.timeout(init.timeoutMs)] : []), ...(init.signal !== undefined ? [init.signal] : [])]) }
        : {}),
    });
  return withRuntimeToken(identity, state, fetchImpl, send);
}

/** rawCall, a refusal thrown as Cloud's status and sentence. */
async function request(identity: Identity, state: LinkState, method: string, path: string, init: CallInit = {}, fetchImpl: typeof fetch = fetch) {
  const response = await rawCall(identity, state, method, path, init, fetchImpl);
  if (!response.ok) throw await cloudFailure(response);
  return response;
}

const json = async <T>(response: Response) => (response.status === 204 ? undefined : ((await response.json()) as T)) as T;

const session = (id: string) => `runtime/sessions/${encodeURIComponent(id)}`;

/**
 * Registers a chat this runtime follows (or stops following), in a workspace of its own on this computer. On a Cloud
 * computer `placed_workspace_id` names the workspace Cloud placed for the chat, which the registration takes up, or ""
 * when nobody placed it (it then needs a free place: 409 cave_code_computer_full); absent, Cloud takes the oldest
 * placement of the chat's repository, as before the field (CONTRACT §6.3).
 */
export const registerSession = (
  identity: Identity,
  state: LinkState,
  sessionId: string,
  input: { title: string; repo: string; base_branch: string; branch: string; engine: string; follow: boolean; placed_workspace_id?: string },
  fetchImpl?: typeof fetch,
) => request(identity, state, "PUT", session(sessionId), { json: input, timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then((r) => json<{ workspace_id: string; follow: boolean; journal?: JournalIndex }>(r));

export const getJournal = (identity: Identity, state: LinkState, sessionId: string, fetchImpl?: typeof fetch) =>
  request(identity, state, "GET", `${session(sessionId)}/journal`, { timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then((r) => json<JournalIndex>(r));

/** Takes (no token) or keeps (its token) the journal lease while recording how far the copy stands. */
export const putJournal = (
  identity: Identity,
  state: LinkState,
  sessionId: string,
  input: { lease_token?: string; cursor_seq: number; segments: number; size_bytes: number; release?: boolean },
  fetchImpl?: typeof fetch,
) => request(identity, state, "PUT", `${session(sessionId)}/journal`, { json: input, timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then((r) => json<JournalIndex & { lease_token: string | null }>(r));

export const putSegment = (identity: Identity, state: LinkState, sessionId: string, n: number, lease: string, body: Uint8Array, fetchImpl?: typeof fetch, signal?: AbortSignal) =>
  request(identity, state, "PUT", `${session(sessionId)}/journal/segments/${n}`, { body, headers: { "x-caveman-lease": lease }, timeoutMs: segmentCallMs(body.length), ...(signal !== undefined ? { signal } : {}) }, fetchImpl).then(() => undefined);

export const getSegment = (identity: Identity, state: LinkState, sessionId: string, n: number, fetchImpl?: typeof fetch) =>
  request(identity, state, "GET", `${session(sessionId)}/journal/segments/${n}`, { timeoutMs: segmentCallMs(SEGMENT_MAX_BYTES) }, fetchImpl).then(async (r) => new Uint8Array(await r.arrayBuffer()));

/** Where a move sends a chat, as Cloud names it: a Cloud computer (its own, or a new one), a runtime, or a computer by id. */
export type MoveTo = "cloud" | { readonly runtime_id: string } | { readonly computer_id: string };

/** What a device signed for a move it asked for (signMove), passed on so the target can check it. */
export interface MoveAsked {
  readonly request_id: string;
  readonly device?: { readonly device_id: string; readonly at: string; readonly signature: string };
}

export const moveSession = (
  identity: Identity,
  state: LinkState,
  sessionId: string,
  input: { to: MoveTo; reason: "lid" | "user"; move_id?: string } & Partial<MoveAsked>,
  fetchImpl?: typeof fetch,
) => request(identity, state, "POST", `${session(sessionId)}/move`, { json: input }, fetchImpl).then((r) => json<Moved>(r));

/**
 * This Mac's own screen asks for one of its person's chats on another of their computers (Continue on This Mac, for a
 * chat it may never have had): `to` is this Mac's own computer, and `request_id` and `device` are its desktop key's
 * signature over exactly that move, which the chat's Mac checks before it lets the chat go. Cloud passes it on.
 */
export const pullChat = (
  identity: Identity,
  state: LinkState,
  sessionId: string,
  input: { readonly to: { readonly computer_id: string }; readonly request_id: string; readonly device: NonNullable<MoveAsked["device"]>; readonly stop?: MoveStop | undefined },
  fetchImpl?: typeof fetch,
) =>
  request(identity, state, "POST", `runtime/chats/${encodeURIComponent(sessionId)}/pull`, { json: input }, fetchImpl).then((r) =>
    json<{ readonly pending: boolean; readonly computer_id: string; readonly workspace_id?: string; readonly engine?: string }>(r),
  );

/** This computer's answer to a two-phase move: whether it can take the chat (`accept`), and whether it took it (`adopt`). */
export const answerMove = (
  identity: Identity,
  state: LinkState,
  moveId: string,
  input: { phase: "accept" | "adopt"; ok: boolean; code?: string; message?: string },
  fetchImpl?: typeof fetch,
) =>
  // Within what Cloud takes (code 100, message 500 characters): a long git error never turns the answer away.
  request(
    identity,
    state,
    "POST",
    `runtime/moves/${encodeURIComponent(moveId)}`,
    { json: { ...input, ...(input.code !== undefined ? { code: input.code.slice(0, 100) } : {}), ...(input.message !== undefined ? { message: input.message.slice(0, 500) } : {}) } },
    fetchImpl,
  ).then(() => undefined);

/**
 * Which login pays for a Claude Agent or Codex chat where it would land: a key in Cloud's vault, a sign-in made on that
 * computer, or a sign-in that follows the person to all their Cloud computers (Caveman Cloud the spec).
 */
export type TargetLogin = "vault_key" | "computer_sign_in" | "followed_sign_in";

/**
 * Whether Cloud would move the chat to `to`, asked before anything parks: its refusal (no login for the engine there,
 * no Cloud computers, a limit, the target's own refusal) as a CloudError, else which login would pay there. A move
 * about to happen is offered (two-phase moves): Cloud asks the target to accept it and answers its `move_id` once it
 * did, and the move commits to that target, a Cloud computer or one of the person's Macs (`to_kind` "laptop"). `offer:
 * false` only asks (the Move to menu): nothing is offered or held.
 * undefined from a Cloud without the check, or without the no-offer ask: the move itself then says.
 */
export const checkMove = (identity: Identity, state: LinkState, sessionId: string, to: MoveTo, options: { reason?: "lid" | "user"; offer?: false } & Partial<MoveAsked> = {}, fetchImpl?: typeof fetch) =>
  request(identity, state, "POST", `${session(sessionId)}/move-check`, { json: { to, ...options } }, fetchImpl).then(
    (r) => json<{ login?: TargetLogin | null; move_id?: string; computer_id?: string | null; to_kind?: "cloud" | "laptop" }>(r),
    (error: unknown) =>
      error instanceof CloudError && (error.status === 404 || error.status === 405 || (options.offer === false && error.status === 400 && error.code === "cave_bad_request"))
        ? undefined
        : Promise.reject(error),
  );

/** For each engine that runs on the person's own login: whether Cloud holds a key for it, and the computers signed in to it. */
export type EngineLogins = Partial<Record<KeyedEngine, { readonly vault_key: boolean; readonly signed_in_on: ReadonlyArray<string> }>>;

/**
 * The Cloud logins this runtime's person has for Claude Agent and Codex (Cloud's holdings: names only, never a value).
 * A Cloud from before `engine_logins` answers with its vault keys alone. undefined when Cloud can't be asked, or does
 * not answer within CALL_TIMEOUT_MS.
 */
export async function engineLogins(identity: Identity, state: LinkState, fetchImpl: typeof fetch = fetch): Promise<EngineLogins | undefined> {
  const timed: typeof fetch = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const held = await request(identity, state, "GET", "runtime/holdings", {}, timed)
    .then((r) => json<{ engine_logins?: EngineLogins; server_keys?: { names?: ReadonlyArray<string> } | null }>(r))
    .catch(() => undefined);
  if (held === undefined) return undefined;
  if (held.engine_logins) return held.engine_logins;
  const names = (held.server_keys?.names ?? []).filter(isEngineKeyName);
  const engines: ReadonlyArray<KeyedEngine> = ["claude-agent", "codex"];
  return Object.fromEntries(engines.map((engine) => [engine, { vault_key: names.includes(engineKeyName(engine)), signed_in_on: [] }]));
}

/** Whether `engine` has a Cloud login to run on (any engine but Claude Agent and Codex needs none of the person's). */
export const hasCloudLogin = (logins: EngineLogins | undefined, engine: string) =>
  engine !== "claude-agent" && engine !== "codex" ? true : logins?.[engine]?.vault_key === true || (logins?.[engine]?.signed_in_on.length ?? 0) > 0;

/** A chat this runtime's lid sent to a Cloud computer, as Cloud lists it for its return (`idle`: no turn or call there, so it may come back now). */
export interface Return {
  readonly session_id: string;
  readonly computer_id: string;
  readonly moved_at: string;
  readonly idle: boolean;
}

/** The chats that come back to this runtime once it is awake (GET runtime/returns); undefined from a Cloud without the route. */
export const listReturns = (identity: Identity, state: LinkState, fetchImpl?: typeof fetch) =>
  request(identity, state, "GET", "runtime/returns", { timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then(
    (r) => json<{ chats: ReadonlyArray<Return> }>(r).then((out) => out.chats),
    (error: unknown) => (error instanceof CloudError && (error.status === 404 || error.status === 405) ? undefined : Promise.reject(error)),
  );

/** A chat Cloud has placed on this computer, with how far its copy stands (CONTRACT §5.2 of cloud-computers-2026-11-09). */
export interface SessionHere {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly repo: string;
  readonly base_branch: string;
  readonly branch: string;
  readonly engine: string;
  readonly epoch: number;
  readonly journal: { readonly cursor_seq: number; readonly segments: number; readonly size_bytes: number };
  /** The other repositories of its project the chat works in (CONTRACT §7); absent for a chat in one. */
  readonly checkouts?: ReadonlyArray<{ readonly repo: string; readonly base_branch: string; readonly branch: string }>;
}

/**
 * The chats that live on this Cloud computer, as Cloud has them (GET runtime/sessions?here=true): what a runtime that
 * came up on an empty or older disk adopts from their copies. undefined from a Cloud without the list (it answers 404,
 * or refuses the query), or one that keeps it from this caller (403: not a hosted runtime): this computer then knows
 * only the chats on its own disk, as before.
 */
export const sessionsHere = (identity: Identity, state: LinkState, fetchImpl?: typeof fetch) =>
  request(identity, state, "GET", "runtime/sessions?here=true", { timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then(
    (r) => json<{ sessions?: ReadonlyArray<SessionHere> }>(r).then((out) => out.sessions ?? []),
    (error: unknown) => (error instanceof CloudError && [400, 403, 404, 405].includes(error.status) ? undefined : Promise.reject(error)),
  );

/** Move mail for workspaces on this computer, leased for delivery: only channel "move" is taken, so other mail waits for its own reader. */
export async function takeMoves(identity: Identity, state: LinkState, fetchImpl?: typeof fetch) {
  const out = await request(identity, state, "POST", "mail/deliveries?channel=move", { json: {}, timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then((r) =>
    json<{ lease_token: string | null; messages: Array<{ id: string; verb: string; channel: string; body: string }> }>(r),
  );
  const moves = out.messages.flatMap((m) => {
    if (m.verb !== "handoff" || m.channel !== "move") return [];
    try {
      return [{ id: m.id, mail: JSON.parse(m.body) as MoveMail }];
    } catch {
      return [];
    }
  });
  return { lease: out.lease_token, moves };
}

export const ackMoves = (identity: Identity, state: LinkState, lease: string, ids: ReadonlyArray<string>, fetchImpl?: typeof fetch) =>
  request(identity, state, "POST", "mail/deliveries/ack", { json: { lease_token: lease, ids }, timeoutMs: JOURNAL_CALL_MS }, fetchImpl).then(() => undefined);

/** Cloud's refusal code (cave_code_session_elsewhere: the chat lives on another computer now). */
export const refusalCode = (error: unknown) => (error instanceof CloudError ? error.code : undefined);
