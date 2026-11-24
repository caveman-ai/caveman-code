// Org workloads (Caveman Cloud's Agents API: sessions an API key or an automation started, origin `api` or
// `automation`): the Cloud routes a runtime on their computer calls with its own token. The session's mail
// (channel "session": its start, a message, an interrupt, an answer to an ask), the agent version it names, the
// public events and traces it posts, its input files and outputs, and the memory stores attached to it. Tenant and
// computer come from the runtime token; Cloud answers only for sessions on this computer.
import { withRuntimeToken } from "./computers.ts";
import { CloudError, cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";

/** One call may take this long; an upload of a large output gets longer. */
const CALL_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** The mailbox channel Cloud posts a session's mail on (CONTRACT-CHANGES A1). */
export const SESSION_CHANNEL = "session";

/** Who stands behind a mail: an API key's caller, an automation, a person, or another agent (never consent). */
export type MailAuthority = "api" | "automation" | "person" | "agent";

/** `session_start`'s payload (CONTRACT §3.2). `automation.event` is the trigger's data: never templated into a prompt. */
export interface SessionStartPayload {
  readonly kind: "session_start";
  readonly session_id: string;
  /** `name`: the agent file's, which the runtime adds once it loaded the version (trace labels read names). */
  readonly agent: { readonly id: string; readonly version: number; readonly name?: string } | null;
  readonly engine?: string | null;
  readonly model?: string | null;
  readonly repo?: string | null;
  readonly base_branch?: string | null;
  readonly branch?: string | null;
  readonly title?: string | null;
  /** Ids, or C2's attached files (`{id, name, media_type, size_bytes, sha256, mount_path}`). */
  readonly files?: ReadonlyArray<string | { readonly id: string; readonly name?: string; readonly sha256?: string }> | null;
  readonly memory_stores?: ReadonlyArray<{ readonly id: string; readonly access?: "read_write" | "read_only" | ""; readonly name?: string; readonly description?: string }> | null;
  readonly automation?: {
    readonly automation_id: string;
    readonly revision_id: string;
    readonly run_id: string;
    readonly trigger: string;
    readonly event?: unknown;
  } | null;
}

/** `answer`'s payload (CONTRACT §3.3): an approval's decision, a question's answer, or a custom tool's result. */
export interface AnswerPayload {
  readonly ask_id: string;
  readonly decision?: "allow" | "deny";
  readonly message?: string;
  readonly text?: string;
  readonly content?: string;
  readonly is_error?: boolean;
}

/** One mail as Cloud delivers it (Caveman Cloud API Mail, plus `payload`). */
export interface SessionMail {
  readonly id: string;
  readonly verb: string;
  readonly authority: string;
  readonly channel: string;
  readonly to_workspace_id: string | null;
  readonly body: string;
  readonly wakes: boolean;
  readonly payload?: unknown;
  readonly created_at: string;
}

/** A public event as Cloud stores it (§3.4): `seq` orders a session's events and makes a repost harmless. */
export interface PostedEvent {
  readonly seq: number;
  readonly type: string;
  readonly created_at: string;
  readonly data: unknown;
}

interface Init {
  readonly json?: unknown;
  readonly body?: Uint8Array | FormData;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

/** One call to /api/v1/code/<path> with the runtime's token, minted again once when Cloud refused a stale one. */
async function call(identity: Identity, state: LinkState, method: string, path: string, init: Init = {}, fetchImpl: typeof fetch = fetch) {
  const send = (token: string) =>
    fetchImpl(`${identity.cloudUrl}/api/v1/code/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.body instanceof Uint8Array ? { "content-type": "application/octet-stream" } : {}),
        ...init.headers,
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
    });
  const response = await withRuntimeToken(identity, state, fetchImpl, send);
  if (!response.ok) throw await cloudFailure(response);
  return response;
}

const json = async <T>(response: Response) => (response.status === 204 ? undefined : ((await response.json()) as T)) as T;
const enc = encodeURIComponent;

// ------------------------------------------------------------------ mail

/** The session mail for workspaces on this computer, leased for delivery. */
export async function takeSessionMail(identity: Identity, state: LinkState, fetchImpl?: typeof fetch) {
  const out = await call(identity, state, "POST", `mail/deliveries?channel=${SESSION_CHANNEL}`, { json: {} }, fetchImpl).then((r) =>
    json<{ lease_token: string | null; messages: Array<SessionMail> | null }>(r),
  );
  return { lease: out.lease_token, messages: (out.messages ?? []).filter((m) => m.channel === SESSION_CHANNEL) };
}

export const ackSessionMail = (identity: Identity, state: LinkState, lease: string, ids: ReadonlyArray<string>, fetchImpl?: typeof fetch) =>
  call(identity, state, "POST", "mail/deliveries/ack", { json: { lease_token: lease, ids } }, fetchImpl).then((r) => json<{ delivered: Array<string>; lost: Array<string> }>(r));

// ------------------------------------------------------------------ agents

/** An agent version a session on this computer names: the file the one agent loader reads, and its digest. */
export const getAgentVersion = (identity: Identity, state: LinkState, agentId: string, version: number, fetchImpl?: typeof fetch) =>
  call(identity, state, "GET", `runtime/agents/${enc(agentId)}/versions/${version}`, {}, fetchImpl).then((r) => json<{ file: string; file_sha256: string }>(r));

// ------------------------------------------------------------------ events and traces

/** A batch of public events; Cloud keeps each `seq` once, so a batch sent twice changes nothing. */
export const postSessionEvents = (identity: Identity, state: LinkState, sessionId: string, events: ReadonlyArray<PostedEvent>, fetchImpl?: typeof fetch) =>
  call(identity, state, "POST", `runtime/sessions/${enc(sessionId)}/events`, { json: { events } }, fetchImpl).then(() => undefined);

/** One model call of a session on this computer, as Cloud's meter takes it (control-api code/tree.go UsageEvent). */
export interface SessionUsageEvent {
  /** The call's own id: Cloud records each (session, request_id) once, so a report sent twice charges nothing twice. */
  readonly request_id: string;
  /** Cloud's session id. */
  readonly session_id: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly routed: boolean;
  /** Null when nothing is measured (a plan's turn); list_price is computed from tokens, not billed. */
  readonly cost: { readonly usd: number; readonly basis: "billed" | "list_price" } | null;
  readonly occurred_at: string;
}

/** Cloud's answer: what it recorded, what it refused for good, and the tree budgets it charged. */
export interface SessionUsageAccepted {
  readonly accepted: number;
  readonly duplicates: number;
  readonly refused: ReadonlyArray<{ readonly request_id: string; readonly session_id: string; readonly code: string; readonly message: string }> | null;
  readonly budgets: ReadonlyArray<{ readonly tree_id: string; readonly limit_usd: number; readonly spent_usd: number; readonly parked: boolean }> | null;
}

/**
 * Up to 100 calls of sessions on this computer: the meter that charges each session's tree budget (and what the
 * session object's `usage` sums). A tree whose spend reached its limit comes back `parked`.
 */
export const postSessionUsage = (identity: Identity, state: LinkState, events: ReadonlyArray<SessionUsageEvent>, fetchImpl?: typeof fetch) =>
  call(identity, state, "POST", "runtime/usage", { json: { events } }, fetchImpl).then((r) => json<SessionUsageAccepted>(r));

/** OTLP/JSON spans (an ExportTraceServiceRequest) for the session's service account's Cloud project. */
export const postTraces = (identity: Identity, state: LinkState, body: unknown, fetchImpl?: typeof fetch) =>
  call(identity, state, "POST", "runtime/traces", { json: body }, fetchImpl).then(() => undefined);

// ------------------------------------------------------------------ files

/** An input file attached to a session on this computer, as bytes. */
export const getFileContent = (identity: Identity, state: LinkState, fileId: string, fetchImpl?: typeof fetch) =>
  call(identity, state, "GET", `runtime/files/${enc(fileId)}/content`, { timeoutMs: UPLOAD_TIMEOUT_MS }, fetchImpl).then(async (r) => ({
    bytes: new Uint8Array(await r.arrayBuffer()),
    name: r.headers.get("x-caveman-file-name") ?? fileNameOf(r.headers.get("content-disposition")),
  }));

/** One file the session wrote under its outputs, uploaded (multipart, one file per request). */
export const postOutput = (
  identity: Identity,
  state: LinkState,
  sessionId: string,
  file: { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string },
  fetchImpl?: typeof fetch,
) => {
  const form = new FormData();
  form.set("path", file.path);
  form.set("sha256", file.sha256);
  form.set("file", new Blob([file.bytes as Uint8Array<ArrayBuffer>]), file.path.split("/").pop() ?? "output");
  return call(identity, state, "POST", `runtime/sessions/${enc(sessionId)}/outputs`, { body: form, timeoutMs: UPLOAD_TIMEOUT_MS }, fetchImpl).then((r) =>
    json<{ id: string; path?: string; bytes?: number }>(r),
  );
};

/** `attachment; filename="report.csv"` -> report.csv; undefined when Cloud named none. */
export function fileNameOf(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1]!.trim());
  return /filename="?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

// ------------------------------------------------------------------ memory stores

export interface StoredMemory {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly updated_at?: string;
}

/** A store's memories as this session attached it (`session_id`: its attachment decides read_only). */
const memories = (storeId: string, sessionId: string, query = "") => `runtime/memory-stores/${enc(storeId)}/memories?session_id=${enc(sessionId)}${query}`;

/** Every memory in a store this session attached, with content (a page holds at most 100; memories are at most 100 KB). */
export async function listMemories(identity: Identity, state: LinkState, storeId: string, sessionId: string, fetchImpl?: typeof fetch) {
  const out: Array<StoredMemory> = [];
  let after: string | undefined;
  for (;;) {
    const page = await call(identity, state, "GET", memories(storeId, sessionId, `&include_content=true&limit=100${after ? `&after=${enc(after)}` : ""}`), {}, fetchImpl).then((r) =>
      json<{ memories: Array<StoredMemory> | null; next_cursor?: string | null }>(r),
    );
    out.push(...(page.memories ?? []));
    if (!page.next_cursor || page.next_cursor === after) return out;
    after = page.next_cursor;
  }
}

/**
 * Writes one memory. `if_sha256` is the version it was read at: Cloud answers 409 when another writer changed it
 * since; "" means it must not exist yet.
 */
export const putMemory = (
  identity: Identity,
  state: LinkState,
  storeId: string,
  sessionId: string,
  input: { readonly path: string; readonly content: string; readonly if_sha256: string },
  fetchImpl?: typeof fetch,
) => call(identity, state, "PUT", memories(storeId, sessionId), { json: input }, fetchImpl).then((r) => json<StoredMemory>(r));

export const deleteMemory = (identity: Identity, state: LinkState, storeId: string, sessionId: string, path: string, ifSha256: string, fetchImpl?: typeof fetch) =>
  call(identity, state, "DELETE", memories(storeId, sessionId, `&path=${enc(path)}&if_sha256=${enc(ifSha256)}`), {}, fetchImpl).then(() => undefined);

/** Cloud's refusal code, when it sent one. */
export const codeOf = (error: unknown) => (error instanceof CloudError ? error.code : undefined);
export const statusOf = (error: unknown) => (error instanceof CloudError ? error.status : undefined);
