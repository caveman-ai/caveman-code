// Large parts of a chat's copy (Caveman Cloud the spec decision 14, agent-continuity.md AC-08): work in progress too big
// for one journal segment goes up first as chunks of at most 8 MiB, each under its own sha256, and the boundary segment
// names them (`wip_ref`). The computer that adopts the chat fetches every chunk and checks each, then the whole, before
// anything lands; one that does not check refuses the adopt. A Cloud without the route keeps the old refusal (the move
// does not go, F-5). Chunks belong to the chat's copy and go with it.
import { createHash } from "node:crypto";

import { cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { rawCall } from "./moves.ts";

/** One chunk at most (Cloud MaxBlobChunk). */
export const BLOB_CHUNK_BYTES = 8 * 1024 * 1024;
/** One blob at most (Cloud MaxBlobBytes; founder call D4's default). Cloud cannot hold a writer to it; a reader does. */
export const BLOB_MAX_BYTES = 64 * 1024 * 1024;
/** All of one chat's copy's chunks at most (Cloud MaxChatBlobBytes): what an adopt fetches at most. */
export const BLOB_COPY_MAX_BYTES = 256 * 1024 * 1024;
/** A blob's chunks fetched a few at a time, as an adopt fetches segments (K10): each is a round trip on the move's way. */
const CHUNK_FETCHES = 4;
/** One chunk's call at most: a stalled uplink never holds the chat's copy (and its move lock) for good. */
export const BLOB_CALL_MS = 120_000;

/** What a segment names: the whole blob's sha256 and size, and its chunks' sha256s in order. */
export interface BlobRef {
  readonly sha256: string;
  readonly bytes: number;
  readonly chunks: ReadonlyArray<string>;
}

/** A chunk or blob whose bytes are not what its ref says: the adopt is refused, never landed. */
export class BlobUnverified extends Error {}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const path = (sessionId: string, sha: string) => `runtime/sessions/${encodeURIComponent(sessionId)}/journal/blobs/${sha}`;

/**
 * `bytes` as chunks of the chat's copy, under the journal lease: each chunk Cloud does not hold yet (HEAD) is sent.
 * Answers the ref, or undefined from a Cloud without the route (its first PUT answers 404 or 405). Each call gives up
 * after BLOB_CALL_MS, and all of them once `signal` aborts (the lid wants the chat's move lock). `onChunk` runs after
 * each chunk Cloud holds: the caller holds the chat's move lock all the while, so it renews the journal lease there
 * (a long upload never lets the lease lapse under a running turn, AUDIT-W4-EARLY m-8).
 */
export async function putBlob(
  identity: Identity,
  state: LinkState,
  sessionId: string,
  lease: string,
  bytes: Buffer,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  onChunk?: () => Promise<void>,
): Promise<BlobRef | undefined> {
  const timed: typeof fetch = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(BLOB_CALL_MS), ...(signal ? [signal] : [])]) });
  const chunks: Array<string> = [];
  for (let at = 0; at < bytes.length; at += BLOB_CHUNK_BYTES) {
    const chunk = bytes.subarray(at, Math.min(at + BLOB_CHUNK_BYTES, bytes.length));
    const sha = sha256(chunk);
    chunks.push(sha);
    const held = await rawCall(identity, state, "HEAD", path(sessionId, sha), {}, timed);
    await held.body?.cancel().catch(() => undefined);
    if (held.ok) {
      await onChunk?.();
      continue;
    }
    const response = await rawCall(identity, state, "PUT", path(sessionId, sha), { body: chunk, headers: { "x-caveman-lease": lease, "x-caveman-blob-bytes": String(bytes.length) } }, timed);
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await onChunk?.();
      continue;
    }
    if (chunks.length === 1 && (response.status === 404 || response.status === 405) && held.status === response.status) return undefined;
    throw await cloudFailure(response);
  }
  return { sha256: sha256(bytes), bytes: bytes.length, chunks };
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Whether `ref` is one a writer of this module makes: at most one blob's size, cut in whole chunks, every name a
 * sha256. The ref comes from the copy, which whoever held the chat last wrote (a Cloud computer, running agent code):
 * one naming a chunk thousands of times would check chunk by chunk and fill this computer's memory before the whole
 * fails, so it is refused before any chunk is asked for.
 */
export function wellFormed(ref: BlobRef): boolean {
  const bytes = (ref as { bytes?: unknown }).bytes;
  const chunks = (ref as { chunks?: unknown }).chunks;
  return (
    typeof bytes === "number" &&
    Number.isInteger(bytes) &&
    bytes >= 1 &&
    bytes <= BLOB_MAX_BYTES &&
    typeof ref.sha256 === "string" &&
    SHA256.test(ref.sha256) &&
    Array.isArray(chunks) &&
    chunks.length === Math.ceil(bytes / BLOB_CHUNK_BYTES) &&
    chunks.every((sha) => typeof sha === "string" && SHA256.test(sha))
  );
}

/**
 * The blob `ref` names, every chunk and the whole checked against it. BlobUnverified when any is not. The chunks come
 * a few at a time and are put in order; wellFormed bounds how many, so all of them are at most one blob's size.
 */
export async function getBlob(identity: Identity, state: LinkState, sessionId: string, ref: BlobRef, fetchImpl?: typeof fetch): Promise<Buffer> {
  if (!wellFormed(ref)) throw new BlobUnverified("its work in progress names chunks no copy is made of");
  const parts: Array<Buffer> = [];
  let next = 0;
  let failed = false;
  const fetchChunk = async (sha: string) => {
    const response = await rawCall(identity, state, "GET", path(sessionId, sha), {}, fetchImpl);
    if (response.status === 404) throw new BlobUnverified(`a chunk of its work in progress is not with Caveman (${sha.slice(0, 12)})`);
    if (!response.ok) throw await cloudFailure(response);
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.length > BLOB_CHUNK_BYTES || sha256(chunk) !== sha) throw new BlobUnverified(`a chunk of its work in progress is not what was copied (${sha.slice(0, 12)})`);
    return chunk;
  };
  const worker = async () => {
    while (!failed && next < ref.chunks.length) {
      const at = next++;
      parts[at] = await fetchChunk(ref.chunks[at]!).catch((error: unknown) => {
        failed = true;
        throw error;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_FETCHES, ref.chunks.length) }, worker));
  const whole = Buffer.concat(parts);
  if (whole.length !== ref.bytes || sha256(whole) !== ref.sha256) throw new BlobUnverified("its work in progress is not what was copied");
  return whole;
}
