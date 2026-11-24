// Cloud's copy of a chat (Caveman Cloud the spec, CONTRACT §2): the journal range a copy owes Cloud, cut into
// segments that each fit Cloud's cap. Events go in order, as many to a segment as fit; an event too big to copy whole
// goes with its longest text cut and `copy_truncated: true` (this runtime keeps it whole). Only the last segment of a
// turn boundary carries the engine's conversation and the work in progress, as the moves copy always did; a boundary
// too big for one segment sends its events ahead of it, and if even that is too big, the work in progress stays out of
// the copy, which says so (`wip_dropped`): the chat still reads everywhere, and no computer continues it from an older
// work in progress until a later copy carries the new one (F-5).
import { gunzipSync, gzipSync } from "node:zlib";

import { EVENT_COPY_MAX_BYTES, PROTOCOL_REVISION, SEGMENT_MAX_BYTES, SEGMENT_MAX_DECOMPRESSED_BYTES, type SessionEvent } from "@caveman-app/session-protocol";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import type { BlobRef } from "./blobs.ts";
import type { CarriedAsk, CarriedCheckpoints, CarriedQueued, CarriedSeen, MoveBundle } from "./moves.ts";
import type { ToolIntent } from "./toolIntents.ts";

/** The segment formats this runtime reads: v1 (events whole) and v2 (events with their position), which it writes. */
const SEGMENT_FORMATS: ReadonlySet<unknown> = new Set([1, 2]);

/** Events JSON one segment is planned with before it is gzipped; a segment whose gzip still overruns Cloud's cap is halved. */
export const SEGMENT_EVENTS_BUDGET = 6 * 1024 * 1024;

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** A segment's head: what every segment carries beside its events (MoveBundle's keys, plus the range and epoch). */
export interface SegmentHead {
  readonly runtime_id: string;
  readonly repo: string;
  readonly record: MoveBundle["record"];
  readonly epoch: number;
  readonly pending?: string;
  readonly interrupted?: true;
  /** Queued calls this chat answered lately (M-8): the computer that adopts it answers them again without running them. */
  readonly receipts?: ReadonlyArray<CarriedReceipt>;
  /** The follow-ups queued behind the turn as this copy was made, in order: they run where the chat lands (the last segment's). */
  readonly queued?: ReadonlyArray<string>;
  /** `queued` with each message's kind and sender (MoveBundle queued_items). */
  readonly queued_items?: ReadonlyArray<CarriedQueued>;
  /** Asks to chats on the person's other Macs it has no answer to yet: an answer finds it where it lands. */
  readonly mac_asks?: ReadonlyArray<CarriedAsk>;
  /** Mail from the person's other Macs it ran or acted on lately: never run again where it lands. */
  readonly mac_seen?: ReadonlyArray<CarriedSeen>;
  /** A Cloud computer's copy: the new secret-shaped files that stayed there (decision 24), named where it lands (A-5). */
  readonly left?: ReadonlyArray<string>;
  /** The steps about to run, or run, whose result this copy does not hold (toolIntents.ts, R11): told where it lands. */
  readonly intents?: ReadonlyArray<ToolIntent>;
}

/** A queued call's receipt as the copy carries it (caveman_sp_receipts' row). */
export interface CarriedReceipt {
  readonly principal: string;
  readonly method: string;
  readonly request_id: string;
  readonly params_hash: string;
  readonly result: unknown;
  readonly expires_at: number;
}

/** Where a chat's carried receipts are kept (caveman_sp_kv), newest last, at most CARRIED_RECEIPTS. */
export const carriedKey = (sessionId: string) => `receipts:${sessionId}`;
export const CARRIED_RECEIPTS = 20;

/** What a boundary adds to its last segment. */
export interface BoundaryParts {
  readonly engine: MoveBundle["engine"];
  readonly wip: string | null;
  readonly wip_bundle?: string;
  /** The bundle as chunks of the chat's copy, uploaded first (blobs.ts, AC-08): for one too big to ride in a segment. */
  readonly wip_ref?: BlobRef;
  /** The boundary's own work in progress did not fit: `wip` is the last one the copy carried. */
  readonly wip_dropped?: true;
  /** The turn checkpoints journaled since the last boundary that carried any (moves.ts MoveBundle.checkpoints). */
  readonly checkpoints?: CarriedCheckpoints;
}

/** One segment to write: its range and its body as sent. */
export interface PlannedSegment {
  readonly from: number;
  readonly through: number;
  readonly boundary: boolean;
  readonly body: Buffer;
  /** Events in it that were cut to fit. */
  readonly cut: number;
}

/**
 * The event with its longest strings cut until its JSON is at most `max` bytes, and `copy_truncated: true` on it; the
 * event unchanged when it fits.
 */
export function cutEvent(event: SessionEvent, max = EVENT_COPY_MAX_BYTES): SessionEvent {
  if (byteLength(event) <= max) return event;
  const copy = structuredClone(event) as unknown as Record<string, unknown>;
  copy.copy_truncated = true;
  // The longest string first, halved each time: few passes, and short fields (ids, types, cursors) are never touched.
  for (let pass = 0; pass < 64 && byteLength(copy) > max; pass++) {
    let longest: { holder: Record<string, unknown> | Array<unknown>; key: string | number; length: number } | undefined;
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach((item, i) => (typeof item === "string" ? consider(value, i, item) : walk(item)));
      else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) typeof item === "string" ? consider(value as Record<string, unknown>, key, item) : walk(item);
    };
    const consider = (holder: Record<string, unknown> | Array<unknown>, key: string | number, text: string) => {
      if (text.length > 256 && (longest === undefined || text.length > longest.length)) longest = { holder, key, length: text.length };
    };
    walk(copy);
    if (longest === undefined) break;
    const found = longest as { holder: Record<string | number, unknown>; key: string | number; length: number };
    const text = found.holder[found.key] as string;
    found.holder[found.key] = `${text.slice(0, Math.floor(text.length / 2))}\n[cut in Caveman's copy]`;
  }
  return copy as unknown as SessionEvent;
}

/**
 * A segment body as Cloud takes it: JSON, gzipped (v2: events as {cursor, type, at, event}), with the protocol revision
 * and build of the runtime that wrote it, so one that cannot read it refuses it (decodeSegment).
 */
export function encodeSegment(head: SegmentHead, events: ReadonlyArray<SessionEvent>, display: MoveBundle["display"], range: { from: number; through: number; boundary: boolean }, parts?: BoundaryParts, lastWip: string | null = null): Buffer {
  // A running turn's segment that carries its work in progress says the cursor it was taken at (a boundary's is its own).
  return gzipSync(
    JSON.stringify({
      v: 2,
      revision: PROTOCOL_REVISION,
      runtime_version: RUNTIME_VERSION,
      epoch: head.epoch,
      from: range.from,
      through: range.through,
      boundary: range.boundary,
      runtime_id: head.runtime_id,
      after: range.from - 1,
      repo: head.repo,
      record: head.record,
      events: events.map((event) => ({ cursor: event.cursor, type: event.type, at: event.at, event })),
      display,
      engine: parts?.engine ?? null,
      wip: parts ? parts.wip : lastWip,
      ...(parts?.wip_bundle ? { wip_bundle: parts.wip_bundle } : {}),
      ...(parts?.wip_ref ? { wip_ref: parts.wip_ref } : {}),
      ...(parts?.wip_dropped ? { wip_dropped: true } : {}),
      ...(parts?.checkpoints ? { checkpoints: parts.checkpoints } : {}),
      ...(parts !== undefined && !range.boundary ? { wip_at: range.through } : {}),
      ...(head.pending !== undefined ? { pending: head.pending } : {}),
      ...(head.interrupted ? { interrupted: true } : {}),
      ...(head.receipts !== undefined && head.receipts.length > 0 ? { receipts: head.receipts } : {}),
      ...(head.queued !== undefined && head.queued.length > 0 ? { queued: head.queued } : {}),
      ...(head.queued_items !== undefined && head.queued_items.length > 0 ? { queued_items: head.queued_items } : {}),
      ...(head.mac_asks !== undefined && head.mac_asks.length > 0 ? { mac_asks: head.mac_asks } : {}),
      ...(head.mac_seen !== undefined && head.mac_seen.length > 0 ? { mac_seen: head.mac_seen } : {}),
      ...(head.left !== undefined && head.left.length > 0 ? { left: head.left } : {}),
      ...(head.intents !== undefined && head.intents.length > 0 ? { intents: head.intents } : {}),
    }),
  );
}

/**
 * Whether a boundary's work in progress can ride in a segment at all. A git pack does not compress: one past the cap
 * never fits, so a boundary carrying it is never encoded (gzipped, then halved and gzipped again) to find that out.
 */
export const bundleFits = (boundary: BoundaryParts | undefined, cap = SEGMENT_MAX_BYTES) => boundary?.wip_bundle === undefined || Buffer.byteLength(boundary.wip_bundle, "base64") <= cap;

/**
 * The segments that copy `events` (cursors after `after`, in order): event segments as big as fit, then, at a
 * boundary, the last one with the engine and the work in progress. `wipLost` says its work in progress went without
 * (the boundary then says `wip_dropped`), `wipBytes` how big it was; `engineLost` that its engine went without (it was
 * the part too big: the work in progress stays when it fits).
 */
export function planSegments(input: {
  readonly head: SegmentHead;
  readonly after: number;
  readonly events: ReadonlyArray<SessionEvent>;
  readonly display: MoveBundle["display"];
  /** Present at a turn boundary (or a move's last copy). */
  readonly boundary?: BoundaryParts;
  /**
   * A running turn's work in progress (decision 25), no engine: its last segment carries it when it fits there whole,
   * else the copy goes without it (never as chunks, never said dropped: the next boundary carries it). Not with `boundary`.
   */
  readonly wip?: BoundaryParts;
  /** The work in progress the copy already holds: mid-turn segments name it again. */
  readonly lastWip: string | null;
  /** One segment even with nothing to carry but its head (a step's intent, written ahead of its effect). */
  readonly always?: boolean;
  readonly budget?: number;
  readonly cap?: number;
}): {
  readonly segments: ReadonlyArray<PlannedSegment>;
  readonly wipLost: boolean;
  readonly wipBytes?: number;
  readonly engineLost: boolean;
  readonly cut: number;
  readonly wipCarried: boolean;
  /** The boundary's turn checkpoints went without (they were what did not fit): the next boundary carries them. */
  readonly checkpointsLost: boolean;
} {
  const budget = input.budget ?? SEGMENT_EVENTS_BUDGET;
  const cap = input.cap ?? SEGMENT_MAX_BYTES;
  const mayFit = (boundary: BoundaryParts | undefined) => bundleFits(boundary, cap);
  let cut = 0;
  const events = input.events.map((event) => {
    const fitted = cutEvent(event);
    if (fitted !== event) cut++;
    return fitted;
  });
  const displayFor = (run: ReadonlyArray<SessionEvent>) => {
    const ids = new Set(run.flatMap((e) => (e.type === "message.done" && e.item_id ? [e.item_id] : [])));
    return input.display.filter((row) => ids.has(row.message_id));
  };
  const out: Array<PlannedSegment> = [];
  /**
   * Writes `run` as one segment, or halves it until each half fits. One that cannot be written leaves nothing behind:
   * the halves it wrote go too, so whatever is tried next writes those cursors once.
   */
  const emit = (run: ReadonlyArray<SessionEvent>, from: number, boundary?: BoundaryParts): boolean => {
    const through = from + run.length - 1;
    const body = encodeSegment(input.head, run, displayFor(run), { from, through, boundary: boundary !== undefined }, boundary, input.lastWip);
    if (body.length <= cap) {
      out.push({ from, through, boundary: boundary !== undefined, body, cut: run.filter((e) => (e as { copy_truncated?: boolean }).copy_truncated === true).length });
      return true;
    }
    if (run.length <= 1) return false;
    const half = Math.ceil(run.length / 2);
    const written = out.length;
    if (emit(run.slice(0, half), from) && emit(run.slice(half), from + half, boundary)) return true;
    out.length = written;
    return false;
  };
  // Runs of events within the budget.
  const runs: Array<Array<SessionEvent>> = [];
  let current: Array<SessionEvent> = [];
  let bytes = 0;
  for (const event of events) {
    const size = byteLength(event);
    if (current.length > 0 && bytes + size > budget) {
      runs.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0 || input.boundary !== undefined || (input.always === true && runs.length === 0)) runs.push(current);
  let from = input.after + 1;
  let wipLost = false;
  let engineLost = false;
  let wipCarried = false;
  let checkpointsLost = false;
  for (const [i, run] of runs.entries()) {
    const last = i === runs.length - 1;
    let boundary = last ? input.boundary : undefined;
    // A running turn's work in progress rides on its last segment only as one segment that fits whole.
    const mid = last && input.boundary === undefined && input.wip !== undefined && input.wip.wip_ref === undefined && run.length > 0 ? input.wip : undefined;
    if (mid !== undefined && mayFit(mid)) {
      const through = from + run.length - 1;
      const body = encodeSegment(input.head, run, displayFor(run), { from, through, boundary: false }, { engine: null, wip: mid.wip, ...(mid.wip_bundle ? { wip_bundle: mid.wip_bundle } : {}) }, input.lastWip);
      if (body.length <= cap) {
        out.push({ from, through, boundary: false, body, cut: run.filter((e) => (e as { copy_truncated?: boolean }).copy_truncated === true).length });
        from += run.length;
        wipCarried = true;
        continue;
      }
    }
    if (mayFit(boundary) && emit(run, from, boundary)) {
      from += run.length;
      continue;
    }
    if (boundary === undefined) throw new Error(`event ${from} cannot be copied within Cloud's segment cap`);
    // The turn checkpoints are the first to stay behind: never the reason the work in progress or the engine goes without.
    if (boundary.checkpoints !== undefined) {
      const { checkpoints: _checkpoints, ...bare } = boundary;
      boundary = bare;
      checkpointsLost = true;
      if (mayFit(boundary) && emit(run, from, boundary)) {
        from += run.length;
        continue;
      }
    }
    // The boundary's events go ahead on their own; then the engine and the work in progress, then without the bundle.
    if (run.length > 0) {
      if (!emit(run, from)) throw new Error(`event ${from} cannot be copied within Cloud's segment cap`);
      from += run.length;
    }
    if (mayFit(boundary) && emit([], from, boundary)) continue;
    // Said only when the work in progress it names is not the boundary's own.
    const lost = boundary.wip !== input.lastWip ? { wip_dropped: true as const } : {};
    const { wip_bundle: _bundle, wip_ref: _ref, ...without } = boundary;
    // The work in progress was what did not fit: the engine goes without it.
    if (emit([], from, { ...without, wip: input.lastWip, ...lost })) {
      wipLost = lost.wip_dropped === true;
      continue;
    }
    // The engine is: the work in progress goes without it, when it fits on its own.
    engineLost = boundary.engine !== null;
    if (boundary.engine !== null && mayFit(boundary) && emit([], from, { ...boundary, engine: null })) continue;
    wipLost = lost.wip_dropped === true;
    emit([], from, { engine: null, wip: input.lastWip, ...lost });
  }
  const bundled = input.boundary?.wip_bundle;
  return { segments: out, wipLost, ...(wipLost && bundled ? { wipBytes: Buffer.byteLength(bundled, "base64") } : {}), engineLost, cut, wipCarried, checkpointsLost };
}

const isGzip = (raw: Uint8Array) => raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;

/**
 * A segment a newer Caveman Code wrote: in a format, or at a protocol revision, this runtime does not know. Read anyway,
 * the chat would land half understood, so whoever reads it refuses it with this message (a move's adopt answers Cloud
 * with it, and the chat goes back to where it was).
 */
export class NewerCopyError extends Error {
  override readonly name = "NewerCopyError";
}

/**
 * A segment as Cloud hands it back, as the MoveBundle the moves code merges: gzipped or plain JSON, v1 (events whole)
 * or v2 (events as {cursor, type, at, event}). Throws NewerCopyError for one a newer runtime wrote.
 */
export function decodeSegment(raw: Uint8Array): MoveBundle & { readonly epoch?: number; readonly from?: number; readonly through?: number; readonly boundary?: boolean } {
  const text = (isGzip(raw) ? gunzipSync(raw, { maxOutputLength: SEGMENT_MAX_DECOMPRESSED_BYTES }) : Buffer.from(raw)).toString("utf8");
  const body = JSON.parse(text) as Record<string, unknown>;
  // Absent from segments written before runtimes said: revision 0.
  const revision = typeof body.revision === "number" ? body.revision : 0;
  if (!SEGMENT_FORMATS.has(body.v) || revision > PROTOCOL_REVISION) {
    const writer = typeof body.runtime_version === "string" && body.runtime_version !== "" ? `Caveman Code ${body.runtime_version}` : "a newer Caveman Code";
    throw new NewerCopyError(
      `Caveman Code ${RUNTIME_VERSION} can't read this chat's copy, which ${writer} made (copy format ${String(body.v)}, protocol revision ${revision}; it reads formats 1 and 2 up to revision ${PROTOCOL_REVISION}), so it needs updating before it takes the chat`,
    );
  }
  const events = ((body.events as Array<Record<string, unknown>> | undefined) ?? []).map((item) =>
    item !== null && typeof item === "object" && "event" in item && item.event !== null && typeof item.event === "object" ? (item.event as SessionEvent) : (item as unknown as SessionEvent),
  );
  return { ...(body as unknown as MoveBundle), events, display: (body.display as MoveBundle["display"] | undefined) ?? [] };
}
