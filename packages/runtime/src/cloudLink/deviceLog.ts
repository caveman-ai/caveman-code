// The person's device log in Caveman Cloud (docs/): signed approvals and removals their Macs
// share. Cloud stores and carries them, numbered, and holds no key a Mac accepts; each Mac verifies every statement
// itself (session-protocol devices.ts verifyStatement, deviceTrust.ts). The routes act for the runtime's enroller.
import type { DeviceStatement } from "@caveman-app/session-protocol";

import { CALL_TIMEOUT_MS, withRuntimeToken } from "./computers.ts";
import { cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/** Cloud's wait (it caps it at 25 s). */
export const LOG_WAIT_MS = 25_000;
/**
 * A queued call or move This Mac did not answer: its last read of the log is stale (it slept, or just started) and a
 * fresh one did not land, so a removal may be waiting. Never a no: the mail stays unanswered and is tried again.
 */
export const TRUST_UNREAD = "device_log_unread";

/** One statement as Cloud carries it: its number in the person's log, and the statement as stored (each Mac verifies it). */
export interface LoggedStatement {
  readonly seq: number;
  readonly statement: unknown;
}

export interface LogPage {
  readonly statements: ReadonlyArray<LoggedStatement>;
  /** The number to read after next. */
  readonly seq: number;
}

async function call<T>(identity: Identity, link: LinkState, method: string, query: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const send = (token: string) =>
    fetch(`${identity.cloudUrl}/api/v1/code/runtime/devices/statements${query}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  const response = await withRuntimeToken(identity, link, fetch, send);
  if (!response.ok) throw await cloudFailure(response);
  return (await response.json()) as T;
}

/** Puts statements this Mac's screen signed in the person's log; a statement Cloud has already is the same one. */
export const putStatements = (identity: Identity, link: LinkState, statements: ReadonlyArray<DeviceStatement>) =>
  call<unknown>(identity, link, "POST", "", { statements }, CALL_TIMEOUT_MS);

/** The person's statements after `after`, waiting up to `waitMs` for one; `timeoutMs` bounds the whole ask. */
export const statementsAfter = (identity: Identity, link: LinkState, after: number, waitMs: number, options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}) =>
  call<LogPage>(identity, link, "GET", `?after=${after}&wait_ms=${waitMs}`, undefined, options.timeoutMs ?? waitMs + CALL_TIMEOUT_MS, options.signal);
