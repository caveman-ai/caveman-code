// Cloud's routes for a chat's copy that sync adds to the moves journal (Caveman Cloud the spec, CONTRACT §1-§2, S12):
// the epoch bump a runtime asks for when it rebuilds a lost tail from the copy, the lid's handoff, and deleting a
// chat's copy and summary when sync is turned off. The segments themselves go through moves.ts's journal routes.
import { call } from "./computers.ts";
import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import type { JournalIndex } from "./moves.ts";

const session = (id: string) => `sessions/${encodeURIComponent(id)}`;

/** A new epoch for the session's journal, under the lease this runtime holds (a rebuild from Cloud's copy). */
export const bumpEpoch = (identity: Identity, state: LinkState, sessionId: string, leaseToken: string, fetchImpl?: typeof fetch) =>
  call<JournalIndex>(identity, state, "POST", `${session(sessionId)}/journal/epoch`, { lease_token: leaseToken }, fetchImpl);

/**
 * What Cloud made of a handoff (chats_moves.go LidHandoffResult): released, moved when working and it could, or why
 * not. `pending`: a Cloud computer that is up was asked to take it (`move_id`), and Cloud hands it over once that one
 * accepts (or makes another), so the chat is on its way and never carries on here meanwhile (m-10).
 */
export interface Handoff {
  readonly session_id?: string;
  readonly released?: boolean;
  readonly moved: boolean;
  readonly pending?: boolean;
  readonly move_id?: string;
  readonly computer_id?: string;
  readonly runtime_id?: string | null;
  readonly refused?: { readonly code: string; readonly message: string };
}

/** The lid's last word for a chat (S12): its copy is flushed through `through`; Cloud takes the lease and continues a working chat. Said again, it answers the same. */
export const handoffSession = (identity: Identity, state: LinkState, sessionId: string, input: { readonly through: number; readonly reason: "lid"; readonly move_id?: string }, fetchImpl?: typeof fetch) =>
  call<Handoff>(identity, state, "POST", `${session(sessionId)}/handoff`, input, fetchImpl);

/** `fetchImpl`, giving up after `ms` (a request that must answer within the lid's budget). */
export const within =
  (ms: number, fetchImpl: typeof fetch = fetch): typeof fetch =>
  (url, init) =>
    fetchImpl(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });

/** Sync turned off: the chat's summary and copy leave Cloud. */
export const deleteChat = (identity: Identity, state: LinkState, sessionId: string, fetchImpl?: typeof fetch) =>
  call<unknown>(identity, state, "DELETE", `chats/${encodeURIComponent(sessionId)}`, undefined, fetchImpl);
