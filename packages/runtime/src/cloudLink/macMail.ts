// Agent mail between a person's Macs in Caveman Cloud (Caveman Cloud Caveman Cloud API): a
// chat here mails a chat on another of the person's Macs (`mac:<its workspace>`), and this Mac takes the mail its own
// chats get, on channel "mac", numbered per receiving chat. Cloud takes the organization, computer and person from the
// runtime's token, and carries each mail as the sending Mac's agents key signed it (session-protocol macMail.ts).
import type { AgentMail } from "@caveman-app/session-protocol/mac-mail";

import type { Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { ackMail, call, CALL_TIMEOUT_MS, takeChannelMail, waitComputerMail, type TreeMail } from "./mail.ts";

/** The mailbox channel mail between a person's Macs travels on: only Cloud's mac route writes it. */
export const MAC_CHANNEL = "mac";

/** What Cloud adds to a mail for the receiving Mac: the envelope as signed, the receiving chat's session, its number. */
export interface MacMailPayload {
  readonly kind: "mac";
  readonly mail: AgentMail;
  readonly session_id: string;
  readonly recipient_seq: number;
  /** The sending chat's session, as Cloud has it (the asking chat a notification defers to). */
  readonly from_session_id?: string;
}

/** A chat on another of the person's Macs, as Cloud's peer lookup names it. */
export interface MacPeer {
  readonly workspace_id: string;
  readonly session_id: string;
  readonly title: string;
  readonly computer_id: string;
  readonly computer_name: string;
}

/** One signed mail to a chat on another of the person's Macs: kept once per message id (the same one answers again). */
export const sendMacMail = (identity: Identity, state: LinkState, input: { readonly mail: AgentMail; readonly body: string }, fetchImpl?: typeof fetch) =>
  call<TreeMail>(identity, state, "POST", "mail/mac", input, CALL_TIMEOUT_MS, fetchImpl);

/** A chat on another of the person's Macs by its Cloud workspace id; a 404 for anything else. */
export const macPeer = (identity: Identity, state: LinkState, workspaceId: string, fetchImpl?: typeof fetch) =>
  call<MacPeer>(identity, state, "GET", `mail/mac/${encodeURIComponent(workspaceId)}`, undefined, CALL_TIMEOUT_MS, fetchImpl);

/** Cloud's long wait for mail between Macs to any chat on this computer. */
export const waitMacMail = (identity: Identity, state: LinkState, timeoutMs: number, fetchImpl?: typeof fetch) => waitComputerMail(identity, state, MAC_CHANNEL, timeoutMs, fetchImpl);

/** The mail between Macs for chats on this computer, leased for delivery: only channel "mac". */
export const takeMacMail = (identity: Identity, state: LinkState, fetchImpl?: typeof fetch) => takeChannelMail(identity, state, MAC_CHANNEL, fetchImpl);

export const ackMacMail = ackMail;

/**
 * Keeps mail this Mac took and has not finished (its log not read since it woke, a chat whose adopt has not landed) for
 * another lease (Cloud leases mail between Macs for 30 s), so it stays this Mac's, in order, and is not handed out
 * again. `lost`: mail the lease no longer holds (it lapsed, or it was acknowledged).
 */
export const renewMacMail = (identity: Identity, state: LinkState, lease: string, ids: ReadonlyArray<string>, fetchImpl?: typeof fetch) =>
  call<{ renewed: Array<string>; lost: Array<string> }>(identity, state, "POST", "mail/deliveries/renew", { lease_token: lease, ids }, CALL_TIMEOUT_MS, fetchImpl);
