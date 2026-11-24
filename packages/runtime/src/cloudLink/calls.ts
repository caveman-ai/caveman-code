// Calls a device queued in Caveman Cloud for a chat on this computer: a send, a stop or an
// answer made while no device could reach this runtime. Cloud writes each as mail on channel `call` to the chat's
// workspace; this runtime holds one long `mail/wait` for its computer, takes the mail as soon as it returns, runs each
// call as the person (`cloud:<user_id>`) with the device's own request id (so a call that also came over the relay
// runs once: request_id receipts), posts its result, and only then acknowledges the mail. A result that could not be
// posted leaves the mail unacknowledged: Cloud hands it out again once its lease lapses, and the receipt answers it.
// On This Mac a call runs only for a device the person approved (S13, DeviceApproval); a Cloud computer needs none.
//
// A chat's start is the fourth call (CONTRACT §6.8): Cloud queues the runtime's workspace.create with the chat's
// placement, and the Cloud computer it placed the chat on runs it here when it links, as the session Cloud placed. It
// runs on a Cloud computer only, for a placement it names, through the handler a relay call reaches and under the
// same request id, so the queued start and a client's own live one make one workspace. A method this runtime does
// not run from the queue is answered `method_not_found`, never dropped: its device then does what it did before it.
import * as fs from "node:fs";

import { CallDelivery, ErrorCodes, QueuedMethod, START_METHOD, type MethodName } from "@caveman-app/session-protocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CALL_TIMEOUT_MS, withRuntimeToken } from "./computers.ts";
import { TRUST_UNREAD } from "./deviceLog.ts";
import { CloudError, cloudFailure, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import { waitComputerMail } from "./mail.ts";

/**
 * Where a queued call's chat is (session-protocol handlers callPlace): here; leaving (a move lets it go, so its mail
 * goes with the workspace); arriving (Cloud gave this computer the chat, its adopt has not landed yet).
 */
export type CallPlace = "here" | "leaving" | "arriving";
/** How long a call waits for its chat's adopt to land before its mail is left for Cloud to hand out again. */
export const ARRIVE_WAIT_MS = 20_000;

/** How long one wait holds before Cloud answers that nothing came (Cloud caps it at 25 s). */
export const WAIT_MS = 25_000;
/** Without the long poll (a Cloud from before sync), deliveries are taken this often instead. */
export const FALLBACK_POLL_MS = 30_000;
/**
 * How often a pass renews the lease on the call mail it still holds (POST mail/deliveries/renew): Cloud leases a call's
 * mail for 30 s, so a runtime that dies mid-call gives it back that soon, and one at work keeps it.
 */
export const RENEW_EVERY_MS = 10_000;

/**
 * Whether a device the person approved sent a queued call to This Mac (lane R provides it; S13). The default refuses
 * every device, so nothing a device queued runs on a laptop before approval exists.
 */
export class DeviceApproval extends Context.Reference<{ readonly approved: (deviceId: string | undefined, userId: string) => Effect.Effect<boolean> }>("caveman/cloudLink/DeviceApproval", {
  defaultValue: () => ({ approved: () => Effect.succeed(false) }),
}) {}

/** A call's outcome as the result route takes it. */
export interface CallOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The runtime's server, as far as queued calls need it (session-protocol/server.ts runCall). `via.forwardedBy`: the
 * runtime Cloud says handed this call on (CallDelivery.forwarded_by_runtime_id on Cloud's own call mail), never a param.
 */
export type RunCall = (
  principal: string,
  method: MethodName,
  params: unknown,
  via?: { readonly forwardedBy?: string; readonly placedSession?: string },
) => Effect.Effect<unknown, { readonly reason: string; readonly message: string }>;

/** The methods this runtime runs from Cloud's queue (cloudChats.ts QueuedMethod). */
const QUEUED: ReadonlySet<string> = new Set(QueuedMethod.literals);

async function code(identity: Identity, state: LinkState, method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch, timeoutMs = CALL_TIMEOUT_MS) {
  const send = (token: string) =>
    fetchImpl(`${identity.cloudUrl}/api/v1/code/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  const response = await withRuntimeToken(identity, state, fetchImpl, send);
  if (!response.ok) throw await cloudFailure(response);
  return response.status === 204 ? undefined : ((await response.json()) as unknown);
}

export interface Mail {
  readonly id: string;
  readonly verb: string;
  readonly channel: string;
  /** Who posted it: "human" for Cloud's own call mail (a person's queued call), "agent" for anything a runtime sent. */
  readonly authority?: string;
  readonly body: string;
}

/**
 * Cloud's own call mail: a handoff a person's queued call made (Caveman Cloud chat_calls.go). Anything else on the
 * channel (a runtime in the same tree can post there) is never run, on a Cloud computer too.
 */
export const isCloudCall = (mail: Pick<Mail, "verb" | "channel" | "authority">) => mail.channel === "call" && mail.verb === "handoff" && mail.authority === "human";

/** A take of call mail, as Cloud answers it. */
export interface Taken {
  readonly lease_token: string | null;
  readonly messages: ReadonlyArray<Mail>;
}

/** Where a take is kept until it is finished (a file synced to disk: cloudLink/index.ts). */
export interface TakenNote {
  readonly load: Effect.Effect<Taken | undefined>;
  readonly save: (taken: Taken) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

/** A TakenNote in a file at `file`, written whole and synced before the mail runs. */
export const fileNote = (file: string): TakenNote => ({
  load: Effect.sync(() => {
    try {
      const taken = JSON.parse(fs.readFileSync(file, "utf8")) as Taken;
      return typeof taken.lease_token === "string" && Array.isArray(taken.messages) ? taken : undefined;
    } catch {
      return undefined;
    }
  }),
  save: (taken) =>
    Effect.sync(() => {
      const fd = fs.openSync(`${file}.tmp`, "w", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(taken));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(`${file}.tmp`, file);
    }),
  clear: Effect.sync(() => fs.rmSync(file, { force: true })),
});

/** One pass: the call mail Cloud holds for this computer, run, answered and acknowledged. Answers how many ran. */
export const takeCalls = (input: {
  readonly identity: Identity;
  readonly state: LinkState;
  readonly run: RunCall;
  /** This computer is a laptop: only an approved device's calls run. */
  readonly laptop: boolean;
  readonly approved: (call: CallDelivery) => Effect.Effect<Verdict>;
  /** Where the chat is (session-protocol handlers callPlace); `method`: the call's (a start's chat is not made yet). */
  readonly place?: (sessionId: string, method?: string) => Effect.Effect<CallPlace>;
  /** How long a call waits for its chat's adopt to land here ("arriving"). */
  readonly arriveWaitMs?: number;
  /** The mail taken and not yet finished, kept across a crash (CHAOS-6): finished first at the next pass. */
  readonly note?: TakenNote;
  /** How often held mail is renewed (RENEW_EVERY_MS). */
  readonly renewEveryMs?: number;
  readonly fetchImpl?: typeof fetch;
}) =>
  Effect.gen(function* () {
    const { identity, state } = input;
    const placeOf = (sessionId: string, method: string) => (input.place === undefined ? Effect.succeed("here" as CallPlace) : input.place(sessionId, method));
    /** Not here: leaving (a move lets it go), or arriving and its adopt did not land within arriveWaitMs. */
    const follows = (sessionId: string, method: string) =>
      Effect.gen(function* () {
        let where = yield* placeOf(sessionId, method);
        // Cloud gave this computer the chat with the call: its adopt (the move mail beside it) is on its way.
        for (const until = Date.now() + (input.arriveWaitMs ?? ARRIVE_WAIT_MS); where === "arriving" && Date.now() < until; ) {
          yield* Effect.sleep("250 millis");
          where = yield* placeOf(sessionId, method);
        }
        return where !== "here";
      });
    // Mail this runtime took before it stopped, unfinished: run (each once, by request id), answered and acknowledged now
    // rather than after Cloud's lease lapses.
    const kept = input.note ? yield* input.note.load : undefined;
    const taken = kept ?? ((yield* Effect.tryPromise(() => code(identity, state, "POST", "mail/deliveries?channel=call", {}, input.fetchImpl))) as Taken);
    if (taken.lease_token === null || taken.messages.length === 0) return 0;
    const lease = taken.lease_token;
    const renew = (ids: ReadonlyArray<string>) =>
      Effect.tryPromise(() => code(identity, state, "POST", "mail/deliveries/renew", { lease_token: lease, ids }, input.fetchImpl) as Promise<{ readonly lost?: ReadonlyArray<string> }>);
    let messages = taken.messages;
    if (kept !== undefined) {
      // Its lease may have lapsed while this runtime was down: that mail went back to Cloud, which hands it out again (to
      // whichever computer holds the chat now), so it runs there, never here as well. A Cloud without the renew route,
      // or one not reached, leaves it all to run here (once, by request id).
      const held = yield* renew(messages.map((m) => m.id)).pipe(Effect.option);
      const lost = new Set(held._tag === "Some" ? (held.value.lost ?? []) : []);
      messages = messages.filter((m) => !lost.has(m.id));
    }
    if (kept === undefined && input.note) yield* input.note.save(taken);
    // Held while this pass works through it, renewed every RENEW_EVERY_MS; mail left for Cloud (a chat not here) is let go.
    const holding = new Set(messages.map((m) => m.id));
    const renewing = yield* Effect.forkChild(
      Effect.forever(Effect.sleep(input.renewEveryMs ?? RENEW_EVERY_MS).pipe(Effect.andThen(Effect.suspend(() => (holding.size === 0 ? Effect.void : renew([...holding]).pipe(Effect.ignore)))))),
    );
    const answered: Array<string> = [];
    yield* Effect.gen(function* () {
      for (const mail of messages) {
        if (mail.channel !== "call") continue;
        if (!isCloudCall(mail)) {
          // Refused, not run, and acknowledged so it never comes back; no result is posted (its body names calls it may not touch).
          yield* Effect.logWarning(`calls: mail ${mail.id} on the call channel is not a person's queued call (verb ${mail.verb}, from ${mail.authority ?? "nobody"}); it does not run`);
          answered.push(mail.id);
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(mail.body);
        } catch {
          raw = undefined;
        }
        const decoded = Schema.decodeUnknownExit(CallDelivery)(raw);
        // Mail this runtime cannot read is answered as such, so it never comes back.
        if (decoded._tag === "Failure") {
          answered.push(mail.id);
          continue;
        }
        const call = decoded.value;
        // A method from a Cloud newer than this runtime: answered as one it does not run, which its device acts on.
        const known = QUEUED.has(call.method);
        // A chat moving off this computer, or gone from it (M-8): no result and no ack, so the mail goes with its workspace
        // once its lease lapses.
        if (known && (yield* follows(call.session_id, call.method))) {
          holding.delete(mail.id);
          continue;
        }
        const outcome = known ? yield* runOne(input, call) : refused("method_not_found", `This computer does not run ${call.method} from Caveman's queue.`);
        // A lost lease refused the call before execution: it stays owed even if ownership already came back by this
        // check. So does a call This Mac could not check against its device log yet (TRUST_UNREAD): tried again once
        // Cloud hands it out again. Other absence/park refusals follow the chat only while it is actually elsewhere
        // (CHAOS-16).
        if (
          !outcome.ok &&
          (outcome.error?.code === "lease_lost" || outcome.error?.code === TRUST_UNREAD || ((outcome.error?.code === "not_found" || outcome.error?.code === "parked") && (yield* follows(call.session_id, call.method))))
        ) {
          holding.delete(mail.id);
          continue;
        }
        const posted = yield* Effect.tryPromise(() =>
          code(identity, state, "POST", `runtime/chats/${encodeURIComponent(call.session_id)}/calls/${encodeURIComponent(call.call_id)}/result`, outcome, input.fetchImpl),
        ).pipe(
          Effect.as(true),
          // Cloud no longer has the call (expired, the chat gone): nothing to answer.
          Effect.catchIf((error) => error instanceof CloudError && error.status === 404, () => Effect.succeed(true)),
          Effect.catch((error) => Effect.logWarning(`calls: the result of ${call.method} for ${call.session_id} did not reach Caveman Cloud: ${(error as Error).message}`).pipe(Effect.as(false))),
        );
        if (posted) answered.push(mail.id);
      }
    }).pipe(Effect.ensuring(Fiber.interrupt(renewing)));
    if (answered.length > 0) yield* Effect.tryPromise(() => code(identity, state, "POST", "mail/deliveries/ack", { lease_token: lease, ids: answered }, input.fetchImpl)).pipe(Effect.ignore);
    if (input.note) yield* input.note.clear;
    return answered.length;
  });

/** Runs one delivered call as its person, with its request id: the outcome Cloud records. */
const runOne = (input: { readonly identity: Identity; readonly run: RunCall; readonly laptop: boolean; readonly approved: (call: CallDelivery) => Effect.Effect<Verdict> }, call: CallDelivery) =>
  Effect.gen(function* () {
    const start = call.method === START_METHOD;
    if (start) {
      // A chat Cloud placed starts on the Cloud computer it was placed on: never on a Mac, whatever queued it, and
      // only for the placement Cloud names with it (the chat's registration takes up that workspace and no other).
      if (input.laptop) return refused("unsupported", "A chat Caveman placed starts on its Cloud computer, not on a Mac.");
      const placed = call.params.placed_workspace_id;
      if (typeof placed !== "string" || placed === "") return refused("invalid_params", "A queued start names the workspace Caveman placed for it.");
    }
    // A laptop runs calls for its own person only, from a device that person approved.
    if (input.laptop && input.identity.userId !== undefined && call.user_id !== input.identity.userId) return refused("forbidden", "This computer belongs to someone else.");
    if (input.laptop) {
      const verdict = yield* input.approved(call);
      // A call that waited too long says so (lane R): the device is fine.
      if (verdict === false) return refused("device_not_approved", "Approve this device on the Mac first (Settings, Devices).");
      if (verdict !== true) return refused(verdict.code, verdict.message);
    }
    // What Cloud's own mail says of the call, beside its params: who handed it on, and for a start the session Cloud placed.
    const via = { ...(call.forwarded_by_runtime_id === undefined ? {} : { forwardedBy: call.forwarded_by_runtime_id }), ...(start ? { placedSession: call.session_id } : {}) };
    const exit = yield* Effect.exit(input.run(`cloud:${call.user_id}`, call.method as MethodName, { ...call.params, request_id: call.request_id }, Object.keys(via).length === 0 ? undefined : via));
    if (exit._tag === "Success") return { ok: true, result: exit.value ?? null } satisfies CallOutcome;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    const reason = failure?.reason ?? "internal";
    return refused(reason in ErrorCodes ? reason : "internal", failure?.message ?? "the runtime failed this call");
  });

const refused = (code: string, message: string): CallOutcome => ({ ok: false, error: { code, message } });

/** This Mac's word on a delivered call: run it, refuse it as unapproved, or refuse it for the reason given. */
export type Verdict = boolean | { readonly code: string; readonly message: string };

/**
 * The loop: wait for call mail for this computer (one long poll), take it, run it; while `wanted` says so (a Cloud
 * computer always, This Mac with sync on). A Cloud that has no wait without a workspace is asked every 30 s instead.
 */
export const runCalls = (input: {
  readonly identity: () => Identity | undefined;
  readonly state: LinkState;
  readonly wanted: () => boolean;
  readonly run: RunCall;
  readonly laptop: boolean;
  /**
   * This Mac's own check (session-protocol/devices.ts queuedCallAllowed): a device it allowed for the call's person
   * signed exactly this call within 23 hours.
   */
  readonly allowed?: (call: CallDelivery) => Effect.Effect<Verdict>;
  readonly place?: (sessionId: string) => Effect.Effect<CallPlace>;
  readonly note?: TakenNote;
  readonly fetchImpl?: typeof fetch;
}) =>
  Effect.gen(function* () {
    const reference = yield* DeviceApproval;
    const approval = {
      approved: (call: CallDelivery): Effect.Effect<Verdict> =>
        reference.approved(call.device?.device_id ?? call.device_id, call.user_id).pipe(Effect.flatMap((yes) => (yes || input.allowed === undefined ? Effect.succeed<Verdict>(yes) : input.allowed(call)))),
    };
    let failures = 0;
    let longPoll = true;
    while (true) {
      const identity = input.identity();
      if (identity === undefined || !input.wanted()) {
        yield* Effect.sleep("2 seconds");
        continue;
      }
      const pass = Effect.gen(function* () {
        // Anything already waiting first (mail written while this runtime slept), then the wait.
        yield* takeCalls({ identity, state: input.state, run: input.run, laptop: input.laptop, approved: approval.approved, ...(input.place ? { place: input.place } : {}), ...(input.note ? { note: input.note } : {}), ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
        if (!longPoll) return yield* Effect.sleep(FALLBACK_POLL_MS);
        yield* Effect.tryPromise(() => waitComputerMail(identity, input.state, "call", WAIT_MS, input.fetchImpl)).pipe(
          Effect.catchIf(
            (error) => error instanceof CloudError && (error.status === 400 || error.status === 404),
            () => Effect.sync(() => void (longPoll = false)),
          ),
        );
      });
      const exit = yield* Effect.exit(pass);
      if (exit._tag === "Success") failures = 0;
      else {
        failures++;
        yield* Effect.sleep(Math.min(1_000 * 2 ** Math.min(failures - 1, 5), 30_000));
      }
    }
  });
