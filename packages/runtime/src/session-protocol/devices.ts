// Device approval on This Mac (DESIGN S13; the wire is @caveman-app/session-protocol devices.ts). A relayed
// connection to a laptop runtime is never handed to the Session Protocol server until the device on the other end
// proved it holds a key this Mac's own screen allowed: the runtime challenges every relayed stream (a nonce and an
// ephemeral ECDH key), checks the device's signature, and from then on takes only frames sealed under the channel key
// both derived, in sequence. Caveman Cloud carries the frames but holds no key: a stolen Cloud session, or Cloud
// itself, can open a stream, but it cannot answer the challenge, replay an old answer, or slip a frame into a stream a
// device opened. Allowing, listing and removing devices is for local clients only. A Cloud computer is driven on the
// person's Cloud sign-in alone, as before: no gate there.
//
// A Mac whose sign-in names its person is that person's: it takes only their devices, as Caveman Cloud lets a person
// attach only to computers of their own. Another person's device is refused at its hello ("<This Mac> takes only its
// owner's devices."), before its key is looked at: it asks no screen and is never listed. A Mac whose sign-in names
// nobody (one from before Cloud named the person) cannot tell, and asks its screen about any device, as before.
//
// A person's Macs share approvals (docs/): an Allow or Remove on a Mac's own
// screen can carry a statement its desktop key signed, which this runtime puts in the person's log in Cloud and every
// other Mac of theirs follows (follow). Whom This Mac trusts is deviceTrust.ts over its own screen's allows and the
// statements it verified: Cloud carries them and can make none.
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";
import * as os from "node:os";

import {
  ErrorCodes,
  channelKeyBytes,
  verifyStatement,
  statementId,
  cleanDeviceName,
  deviceCode,
  deviceIdOf,
  ephemeralKey,
  helloPayload,
  frameParams,
  sealedFrameAt,
  sealedFrameText,
  publicKeyOf,
  toBase64url,
  callAge,
  pairingCode,
  verifyCall,
  verifyDeviceSignature,
  pairAnswer,
  verifyPairProof,
  DEVICE_REQUEST_TTL_MS,
  PAIRING_CODE_TTL_MS,
  type DeviceCall,
  type DeviceKind,
  type DeviceMove,
  type DeviceStatement,
  type DeviceEntry,
  type DeviceList,
  type DevicePublicKey,
  type DeviceRequest,
  type DeviceStatus,
  type ChannelKeyBytes,
  type WebKey,
} from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

import { CALL_TIMEOUT_MS } from "../cloudLink/computers.ts";
import { putStatements, statementsAfter, LOG_WAIT_MS, TRUST_UNREAD, type LogPage } from "../cloudLink/deviceLog.ts";
import { CloudError, type Identity } from "../cloudLink/identity.ts";
import { CloudComputer, type LinkState } from "../cloudLink/index.ts";
import { removalKey, trusted, type Signer, type Trust, type TrustedAgents } from "./deviceTrust.ts";
import { ProtocolError, wakeableSleep } from "./handlers.ts";
import { SessionStore } from "./store.ts";

/**
 * One ordered, text-framed connection from a device, whatever carries it (a relay stream today; a WebRTC data channel
 * works the same). `close` ends it and must tell the sink the gate returned (`closed`), as relay.ts does.
 */
export interface FrameChannel {
  send(data: string | Uint8Array): Promise<void>;
  close(reason?: string): void;
}
/** What a channel delivers to: the gate, then the Session Protocol server behind it. */
export interface FrameSink {
  message(data: string | Uint8Array): void;
  closed(reason: string): void;
}

const KV_KEY = "devices";
/** The person's log as This Mac follows it, apart from the list: written only when the log changes. */
const KV_LOG_KEY = "devices.log";
/** Devices waiting for an answer at once; more are refused (not blocked) until the person answers or they lapse. */
export const MAX_REQUESTS = 3;
/** A relayed stream that has not said device.hello by then is closed. */
export const HELLO_TIMEOUT_MS = 30_000;
/** How long a hello from a device This Mac does not know waits on the person's log before it asks the screen. */
export const LOG_PULL_MS = 2_000;
/** Hellos from new keys read the log at most this often: a burst of them shares one read. */
const PULL_GAP_MS = 1_000;
/**
 * A read of the log finished longer ago than this (wall clock) is stale: the follow loop waits LOG_WAIT_MS at most, so
 * the Mac slept (a timeout's clock stops while it does), and a hello reads the log again before it is answered.
 */
const STALE_MS = LOG_WAIT_MS + CALL_TIMEOUT_MS;
/**
 * The most allows a Mac takes into its log for its person (Cloud keeps no more), and the most removals it takes by
 * keys it does not trust; a removal by a Mac it trusts always goes in (take).
 */
export const MAX_STATEMENTS = 2_000;

/**
 * Seals and opens a connection's frames with Node's own AES-256-GCM, at once: the same frames, byte for byte, as
 * WebCrypto's sealFrame/openFrame. A WebCrypto job comes back through the event loop, which a turn keeps busy just
 * as its events burst, so each frame to a device waited about 3 ms here, and 25 ms on a loaded CI runner, before it
 * left (S14: the Mac's remote paths were that much slower than a Cloud computer's, which seals nothing).
 */
export const frameCrypto = (keys: ChannelKeyBytes) => {
  const toDevice = createSecretKey(keys.to_device);
  const toRuntime = createSecretKey(keys.to_runtime);
  return {
    seal: (seq: number, body: string): string => {
      const { iv, aad } = frameParams("to_device", seq);
      const cipher = createCipheriv("aes-256-gcm", toDevice, iv, { authTagLength: 16 });
      cipher.setAAD(aad);
      return sealedFrameText(seq, Buffer.concat([cipher.update(body, "utf8"), cipher.final(), cipher.getAuthTag()]));
    },
    open: (seq: number, raw: string): string | undefined => {
      const ct = sealedFrameAt(raw, seq);
      if (ct === undefined || ct.length < 16) return undefined;
      try {
        const { iv, aad } = frameParams("to_runtime", seq);
        const decipher = createDecipheriv("aes-256-gcm", toRuntime, iv, { authTagLength: 16 });
        decipher.setAAD(aad);
        decipher.setAuthTag(ct.subarray(ct.length - 16));
        const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
        return new TextDecoder("utf-8", { fatal: true }).decode(plain);
      } catch {
        return undefined;
      }
    },
  };
};
/** Keep awake while a device drove a chat this recently (S13). */
export const DRIVE_WINDOW_MS = 10 * 60 * 1000;
/** A turn running or starting: a chat the device started "still works". */
const WORKING = new Set(["starting", "working"]);

interface StoredDevice {
  readonly device_id: string;
  readonly name: string;
  readonly public_key: DevicePublicKey;
  readonly user_id: string;
  readonly added_at: string;
  last_seen_at?: string;
  /**
   * "mac": a Mac's desktop key that joined with this Mac's code (decision 31), allowed as one; else what this screen
   * kept it as. Absent (allowed on a v1 hello: before v2, or from an older app): a device. A device becomes a Mac here
   * only by joining with the code (hello).
   */
  readonly role?: DeviceKind;
  /** The id of the allow this screen signed for the person's other Macs; absent: this Mac only. */
  readonly statement?: string;
}
interface StoredRequest {
  readonly device_id: string;
  readonly name: string;
  readonly public_key: DevicePublicKey;
  readonly user_id: string;
  readonly at: string;
  readonly role?: DeviceKind;
}
interface StoredBlock {
  readonly device_id: string;
  readonly name: string;
  readonly at: string;
  /** The id of the removal this screen signed for the person's other Macs; absent: this Mac only. */
  readonly statement?: string;
}
/** The person's log as This Mac follows it: whose it is, how far it read, and the statements that verified. */
interface StoredLog {
  readonly owner: string;
  cursor: number;
  statements: DeviceStatement[];
  /** Their ids, as statementId gives them (kept beside, so a statement is never taken twice). */
  ids: string[];
  /**
   * Set once `take` skipped a statement past the cap since the log was last read from the start: the keys whose
   * statements it kept past the cap all along since then. A key that gains that (a Mac this screen allows) reads the log
   * again from the start (A-3). Absent: nothing was skipped.
   */
  counted?: string[];
  /** Where the log was read to before it was read again from the start: until back there, it counts as unread. */
  rereadTo?: number;
}
interface Saved {
  devices: StoredDevice[];
  requests: StoredRequest[];
  blocked: StoredBlock[];
  /** Statements this Mac's screen signed that Cloud has not taken yet. */
  outbox: DeviceStatement[];
  /** Statements this screen signed that Cloud refused for good, by id: why, as Cloud said. They count on this Mac only. */
  refused: Record<string, string>;
  /** Removals by another Mac this screen lifted (Unblock), by removalKey: counted here no more. A later one counts. */
  lifted: string[];
  /** Macs this screen allowed and then removed: never trusted here, but their removals still stand (deviceTrust removers). */
  retired: Signer[];
  /** When a device allowed through another Mac last connected here. */
  seen: Record<string, string>;
  /** This Mac's own desktop key, as its screen's statements name it: never listed among the devices that drive it. */
  own?: string;
  /** The runtime this screen's standing allows were last put as: a new one (signed out and in again) puts them again. */
  putAs?: string;
  /** The id of this screen's vouch for this runtime's agents key (device.vouch), put again under a new runtime as an allow is. */
  vouch?: string;
}

/** One relayed stream's state, as the registry sees it. */
interface Gate {
  readonly userId: string;
  deviceId: string | undefined;
  phase: "starting" | "challenged" | "verifying" | "pending" | "approved" | "closed";
  /**
   * A Join's own connection (decision 31), from a device this Mac lets in already or a key it does not know yet: it waits
   * on the screen's answer to its request to count as a Mac, approved only once it does (never by an allow of the key as
   * a device, m-h), refused once that request is gone unanswered (m-13).
   */
  wantsMac?: boolean;
  approve(): void;
  end(status: DeviceStatus, reason: string): void;
}

/** A call's device fields, as a queued call carries them (session-protocol devices.ts signCall). */
export interface CallDevice {
  readonly device_id: string;
  readonly at: string;
  readonly signature: string;
}

/**
 * Whether This Mac may run a call Cloud queued for `userId` (S13): a device this Mac allowed for that person signed
 * exactly this call, within the last 23 hours. Without that, a stolen Cloud session (or Cloud) could queue a turn.
 */
export async function queuedCallAllowed(
  devices: ReadonlyArray<{ readonly device_id: string; readonly user_id: string; readonly public_key: DevicePublicKey }>,
  userId: string,
  call: Omit<DeviceCall, "at">,
  device: CallDevice | undefined,
  now = Date.now(),
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: "device_not_approved" | "call_expired"; readonly reason: string }> {
  const no = (reason: string) => ({ ok: false, code: "device_not_approved", reason }) as const;
  if (!device || typeof device.device_id !== "string" || typeof device.at !== "string" || typeof device.signature !== "string")
    return no("This Mac runs calls queued with Caveman only from a device it allowed; this one carries none.");
  const known = devices.find((d) => d.device_id === device.device_id && d.user_id === userId);
  if (!known) return no("The device that queued this call is not allowed on this Mac. Allow it on the Mac (Settings, Devices).");
  // Too old to run is its own answer: the device is fine, the call waited too long.
  if (callAge(device.at, now) === "expired") return { ok: false, code: "call_expired", reason: "This waited too long to run on the Mac. Send it again." };
  if (!(await verifyCall(known.public_key, { ...call, at: device.at }, device.signature, now))) return no("The call's device signature does not hold.");
  return { ok: true };
}

/**
 * Whether This Mac may act on a move Cloud mailed it (a chat leaving for another computer, with its work in progress):
 * the same check as a queued call, over a move a device signed (session-protocol devices.ts signMove).
 */
export const queuedMoveAllowed = (
  devices: ReadonlyArray<{ readonly device_id: string; readonly user_id: string; readonly public_key: DevicePublicKey }>,
  userId: string,
  move: DeviceMove,
  device: CallDevice | undefined,
  now = Date.now(),
) => queuedCallAllowed(devices, userId, { session_id: move.session_id, request_id: move.request_id, method: "session.move", params: { to: move.to } }, device, now);

/** How This Mac calls itself on the waiting screen: the Mac's own name (System Settings > General > Sharing). */
function machineName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (name) return cleanDeviceName(name);
    } catch {
      // Fall back to the host name.
    }
  }
  return cleanDeviceName(os.hostname().replace(/\.local$/, ""));
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The clock device requests lapse and keep-awake windows run on (tests move it). */
export class DevicesClock extends Context.Reference<() => number>("caveman/session-protocol/DevicesClock", { defaultValue: () => Date.now }) {}

export interface DevicesOptions {
  /** Sends a notification to every local client (never a relayed one). */
  readonly notifyLocal: (method: "device.request" | "device.changed", params: unknown) => void;
  readonly runtimeName?: () => string;
  /** This runtime's agents key's public half (the desktop app hands the key over in memory); absent: it has none. */
  readonly agentsKey?: { readonly device_id: string; readonly public_key: DevicePublicKey } | undefined;
}

/** What the person's log follows with: this runtime's Cloud identity, read each time, and its link. */
export interface DeviceLogLink {
  readonly identity: () => Identity | undefined;
  readonly link: LinkState;
}

/** Whose log a Mac follows: its enrollment's organization and person (an enrollment that names none shares nothing). */
const ownerOf = (person: { readonly organizationId: string; readonly userId: string }) => `${person.organizationId}\0${person.userId}`;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** A Cloud without the device log: ask again this much later. */
const IDLE_MS = 5 * 60_000;
/** Not signed in to Cloud: look again this much later (an enrollment seen sooner wakes the loop). */
const SIGNED_OUT_MS = 30_000;
/**
 * A refusal Cloud gives again for the same statement (personSettings' final): kept here, never sent again. A 403 is
 * not one: Cloud refuses the whole put while the person may not run Caveman Code for a while (a role or membership
 * change), so what waits, a stolen phone's removal too, stays in the outbox for the follow loop's next try.
 */
const final = (error: unknown) => error instanceof CloudError && error.status >= 400 && error.status < 500 && ![401, 403, 404, 405, 408, 429].includes(error.status);
const tryCloud = <A>(promise: () => Promise<A>) => Effect.tryPromise({ try: promise, catch: (error) => error });

export const makeDevices = (options: DevicesOptions) =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const computer = yield* CloudComputer;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const now = yield* DevicesClock;
    let name: string | undefined;
    const runtimeName = () => (name ??= options.runtimeName?.() ?? machineName());

    const raw = yield* store.kvGet(KV_KEY);
    const saved: Saved = { devices: [], requests: [], blocked: [], outbox: [], refused: {}, lifted: [], retired: [], seen: {} };
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as Partial<Saved>;
        saved.devices = Array.isArray(parsed.devices) ? parsed.devices : [];
        saved.requests = Array.isArray(parsed.requests) ? parsed.requests : [];
        saved.blocked = Array.isArray(parsed.blocked) ? parsed.blocked : [];
        saved.outbox = Array.isArray(parsed.outbox) ? parsed.outbox : [];
        saved.refused = parsed.refused !== null && typeof parsed.refused === "object" ? parsed.refused : {};
        saved.lifted = Array.isArray(parsed.lifted) ? parsed.lifted : [];
        saved.retired = Array.isArray(parsed.retired) ? parsed.retired : [];
        saved.seen = parsed.seen !== null && typeof parsed.seen === "object" ? parsed.seen : {};
        if (typeof parsed.own === "string") saved.own = parsed.own;
        if (typeof parsed.putAs === "string") saved.putAs = parsed.putAs;
        if (typeof parsed.vouch === "string") saved.vouch = parsed.vouch;
      } catch {
        // An unreadable list allows nobody: every device asks again.
      }
    }
    let log: StoredLog = { owner: "", cursor: 0, statements: [], ids: [] };
    const rawLog = yield* store.kvGet(KV_LOG_KEY);
    if (rawLog !== undefined) {
      try {
        const parsed = JSON.parse(rawLog) as Partial<StoredLog>;
        if (typeof parsed.owner === "string" && typeof parsed.cursor === "number" && Array.isArray(parsed.statements) && Array.isArray(parsed.ids) && parsed.ids.length === parsed.statements.length) {
          const { counted, rereadTo, ...rest } = parsed as StoredLog;
          log = rest;
          if (Array.isArray(counted) && counted.every((id) => typeof id === "string")) log.counted = counted;
          else if (!("counted" in parsed)) {
            // Kept before skips were noted (A-3): a log at the cap may have skipped what a Mac trusted since signed, so
            // it is read again from the start once any key counts here.
            const removals = log.statements.filter((s) => s.kind === "remove").length;
            if (removals >= MAX_STATEMENTS || log.statements.length - removals >= MAX_STATEMENTS) log.counted = [];
          }
          if (typeof rereadTo === "number" && rereadTo > log.cursor) log.rereadTo = rereadTo;
        }
      } catch {
        // An unreadable log is read again from the start.
      }
    }
    /** The log's statement ids, for a check at the moment a statement goes in. */
    let logIds = new Set(log.ids);
    /** The ids (statementId) of the statements in the outbox, by their signature: what still waits there reads so (m-j). */
    const outboxIds = new Map<string, string>();
    for (const s of saved.outbox) outboxIds.set(s.signature, yield* Effect.promise(() => statementId(s)));
    /** The statements this screen signed that Cloud has not taken yet, by id. */
    const unsent = () => new Set(saved.outbox.flatMap((s) => outboxIds.get(s.signature) ?? []));
    const gates = new Set<Gate>();
    /** Called after each settle: what trust says may have changed. */
    const trustListeners = new Set<() => void>();
    /** Bumped on every change trust reads (the screen's allows, blocks and lifts, the log): trust is computed again after. */
    let version = 0;
    const touched = () => void version++;
    let writes: Promise<void> = Promise.resolve();
    const write = (key: string, text: string) => {
      writes = writes.then(() => runPromise(store.kvSet(key, text))).catch(() => undefined);
      return writes;
    };
    /** Saves the list. `trust` false: nothing trust reads changed (when a device was last seen, a request, the outbox). */
    const save = (trust = true) => {
      if (trust) touched();
      return write(KV_KEY, JSON.stringify(saved));
    };
    /** Saves the log (whoever changed its statements also said touched). */
    const saveLog = () => write(KV_LOG_KEY, JSON.stringify(log));
    const iso = (ms: number) => new Date(ms).toISOString();
    const lapse = () => {
      const cutoff = now() - DEVICE_REQUEST_TTL_MS;
      const before = saved.requests.length;
      saved.requests = saved.requests.filter((r) => Date.parse(r.at) > cutoff);
      return saved.requests.length !== before;
    };

    // ------------------------------------------------------------ trust: this screen's allows and the person's log
    /** The log's link, once the server started following it (follow). */
    let logLink: DeviceLogLink | undefined;
    /** The follow loop's sleeps, which a statement this screen signed or a new enrollment cuts short. */
    const idle = wakeableSleep();
    /** The enrollment, read from disk at most once a second (the gate and the list ask it often). */
    let read: { readonly at: number; readonly identity: Identity | undefined } | undefined;
    const ownerNow = (identity: Identity | undefined) => (identity?.userId ? ownerOf({ organizationId: identity.organizationId, userId: identity.userId }) : undefined);
    const identityNow = () => {
      if (!logLink) return undefined;
      if (read === undefined || Date.now() - read.at > 1_000) {
        const identity = logLink.identity();
        // Enrolled since (or now for its person): the follow loop starts at once, not at its next look.
        const owner = ownerNow(identity);
        if (owner !== undefined && owner !== ownerNow(read?.identity)) idle.poke();
        read = { at: Date.now(), identity };
      }
      return read.identity;
    };
    /** The person This Mac's enrollment names: whose statements count. Undefined: this Mac shares nothing. */
    const person = () => {
      const identity = identityNow();
      return identity?.userId ? { organizationId: identity.organizationId, userId: identity.userId } : undefined;
    };
    let cached: { readonly key: string; readonly trust: Trust } | undefined;
    /** Trust for the enrollment's person, recomputed only when what it reads changed. */
    const trustOf = (who: { readonly organizationId: string; readonly userId: string }): Trust => {
      const key = `${ownerOf(who)}\0${version}`;
      if (cached?.key === key) return cached.trust;
      const statements = log.owner === ownerOf(who) ? log.statements : [];
      const trust = trusted({
        roots: saved.devices.filter((d) => d.user_id === who.userId).map((d) => ({ device_id: d.device_id, public_key: d.public_key, name: d.name, role: d.role ?? "device" })),
        statements,
        organizationId: who.organizationId,
        userId: who.userId,
        blocked: saved.blocked.map((b) => b.device_id),
        removers: [...(saved.own ? [{ device_id: saved.own, name: "This Mac" }] : []), ...saved.retired],
        lifted: saved.lifted,
      });
      cached = { key, trust };
      return trust;
    };
    /**
     * A device allowed to drive This Mac as `userId`. A Mac whose enrollment names its person is that person's, and
     * takes only their devices, through trust for them: another person's is refused at its hello (gate), and an allow
     * this screen gave one before the Mac named its owner counts for nothing. A Mac that names nobody goes by this
     * screen's own allows, as before.
     */
    const allowedFor = (deviceId: string, userId: string): { readonly public_key: DevicePublicKey } | undefined => {
      const who = person();
      if (who) return userId === who.userId ? trustOf(who).devices.get(deviceId) : undefined;
      const own = saved.devices.find((d) => d.device_id === deviceId && d.user_id === userId);
      return own && !saved.blocked.some((b) => b.device_id === deviceId) ? own : undefined;
    };
    /** What a device counts as here, when it is allowed (allowedFor): through trust for the enrollment's person, else this screen's allow. */
    const roleHere = (deviceId: string, userId: string): DeviceKind | undefined => {
      const who = person();
      if (who) return userId === who.userId ? trustOf(who).devices.get(deviceId)?.role : undefined;
      const own = saved.devices.find((d) => d.device_id === deviceId && d.user_id === userId);
      return own && !saved.blocked.some((b) => b.device_id === deviceId) ? (own.role ?? "device") : undefined;
    };
    /** Said no to: another person's on a Mac that names its owner, blocked here, removed by one of the person's Macs, or allowed here for another person. */
    const refusedHere = (deviceId: string, userId: string) => {
      const who = person();
      if (who && userId !== who.userId) return true;
      if (saved.blocked.some((b) => b.device_id === deviceId)) return true;
      if (who && trustOf(who).removed.has(deviceId)) return true;
      return saved.devices.some((d) => d.device_id === deviceId && d.user_id !== userId);
    };
    /**
     * What This Mac knows of a device a refused move names, for its chat's note: one it lets in (the move's signature
     * failed, or it waited too long), or one removed here or on a Mac. A waiting request counts as neither: any key
     * makes one with a single hello, so the note never vouches for its code.
     */
    const seenAs = (deviceId: string, userId: string): "allowed" | "removed" | undefined => {
      if (allowedFor(deviceId, userId)) return "allowed";
      const who = person();
      return saved.blocked.some((b) => b.device_id === deviceId) || (who !== undefined && trustOf(who).removed.has(deviceId)) ? "removed" : undefined;
    };
    /** Every device that may sign a queued call or move here, for the runners' checks: the owner's alone once the Mac names them (allowedFor). */
    const allowedList = () => {
      const who = person();
      if (who) return [...trustOf(who).devices.values()].map((d) => ({ device_id: d.device_id, user_id: who.userId, public_key: d.public_key }));
      return saved.devices.filter((d) => !saved.blocked.some((b) => b.device_id === d.device_id));
    };

    const view = (): DeviceList => {
      lapse();
      const connected = new Set([...gates].filter((g) => g.phase === "approved" && g.deviceId !== undefined).map((g) => g.deviceId!));
      const who = person();
      const trust = who ? trustOf(who) : undefined;
      const entry = (d: { device_id: string; name: string; user_id: string; added_at: string; last_seen_at?: string | undefined }, extra: Partial<DeviceEntry>): DeviceEntry => ({
        device_id: d.device_id,
        name: d.name,
        code: deviceCode(d.device_id),
        user_id: d.user_id,
        added_at: d.added_at,
        ...(d.last_seen_at ? { last_seen_at: d.last_seen_at } : {}),
        connected: connected.has(d.device_id),
        ...extra,
      });
      /**
       * A statement this screen signed: shared with the person's other Macs, or why Cloud would not carry it. Not shared
       * while a Mac's removal of the device stands on them, which only this screen lifted (Unblock): there it stays out.
       * One still in the outbox (this Mac has not reached Cloud since) is waiting: the other Macs do not have it yet (m-j).
       */
      const waiting = unsent();
      const sharing = (deviceId: string, statement: string | undefined) =>
        statement === undefined
          ? {}
          : saved.refused[statement] !== undefined
            ? { not_shared: saved.refused[statement]! }
            : trust?.lifted.has(deviceId)
              ? {}
              : { shared: true, ...(waiting.has(statement) ? { waiting: true } : {}) };
      const roots = saved.devices.flatMap((d) => {
        // Allowed here for someone else before the Mac named its owner: it lets nothing in now (allowedFor), so it is not listed.
        if (who && d.user_id !== who.userId) return [];
        const counted = trust && who && d.user_id === who.userId ? trust.devices.get(d.device_id) : undefined;
        // A root a removal elsewhere took away is listed as removed, not here.
        if (trust && who && d.user_id === who.userId && !counted) return [];
        const role = counted?.role ?? d.role;
        return [entry(d, { ...(role === "mac" ? { role } : {}), ...sharing(d.device_id, d.statement) })];
      });
      const through = trust
        ? [...trust.devices.values()].flatMap((d) => {
            // This Mac's own key, which its other Macs allowed: it is This Mac, not a device that drives it.
            if (!d.allowed_by || d.device_id === saved.own) return [];
            const allow = log.statements.find((s) => s.kind === "allow" && s.device_id === d.device_id && s.signer.device_id === d.allowed_by!.device_id);
            return [entry({ device_id: d.device_id, name: d.name, user_id: who!.userId, added_at: allow?.at ?? iso(now()), last_seen_at: saved.seen[d.device_id] }, { ...(d.role === "mac" ? { role: d.role } : {}), allowed_by: d.allowed_by })];
          })
        : [];
      const removedElsewhere = trust
        ? [...trust.removed.values()]
            .filter((r) => !saved.blocked.some((b) => b.device_id === r.device_id))
            .map((r) => {
              const removal = log.statements.find((s) => s.kind === "remove" && s.device_id === r.device_id && s.signer.device_id === r.removed_by.device_id);
              return { device_id: r.device_id, name: r.name, code: deviceCode(r.device_id), at: removal?.at ?? iso(now()), removed_by: r.removed_by };
            })
        : [];
      return {
        required: computer === undefined,
        devices: [...roots, ...through],
        // Only the owner's devices wait on a Mac that names its owner (the gate asks the screen about no other).
        requests: saved.requests
          .filter((r) => !who || r.user_id === who.userId)
          .map((r): DeviceRequest => ({ device_id: r.device_id, name: r.name, code: deviceCode(r.device_id), user_id: r.user_id, at: r.at, public_key: r.public_key, ...(r.role ? { role: r.role } : {}) })),
        blocked: [
          ...saved.blocked.map((b) => ({
            device_id: b.device_id,
            name: b.name,
            code: deviceCode(b.device_id),
            at: b.at,
            ...(b.statement && saved.refused[b.statement] !== undefined ? { not_shared: saved.refused[b.statement]! } : b.statement && waiting.has(b.statement) ? { waiting: true } : {}),
          })),
          ...removedElsewhere,
        ],
        ...(who ? { family: { organization_id: who.organizationId, user_id: who.userId } } : {}),
        ...(pairing !== undefined && now() <= pairing.expires ? { pairing: { expires_at: iso(pairing.expires) } } : {}),
      };
    };
    const changed = () => options.notifyLocal("device.changed", view());

    // ------------------------------------------------------------ Add a Mac (decision 31)
    /**
     * The code this screen shows for another of the person's Macs to join this one with (device.pair.start): one at a
     * time, in memory only, for PAIRING_CODE_TTL_MS, and used up by the first hello that tries one, right or wrong (T22).
     */
    let pairing: { readonly code: string; readonly expires: number } | undefined;
    const pairStart = Effect.gen(function* () {
      if (computer !== undefined) return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: "A Cloud computer is not one of your Macs: Macs join each other in their own app" }));
      if (!person())
        return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: "This Mac adds your other Macs once its Caveman sign-in names you (Settings, Remote control)" }));
      const code = pairingCode();
      pairing = { code, expires: now() + PAIRING_CODE_TTL_MS };
      changed();
      return { code, expires_at: iso(pairing.expires) };
    });

    // ------------------------------------------------------------ keep awake (S13): what remote devices did lately
    let lastDrove = 0;
    /** Sessions a device started or sent to, with when. */
    const driven = new Map<string, number>();
    const noteDriven = (body: string, createIds: Set<unknown>) => {
      let message: { id?: unknown; method?: unknown; params?: { request_id?: unknown; session_id?: unknown } };
      try {
        message = JSON.parse(body);
      } catch {
        return;
      }
      if (typeof message.params?.request_id !== "string") return;
      lastDrove = now();
      if (message.method === "turn.submit" && typeof message.params.session_id === "string") driven.set(message.params.session_id, lastDrove);
      if (message.method === "workspace.create" && message.id !== undefined) createIds.add(message.id);
    };
    const awake = Effect.gen(function* () {
      const settingsRaw = yield* store.kvGet("settings");
      const settings = settingsRaw === undefined ? {} : (JSON.parse(settingsRaw) as { keep_awake_remote?: boolean });
      if (computer !== undefined || settings.keep_awake_remote === false) return { wanted: false };
      const at = now();
      if (at - lastDrove <= DRIVE_WINDOW_MS) return { wanted: true };
      if (driven.size === 0) return { wanted: false };
      const records = yield* store.listWorkspaces();
      const working = new Set(records.filter((r) => WORKING.has(r.workspace.status)).map((r) => r.workspace.session_id));
      let wanted = false;
      for (const session of driven.keys()) {
        if (working.has(session)) wanted = true;
        else driven.delete(session);
      }
      return { wanted };
    });

    // ------------------------------------------------------------ the person's log (follow)
    const seenNow = (deviceId: string) => {
      const own = saved.devices.find((d) => d.device_id === deviceId);
      if (own) own.last_seen_at = iso(now());
      else saved.seen[deviceId] = iso(now());
      void save(false);
    };
    type Person = NonNullable<ReturnType<typeof person>>;
    /** This Mac's place in `who`'s log: another person's (a new enrollment) starts over, and so does what waits to go. */
    const logFor = (who: Person) => {
      if (log.owner !== ownerOf(who)) {
        log = { owner: ownerOf(who), cursor: 0, statements: [], ids: [] };
        logIds = new Set();
        saved.outbox = saved.outbox.filter((s) => s.organization_id === who.organizationId && s.user_id === who.userId);
        touched();
      }
      return log;
    };
    /** Puts a statement in the log, once: false when it is there already. */
    const keep = (statement: DeviceStatement, id: string) => {
      if (logIds.has(id)) return false;
      logIds.add(id);
      log.statements.push(statement);
      log.ids.push(id);
      touched();
      return true;
    };
    /**
     * The keys whose statements `take` keeps past the cap: the role-mac keys trust reaches, and (their removals) This
     * Mac's own key and the Macs its screen allowed and then removed, whose removals count here whatever trust says.
     */
    const counting = (who: Person) => {
      const macs = new Set([...trustOf(who).devices.values()].filter((d) => d.role === "mac").map((d) => d.device_id));
      const removers = new Set([...(saved.own ? [saved.own] : []), ...saved.retired.map((r) => r.device_id)]);
      return { macs, removers, all: new Set([...macs, ...removers]) };
    };
    /**
     * Takes statements into the log: each verified, of this person, once. Past MAX_STATEMENTS allows, or as many
     * removals, the rest are ignored, except one by a key that counts here (a Mac key This Mac trusts; a removal by a
     * remover): a flood of statements by keys it does not trust (one stolen sign-in's runtimes can put the whole cap)
     * never keeps out what the person's Macs sign after it. What it skips is noted (`counted`): should one of the keys
     * that signed it count here later, the log is read again (catchUp).
     */
    const take = async (who: Person, statements: ReadonlyArray<unknown>) => {
      // Checked at once (a page holds up to 500), then kept in the order the log carried them.
      const checked = await Promise.all(
        statements.map(async (raw) => {
          const statement = await verifyStatement(raw);
          return statement && statement.organization_id === who.organizationId && statement.user_id === who.userId ? { statement, id: await statementId(statement) } : undefined;
        }),
      );
      logFor(who);
      // An agents key's vouch counts with the allows: it only adds (a Mac's mail it takes).
      let removals = log.statements.filter((s) => s.kind === "remove").length;
      let allows = log.statements.length - removals;
      let added = 0;
      for (const one of checked) {
        if (!one) continue;
        const { statement, id } = one;
        if ((statement.kind === "remove" ? removals : allows) >= MAX_STATEMENTS) {
          const keys = counting(who);
          if (!keys.macs.has(statement.signer.device_id) && !(statement.kind === "remove" && keys.removers.has(statement.signer.device_id))) {
            // Skipped: only the keys that counted all along since the log was last read from the start stay noted.
            log.counted = log.counted === undefined ? [...keys.all] : log.counted.filter((id) => keys.all.has(id));
            continue;
          }
        }
        if (!keep(statement, id)) continue;
        if (statement.kind === "remove") removals++;
        else allows++;
        added++;
      }
      return added;
    };
    /**
     * What the log changed, at once: a waiting device a Mac of the person's allowed goes in (and the screen stops
     * asking), and a device no longer trusted here (removed on one of their Macs, or trusted only through a Mac that
     * was) is cut off, its request with it.
     */
    /**
     * Whether the person's log answered a waiting request: a Mac of the person's allowed its device as what it asks to be
     * (one that joined with this Mac's code asks to be a Mac). Never one from a device this screen allowed, which asks to
     * count as a Mac now: only this screen answers that.
     */
    const answeredByLog = (r: StoredRequest) => {
      if (saved.devices.some((d) => d.device_id === r.device_id && d.user_id === r.user_id)) return false;
      const role = roleHere(r.device_id, r.user_id);
      return role !== undefined && (r.role !== "mac" || role === "mac");
    };
    /**
     * A key that counts here now and did not when `take` skipped part of the log (A-3: a new Mac read a flood of
     * removals before its screen allowed the Mac that signed one after it): the log is read again from the start, and
     * counts as unread (stale) until it is back where it was, so what that key signed past the cap is never lost.
     */
    const catchUp = (who: Person) => {
      if (log.owner !== ownerOf(who) || log.counted === undefined) return;
      const before = new Set(log.counted);
      if ([...counting(who).all].every((id) => before.has(id))) return;
      log.rereadTo = Math.max(log.rereadTo ?? 0, log.cursor);
      log.cursor = 0;
      delete log.counted;
      void saveLog();
      nudge();
    };
    const settle = () => {
      // A key that counts now may have signed what the log skipped: read it again (A-3).
      const who = person();
      if (who) catchUp(who);
      // A request the log answered, whether or not its device still waits on a stream, or one refused now.
      const before = saved.requests.length;
      saved.requests = saved.requests.filter((r) => !refusedHere(r.device_id, r.user_id) && !answeredByLog(r));
      let asked = saved.requests.length !== before;
      for (const g of [...gates]) {
        if (g.deviceId === undefined) continue;
        const allowed = allowedFor(g.deviceId, g.userId) !== undefined;
        // A Join's connection waits for the Mac role itself; any other, for the device to be let in.
        const ok = g.wantsMac ? roleHere(g.deviceId, g.userId) === "mac" : allowed;
        if (g.phase === "pending" && ok) {
          asked = true;
          g.approve();
        } else if ((g.phase === "approved" && !allowed) || (g.phase === "pending" && refusedHere(g.deviceId, g.userId))) {
          if (g.phase === "pending") {
            saved.requests = saved.requests.filter((r) => r.device_id !== g.deviceId);
            asked = true;
          }
          g.end("refused", "this device was removed on another of the person's Macs");
        } else if (g.phase === "pending" && g.wantsMac && !saved.requests.some((r) => r.device_id === g.deviceId && r.role === "mac")) {
          // Its request to count as a Mac is gone without a yes (Keep as a device): the Join hears no.
          g.end("refused", "this Mac's screen kept the device as it was");
        }
      }
      if (asked) void save(false);
      changed();
      // Whoever acts on trust beyond the gates hears it changed (macMail.ts: mail a removed Mac queued here, A-4).
      for (const listener of trustListeners) listener();
    };
    /** Pages of the log are taken one at a time, in the order they came. */
    const pageLane = Semaphore.makeUnsafe(1);
    /** When (DevicesClock: the wall clock, which runs on while the Mac sleeps) a read of the log was last taken. */
    let readAt = 0;
    /**
     * Until when Cloud said it keeps no log (404, 405: a Cloud without it) or gives this person's none for now (403): no
     * read waits on it, since Cloud just said there is nothing to read (the follow loop asks again after IDLE_MS).
     */
    let absentUntil = 0;
    const absent = (error: unknown) => error instanceof CloudError && (error.status === 404 || error.status === 403 || error.status === 405);
    const noteAbsent = (error: unknown) => Effect.sync(() => void (absent(error) && (absentUntil = now() + IDLE_MS)));
    /**
     * The last read is stale: it finished longer ago than a wait cycle (the Mac slept, or this runtime just started), so a
     * removal may be waiting in the log that This Mac has not read.
     */
    const stale = () => (now() - readAt > STALE_MS && now() >= absentUntil) || (log.rereadTo !== undefined && log.cursor < log.rereadTo);
    /**
     * Takes a page of the log, and acts on what it changed: whether it moved this Mac's place in the log. `read`: where
     * the read that brought it began (`after`) and when it went out (`sentAt`, DevicesClock).
     */
    const page = (who: Person, got: LogPage, read: { readonly after: number; readonly sentAt: number }) =>
      pageLane.withPermits(1)(
        Effect.gen(function* () {
          const cursor = logFor(who).cursor;
          // A statement numbered at or below the place This Mac read to was in a page taken already (a read beside this
          // one, or Cloud carrying a page again): never checked twice.
          const fresh = Array.isArray(got.statements) ? got.statements.filter((s) => !(typeof s?.seq === "number" && s.seq <= cursor)).map((s) => s?.statement) : [];
          const added = yield* tryCloud(() => take(who, fresh));
          // A page covers the log from where its read began: it moves this Mac's place only from a place at or after
          // that (a read from before the log was read again from the start says nothing of what lies before it).
          const moved = typeof got.seq === "number" && read.after <= logFor(who).cursor && got.seq > logFor(who).cursor;
          if (moved) log.cursor = got.seq;
          const caughtUp = log.rereadTo !== undefined && log.cursor >= log.rereadTo;
          if (caughtUp) delete log.rereadTo;
          if (added > 0 || moved || caughtUp) yield* Effect.promise(saveLog);
          // Fresh only when the read went out within a wait cycle of now: one sent before a sleep and answered after
          // the wake (or answered while the Mac slept) says nothing of what was signed meanwhile (A-9).
          if (now() - read.sentAt <= STALE_MS) readAt = now();
          if (added > 0) settle();
          return moved;
        }),
      );
    /** The read hellos wait on now, shared by those at once; it runs to its end whoever stops waiting. */
    let pulling: Deferred.Deferred<void> | undefined;
    let pulledAt = 0;
    /**
     * One read of the log now, waited on for `ms` at most, its checks included: a device This Mac does not know yet
     * may be in it. Hellos at once share one read, and a read moments ago stands (a burst of new keys never spends the
     * log's rate on Cloud). One that lands later still approves a device that waits (settle).
     */
    const pullLog = (ms: number) =>
      Effect.gen(function* () {
        let done = pulling;
        if (done === undefined) {
          const who = person();
          const identity = identityNow();
          const link = logLink?.link;
          if (!who || !identity || !link || now() - pulledAt < PULL_GAP_MS || now() < absentUntil) return;
          pulledAt = now();
          const started = Deferred.makeUnsafe<void>();
          done = pulling = started;
          const read = { after: logFor(who).cursor, sentAt: now() };
          yield* tryCloud(() => statementsAfter(identity, link, read.after, 0, { timeoutMs: ms })).pipe(
            Effect.tapError(noteAbsent),
            Effect.flatMap((got) => page(who, got, read)),
            // Not read in time, or Cloud is away: the screen asks.
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                if (pulling === started) pulling = undefined;
                Deferred.doneUnsafe(started, Exit.void);
              }),
            ),
            Effect.forkDetach,
          );
        }
        yield* Effect.raceFirst(Deferred.await(done), Effect.sleep(ms));
      });
    let wake: AbortController | undefined;
    /** A statement waits to go, or the Mac woke: the follow loop stops waiting on Cloud and goes again now. */
    const nudge = () => {
      wake?.abort();
      idle.poke();
    };
    /** Puts what this screen signed: a statement Cloud refuses for good is kept here with why, and never holds up the rest. */
    const send = (identity: Identity, link: LinkState, who: Person) =>
      Effect.gen(function* () {
        const going = saved.outbox.filter((s) => s.organization_id === who.organizationId && s.user_id === who.userId);
        const done = new Set<DeviceStatement>();
        let parked = false;
        /** Cloud took them (undefined), or refused them for good (why); anything else fails the round, to go again. */
        const put = (batch: ReadonlyArray<DeviceStatement>) =>
          tryCloud(() => putStatements(identity, link, batch)).pipe(
            Effect.as<string | undefined>(undefined),
            Effect.catch((error) => (final(error) ? Effect.succeed((error as Error).message) : Effect.fail(error))),
          );
        yield* Effect.gen(function* () {
          for (let i = 0; i < going.length; i += 16) {
            const batch = going.slice(i, i + 16);
            if ((yield* put(batch)) === undefined) {
              for (const s of batch) done.add(s);
              continue;
            }
            // One at a time: Cloud's no is one statement's, and the others go.
            for (const s of batch) {
              const why = yield* put([s]);
              if (why !== undefined) {
                saved.refused[yield* Effect.promise(() => statementId(s))] = why;
                parked = true;
                yield* Effect.logWarning(`devices: Caveman Cloud would not carry a ${s.kind} of ${s.device_id} to the person's other Macs: ${why}`);
              }
              done.add(s);
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (done.size > 0) {
                saved.outbox = saved.outbox.filter((s) => !done.has(s));
                for (const s of done) outboxIds.delete(s.signature);
                yield* Effect.promise(() => save(false));
              }
              // Sent or refused: the screen stops saying it waits (m-j).
              if (parked || done.size > 0) changed();
            }),
          ),
        );
      });
    /**
     * One round: what this screen signed goes up, then the log is read, waiting on Cloud up to LOG_WAIT_MS. A put that
     * failed never keeps this Mac from reading what the person's other Macs signed; it is tried again after. True when
     * Cloud answered a wait at once with nothing new (one that ignores the wait, or carries a page again).
     */
    const round = (link: DeviceLogLink, identity: Identity, who: Person) =>
      Effect.gen(function* () {
        logFor(who);
        // A key that counts here since the last round (or since a restart cut one short) may have signed what was skipped.
        catchUp(who);
        // A new runtime (signed out and in again): Cloud deleted the allows the one before put, as it does a revoked
        // runtime's, so this screen's standing allows go up again under this one (Cloud keeps one row per statement).
        if (saved.putAs !== identity.runtimeId) {
          const standing = new Set([...saved.devices.flatMap((d) => (d.statement === undefined ? [] : [d.statement])), ...(saved.vouch === undefined ? [] : [saved.vouch])]);
          log.statements.forEach((s, i) => {
            if (s.kind === "remove" || !standing.has(log.ids[i]!) || saved.outbox.includes(s)) return;
            saved.outbox.push(s);
            outboxIds.set(s.signature, log.ids[i]!);
          });
          saved.putAs = identity.runtimeId;
          yield* Effect.promise(() => save(false));
        }
        const failed = yield* send(identity, link.link, who).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed({ error })),
        );
        const controller = new AbortController();
        wake = controller;
        // Statements still to go: the log as it stands, then the put again.
        const waitMs = saved.outbox.length > 0 ? 0 : LOG_WAIT_MS;
        const started = Date.now();
        const read = { after: logFor(who).cursor, sentAt: now() };
        const got = yield* tryCloud(() => statementsAfter(identity, link.link, read.after, waitMs, { signal: controller.signal })).pipe(
          Effect.catch((error) => (controller.signal.aborted ? Effect.succeed(undefined) : noteAbsent(error).pipe(Effect.andThen(Effect.fail(error))))),
          Effect.ensuring(Effect.sync(() => void (wake === controller && (wake = undefined)))),
        );
        const moved = got ? yield* page(who, got, read) : false;
        if (failed) return yield* Effect.fail(failed.error);
        return got !== undefined && waitMs > 0 && !moved && Date.now() - started < RETRY_MIN_MS;
      });
    /**
     * Follows the person's log for the runtime's life (This Mac only): puts what this screen signed, takes what their
     * other Macs signed, and acts on it at once. Cloud without the log, or an enrollment that names no person, shares
     * nothing and loses nothing: this Mac's own screen still allows.
     */
    const follow = (link: DeviceLogLink): Effect.Effect<void> =>
      computer !== undefined
        ? Effect.void
        : Effect.gen(function* () {
            logLink = link;
            touched();
            let failures = 0;
            while (true) {
              const identity = identityNow();
              const who = person();
              // Not signed in yet (or the sign-in names no person): an enrollment, or a statement signed here, wakes it.
              if (!identity || !who) {
                yield* idle.sleep(SIGNED_OUT_MS);
                continue;
              }
              const result = yield* round(link, identity, who).pipe(Effect.result);
              if (result._tag === "Success") {
                failures = 0;
                // Cloud did not wait: the next round waits a moment (a statement this screen signs still goes at once).
                if (result.success) yield* idle.sleep(RETRY_MIN_MS);
                continue;
              }
              const error = result.failure;
              // Cloud without the log, or not taking this person's statements for now (a 403 keeps the outbox).
              if (absent(error)) {
                yield* idle.sleep(IDLE_MS);
                continue;
              }
              failures++;
              yield* Effect.logWarning(`devices: a round with the person's device log did not finish (${String(error)})`);
              yield* idle.sleep(Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS) * (0.5 + Math.random() / 2));
            }
          });

    // ------------------------------------------------------------ the gate on each relayed stream
    const errorFrame = (id: unknown, message: string, reason: "device_not_approved" | "invalid_params" | "rate_limited" = "device_not_approved") =>
      JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: ErrorCodes[reason], message, data: { reason } } });

    /**
     * Gates one relayed stream to This Mac. `serve` hands a stream to the Session Protocol server; it runs only once
     * the device is approved, and gets only the frames the device sealed.
     */
    const gate = (stream: FrameChannel, info: { readonly runtimeId: string; readonly userId: string }, serve: (stream: FrameChannel) => FrameSink): FrameSink => {
      const nonce = toBase64url(randomBytes(32));
      let ephemeral: { readonly public_key: string; readonly privateKey: WebKey } | undefined;
      let keys: ReturnType<typeof frameCrypto> | undefined;
      /** The last frame read from the device, and the last sent to it, once approved. */
      let seq = 0;
      let sent = 0;
      let inner: FrameSink | undefined;
      let code = "";
      const createIds = new Set<unknown>();
      let chain: Promise<void> = Promise.resolve();

      const close = (reason: string) => {
        if (self.phase === "closed") return;
        // relay.ts tells this sink `closed` as it closes the stream.
        stream.close(reason);
      };
      /** The gate lets go of the stream: nothing more reaches the server or the device, and the server's connection ends. */
      const shut = (reason: string) => {
        if (self.phase === "closed") return;
        const wasApproved = self.phase === "approved";
        self.phase = "closed";
        clearTimeout(timer);
        gates.delete(self);
        inner?.closed(reason);
        if (wasApproved) changed();
      };
      /** One frame to the device: encrypted once approved (nothing plain follows the approval), plain before. */
      const toDevice = (text: string): Promise<void> => {
        if (self.phase !== "approved" || !keys) return stream.send(text);
        let sealed: string;
        try {
          sealed = keys.seal(++sent, text);
        } catch {
          close("a frame could not be sealed");
          return Promise.resolve();
        }
        return stream.send(sealed);
      };
      const status = (value: DeviceStatus) =>
        toDevice(JSON.stringify({ jsonrpc: "2.0", method: "device.status", params: { status: value, runtime_name: runtimeName(), code } }));
      /** A Join's proof that this screen took it as one of the person's Macs (pairAnswer, under the code it showed); undefined: no Join. */
      let joined: string | undefined;
      /**
       * A Join's answer (m-h): the first frame sealed on its connection names the role "mac", proved under the code, so
       * the joining Mac says it was taken only once this Mac's screen did, and never on a status the relay made up.
       */
      const confirmJoin = () =>
        joined === undefined || self.deviceId === undefined || roleHere(self.deviceId, self.userId) !== "mac"
          ? Promise.resolve()
          : toDevice(JSON.stringify({ jsonrpc: "2.0", method: "device.status", params: { status: "approved", runtime_name: runtimeName(), code, role: "mac", proof: joined } }));
      const startServing = () => {
        clearTimeout(timer);
        inner = serve({
          send: (data) => {
            if (self.phase === "closed") return Promise.resolve();
            // The answer to a workspace.create the device sent: its chat counts as one it started.
            if (createIds.size > 0 && typeof data === "string") {
              try {
                const reply = JSON.parse(data) as { id?: unknown; result?: { session_id?: unknown } };
                if (reply.id !== undefined && createIds.delete(reply.id) && typeof reply.result?.session_id === "string") driven.set(reply.result.session_id, now());
              } catch {
                // Not JSON: not an answer.
              }
            }
            // The server speaks text frames only; anything else cannot be sealed, so it does not go.
            if (typeof data !== "string") return Promise.resolve(close("a frame could not be sealed"));
            return toDevice(data);
          },
          close,
        });
      };

      const self: Gate = {
        userId: info.userId,
        deviceId: undefined,
        phase: "starting",
        approve: () => {
          if (self.phase !== "pending") return;
          if (self.wantsMac && (self.deviceId === undefined || roleHere(self.deviceId, self.userId) !== "mac")) return;
          // Said plain, as the device's hello was answered; every frame after it goes sealed, a Join's answer first.
          void status("approved");
          self.phase = "approved";
          seq = 0;
          sent = 0;
          void confirmJoin();
          startServing();
        },
        end: (value, reason) => {
          if (self.phase === "closed") return;
          // The device hears why (sealed when it was approved). The gate stops now, not once that left a socket that may
          // be backed up; the stream ends then.
          const told = status(value);
          shut(reason);
          void told.finally(() => stream.close(reason));
        },
      };
      gates.add(self);
      let timer = setTimeout(() => self.phase !== "approved" && close("no device.hello"), HELLO_TIMEOUT_MS);
      timer.unref?.();
      /**
       * A pending stream waits as long as its request lives. One that closed, or was approved, while its pending answer
       * waited in a backed-up socket arms nothing: shut and startServing cleared its timer already.
       */
      const waitFor = (request: StoredRequest) => {
        if (self.phase !== "pending") return;
        clearTimeout(timer);
        timer = setTimeout(() => self.phase === "pending" && close("nobody answered on this computer"), Math.max(0, Date.parse(request.at) + DEVICE_REQUEST_TTL_MS - now()));
        timer.unref?.();
      };

      const hello = async (id: unknown, params: unknown) => {
        self.phase = "verifying";
        // A Mac that names its owner takes only their devices, as Caveman Cloud lets a person attach only to computers of
        // their own: another person's (Cloud's word for who asks, as for every stream) is told so before its key is
        // looked at. It asks no screen, is never listed as waiting, and uses up no code this screen shows.
        const owner = person();
        if (owner && info.userId !== owner.userId) {
          await stream.send(errorFrame(id, `${runtimeName()} takes only its owner's devices.`));
          return close("another person's device");
        }
        const p = isObject(params) ? params : {};
        const publicKey = publicKeyOf(p.public_key);
        if (!publicKey || typeof p.key !== "string" || typeof p.signature !== "string" || !ephemeral) {
          await stream.send(errorFrame(id, "device.hello needs a P-256 public key, a key and a signature", "invalid_params"));
          return close("bad device.hello");
        }
        const deviceId = await deviceIdOf(publicKey);
        if (p.device_id !== undefined && p.device_id !== deviceId) {
          await stream.send(errorFrame(id, "the device id is not its key's"));
          return close("device id mismatch");
        }
        // A v2 hello signs the device's kind and name too; a v1 one (an older device, or an offer the relay stripped)
        // signs neither and reads as a device, which only ever narrows what it may do.
        if (p.kind !== undefined && p.kind !== "mac" && p.kind !== "device") {
          await stream.send(errorFrame(id, 'a device\'s kind is "mac" or "device"', "invalid_params"));
          return close("bad device.hello");
        }
        const claimed: DeviceKind = p.kind === "mac" ? "mac" : "device";
        const signed = helloPayload({
          runtime_id: info.runtimeId,
          nonce,
          runtime_key: ephemeral.public_key,
          device_key: p.key,
          ...(p.kind !== undefined ? { v2: { kind: claimed, name: cleanDeviceName(p.name) } } : {}),
        });
        if (!(await verifyDeviceSignature(publicKey, signed, p.signature))) {
          await stream.send(errorFrame(id, "the device's signature does not hold for this connection"));
          return close("bad device signature");
        }
        try {
          keys = frameCrypto(await channelKeyBytes({ privateKey: ephemeral.privateKey, peer_key: p.key, runtime_id: info.runtimeId, nonce, runtime_key: ephemeral.public_key, device_key: p.key }));
        } catch {
          await stream.send(errorFrame(id, "the device's key is not a P-256 key", "invalid_params"));
          return close("bad device key");
        }
        if (self.phase !== "verifying") return;
        self.deviceId = deviceId;
        code = deviceCode(deviceId);
        const answer = (value: DeviceStatus) => stream.send(JSON.stringify({ jsonrpc: "2.0", id, result: { status: value, code } }));
        const name = cleanDeviceName(p.name);
        // Decision 31: a key counts as a Mac here only when its v2 hello, which signs its kind "mac", proves the code this
        // Mac's screen shows (device.pair.start), for this very key: the proof names the key's id, so the same hello bytes
        // signed again by a key the relay swapped in never carry it (A-1). Any proof uses the code up, right or wrong: one
        // try (T22). A hello that says "mac" without one asks as a device, as a page Cloud serves could say it.
        let paired = false;
        if (p.pair !== undefined) {
          const live = pairing;
          pairing = undefined;
          const who = person();
          paired =
            typeof p.pair === "string" &&
            live !== undefined &&
            now() <= live.expires &&
            p.kind === "mac" &&
            who !== undefined &&
            info.userId === who.userId &&
            (await verifyPairProof(live.code, deviceId, signed, p.pair));
          if (paired && live !== undefined) joined = await pairAnswer(live.code, deviceId, signed);
          if (live !== undefined) changed();
          if (!paired) {
            await stream.send(
              errorFrame(id, `That code did not join ${runtimeName()}: it was wrong, used, or more than 10 minutes old. On ${runtimeName()}, choose Add a Mac again and type its new code.`, "invalid_params"),
            );
            return close("a wrong or old pairing code");
          }
        }
        if (self.phase !== "verifying") return;
        // The person's log is read first, briefly, for a device This Mac does not know yet (another of their Macs may
        // have allowed it), and for any device once the last read is stale (the Mac slept: a removal may be waiting).
        const who = person();
        if (who && info.userId === who.userId) {
          const old = stale();
          // The follow loop's read from before the sleep is dropped too: it goes again at once.
          if (old) wake?.abort();
          if (old || (!allowedFor(deviceId, info.userId) && !refusedHere(deviceId, info.userId))) await runPromise(pullLog(LOG_PULL_MS));
        }
        if (self.phase !== "verifying") return;
        if (allowedFor(deviceId, info.userId)) {
          seenNow(deviceId);
          // A device this Mac lets in that joined with the code and does not count as a Mac here yet: the screen is asked
          // once whether it does, about the device as this screen allowed it (its stored name and key), else as it asks.
          // Its other connections drive this Mac as before. This one, the Join's own, waits on that answer: approved once
          // the screen allows it as a Mac, refused once it keeps it as a device, so Join never says the Mac was taken
          // while the screen still asks (m-13).
          if (paired && roleHere(deviceId, info.userId) !== "mac") {
            let request = saved.requests.find((r) => r.device_id === deviceId && r.role === "mac");
            const fresh = request === undefined;
            if (request === undefined) {
              const root = saved.devices.find((d) => d.device_id === deviceId && d.user_id === info.userId);
              request = { device_id: deviceId, name: root?.name ?? name, public_key: root?.public_key ?? publicKey, user_id: info.userId, at: iso(now()), role: "mac" };
              saved.requests = [...saved.requests.filter((r) => r.device_id !== deviceId), request];
              void save(false);
            }
            self.phase = "pending";
            self.wantsMac = true;
            await answer("pending");
            waitFor(request);
            if (fresh) options.notifyLocal("device.request", { device_id: deviceId, name: request.name, code, user_id: info.userId, at: request.at, public_key: request.public_key, role: "mac" } satisfies DeviceRequest);
            changed();
            return;
          }
          self.phase = "approved";
          seq = 0;
          await answer("approved");
          await confirmJoin();
          // The stream closed, or the device was removed, while the approval waited in a backed-up socket.
          if (self.phase !== "approved") return;
          startServing();
          changed();
          return;
        }
        // Allowed for another person, blocked here, or removed on one of the person's Macs: no.
        if (refusedHere(deviceId, info.userId)) {
          await answer("refused");
          return close("this device may not drive this computer");
        }
        lapse();
        const waiting = saved.requests.find((r) => r.device_id === deviceId);
        // One request per device, for the person it first asked as: the screen shows that one.
        if (waiting && waiting.user_id !== info.userId) {
          await stream.send(errorFrame(id, `This device already waits for ${runtimeName()}'s answer for another person. Try again once that is answered.`, "rate_limited"));
          return close("this device already waits for an answer for another person");
        }
        if (!waiting && !paired && saved.requests.length >= MAX_REQUESTS) {
          // Not a no for this device: it asks again later, once the person answered the others or they lapsed.
          await stream.send(errorFrame(id, `${runtimeName()} has too many devices waiting for an answer. Try again in a few minutes.`, "rate_limited"));
          return close("too many devices are waiting for an answer");
        }
        // The screen answers a request as it shows it: asking again while it waits never changes its kind or name (a
        // page Cloud serves could ask as a phone, then as a Mac just before the click), and the stream joins it. Only
        // the code changes it: a Mac that joined with it asks as one, under the name the screen showed (decision 31).
        // A v1 hello never said its kind: a device, with no kind kept.
        const fresh = waiting === undefined || (paired && waiting.role !== "mac");
        const request: StoredRequest = !fresh
          ? waiting
          : { device_id: deviceId, name: waiting?.name ?? name, public_key: publicKey, user_id: info.userId, at: iso(now()), ...(paired ? { role: "mac" as const } : p.kind !== undefined ? { role: "device" as const } : {}) };
        if (fresh) {
          saved.requests = [...saved.requests.filter((r) => r.device_id !== deviceId), request];
          void save();
        }
        self.phase = "pending";
        // A Join waits for the Mac role itself: an allow of this key as a device (another Mac's, from the log) is no
        // answer to it, and approves nothing on this connection while the screen still asks (m-h).
        if (paired) self.wantsMac = true;
        await answer("pending");
        waitFor(request);
        if (fresh) options.notifyLocal("device.request", { device_id: deviceId, name: request.name, code, user_id: info.userId, at: request.at, public_key: publicKey, ...(request.role ? { role: request.role } : {}) } satisfies DeviceRequest);
        changed();
      };

      const frame = async (data: string | Uint8Array) => {
        if (self.phase === "closed") return;
        if (self.phase === "approved") {
          const body = typeof data === "string" && keys ? keys.open(seq + 1, data) : undefined;
          if (body === undefined) return close("a frame was not sealed by this device");
          seq++;
          noteDriven(body, createIds);
          inner?.message(body);
          return;
        }
        if (typeof data !== "string") return;
        let message: { id?: unknown; method?: unknown; params?: unknown };
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (!isObject(message)) return;
        if (message.method === "device.hello" && self.phase === "challenged") return hello(message.id, message.params);
        // Nothing else runs before the Mac allowed this device: no reads either (chats that do not sync are not Cloud's).
        if (message.id !== undefined) {
          await stream.send(
            errorFrame(
              message.id,
              self.phase === "pending" ? `Waiting for ${runtimeName()} to allow this device.` : `Allow this device on ${runtimeName()} first.`,
            ),
          );
        }
      };

      chain = (async () => {
        ephemeral = await ephemeralKey();
        if (self.phase !== "starting") return;
        self.phase = "challenged";
        await stream.send(JSON.stringify({ jsonrpc: "2.0", method: "device.challenge", params: { nonce, runtime_id: info.runtimeId, key: ephemeral.public_key, runtime_name: runtimeName(), hello: 2 } }));
      })();

      return {
        message: (data) => {
          chain = chain.then(() => frame(data)).catch(() => close("the device check failed"));
        },
        closed: shut,
      };
    };

    // ------------------------------------------------------------ local clients
    const localOnly = (principal: string) =>
      principal === "local" ? Effect.void : Effect.fail(new ProtocolError({ reason: "forbidden", message: "only this computer's own screen manages the devices that drive it" }));

    /**
     * A statement this screen's desktop key signed, checked against what it names: that device as it asked here (its
     * key, name and kind), for this Mac's own person, never the payload's say. It goes in the outbox, which the caller
     * saves with what the screen changed, and only then in this Mac's own log (logged): a statement in the log but not
     * the outbox would count here and never reach the person's other Macs.
     */
    const checked = (statement: unknown, kind: "allow" | "remove" | "agents", deviceId: string, record?: { readonly public_key: DevicePublicKey; readonly name: string; readonly user_id: string; readonly role?: DeviceKind | undefined }) =>
      Effect.gen(function* () {
        const who = person();
        if (!who) return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: "This Mac shares approvals with your other Macs once its Caveman sign-in names you (Settings, Remote control)" }));
        const bad = (why: string) => Effect.fail(new ProtocolError({ reason: "invalid_params", message: `the signed statement ${why}` }));
        const s = yield* Effect.promise(() => verifyStatement(statement));
        if (!s) return yield* bad("does not verify");
        if (s.kind !== kind || s.device_id !== deviceId) return yield* bad(`is not ${kind === "allow" ? "an allow" : kind === "agents" ? "a vouch" : "a removal"} of that ${kind === "agents" ? "agents key" : "device"}`);
        if (s.organization_id !== who.organizationId || s.user_id !== who.userId) return yield* bad("names another person or organization than this Mac's");
        if (
          kind === "allow" &&
          (!record || record.user_id !== who.userId || s.public_key?.x !== record.public_key.x || s.public_key?.y !== record.public_key.y || s.name !== record.name || s.role !== (record.role ?? "device"))
        )
          return yield* bad("does not match the device that asked");
        if (kind === "agents" && (!record || s.public_key?.x !== record.public_key.x || s.public_key?.y !== record.public_key.y || s.name !== record.name))
          return yield* bad("does not name this runtime's agents key and This Mac's name");
        saved.own = s.signer.device_id;
        logFor(who);
        const id = yield* Effect.promise(() => statementId(s));
        saved.outbox.push(s);
        outboxIds.set(s.signature, id);
        return { statement: s, id };
      });
    /** The screen's statement in this Mac's own log, once the outbox that holds it is saved. */
    const logged = (signed: { readonly statement: DeviceStatement; readonly id: string } | undefined) =>
      signed !== undefined && keep(signed.statement, signed.id) ? Effect.promise(saveLog) : Effect.void;

    const allow = (deviceId: string, statement?: unknown, role?: DeviceKind) =>
      Effect.gen(function* () {
        lapse();
        const known = saved.devices.find((d) => d.device_id === deviceId);
        const request = saved.requests.find((r) => r.device_id === deviceId);
        if (!request && !known) return yield* Effect.fail(new ProtocolError({ reason: "not_found", message: "no device is waiting with that id" }));
        // A request another person's device left before this Mac named its owner: not this screen's to allow any more.
        const owner = person();
        if (request !== undefined && owner !== undefined && request.user_id !== owner.userId)
          return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `${runtimeName()} takes only its owner's devices.` }));
        // A device this Mac lets in (allowed here, or through another of the person's Macs), asking now to count as a Mac:
        // it joined with this Mac's code (hello).
        const upgrade = request !== undefined && (known !== undefined || roleHere(deviceId, request.user_id) !== undefined);
        // The click answers the request the screen showed: a kind it did not show is refused. Only an upgrade may be
        // answered "device", which keeps it as it was.
        const asked = request?.role ?? known?.role ?? "device";
        if (role !== undefined && role !== asked && !(upgrade && role === "device"))
          return yield* Effect.fail(
            new ProtocolError({ reason: "invalid_state", message: `this device asks as ${asked === "mac" ? "a Mac" : "a device"} now, not as the screen showed it: look at its request again` }),
          );
        // Removed on another of the person's Macs: nothing is allowed or signed here until this screen lifts that.
        const who = person();
        if (who && trustOf(who).removed.has(deviceId))
          return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: "another of your Macs removed this device: unblock it here first" }));
        if (upgrade && role === "device") {
          if (statement !== undefined) return yield* Effect.fail(new ProtocolError({ reason: "invalid_params", message: "keeping a Mac as it was signs nothing" }));
          // Kept as it was: a device, here as wherever it was allowed. Only the code asks again. The Join that asked hears
          // no (settle).
          saved.requests = saved.requests.filter((r) => r.device_id !== deviceId);
          saved.devices = saved.devices.map((d) => (d.device_id === deviceId ? { ...d, role: "device" } : d));
          yield* Effect.promise(() => save());
          settle();
          return { device: view().devices.find((d) => d.device_id === deviceId)! };
        }
        // An upgrade is answered for the device as this screen allowed it: its name and key stay the ones kept here.
        const answered = upgrade && known ? { ...request, name: known.name, public_key: known.public_key, user_id: known.user_id } : request;
        const signed = statement === undefined ? undefined : yield* checked(statement, "allow", deviceId, answered ?? known);
        if (answered) {
          saved.requests = saved.requests.filter((r) => r.device_id !== deviceId);
          saved.blocked = saved.blocked.filter((b) => b.device_id !== deviceId);
          saved.devices = [
            ...saved.devices.filter((d) => d.device_id !== deviceId),
            {
              device_id: deviceId,
              name: answered.name,
              public_key: answered.public_key,
              user_id: answered.user_id,
              added_at: known?.added_at ?? iso(now()),
              ...(known?.last_seen_at ? { last_seen_at: known.last_seen_at } : {}),
              ...(answered.role ? { role: answered.role } : {}),
              ...(signed ? { statement: signed.id } : {}),
            },
          ];
        } else if (signed) saved.devices = saved.devices.map((d) => (d.device_id === deviceId ? { ...d, statement: signed.id } : d));
        yield* Effect.promise(() => save());
        yield* logged(signed);
        nudge();
        const device = saved.devices.find((d) => d.device_id === deviceId)!;
        if (!allowedFor(deviceId, device.user_id))
          return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: "another of your Macs removed this device: unblock it here first" }));
        for (const g of gates) if (g.deviceId === deviceId && g.userId === device.user_id) g.approve();
        // A Mac allowed here may bring in devices it allowed: they go in at once.
        settle();
        return { device: view().devices.find((d) => d.device_id === deviceId)! };
      });

    const remove = (deviceId: string, statement?: unknown) =>
      Effect.gen(function* () {
        const who = person();
        const trust = who ? trustOf(who) : undefined;
        const device = saved.devices.find((d) => d.device_id === deviceId);
        const through = trust?.devices.get(deviceId);
        const request = saved.requests.find((r) => r.device_id === deviceId);
        const blocked = saved.blocked.find((b) => b.device_id === deviceId);
        const removedElsewhere = trust?.removed.get(deviceId);
        if (!device && !through && !request && !blocked && !removedElsewhere) return yield* Effect.fail(new ProtocolError({ reason: "not_found", message: "no device with that id" }));
        // A device another Mac removed is listed as removed: unsigned, this is its Unblock. Never for one that waits for
        // the screen: Don't allow is a no, and only Unblock lifts a removal.
        const removing = statement === undefined && removedElsewhere && !through && !request ? undefined : (device ?? through ?? request);
        let signed: { readonly statement: DeviceStatement; readonly id: string } | undefined;
        if (removing) {
          signed = statement === undefined ? undefined : yield* checked(statement, "remove", deviceId);
          // A Mac removed here keeps its removals here (a removed Mac's removals still stand).
          if ((through?.role ?? device?.role) === "mac") saved.retired = [...saved.retired.filter((r) => r.device_id !== deviceId), { device_id: deviceId, name: removing.name }];
          saved.devices = saved.devices.filter((d) => d.device_id !== deviceId);
          saved.requests = saved.requests.filter((r) => r.device_id !== deviceId);
          saved.lifted = saved.lifted.filter((key) => !key.startsWith(`${deviceId}:`));
          saved.blocked = [...saved.blocked.filter((b) => b.device_id !== deviceId), { device_id: deviceId, name: removing.name, at: iso(now()), ...(signed ? { statement: signed.id } : {}) }];
        } else {
          // Unblock: this Mac's own word, which no other Mac hears.
          if (statement !== undefined) return yield* Effect.fail(new ProtocolError({ reason: "invalid_params", message: "Unblock signs nothing: it counts on this Mac only" }));
          saved.blocked = saved.blocked.filter((b) => b.device_id !== deviceId);
          if (removedElsewhere) {
            // The removals by the person's other Macs that stand now are lifted here; a later one counts again.
            saved.lifted = [...new Set([...saved.lifted, ...log.statements.filter((s) => s.kind === "remove" && s.device_id === deviceId).map(removalKey)])];
            // Removed elsewhere, perhaps stolen: even one this screen had allowed asks again, showing its code, before
            // it is let back in here. A Mac among them keeps its removals here, as one removed on this screen does.
            if (device?.role === "mac") saved.retired = [...saved.retired.filter((r) => r.device_id !== deviceId), { device_id: deviceId, name: device.name }];
            saved.devices = saved.devices.filter((d) => d.device_id !== deviceId);
          }
        }
        yield* Effect.promise(() => save());
        yield* logged(signed);
        nudge();
        // Its open streams end now, not at their next frame.
        if (removing) for (const g of [...gates]) if (g.deviceId === deviceId) g.end("refused", device || through ? "this device was removed on the computer" : "the computer did not allow this device");
        // A Mac removed here takes the devices trusted only through it along.
        settle();
        return {};
      });

    // ------------------------------------------------------------ this runtime's agents key (macMail.ts)
    /** This runtime's agents key's vouch, as this screen signed it and the log holds it. */
    const vouched = () => {
      const agents = options.agentsKey;
      const at = saved.vouch === undefined ? -1 : log.ids.indexOf(saved.vouch);
      return agents !== undefined && at >= 0 && log.statements[at]?.kind === "agents" && log.statements[at]?.device_id === agents.device_id;
    };
    /**
     * That vouch is in this Mac's log and Cloud took it (it waits in the outbox no more, and was not refused), so the
     * person's other Macs can read it: until then a mail this runtime signs reaches them from a key no Mac vouched for,
     * which they drop for good (macMail.ts sends nothing before).
     */
    const shared = () => {
      const agents = options.agentsKey;
      if (agents === undefined || saved.vouch === undefined || !vouched() || saved.refused[saved.vouch] !== undefined) return false;
      return !saved.outbox.some((s) => s.kind === "agents" && s.device_id === agents.device_id);
    };
    const agentsView = () => ({ ...(options.agentsKey ? { agents: options.agentsKey } : {}), name: runtimeName(), vouched: vouched(), shared: shared() });
    /**
     * This screen's desktop key vouches for this runtime's agents key: the statement names exactly that key and This
     * Mac's name, for its person. It goes in the outbox and the log as an allow does, and again under a new runtime.
     */
    const vouch = (statement: unknown) =>
      Effect.gen(function* () {
        const agents = options.agentsKey;
        if (agents === undefined)
          return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: "This Mac's runtime has no agents key: it sends and takes mail between your Macs only in the desktop app" }));
        const signed = yield* checked(statement, "agents", agents.device_id, { public_key: agents.public_key, name: runtimeName(), user_id: person()?.userId ?? "" });
        saved.vouch = signed.id;
        yield* Effect.promise(() => save());
        yield* logged(signed);
        nudge();
        return { vouched: true };
      });

    const handlers = {
      "device.hello": () => Effect.fail(new ProtocolError({ reason: "invalid_state", message: "this connection needs no device approval" })),
      "device.list": (_params: unknown, connection: { readonly principal: string }) => localOnly(connection.principal).pipe(Effect.as(view())),
      "device.allow": (params: { readonly device_id: string; readonly statement?: unknown; readonly role?: DeviceKind }, connection: { readonly principal: string }) =>
        localOnly(connection.principal).pipe(Effect.andThen(allow(params.device_id, params.statement, params.role))),
      "device.remove": (params: { readonly device_id: string; readonly statement?: unknown }, connection: { readonly principal: string }) =>
        localOnly(connection.principal).pipe(Effect.andThen(remove(params.device_id, params.statement))),
      "device.awake": (_params: unknown, connection: { readonly principal: string }) => localOnly(connection.principal).pipe(Effect.andThen(awake)),
      "device.pair.start": (_params: unknown, connection: { readonly principal: string }) => localOnly(connection.principal).pipe(Effect.andThen(pairStart)),
      "device.agents": (_params: unknown, connection: { readonly principal: string }) => localOnly(connection.principal).pipe(Effect.as(agentsView())),
      "device.vouch": (params: { readonly statement: unknown }, connection: { readonly principal: string }) => localOnly(connection.principal).pipe(Effect.andThen(vouch(params.statement))),
    };

    /**
     * Whether trust as it stands may answer a queued call or move for `userId`: after a sleep or a restart (the last read
     * of the log is stale) only once a fresh read landed, since a removal may wait in the log (a phone stolen while This
     * Mac slept, its calls queued for the wake). A hello from a known device goes on while Cloud is away; mail fails
     * closed instead: not answered now, and tried again (TRUST_UNREAD).
     */
    const readFor = (userId: string) =>
      runPromise(
        Effect.gen(function* () {
          const who = person();
          if (!who || userId !== who.userId || !stale()) return true;
          wake?.abort();
          yield* pullLog(LOG_PULL_MS);
          return !stale();
        }),
      );
    const unread = { ok: false, code: TRUST_UNREAD, reason: "This Mac has not read your Macs' device approvals in Caveman since it woke or started; it tries again." } as const;

    return {
      /** Null on a Cloud computer: its relayed streams go straight to the server. */
      gate: computer === undefined ? gate : null,
      /** For the runner of calls Cloud queued (mail channel `call`): on This Mac, only ones a device it trusts signed. */
      queuedCallAllowed: async (userId: string, call: Omit<DeviceCall, "at">, device: CallDevice | undefined) =>
        computer !== undefined ? ({ ok: true } as const) : !(await readFor(userId)) ? unread : queuedCallAllowed(allowedList(), userId, call, device, now()),
      /**
       * For the runner of move mail (A4): on This Mac, only a move a device it trusts signed (security review R-2). A
       * refusal says what This Mac knows of the device the mail names (seenAs): only one removed here or on a Mac may
       * its chat name by code, since the mail is Cloud's word.
       */
      queuedMoveAllowed: async (userId: string, move: DeviceMove, device: CallDevice | undefined) => {
        if (computer !== undefined) return { ok: true } as const;
        if (!(await readFor(userId))) return unread;
        const out = await queuedMoveAllowed(allowedList(), userId, move, device, now());
        const seen = device === undefined ? undefined : seenAs(device.device_id, userId);
        return out.ok ? out : { ...out, ...(seen ? { seen } : {}) };
      },
      /** The person's log, followed for the runtime's life (server.ts starts it with the Cloud link). */
      follow,
      /**
       * For the Mac mail reader (macMail.ts): the agents key `id` of one of the person's Macs, as trust stands for the
       * enrollment's person, when a Mac This Mac trusts vouched for it. `unread`: the log is stale (after a sleep or a
       * start) and a fresh read did not land, so nothing is answered yet. `pull`: a stale log, or a key This Mac does not
       * know yet, is read again first, briefly, as for a device's hello (the Mac that vouched for it may have done so a
       * moment ago); without it, the answer is from the log as This Mac has it (the reader pulls once a pass, at most).
       */
      agentsTrusted: async (id: string, pull: boolean): Promise<{ readonly unread: true } | { readonly unread?: undefined; readonly agents: TrustedAgents | undefined }> => {
        // Before the log is followed at all (a runtime starting), nothing is known yet: not a no (macMail.ts drops a
        // removed Mac's queued mail on a no, A-4).
        if (logLink === undefined) return { unread: true };
        const who = person();
        if (!who) return { agents: undefined };
        if (pull ? !(await readFor(who.userId)) : stale()) return { unread: true };
        if (pull && trustOf(who).agents.get(id) === undefined) await runPromise(pullLog(LOG_PULL_MS));
        return { agents: trustOf(who).agents.get(id) };
      },
      /** For the Mac mail sender (macMail.ts): this runtime's agents key's vouch is in this Mac's log and in Cloud. */
      agentsShared: shared,
      /** `listener` runs each time trust may have changed (a screen's allow or removal, the log's): macMail.ts re-checks queued mail. */
      onTrust: (listener: () => void) => void trustListeners.add(listener),
      handlers,
      list: Effect.sync(view),
      awake,
    };
  });

export type Devices = Effect.Success<typeof makeDevices>;
