// The person's chat routes on Caveman Cloud (CONTRACT §3), from either kind of device:
// - the web build Cloud serves: same origin, the HttpOnly session cookie, a CSRF header on writes;
// - the desktop: Cloud's own origin with a short-lived bearer its runtime mints (cloud.client_token).
import type { LatencyReport } from "./latency.ts";
import type { CallState, ChatCallMethod, ChatList, ChatSummary, CopyPage, PersonState, PersonStatePatch, RuntimeState } from "./wire.ts";

export interface CloudAuth {
  /** Origin of Cloud's API ("" = this page's own). */
  readonly base: string;
  /** Headers for a request: a bearer on the desktop, nothing on the web (the cookie rides along). */
  readonly headers: () => Promise<Record<string, string>>;
  /** The credential was refused: renew it (a fresh cookie, a new token). False when only signing in again helps. */
  readonly renew: () => Promise<boolean>;
  /** "same-origin" sends the cookie (web); "omit" never does (desktop). */
  readonly credentials: RequestCredentials;
}

/** Cloud answered with an error: its code (`cave_code_...`), plain message and details when it sent them. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The envelope's `details`: a credits refusal's `reason` and `resets_at`. */
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(status: number, code: string | undefined, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Cloud's sign-in for this device ended: sign in again. */
export class SignedOut extends CloudError {
  constructor() {
    super(401, "unauthorized", "Your Caveman sign-in ended. Sign in again.");
    this.name = "SignedOut";
  }
}

/** The web build's own Cloud: same origin, cookie, renew through /api/v1/auth/refresh. */
export const cookieAuth = (fetchImpl: typeof fetch = fetch): CloudAuth => ({
  base: "",
  headers: async () => ({}),
  renew: async () => (await fetchImpl("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin", headers: { "x-cave-csrf": "1" } }).catch(() => undefined))?.ok === true,
  credentials: "same-origin",
});

/**
 * Who the web build's cookie signs in, as `org:user` (GET /api/v1/auth/me): whose part of the device store this tab
 * reads (F-1). Null when nobody is signed in; throws when Cloud cannot say now.
 */
export async function webPerson(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const ask = () => fetchImpl("/api/v1/auth/me", { headers: { accept: "application/json" }, credentials: "same-origin" });
  let response = await ask();
  // The cookie may only need renewing, as for every other route.
  if (response.status === 401 && (await cookieAuth(fetchImpl).renew())) response = await ask();
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new CloudError(response.status, undefined, `Caveman answered ${response.status}`);
  const me = (await response.json()) as { user?: { id?: unknown; organization_id?: unknown } };
  const { id, organization_id } = me.user ?? {};
  return typeof id === "string" && id !== "" && typeof organization_id === "string" && organization_id !== "" ? `${organization_id}:${id}` : null;
}

export interface CloudApi {
  /** The person's chats: open ones, or with `archived` only archived ones (the Delete dialog's kept work, A-7). */
  list(archived?: boolean): Promise<ChatList>;
  /**
   * The device stream (SSE) from `after`; the caller reads it with readEvents (sse.ts). `active`: the person is at
   * this device (presence.ts), which Cloud counts toward keeping their computers awake (F-7).
   */
  stream(after: number, signal: AbortSignal, active?: boolean): Promise<Response>;
  setState(sessionId: string, patch: PersonStatePatch): Promise<PersonState>;
  events(sessionId: string, epoch: number, after: number, limit?: number): Promise<CopyPage>;
  /** `extra`: fields beside the call's own (a device id for a laptop to approve it by, S13). */
  call(sessionId: string, requestId: string, method: ChatCallMethod, params: unknown, extra?: Readonly<Record<string, unknown>>): Promise<CallState>;
  callState(sessionId: string, requestId: string): Promise<CallState>;
  /** `extra`: the request id and this device's signature over the move, for a Mac to let the chat go by (S-R4). */
  move(sessionId: string, to: "cloud" | { readonly computer_id: string }, extra?: Readonly<Record<string, unknown>>): Promise<{ pending: boolean }>;
  resume(computerId: string): Promise<void>;
  /**
   * Moves a Cloud computer onto the install's current image (an idle one sleeps and wakes on it now, a busy one at its
   * next wake): the desktop tab's Update now on a computer whose image predates the desktop.
   */
  update(computerId: string): Promise<void>;
  /** S14: resume an asleep Cloud computer because the person is about to need it (wake.ts; bounded on both sides). */
  wakeHint(computerId: string, reason: "typing" | "open"): Promise<void>;
  /** S14: this device's measured p50/p95 per path (latency.ts). */
  latency(report: LatencyReport): Promise<void>;
}

export type { ChatSummary, RuntimeState };

/**
 * A copy read that hears nothing from Cloud for this long (no answer, no more of its body) is on a dead socket: it
 * fails, so the chat's next copy read is not held behind it (ChatFeed reads one at a time).
 */
export const COPY_SILENT_MS = 30_000;

/**
 * One request to Cloud as this device's person: its headers, one renewal on a 401, and a refusal thrown as CloudError
 * with Cloud's own sentence. Every Cloud route a client calls goes through it.
 */
export const cloudRequester =
  (auth: CloudAuth, fetchImpl: typeof fetch = fetch) =>
  async (path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> => {
    const go = async () => {
      const headers: Record<string, string> = { accept: "application/json", ...(await auth.headers()) };
      if (init.method && init.method !== "GET") Object.assign(headers, { "content-type": "application/json", "x-cave-csrf": "1" });
      return fetchImpl(`${auth.base}${path}`, { ...init, headers, credentials: auth.credentials, ...(signal ? { signal } : {}) });
    };
    let response = await go();
    if (response.status === 401 && (await auth.renew())) response = await go();
    if (response.status === 401) throw new SignedOut();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string }; code?: string; message?: string } | null;
      const code = body?.error?.code ?? body?.code;
      throw new CloudError(response.status, code, body?.error?.message ?? body?.message ?? `Caveman answered ${response.status}`);
    }
    return response;
  };

export function cloudApi(auth: CloudAuth, fetchImpl: typeof fetch = fetch): CloudApi {
  const request = cloudRequester(auth, fetchImpl);
  const json = async <T,>(path: string, init?: RequestInit): Promise<T> => (await request(path, init)).json() as Promise<T>;
  /** A GET read while Cloud keeps saying something: aborted after `silentMs` with no answer or no more of its body. */
  const heardJson = async <T,>(path: string, silentMs: number): Promise<T> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(new Error("Caveman stopped answering.")), silentMs);
    };
    heard();
    try {
      const response = await request(path, {}, abort.signal);
      if (!response.body) return (await response.json()) as T;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        heard();
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as T;
    } finally {
      clearTimeout(timer);
    }
  };
  const chat = (id: string) => `/api/v1/code/chats/${encodeURIComponent(id)}`;
  return {
    list: (archived = false) => json<ChatList>(`/api/v1/code/chats?archived=${archived}`),
    stream: (after, signal, active) => request(`/api/v1/code/chats/stream?after=${after}${active ? "&active=1" : ""}`, { headers: { accept: "text/event-stream" } }, signal),
    setState: (id, patch) => json<PersonState>(`${chat(id)}/state`, { method: "PUT", body: JSON.stringify(patch) }),
    events: (id, epoch, after, limit = 2000) => heardJson<CopyPage>(`${chat(id)}/events?epoch=${epoch}&after=${after}&limit=${limit}`, COPY_SILENT_MS),
    call: (id, request_id, method, params, extra) => json<CallState>(`${chat(id)}/calls`, { method: "POST", body: JSON.stringify({ ...extra, request_id, method, params }) }),
    callState: (id, requestId) => json<CallState>(`${chat(id)}/calls/${encodeURIComponent(requestId)}`),
    move: (id, to, extra) => json<{ pending: boolean }>(`${chat(id)}/move`, { method: "POST", body: JSON.stringify({ ...extra, to }) }),
    resume: async (computerId) => void (await request(`/api/v1/code/computers/${encodeURIComponent(computerId)}/resume`, { method: "POST", body: "{}" })),
    update: async (computerId) => void (await request(`/api/v1/code/computers/${encodeURIComponent(computerId)}/update`, { method: "POST", body: "{}" })),
    wakeHint: async (computerId, reason) => void (await request(`/api/v1/code/computers/${encodeURIComponent(computerId)}/wake-hint`, { method: "POST", body: JSON.stringify({ reason }) })),
    latency: async (report) => void (await request("/api/v1/code/telemetry/latency", { method: "POST", body: JSON.stringify(report) })),
  };
}

/** One server-sent event. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

/**
 * The events of a text/event-stream body, as they arrive (fetch, so the desktop can send a bearer, which EventSource
 * cannot). Comments (keepalives) are skipped. Ends when the body does.
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
        // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
        if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
          event = "message";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? "" : line.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
