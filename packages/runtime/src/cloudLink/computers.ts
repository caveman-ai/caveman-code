// Cloud computers from This Mac: the runtime calls Caveman Cloud's /code/runtime/* person routes
// with its own runtime token, and Cloud acts as the member who signed this runtime in. The person's
// Cloud credential never reaches the runtime or a client (Caveman Cloud
// Caveman Cloud API, AsEnroller).
import { ruleOf } from "./credentialRule.ts";
import { CloudError, cloudFailure, signAssertion, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

export interface CloudComputer {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly size: string;
  readonly desired_state: "running" | "stopped" | "suspended" | "deleted";
  readonly observed_state: "pending" | "starting" | "running" | "stopping" | "stopped" | "suspended" | "deleted" | "failed";
  readonly observed_reason: string;
  readonly updated_at: string;
  /** "usage": asleep because nothing paid for its time. */
  readonly sleep_reason?: string;
  /** Cloud lost the disk it kept for this computer, then (SPEC §7.4 of cloud-computers-2026-11-09): its chats come back from their copies. */
  readonly disk_lost_at?: string;
  readonly disk_lost_reason?: string;
  /** Its runtime is older than this Cloud's minimum (CONTRACT §5.4): it updates when it next wakes. */
  readonly runtime_outdated?: boolean;
}

/** How long one Cloud call may take: a Cloud that hangs must not hold a session, a sync loop or a mirror. */
export const CALL_TIMEOUT_MS = 10_000;
/** A skew this small is left alone, as the link does: the Date header's whole seconds would set a retry a second back. */
const SKEW_TOLERANCE_MS = 5_000;

/**
 * A token minted for these calls while Remote control is off, shared until two thirds of its life
 * have passed: Settings polls every few seconds, and each mint rotates the runtime's token in Cloud
 * (a link reconnecting would lose its own token's grace). One mint at a time per runtime.
 */
const minted = new Map<string, Promise<{ value: string; refreshAt: number }>>();

async function mint(identity: Identity, fetchImpl: typeof fetch) {
  // issued_at is Cloud's clock, as its Date header shows it when ours is off (as the link's mint), and Cloud fences
  // replays by it: a refusal retries once, on Cloud's clock and a second later (a second mint in the same second).
  let skewMs = 0;
  for (let attempt = 0; ; attempt++) {
    const issuedAt = Math.floor((Date.now() + skewMs) / 1000) + attempt;
    const response = await fetchImpl(`${identity.cloudUrl}/api/v1/code/runtimes/${identity.runtimeId}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization_id: identity.organizationId, issued_at: issuedAt, signature: signAssertion(identity, issuedAt) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const skew = Date.parse(response.headers.get("date") ?? "") - Date.now();
    if (Math.abs(skew) > SKEW_TOLERANCE_MS) skewMs = skew;
    if (response.ok) {
      const body = (await response.json()) as { token: string; expires_at: string };
      const now = Date.now();
      return { value: body.token, refreshAt: now + Math.max(0, Date.parse(body.expires_at) - (now + skewMs)) * (2 / 3) };
    }
    if (response.status !== 401 || attempt > 0) throw await cloudFailure(response);
  }
}

/**
 * The live link's token, else the shared minted one (`stale` names one Cloud just refused). While the link runs, every
 * call waits for the link's token, or asks the link for a new one, and never mints its own: each mint cuts the token
 * before it to Cloud's last minute of grace, and a claimed Cloud computer's link was left on such a token (kind K14).
 */
export async function tokenFor(identity: Identity, state: LinkState, fetchImpl: typeof fetch, stale?: string): Promise<string> {
  if (state.cloudUrl === identity.cloudUrl) {
    if (state.token && state.token !== stale) return state.token;
    if (state.fresh) return state.fresh(stale, CALL_TIMEOUT_MS);
  }
  const key = `${identity.cloudUrl}\0${identity.runtimeId}`;
  const current = minted.get(key);
  if (current) {
    const token = await current.catch(() => undefined);
    if (token && token.value !== stale && Date.now() < token.refreshAt) return token.value;
    if (minted.get(key) !== current) return tokenFor(identity, state, fetchImpl, stale); // another call minted meanwhile
  }
  const token = mint(identity, fetchImpl);
  minted.set(key, token);
  return (await token).value;
}

/** One /api/v1/code/runtime/<path> call with the runtime's token; a 204 (or a 304 to `headers`' If-None-Match) answers undefined. */
export async function call<T>(
  identity: Identity,
  state: LinkState,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await request(identity, state, method, path, body, fetchImpl, { accept: "application/json", ...headers });
  if (response.status === 304 || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The same call's response as is (a text/plain log); a refusal throws Cloud's status and sentence. */
export async function request(identity: Identity, state: LinkState, method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch, headers: Record<string, string> = {}) {
  const send = (token: string) =>
    fetchImpl(`${identity.cloudUrl}/api/v1/code/runtime/${path}`, {
      method,
      headers: { ...headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  const response = await withRuntimeToken(identity, state, fetchImpl, send);
  if (!response.ok && response.status !== 304) {
    const failure = await cloudFailure(response);
    // Cloud refusing a credential route because credentials stay outside this computer: the rule applies from here on.
    ruleOf(state).refusedBy(failure);
    throw failure;
  }
  return response;
}

/**
 * `send` with the runtime's token. Cloud refusing it (401) means the runtime's own token is out of date (rotated by a
 * newer mint, expired across a sleep): it gets a new one, the link's or one minted for the call, and sends once more,
 * so nobody is told to sign in again for a token the runtime holds itself (kind K14).
 */
export async function withRuntimeToken(identity: Identity, state: LinkState, fetchImpl: typeof fetch, send: (token: string) => Promise<Response>): Promise<Response> {
  const token = await tokenFor(identity, state, fetchImpl);
  const response = await send(token);
  if (response.status !== 401) return response;
  await response.body?.cancel().catch(() => undefined);
  return send(await tokenFor(identity, state, fetchImpl, token));
}

const row = (c: CloudComputer): CloudComputer => ({
  id: c.id,
  name: c.name,
  driver: c.driver,
  size: c.size,
  desired_state: c.desired_state,
  observed_state: c.observed_state,
  observed_reason: c.observed_reason,
  updated_at: c.updated_at,
  ...(c.sleep_reason ? { sleep_reason: c.sleep_reason } : {}),
  ...(typeof c.disk_lost_at === "string" && c.disk_lost_at !== "" ? { disk_lost_at: c.disk_lost_at, ...(typeof c.disk_lost_reason === "string" ? { disk_lost_reason: c.disk_lost_reason } : {}) } : {}),
  ...(c.runtime_outdated === true ? { runtime_outdated: true } : {}),
});

export async function listCloudComputers(identity: Identity, state: LinkState, fetchImpl?: typeof fetch) {
  // Only the enroller's own: a colleague's computer is theirs to sleep (Cloud refuses it anyway).
  const out = await call<{ computers?: CloudComputer[]; cloud_computers?: boolean; caveman_on_computers?: boolean; caveman_paid?: boolean }>(identity, state, "GET", "computers?mine=true", undefined, fetchImpl);
  // caveman: Cloud computers here run Caveman chats (preflight cavemanOnCloud); a Cloud that does not say runs none.
  // cavemanPaid: where they pay from the person's credits, whether anything can pay now; undefined where Cloud does not say.
  return {
    available: out.cloud_computers === true,
    caveman: out.caveman_on_computers === true,
    ...(typeof out.caveman_paid === "boolean" ? { cavemanPaid: out.caveman_paid } : {}),
    computers: (out.computers ?? []).map(row),
  };
}

export async function setCloudComputer(identity: Identity, state: LinkState, computerId: string, wanted: "running" | "suspended", fetchImpl?: typeof fetch) {
  const verb = wanted === "running" ? "resume" : "sleep";
  return row(await call<CloudComputer>(identity, state, "POST", `computers/${encodeURIComponent(computerId)}/${verb}`, {}, fetchImpl));
}

/**
 * Deletes a Cloud computer this runtime's enroller made (Cloud's AsEnroller route): its workspaces are archived, their
 * copies kept in Cloud, and its disk goes, uncommitted work included. Answers the row, now deleted.
 */
export async function deleteCloudComputer(identity: Identity, state: LinkState, computerId: string, fetchImpl?: typeof fetch) {
  return row(await call<CloudComputer>(identity, state, "DELETE", `computers/${encodeURIComponent(computerId)}`, undefined, fetchImpl));
}

export async function createCloudWorkspace(
  identity: Identity,
  state: LinkState,
  input: {
    readonly title: string;
    readonly repo: string;
    readonly base_branch?: string | undefined;
    readonly engine: string;
    /** The other repositories of the project the chat works in (CONTRACT §7); absent for a chat in one, whose request is as it was. */
    readonly checkouts?: ReadonlyArray<{ readonly repo: string; readonly base_branch?: string | undefined }> | undefined;
    /**
     * The chat's start, which Cloud queues with the placement (CONTRACT §6.8): the computer's runtime runs it when it
     * links. A Cloud from before it refuses the field (its strict decode: "Invalid JSON."): the placement is asked for
     * again without it, and the answer then names no queued start, which is how the client knows to start the chat itself.
     */
    readonly start?: { readonly request_id: string; readonly params: Readonly<Record<string, unknown>> } | undefined;
  },
  fetchImpl?: typeof fetch,
) {
  type Placed = { id: string; computer_id: string | null; session_id?: string; start?: { id: string; request_id: string; method: string; status: "queued" | "delivered" | "done" | "failed" | "expired"; created_at: string } };
  const body = {
    title: input.title.slice(0, 200),
    repo: input.repo,
    base_branch: input.base_branch ?? "",
    engine: input.engine,
    computer: { kind: "cloud" },
    ...(input.checkouts !== undefined && input.checkouts.length > 0 ? { checkouts: input.checkouts.map((one) => ({ repo: one.repo, ...(one.base_branch ? { base_branch: one.base_branch } : {}) })) } : {}),
  };
  const place = (start: typeof input.start) => call<Placed>(identity, state, "POST", "workspaces", start === undefined ? body : { ...body, start }, fetchImpl);
  const w = await place(input.start).catch((error: unknown) => {
    if (input.start !== undefined && startUnknown(error)) return place(undefined);
    throw error;
  });
  if (!w.computer_id) throw new Error("Caveman made the workspace without a computer");
  const queued = w.start !== undefined && typeof w.session_id === "string" && w.session_id !== "";
  return {
    workspace_id: w.id,
    computer_id: w.computer_id,
    open_url: `${identity.cloudUrl}/code/`,
    ...(queued ? { session_id: w.session_id!, start: { id: w.start!.id, request_id: w.start!.request_id, method: w.start!.method, status: w.start!.status, created_at: w.start!.created_at } } : {}),
  };
}

/** A Cloud from before queued starts refused `start`: its strict decode says only "Invalid JSON." (400 cave_bad_request). */
export const startUnknown = (error: unknown) => error instanceof CloudError && error.status === 400 && error.code === "cave_bad_request" && error.message === "Invalid JSON.";

/** This Mac's usage (usageReporter.ts). Cloud records each event once; an event it refuses is dropped, the rest count. */
export const reportLocalUsage = (identity: Identity, state: LinkState, events: ReadonlyArray<unknown>, fetchImpl?: typeof fetch) =>
  call<{ accepted: number; duplicates: number; refused: Array<{ request_id: string; code: string }> }>(identity, state, "POST", "local-usage", { events }, fetchImpl);
