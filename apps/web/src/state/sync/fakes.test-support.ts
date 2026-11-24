// In-memory stand-ins for the sync tests: Caveman Cloud's chat routes (list, device stream, copy, calls) and a
// runtime's Session Protocol client. They play the contract (CONTRACT §1, §3), not any implementation.
import type { Client, AttachOptions, Subscription } from "@caveman-app/session-protocol/client";
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import type { Session, SessionEvent } from "@caveman-app/session-protocol";
import type { CloudApi } from "./cloud-api.ts";
import { CloudError } from "./cloud-api.ts";
import type { Kv } from "./kv.ts";
import type { CallState, ChatSummary, CopyPage, DirectAdvert, PersonState, RuntimeState } from "./wire.ts";

const at = "2026-10-21T12:00:00.000Z";

export const event = (session_id: string, cursor: number, text = `e${cursor}`): SessionEvent =>
  ({ session_id, cursor, at, type: "message.delta", payload: { text } }) as SessionEvent;

export const summary = (session_id: string, over: Partial<ChatSummary> = {}): ChatSummary => ({
  session_id,
  workspace_id: `w-${session_id}`,
  runtime_id: "rt-cloud-1",
  computer_id: "c-1",
  where: { kind: "cloud", name: "Cloud computer 1" },
  title: `Chat ${session_id}`,
  engine: "caveman",
  repo: "acme/app",
  branch: "main",
  kind: "chat",
  status: "idle",
  last_activity_at: at,
  epoch: 1,
  head: 0,
  synced_through: 0,
  archived: false,
  person: { seen_cursor: 0, pinned: false },
  calls: [],
  seq: 0,
  ...over,
});

export const runtime = (runtime_id: string, over: Partial<RuntimeState> = {}): RuntimeState => ({
  runtime_id,
  computer_id: `c-${runtime_id}`,
  kind: "cloud",
  name: runtime_id,
  online: true,
  last_seen_at: at,
  ...over,
});

type Change = { readonly seq: number; readonly event: string; readonly data: unknown };

export function fakeCloud() {
  const chats = new Map<string, ChatSummary>();
  const runtimes = new Map<string, RuntimeState>();
  const log: Change[] = [];
  let seq = 0;
  /** Changes at or before this seq are forgotten: a stream from before it gets `reset`. */
  let retainedAfter = 0;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const frame = (c: Change) => encoder.encode(`id: ${c.seq}\nevent: ${c.event}\ndata: ${JSON.stringify(c.data)}\n\n`);
  const copies = new Map<string, { epoch: number; events: SessionEvent[] }>();
  const calls = new Map<string, CallState>();
  const posted: Array<{ session: string; request_id: string; method: string }> = [];
  const streamAfters: number[] = [];
  const streamActive: boolean[] = [];
  /** Streams that stay silent (no keepalive): a half-open socket. */
  let silent = false;
  let lists = 0;
  let down = false;
  const wakeHints: Array<{ computerId: string; reason: string }> = [];
  /** Every computer a device asked Cloud to run (POST computers/{id}/resume). */
  const resumes: string[] = [];
  const moves: Array<{ session: string; to: unknown }> = [];
  /** What each move posted beside `to` (its request id and the device's signature). */
  const moveExtras: Array<Readonly<Record<string, unknown>> | undefined> = [];
  const latencyReports: unknown[] = [];

  const change = (event: string, data: unknown) => {
    const c = { seq: ++seq, event, data };
    log.push(c);
    for (const s of streams) s.enqueue(frame(c));
    return c.seq;
  };

  /** What the install says about direct channels (S14), on the list; unset: nothing, as an older Cloud. */
  const advert: { direct?: DirectAdvert } = {};
  const api: CloudApi = {
    list: async () => {
      if (down) throw new TypeError("fetch failed");
      lists++;
      return { chats: [...chats.values()], runtimes: [...runtimes.values()], seq, ...(advert.direct ? { direct: advert.direct } : {}) };
    },
    stream: async (after, signal, active) => {
      if (down) throw new TypeError("fetch failed");
      streamAfters.push(after);
      streamActive.push(active === true);
      let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller;
          if (after < retainedAfter) controller.enqueue(encoder.encode(`event: reset\ndata: {}\n\n`));
          else for (const c of log) if (c.seq > after) controller.enqueue(frame(c));
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
          if (!silent) streams.add(controller);
        },
        cancel() {
          if (mine) streams.delete(mine);
        },
      });
      // As fetch does: an abort errors the body, whether or not anything still writes to it.
      signal.addEventListener("abort", () => {
        if (!mine) return;
        streams.delete(mine);
        try {
          mine.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
    setState: async (id, patch) => {
      const chat = chats.get(id);
      if (!chat) throw new CloudError(404, "cave_code_chat_not_found", "no chat");
      const person: PersonState = {
        ...chat.person,
        ...(patch.seen_cursor !== undefined ? { seen_cursor: Math.max(chat.person.seen_cursor, patch.seen_cursor) } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      };
      put({ ...chat, person });
      return person;
    },
    events: async (id, epoch, after, limit = 2000) => {
      if (down) throw new TypeError("fetch failed");
      const copy = copies.get(id) ?? { epoch: 1, events: [] };
      const through = copy.events.length;
      if (epoch !== copy.epoch) return { epoch: copy.epoch, through, events: [], more: false, reset: true } satisfies CopyPage;
      const page = copy.events.filter((e) => e.cursor > after).slice(0, limit);
      return {
        epoch: copy.epoch,
        through,
        events: page.map((e) => ({ cursor: e.cursor, type: e.type, at: e.at, event: e })),
        more: page.length > 0 && page[page.length - 1]!.cursor < through,
      } satisfies CopyPage;
    },
    call: async (id, request_id, method) => {
      if (down) throw new TypeError("fetch failed");
      posted.push({ session: id, request_id, method });
      const key = `${id}/${request_id}`;
      const known = calls.get(key);
      if (known) return known;
      const state: CallState = { id: `call-${calls.size + 1}`, request_id, method, status: "queued", created_at: at };
      calls.set(key, state);
      return state;
    },
    callState: async (id, requestId) => {
      if (down) throw new TypeError("fetch failed");
      const known = calls.get(`${id}/${requestId}`);
      if (!known) throw new CloudError(404, "cave_code_call_not_found", "no call");
      return known;
    },
    move: async (id, to, extra) => (moves.push({ session: id, to }), moveExtras.push(extra), { pending: true }),
    resume: async (computerId) => void resumes.push(computerId),
    update: async () => undefined,
    wakeHint: async (computerId, reason) => void wakeHints.push({ computerId, reason }),
    latency: async (report) => void latencyReports.push(report),
  };

  const put = (chat: ChatSummary) => {
    const next = { ...chat, seq: seq + 1 };
    chats.set(chat.session_id, next);
    change("chat", next);
    return next;
  };

  return {
    api,
    advert,
    chats,
    posted,
    wakeHints,
    resumes,
    /** The calls Cloud holds, one per request id however often it was posted: `session/request_id`. */
    queued: () => [...calls.keys()],
    moves,
    moveExtras,
    latencyReports,
    streamAfters,
    streamActive,
    /** New streams go quiet after their first bytes, as over a socket a network change left half open. */
    goSilent: (value: boolean) => (silent = value),
    lists: () => lists,
    seq: () => seq,
    put,
    gone(session_id: string) {
      chats.delete(session_id);
      change("gone", { session_id });
    },
    runtime(state: RuntimeState) {
      runtimes.set(state.runtime_id, state);
      change("runtime", state);
    },
    /** Forget the change log through now: a device resuming from before gets `reset`. */
    compact() {
      retainedAfter = seq;
      log.length = 0;
    },
    /** End every open stream, as a restart of Cloud would. */
    dropStreams() {
      for (const s of streams) s.close();
      streams.clear();
    },
    setDown(value: boolean) {
      down = value;
    },
    /** Cloud queued a chat's start with its placement (POST workspaces with `start`): it holds that call. */
    startCall(session: string, call: CallState) {
      calls.set(`${session}/${call.request_id}`, call);
    },
    /** Cloud handed a queued call to the chat's computer, which has not posted its result yet: Cloud still holds it. */
    delivered(session: string, requestId: string) {
      const key = `${session}/${requestId}`;
      const known = calls.get(key);
      if (known) calls.set(key, { ...known, status: "delivered" });
    },
    /** The chat's computer ran a queued call and posted its result (or Cloud gave up on it): Cloud holds it no more. */
    ran(session: string, requestId: string, status: "done" | "failed" | "expired" = "done") {
      const key = `${session}/${requestId}`;
      const known = calls.get(key);
      if (known) calls.set(key, { ...known, status });
    },
    openStreams: () => streams.size,
    copy(session: string, epoch: number, events: SessionEvent[]) {
      copies.set(session, { epoch, events });
    },
  };
}

/**
 * A runtime's client for one or more chats: a journal per session with an epoch, attach with (epoch, cursor) and
 * reset, live appends, the runtime ending a subscription, refusals, and a link that drops.
 */
export function fakeRuntimeClient() {
  const journals = new Map<string, { epoch: number; events: SessionEvent[] }>();
  type Sub = { session: string; cursor: number; onEvent: (e: SessionEvent) => void; options: AttachOptions; active: boolean };
  const subs = new Set<Sub>();
  const attaches: Array<{ session: string; cursor: number; epoch: number | undefined }> = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let refuse: string | undefined;
  const journal = (session: string) => {
    let j = journals.get(session);
    if (!j) journals.set(session, (j = { epoch: 1, events: [] }));
    return j;
  };
  const client: Client = {
    async call(method, params) {
      calls.push({ method, params });
      return {} as never;
    },
    async attach(session, cursor, onEvent, options) {
      const opts: AttachOptions = typeof options === "function" ? { onError: options } : (options ?? {});
      attaches.push({ session, cursor, epoch: opts.epoch });
      if (refuse) throw new SessionProtocolError({ code: -32001, message: refuse, data: { reason: refuse as "not_found" } });
      const j = journal(session);
      const sub: Sub = { session, cursor, onEvent, options: opts, active: true };
      const reset = (opts.epoch !== undefined && opts.epoch !== j.epoch) || cursor > j.events.length;
      if (reset) {
        sub.cursor = 0;
        opts.onReset?.(j.epoch);
      }
      subs.add(sub);
      opts.onState?.("live");
      queueMicrotask(() => {
        for (const e of j.events) if (e.cursor > sub.cursor && sub.active) (sub.cursor = e.cursor), onEvent(e);
      });
      const result: Subscription = {
        session: { id: session, workspace_id: `w-${session}`, engine: "caveman", state: "live", head: j.events.length, created_at: at, updated_at: at } as unknown as Session,
        cursor: () => sub.cursor,
        epoch: () => j.epoch,
        detach: async () => {
          sub.active = false;
          subs.delete(sub);
        },
      };
      return result;
    },
    on: () => () => undefined,
    hello: () => undefined,
    onHello: () => () => undefined,
    close: () => undefined,
  };
  return {
    client,
    attaches,
    calls,
    journal,
    active: () => [...subs].filter((s) => s.active).length,
    append(session: string, text?: string) {
      const j = journal(session);
      const e = event(session, j.events.length + 1, text);
      j.events.push(e);
      for (const s of subs) if (s.active && s.session === session && e.cursor === s.cursor + 1) (s.cursor = e.cursor), s.onEvent(e);
      return e;
    },
    /** The journal rewritten under a new epoch; live subscriptions get reset and the new events. */
    rewrite(session: string, texts: string[]) {
      const j = journal(session);
      j.epoch++;
      j.events = texts.map((t, i) => event(session, i + 1, t));
      for (const s of subs) {
        if (!s.active || s.session !== session) continue;
        s.cursor = 0;
        s.options.onReset?.(j.epoch);
        for (const e of j.events) (s.cursor = e.cursor), s.onEvent(e);
      }
    },
    /** The runtime ends every subscription with `reason`. */
    end(reason: string) {
      for (const s of [...subs]) {
        s.active = false;
        subs.delete(s);
        s.options.onError?.(new SessionProtocolError({ code: -32010, message: reason, data: { reason: reason as "lease_lost" } }));
      }
    },
    linkDown() {
      for (const s of subs) s.options.onState?.("reconnecting");
    },
    refuse: (reason: string | undefined) => (refuse = reason),
  };
}

/**
 * `kv` as IndexedDB applies what is asked of it: each read and write its own transaction, applied a task later, in the
 * order made (a value copied as it is asked to be written). memoryKv applies each at once, which hides a write that
 * lands after one made later than it.
 */
export function idbOrderedKv<K extends Kv>(kv: K): K {
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = <T,>(op: () => Promise<T>): Promise<T> => {
    const next = last.then(() => new Promise<void>((applied) => setTimeout(applied, 0))).then(op);
    last = next.catch(() => undefined);
    return next;
  };
  return {
    ...kv,
    get: <T,>(key: string) => inTurn(() => kv.get<T>(key)),
    scan: <T,>(prefix: string) => inTurn(() => kv.scan<T>(prefix)),
    put: (key: string, value: unknown) => {
      const copy = structuredClone(value);
      return inTurn(() => kv.put(key, copy));
    },
    delete: (key: string) => inTurn(() => kv.delete(key)),
    batch: (writes: ReadonlyArray<readonly [string, unknown]>, deletes?: ReadonlyArray<string>) => {
      const copies = writes.map(([key, value]) => [key, structuredClone(value)] as const);
      return inTurn(() => kv.batch(copies, deletes));
    },
    clear: (prefix: string) => inTurn(() => kv.clear(prefix)),
  };
}

export const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
