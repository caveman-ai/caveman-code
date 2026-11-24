// Sending, stopping and answering in a chat from any device, exactly once (S5). The runtime that holds the chat gets
// the call directly while this device reaches it; otherwise Cloud queues it (POST /code/chats/{id}/calls), wakes a
// Cloud computer or moves a sleeping Mac's chat to one (S12), and the runtime runs it with the same request id, so one
// that went both ways runs once (its receipt answers the repeat). Every call waits in this device's outbox from the
// moment it is sent until its runtime answered it or Cloud took it, so a reload or a crash sends it on, in order (resend).
// A call handed to a runtime that does not go out within UNSENT_MS (the relay
// cannot reach it although Cloud still lists it online), or that loses the connection it went out on for as long
// before its answer comes, is taken back and queued in Cloud instead (X-3), as is one the runtime turned away because
// the chat is moving (CHAOS-15).
import type { Outbox, OutboxEntry } from "@caveman-app/session-protocol/client";
import { CallNotSent, outboxAt, SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import type { CloudApi } from "./cloud-api.ts";
import { CloudError, SignedOut } from "./cloud-api.ts";
import type { CallState, ChatCallMethod } from "./wire.ts";

/** The second answer to one ask: someone answered it first, here or on another device. */
export class AnsweredElsewhere extends Error {
  constructor() {
    super("Answered on another device");
    this.name = "AnsweredElsewhere";
  }
}

/**
 * Where one call goes. To a runtime (`runtime`, its id when Cloud lists it, on `computer`): `epoch` is the chat's journal epoch now
 * (kept with the call in the outbox, so it is never resent into a rewritten journal); `orCloud`, Cloud can queue it
 * instead if it does not go out in time. Without it, Cloud cannot carry the call: only that runtime's connection does.
 */
export type Route =
  | { readonly via: "runtime"; readonly client: Client; readonly runtime?: string; readonly computer?: string; readonly epoch?: number; readonly orCloud?: boolean }
  | { readonly via: "cloud" };

/** How long a call handed to a runtime may wait for its socket before it goes to Cloud's queue instead (X-3). */
export const UNSENT_MS = 3_000;

/**
 * The oldest call that never went out on a runtime's connection that a reload still posts to Cloud's queue: a day, as
 * long as Cloud keeps a queued call. One older (a device signed out for longer) would have expired in Cloud's queue,
 * and once Cloud has forgotten a finished call (a week) the same request id would run again, long after its person
 * moved on.
 */
export const QUEUE_RESEND_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * The oldest call that went out on a runtime's connection with no answer that a reload still sends on: as long as the
 * client would send it again on a new socket (hub.ts resendable). It may have run, and must not run again hours later
 * (X-3).
 */
export const RESEND_OUT_WITHIN_MS = 10 * 60_000;

/** A call queued in Cloud, as the device signs it (S13): `params` exactly as posted, after a JSON round trip. */
export interface QueuedCallBody {
  readonly session_id: string;
  readonly request_id: string;
  readonly method: ChatCallMethod;
  readonly params: unknown;
}

export type SendOutcome = { readonly via: "runtime"; readonly result: unknown } | { readonly via: "cloud"; readonly call: CallState };

export interface SenderOptions {
  readonly api: CloudApi;
  /**
   * Where every call waits from the moment it is sent until its runtime answered it or Cloud took it (outbox.ts, scope
   * "cloud"): what a closed page left there goes to Cloud's queue from the next one (resend).
   */
  readonly outbox: Outbox;
  /** A call Cloud took after a reload resent it, with the params it was made with (a send's text, to show again). */
  readonly onQueued?: (sessionId: string, call: CallState, params: unknown) => void;
  readonly retryMs?: (attempt: number) => number;
  /** Fields added to every call queued in Cloud (device_hooks.ts: the device's signature over it). */
  readonly callFields?: (call: QueuedCallBody) => Promise<Readonly<Record<string, unknown>>>;
  /**
   * Whether a call that went out on `runtime`'s connection with no answer may go out again after a reload, as the
   * client asks before it resends one (hub.ts resendable: not once its chat runs elsewhere or on another epoch). None:
   * only RESEND_OUT_WITHIN_MS.
   */
  readonly resendable?: (runtime: string, entry: OutboxEntry) => boolean | Promise<boolean>;
  /** Test seam: UNSENT_MS. */
  readonly unsentMs?: number;
}

/** Where a queued call's chat runs, as its status line names it. */
export interface CallPlace {
  readonly name: string;
  /** A Cloud computer wakes for a queued call; a Mac does not. */
  readonly cloud: boolean;
}

/**
 * The quiet line under a send (or stop, or answer) queued in Cloud, while it waits: "Queued · waking api-box",
 * "Waiting for Julius's MacBook", why it cannot move, "Delivered · api-box"; null once it ran.
 */
export function queuedLine(call: Pick<CallState, "status" | "waiting" | "error">, where: CallPlace): string | null {
  if (call.status === "queued" && call.waiting?.reason === "not_movable") return call.waiting.detail ?? `Waiting for ${where.name}. This chat cannot move to a Cloud computer.`;
  if (call.status === "queued" && call.waiting?.reason === "laptop_asleep") return `Waiting for ${where.name}`;
  if (call.status === "queued") return where.cloud ? `Queued · waking ${where.name}` : `Queued · ${where.name}`;
  if (call.status === "delivered") return `Delivered · ${where.name}`;
  if (call.status === "expired") return "Not delivered: it waited a day.";
  if (call.status === "failed") return call.error?.code === "invalid_state" && call.error.message.includes("answered") ? "Answered on another device" : (call.error?.message ?? "Not delivered");
  return null;
}

/**
 * One chat's calls from this device. The runtime runs what its connection brings at once and what Cloud's queue hands
 * it as it comes, with no order between the two, so the lane keeps the order across them: once a call heads for Cloud's
 * queue, the chat's calls still on a runtime's connection go there too, in the order sent, and later ones follow them
 * until Cloud ran them.
 */
interface Lane {
  /** The newest call is out (on the runtime's connection, or queued in Cloud): the next one goes then. */
  out: Promise<unknown>;
  /**
   * Every call so far that Cloud could carry went its way for good: answered or given up on the runtime's connection,
   * or queued in Cloud. One it could not carry (no orCloud) may wait for its runtime without bound: none waits for it.
   */
  settled: Promise<unknown>;
  /**
   * The chat's calls on their way into Cloud's queue from here ("heading": later ones follow, whatever Cloud says now)
   * or in it ("queued"), that Cloud may not have handed over and run yet, oldest first.
   */
  readonly inCloud: Map<string, "heading" | "queued">;
  /** The chat's calls on a runtime's connection that Cloud could carry instead, unanswered: how to take each back. */
  readonly onRuntime: Map<string, AbortController>;
}

/** A call as the sender's outbox keeps it (OutboxEntry.params). */
interface Held {
  readonly session_id: string;
  readonly call: { readonly request_id: string };
  /**
   * It may have gone out on a runtime's connection and has no answer yet, as the client means it (CallOptions.wentOut,
   * a restored entry): that connection's outbox holds it, so it may go out at any moment, and this mark is kept before
   * it can (onKept). It may have run, so it goes again only as a resend would. A reload sends it to Cloud's queue only
   * within RESEND_OUT_WITHIN_MS, the client's own resend window, and only while `resendable` says the client would
   * send it again: its chat still runs on `runtime` (the entry's `epoch` is the chat's when it went out).
   */
  readonly wentOut?: true;
  readonly runtime?: string;
  /** The computer `runtime` was on: a Cloud computer wakes under a new runtime id, and is the same place (hub.ts resendable). */
  readonly computer?: string;
  /**
   * Cloud cannot carry it: its route has no orCloud (the desktop's own runtime, a Mac that has not allowed this device,
   * a chat Cloud does not list), so only its runtime's connection takes it. It waits here only until that connection's
   * outbox holds it, and a reload never posts it to Cloud's queue.
   */
  readonly noCloud?: true;
}

/** Cloud cannot carry a call that goes this way (Held.noCloud). */
const noCloud = (route: Route): boolean => route.via === "runtime" && route.orCloud !== true;
const markedNoCloud = (entry: OutboxEntry): boolean => (entry.params as Held).noCloud === true;

export class ChatSender {
  private readonly lanes = new Map<string, Lane>();
  /** Calls sent here before the outbox was read for what a closed page left: this page's own, not left over. */
  private fresh: Set<string> | undefined = new Set();
  /** The calls a closed page left in the outbox, sent again chat by chat: a chat's first call here waits for its own only. */
  private readonly restored: Promise<ReadonlyMap<string, Promise<void>>>;
  /** Stops listening for what the outbox takes over later. */
  private readonly stopTaking: (() => void) | undefined;
  private closed = false;

  private readonly options: SenderOptions;

  constructor(options: SenderOptions) {
    this.options = options;
    this.restored = this.resend();
    // What the outbox takes over later (another page of this device left it, and has gone since): posted as a reload's,
    // in its chat's lane, behind what the chat's calls here are waiting on and ahead of the next one made here.
    this.stopTaking = options.outbox.taken?.((entries) => {
      if (this.closed) return false;
      const now = Date.now();
      for (const entry of entries) {
        const lane = this.lane((entry.params as Held).session_id);
        const posted = lane.out.then(() => this.resendOne(entry, now));
        lane.out = posted.catch(() => undefined);
        lane.settled = lane.settled.then(() => posted).catch(() => undefined);
      }
      return true;
    });
  }

  /** This sender is done (its person signed out or another signed in): it takes nothing more over from its outbox. */
  close(): void {
    this.closed = true;
    this.stopTaking?.();
  }

  /**
   * Sends one call for a chat, in order with the chat's earlier ones, the way `route` says now, or `reroute` once the
   * calls before it are out. A call behind one Cloud may still hand over follows it to Cloud's queue when its route lets
   * Cloud take it, and a call goes to Cloud's queue only once the calls before it went their way for good (`settled`).
   * It is in the outbox before it waits for any of that, saying whether Cloud can carry it the way it goes (as `route`
   * says, then as the way it takes once asked again), and leaves it once its way is settled for good.
   */
  send(sessionId: string, method: ChatCallMethod, params: { readonly request_id: string } & Record<string, unknown>, route: Route, reroute?: () => Route): Promise<SendOutcome> {
    let entry = this.keep(sessionId, method, params, noCloud(route));
    const lane = this.lane(sessionId);
    const settled = lane.settled;
    const run = lane.out.then(async () => {
      // Asked first: a call routed to a runtime's connection goes onto it at once, while the route still holds it.
      const held = await this.heldInCloud(sessionId, lane);
      const now = reroute?.() ?? route;
      const toRuntime = now.via === "runtime" && !(now.orCloud && held);
      // The way it takes now: a reload posts it to Cloud's queue only if Cloud can carry it that way.
      const runtimeOnly = toRuntime && noCloud(now);
      if (runtimeOnly !== markedNoCloud(entry)) entry = this.keep(sessionId, method, params, runtimeOnly, entry.at);
      if (now.via === "runtime" && toRuntime) return { ...this.toRuntime(sessionId, lane, entry, now, settled), carried: now.orCloud === true };
      this.divert(lane, params.request_id);
      const queued = settled.then(() => this.queue(sessionId, lane, entry));
      return { out: queued, answer: queued.then((call): SendOutcome => ({ via: "cloud", call })), carried: true };
    });
    const answer = run.then((r) => r.answer);
    // Answered or refused by the runtime, taken or refused by Cloud: it leaves the outbox. Refused because this device
    // signed out, it stays, and goes out after the next sign-in here.
    void answer.then(
      () => this.release(entry),
      (error: unknown) => void (error instanceof SignedOut || this.release(entry)),
    );
    // The next call waits for this one to be out, never for its failure.
    lane.out = run.then((r): Promise<unknown> => r.out).catch(() => undefined);
    lane.settled = run.then((r) => (r.carried ? settled.then(() => r.answer) : settled)).catch(() => undefined);
    return answer;
  }

  private lane(sessionId: string): Lane {
    let lane = this.lanes.get(sessionId);
    if (!lane) {
      const restored = this.restored.then((chats) => chats.get(sessionId));
      this.lanes.set(sessionId, (lane = { out: restored, settled: restored, inCloud: new Map(), onRuntime: new Map() }));
    }
    return lane;
  }

  /**
   * The client keeps its own calls in the order made (client.ts); the next call here only waits for this one to be out
   * (on the wire, or queued in Cloud), never for its answer, so a stop never waits for a send's answer. A call Cloud
   * could queue instead that is not out within UNSENT_MS, whose connection was lost that long before its answer came
   * or was let go, or that is taken back (`divert`), leaves the client's outbox and goes to Cloud under the same request
   * id once the calls before it (`before`) went their way; one that went out may have run, and its receipt answers it.
   * Such a call stays in this outbox meanwhile, as one that went out once it did. One Cloud could not carry leaves it
   * once the client's own outbox holds it: that runtime is the only way it goes.
   */
  private toRuntime(sessionId: string, lane: Lane, entry: OutboxEntry, route: Extract<Route, { via: "runtime" }>, before: Promise<unknown>) {
    const method = entry.method as ChatCallMethod;
    const { call: params } = entry.params as Held;
    let markOut: () => void = () => undefined;
    const out = route.orCloud ? new Promise<void>((resolve) => (markOut = resolve)) : Promise.resolve();
    const takeBack = route.orCloud ? new AbortController() : undefined;
    if (takeBack) lane.onRuntime.set(params.request_id, takeBack);
    // Marked once its connection's outbox holds it, before it can go out (the client waits for it), or as it goes out
    // on a connection that keeps none.
    let marked: Promise<void> | undefined;
    const mayRun = () => (marked ??= this.wentOut(entry, route));
    const sent = () => {
      void mayRun();
      markOut();
    };
    const answer = route.client
      .call(method, params as never, {
        ...(takeBack ? { unsentAfterMs: this.options.unsentMs ?? UNSENT_MS, onKept: mayRun, onSent: sent, signal: takeBack.signal } : { onKept: () => this.release(entry) }),
        ...(route.epoch !== undefined ? { epoch: route.epoch } : {}),
      })
      .then(
        (result): SendOutcome => {
          lane.onRuntime.delete(params.request_id);
          return { via: "runtime", result };
        },
        (error: unknown): Promise<SendOutcome> => {
          lane.onRuntime.delete(params.request_id);
          if (route.orCloud && ((error instanceof CallNotSent && (error.reason === "unsent" || error.reason === "unanswered")) || followsTheChat(method, error))) {
            this.divert(lane, params.request_id);
            // Let go unanswered, it may have run there; refused, or never sent, it did not.
            const mayHaveRun = error instanceof CallNotSent && error.reason === "unanswered";
            // One that did not run is kept as such at once, not once the calls before it are out: a page that lost its
            // lock posts none of those, and the page loaded anew would find it marked as one that may have run.
            const kept = mayHaveRun ? undefined : this.headed(sessionId, entry);
            const queued = before.then(() => this.queue(sessionId, lane, entry, mayHaveRun, kept));
            void queued.then(markOut, markOut);
            return queued.then((call): SendOutcome => ({ via: "cloud", call }));
          }
          markOut();
          return Promise.reject(answeredElsewhere(method, error));
        },
      );
    return { out, answer };
  }

  /**
   * A call heads for Cloud's queue: the chat's later calls follow it there, and those still on a runtime's connection
   * are taken back to go there as well, each once the ones before it did, so none runs ahead of one sent before it and
   * none waits on a connection Cloud can do without.
   */
  private divert(lane: Lane, requestId: string): void {
    lane.inCloud.set(requestId, "heading");
    for (const takeBack of lane.onRuntime.values()) takeBack.abort();
  }

  /**
   * Whether Cloud may still hand the runtime one of the chat's calls from here: one is on its way there, or it is
   * queued, or delivered and not run yet, or Cloud cannot say now (it is down, or this device signed out), since a call
   * the runtime took directly could then run first: the next call follows it into Cloud's queue, and waits there for
   * Cloud, though the runtime is reachable. One Cloud ran, gave up on or forgot no longer holds the chat's calls back.
   */
  private async heldInCloud(sessionId: string, lane: Lane): Promise<boolean> {
    // The live map: a call that heads for Cloud while Cloud is asked about another counts too.
    for (const [requestId, where] of lane.inCloud) {
      if (where === "heading") return true;
      try {
        const { status } = await this.options.api.callState(sessionId, requestId);
        if (status === "queued" || status === "delivered") return true;
      } catch (error) {
        if (!(error instanceof CloudError && error.status === 404)) return true;
      }
      lane.inCloud.delete(requestId);
    }
    return false;
  }

  /**
   * Posts a call to Cloud's queue; `send` lets it leave the outbox once Cloud took it (or refused it). `kept`: its entry
   * for Cloud's queue is written already (`headed`).
   */
  private async queue(sessionId: string, lane: Lane, entry: OutboxEntry, mayHaveRun = false, kept?: Promise<void>): Promise<CallState> {
    const method = entry.method as ChatCallMethod;
    const { call: params } = entry.params as Held;
    // On its way into Cloud's queue: a reload posts it again within QUEUE_RESEND_WITHIN_MS, as one that never went out
    // (Cloud's queue was its way from the start, or it was refused or never sent: `toRuntime` wrote that at once). Not
    // one that may have run: a page that reloads before Cloud took it (Cloud down, the store slow, or the page lost its
    // lock and posts nothing: `post`) leaves it to the page loaded anew, maybe long after and with the chat moved,
    // which must judge it by its mark (Held.wentOut), as the client would before sending it again.
    if (kept) await kept;
    else if (!mayHaveRun) await this.headed(sessionId, entry);
    let call: CallState;
    try {
      call = await this.post(sessionId, method, params);
    } catch (error) {
      lane.inCloud.delete(params.request_id);
      throw error;
    }
    // Cloud holds it now.
    lane.inCloud.set(params.request_id, "queued");
    return call;
  }

  /** The call as the outbox keeps it on its way into Cloud's queue: no mark of the way it took before. */
  private headed(sessionId: string, entry: OutboxEntry): Promise<void> {
    const { call } = entry.params as Held;
    return this.options.outbox.put({ ...entry, params: { session_id: sessionId, call } satisfies Held }).catch(() => undefined);
  }

  /**
   * The call as the outbox keeps it, saying whether Cloud cannot carry it the way it goes (Held.noCloud), put at once
   * (`at`: again, as it was made). A full or broken store still sends: the call just would not survive a reload.
   */
  private keep(sessionId: string, method: ChatCallMethod, params: { readonly request_id: string }, runtimeOnly: boolean, at?: number): OutboxEntry {
    this.fresh?.add(params.request_id);
    // On the outbox clock: two sent in one millisecond keep their order across a reload.
    const held: Held = { session_id: sessionId, call: params, ...(runtimeOnly ? { noCloud: true } : {}) };
    const entry: OutboxEntry = { request_id: params.request_id, method, params: held, at: at ?? outboxAt() };
    void this.options.outbox.put(entry).catch(() => undefined);
    return entry;
  }

  /** It may go out on `route`'s connection from now on (Held.wentOut), on the chat's epoch then. */
  private wentOut(entry: OutboxEntry, route: Extract<Route, { via: "runtime" }>): Promise<void> {
    // A page that lost its lock sends nothing, on the relay or the direct channel (client.ts, direct.ts): marked, the
    // next page would give it the ten-minute rule of one that may have run, though it never left.
    if (this.options.outbox.ours?.() === false) return Promise.resolve();
    const { session_id, call } = entry.params as Held;
    const held: Held = { session_id, call, wentOut: true, ...(route.runtime !== undefined ? { runtime: route.runtime } : {}), ...(route.computer !== undefined ? { computer: route.computer } : {}) };
    return this.options.outbox.put({ ...entry, params: held, ...(route.epoch !== undefined ? { epoch: route.epoch } : {}) }).catch(() => undefined);
  }

  private release(entry: OutboxEntry): void {
    void this.options.outbox.delete(entry.request_id).catch(() => undefined);
  }

  /**
   * POSTs until Cloud answers (it dedupes by request id, so retrying is safe); a refusal is final. A send the person
   * saw go out is never dropped because Cloud was briefly down.
   */
  private async post(sessionId: string, method: ChatCallMethod, params: { readonly request_id: string }): Promise<CallState> {
    // Signed over the params as Cloud and the runtime will read them back (R-1: a JSON round trip first).
    const fields = await this.options.callFields?.({ session_id: sessionId, request_id: params.request_id, method, params: JSON.parse(JSON.stringify(params)) as unknown });
    for (let attempt = 0; ; attempt++) {
      // The outbox no longer answers for this page's calls (it lost its Web Lock: another page may be posting them):
      // none goes out again, and the page loads anew.
      if (this.options.outbox.ours?.() === false) return new Promise<never>(() => undefined);
      try {
        return await this.options.api.call(sessionId, params.request_id, method, params, fields);
      } catch (error) {
        if (refused(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.options.retryMs?.(attempt) ?? Math.min(1_000 * 2 ** attempt, 30_000)));
      }
    }
  }

  /**
   * Calls a closed page sent that neither their runtime answered nor Cloud took: one waiting behind another, one handed
   * to a runtime's connection, one on its way into Cloud's queue. Each goes to Cloud's queue under its request id, each
   * chat's in the order sent and the chats side by side, since `post` waits out Cloud as long as it takes. One the
   * client also resends on the runtime's connection runs once: the receipt answers whichever way comes second, and as
   * both ways keep the order sent, the first of each call keeps it too. One Cloud cannot carry (Held.noCloud) never goes
   * there: the page closed before its connection's outbox held it, and it is let go. Another open page's calls are not
   * here at all (outbox.ts): that page still sends them.
   */
  private async resend(): Promise<ReadonlyMap<string, Promise<void>>> {
    const entries = await this.options.outbox.load().catch(() => [] as ReadonlyArray<OutboxEntry>);
    const fresh = this.fresh;
    this.fresh = undefined;
    const now = Date.now();
    const chats = new Map<string, Promise<void>>();
    for (const entry of entries) {
      if (fresh?.has(entry.request_id)) continue;
      const { session_id } = entry.params as Held;
      chats.set(session_id, (chats.get(session_id) ?? Promise.resolve()).then(() => this.resendOne(entry, now)));
    }
    return chats;
  }

  private async resendOne(entry: OutboxEntry, now: number): Promise<void> {
    const { session_id, call, wentOut, runtime, noCloud: runtimeOnly } = entry.params as Held;
    const fresh = now - entry.at <= (wentOut ? RESEND_OUT_WITHIN_MS : QUEUE_RESEND_WITHIN_MS);
    // One that went out may have run there: it goes again only as the client would send it again (X-3).
    const again = fresh && !runtimeOnly && (!wentOut || runtime === undefined || !this.options.resendable || (await Promise.resolve(this.options.resendable(runtime, entry)).catch(() => false)));
    if (again) {
      try {
        const state = await this.post(session_id, entry.method as ChatCallMethod, call);
        this.lane(session_id).inCloud.set(call.request_id, "queued");
        this.options.onQueued?.(session_id, state, call);
      } catch (error) {
        // Signed out: it waits for the next sign-in on this device. Refused: nothing more to do.
        if (error instanceof SignedOut) return;
      }
    }
    await this.options.outbox.delete(entry.request_id).catch(() => undefined);
  }
}

/**
 * The runtime did not run the call because the chat is in a move's window (CHAOS-15): it is moving away from that
 * computer (`lease_lost`), or not there yet or any more (`not_found`). The send or stop follows the chat through
 * Cloud's queue under the same request id (a refusal leaves no receipt, so it runs once, wherever the chat lands).
 */
const followsTheChat = (method: ChatCallMethod, error: unknown) =>
  error instanceof SessionProtocolError &&
  (error.error.data?.reason === "lease_lost" || (error.error.data?.reason === "not_found" && (method === "turn.submit" || method === "turn.interrupt")));

/** Cloud refused the call itself (a 4xx, signed out): retrying the same request cannot help. */
const refused = (error: unknown) => error instanceof SignedOut || (error instanceof CloudError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);

/** A refused ask.respond because the ask was answered first, as AnsweredElsewhere; anything else as it was. */
export function answeredElsewhere(method: string, error: unknown): unknown {
  if (method === "ask.respond" && error instanceof SessionProtocolError && error.error.data?.reason === "invalid_state" && /answered/i.test(error.message)) return new AnsweredElsewhere();
  return error;
}
