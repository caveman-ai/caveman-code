// The session mailbox in Caveman Cloud (Caveman Cloud Caveman Cloud API), for a tree of
// workspaces that spans computers: a lead on one, builders on Cloud computers of their own. Every call carries the
// runtime's token; Cloud takes the organization and computer from it, lets a runtime speak only for workspaces on
// its own computer and to workspaces in the same tree, and makes each write idempotent by request_id within the tree.
// A tree's mail travels on its own channel ("tree"), so its reader never takes another loop's mail (move, session).
import { withRuntimeToken } from "./computers.ts";
import { cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/** The mailbox channel a tree's mail travels on (CONTRACT-CHANGES A5): spawns, results, tasks and notes. */
export const TREE_CHANNEL = "tree";

/** One mail as Cloud stores it (mailbox.go Mail). */
export interface TreeMail {
  readonly id: string;
  readonly verb: string;
  readonly authority: string;
  readonly channel: string;
  readonly from_workspace_id: string | null;
  readonly to_workspace_id: string | null;
  readonly body: string;
  readonly wakes: boolean;
  readonly reply_to: string | null;
  readonly created_at: string;
  /** A spawn's builder rows (SpawnPayload); absent on peer mail. */
  readonly payload?: unknown;
}

/** What a spawn names for the builder's computer (CONTRACT-CHANGES A5): the builder's own workspace and session rows. */
export interface SpawnPayload {
  readonly kind: "spawn";
  readonly workspace_id: string;
  readonly session_id: string;
  readonly title: string;
  readonly repo: string;
  readonly base_branch: string;
  readonly branch: string;
  readonly engine: string;
  /** The builder's model when the spawn named one, and the lead's session it reports to. */
  readonly model?: string;
  readonly lead_workspace_id: string;
  readonly lead_session_id?: string;
  /** A lead's schedule that runs on Cloud: the builder holds it on its own chat instead of starting a turn now. */
  readonly schedule?: Record<string, unknown>;
}

export const spawnPayloadOf = (mail: TreeMail): SpawnPayload | undefined => {
  const p = mail.payload as Partial<SpawnPayload> | null | undefined;
  if (mail.verb !== "spawn" || p?.kind !== "spawn") return undefined;
  const fields = [p.workspace_id, p.session_id, p.repo, p.branch, p.engine] as const;
  if (!fields.every((v) => typeof v === "string" && v !== "")) return undefined;
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const model = text(p.model);
  const leadSession = text(p.lead_session_id);
  const schedule = p.schedule !== null && typeof p.schedule === "object" && !Array.isArray(p.schedule) ? p.schedule : undefined;
  return {
    kind: "spawn",
    workspace_id: p.workspace_id!,
    session_id: p.session_id!,
    title: text(p.title) ?? "",
    repo: p.repo!,
    base_branch: text(p.base_branch) ?? "",
    branch: p.branch!,
    engine: p.engine!,
    lead_workspace_id: text(p.lead_workspace_id) ?? "",
    ...(model === undefined ? {} : { model }),
    ...(leadSession === undefined ? {} : { lead_session_id: leadSession }),
    ...(schedule === undefined ? {} : { schedule }),
  };
};

/** Cloud's workspace row, as much of it as the runtime reads. */
export interface CloudWorkspace {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly branch: string;
  readonly engine: string;
  readonly computer_id: string | null;
  readonly parent_id?: string | null;
}

/** One call may take this long; a wait gets its own time on top. */
export const CALL_TIMEOUT_MS = 15_000;

/** One call to Cloud's /api/v1/code routes with the link's token (the mailbox's, and mail between Macs: macMail.ts). */
export async function call<T>(identity: Identity, state: LinkState, method: string, path: string, json: unknown, timeoutMs = CALL_TIMEOUT_MS, fetchImpl: typeof fetch = fetch): Promise<T> {
  const send = (token: string) =>
    fetchImpl(`${identity.cloudUrl}/api/v1/code/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  const response = await withRuntimeToken(identity, state, fetchImpl, send);
  if (!response.ok) throw await cloudFailure(response);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** What mail/spawn takes (mailbox.go SpawnInput), and nothing more: Cloud decodes strictly (an unknown field is a 400). */
export interface SpawnInput {
  readonly request_id: string;
  readonly from_workspace_id: string;
  readonly title: string;
  readonly brief: string;
  readonly branch: string;
  readonly engine?: string;
  /** "cloud": a lead on This Mac asks for a fresh Cloud computer for the builder (CONTRACT §4). */
  readonly where?: "cloud";
  /**
   * One of the person's Cloud computers for the builder (or the lead's own), woken if suspended and paid for; never with `where`.
   * Cloud refuses a laptop (404) and a computer the tree's person did not make (403 cave_code_computer_not_yours).
   */
  readonly computer_id?: string;
  /** The builder's model on its engine (the lead's, when it runs the lead's engine); absent: that engine's default there. */
  readonly model?: string;
  /** The lead's session the builder reports to (one of the lead workspace's): its chat sits under it on every device. */
  readonly lead_session_id?: string;
  /** A schedule for the builder to hold (a lead's schedule that runs on Cloud); Cloud passes it on in the spawn's payload. */
  readonly schedule?: Record<string, unknown>;
}

/** Starts a builder in Cloud under the lead: its workspace, its computer, and the waking spawn mail with the brief. */
export const spawnBuilder = (identity: Identity, state: LinkState, input: SpawnInput, fetchImpl?: typeof fetch) =>
  call<{ workspace: CloudWorkspace; message: TreeMail }>(identity, state, "POST", "mail/spawn", input, CALL_TIMEOUT_MS, fetchImpl);

export interface SendInput {
  readonly request_id: string;
  readonly from_workspace_id: string;
  readonly to_workspace_id: string;
  readonly body: string;
  readonly reply_to?: string;
}

/** A task, note or ask to another workspace of the tree, on the tree's channel. */
export const sendTreeMail = (identity: Identity, state: LinkState, verb: "task" | "note" | "ask", input: SendInput, fetchImpl?: typeof fetch) =>
  call<TreeMail>(identity, state, "POST", `mail/${verb}`, { ...input, channel: TREE_CHANNEL }, CALL_TIMEOUT_MS, fetchImpl);

/** Mail to a workspace after `after`, and which watched workspaces are at rest; held up to `timeout_ms` (Cloud caps 25 s). */
export const waitTreeMail = (
  identity: Identity,
  state: LinkState,
  input: { readonly workspace_id: string; readonly after?: string; readonly workspace_ids?: ReadonlyArray<string>; readonly timeout_ms: number },
  fetchImpl?: typeof fetch,
) => {
  const query = new URLSearchParams({ workspace_id: input.workspace_id, timeout_ms: String(input.timeout_ms) });
  if (input.after) query.set("after", input.after);
  if (input.workspace_ids?.length) query.set("workspace_ids", input.workspace_ids.join(","));
  return call<{ messages: Array<TreeMail>; finished: Array<CloudWorkspace>; timed_out: boolean }>(
    identity,
    state,
    "GET",
    `mail/wait?${query}`,
    undefined,
    input.timeout_ms + CALL_TIMEOUT_MS,
    fetchImpl,
  );
};

/**
 * Cloud's long wait for tree mail to any workspace on this computer (Caveman Cloud mail_api.go MailWait without a
 * workspace): answers once there is some to take with takeTreeMail, or after `timeout_ms` (Cloud caps 25 s).
 */
export const waitTreeComputer = (identity: Identity, state: LinkState, timeoutMs: number, fetchImpl?: typeof fetch) => waitComputerMail(identity, state, TREE_CHANNEL, timeoutMs, fetchImpl);

/** The least a wait that finds no mail takes, however soon Cloud answered it. */
export const WAIT_FLOOR_MS = 1_000;

/**
 * The same long wait for mail on any channel (moves, calls): `{ready}` once there is some to take, or after `timeout_ms`.
 * One answered "none" sooner than WAIT_FLOOR_MS (a proxy that cuts long requests, a Cloud that does not hold them) is
 * held for the rest of it: every loop asks again as soon as its wait returns, and those answers kept a claimed Cloud
 * computer at a core of CPU (kind review K10).
 */
export const waitComputerMail = async (identity: Identity, state: LinkState, channel: string, timeoutMs: number, fetchImpl?: typeof fetch) => {
  const asked = Date.now();
  const out = await call<{ ready: boolean; timed_out: boolean }>(identity, state, "GET", `mail/wait?channel=${encodeURIComponent(channel)}&timeout_ms=${timeoutMs}`, undefined, timeoutMs + CALL_TIMEOUT_MS, fetchImpl);
  const left = Math.min(timeoutMs, WAIT_FLOOR_MS) - (Date.now() - asked);
  if (out?.ready !== true && left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  return out;
};

export interface CloudClaim {
  readonly path: string;
  readonly workspace_id: string;
  readonly expires_at?: string;
}

export const claimPaths = (identity: Identity, state: LinkState, input: { readonly request_id: string; readonly from_workspace_id: string; readonly paths: ReadonlyArray<string> }, fetchImpl?: typeof fetch) =>
  call<{ claims: Array<CloudClaim>; conflicts: Array<CloudClaim> }>(identity, state, "POST", "mail/claim", input, CALL_TIMEOUT_MS, fetchImpl);

export const releasePaths = (identity: Identity, state: LinkState, input: { readonly request_id: string; readonly from_workspace_id: string; readonly paths: ReadonlyArray<string> }, fetchImpl?: typeof fetch) =>
  call<{ released: Array<string> }>(identity, state, "POST", "mail/release", input, CALL_TIMEOUT_MS, fetchImpl).then((out) => out.released ?? []);

/** The mail on `channel` for workspaces on this computer, leased for delivery: only that channel's. */
export async function takeChannelMail(identity: Identity, state: LinkState, channel: string, fetchImpl?: typeof fetch) {
  const out = await call<{ lease_token: string | null; messages: Array<TreeMail> | null }>(identity, state, "POST", `mail/deliveries?channel=${channel}`, {}, CALL_TIMEOUT_MS, fetchImpl);
  return { lease: out.lease_token, messages: (out.messages ?? []).filter((m) => m.channel === channel) };
}

/** The tree mail for workspaces on this computer, leased for delivery: only channel "tree". */
export const takeTreeMail = (identity: Identity, state: LinkState, fetchImpl?: typeof fetch) => takeChannelMail(identity, state, TREE_CHANNEL, fetchImpl);

/** Mail taken under `lease` is done (whatever its channel). */
export const ackMail = (identity: Identity, state: LinkState, lease: string, ids: ReadonlyArray<string>, fetchImpl?: typeof fetch) =>
  call<{ delivered: Array<string>; lost: Array<string> }>(identity, state, "POST", "mail/deliveries/ack", { lease_token: lease, ids }, CALL_TIMEOUT_MS, fetchImpl);
export const ackTreeMail = ackMail;
