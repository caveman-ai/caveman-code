// A live Cloud link: mints runtime tokens and refreshes them before they
// expire, heartbeats with whether the runtime is busy, and keeps one relay
// connection up (reconnecting with backoff). Plain timers and promises, so the
// clock, fetch and the relay URL can be driven by tests. A process that did not
// run for a while (restored from a memory snapshot, stopped, its host asleep)
// recovers within a second of running again: see thawed.
import { PROTOCOL_REVISION } from "@caveman-app/session-protocol";

import { RUNTIME_CAPABILITIES, RUNTIME_VERSION } from "../runtimeVersion.ts";
import type { HeartbeatRepo } from "./heartbeatRepos.ts";
import { CloudError, cloudFailure, signAssertion, type Identity } from "./identity.ts";
import { readLifecycle, type Lifecycle } from "./lifecycle.ts";
import { dialRelay, type OpenInfo, type RelayConnection, type RelayStream, type StreamSink } from "./relay.ts";

export interface Token {
  readonly value: string;
  /** Cloud's expires_at, on Cloud's clock. */
  readonly expiresAt: number;
  /** The assertion's issued_at, on Cloud's clock (seconds). */
  readonly issuedAt: number;
}

export type LinkStatus = "connecting" | "connected" | "unauthorized" | "replaced" | "stopped";

export interface LinkOptions {
  readonly identity: Identity;
  /** A client attached through the relay; the sink receives its messages. */
  readonly onStream: (stream: RelayStream, info: OpenInfo) => StreamSink;
  /**
   * The computer is in use (the heartbeat's `active`), as index.ts's `inUse` decides: a turn runs or waits, a hosted
   * run works, a person holds the desktop, or a client changed something in the last 45 s. A client that is only
   * attached, watching, does not count.
   */
  readonly active: () => boolean;
  /** The Mac is going to sleep (the heartbeat's `suspending`): Cloud may move its chats once it has gone quiet (moves). */
  readonly suspending?: () => boolean;
  /**
   * While it goes to sleep: the working chats the lid kept on this Mac (the heartbeat's `kept`, beside `suspending`),
   * which Cloud's fallback never moves while it sleeps (AUDIT-W4-EARLY A-6).
   */
  readonly kept?: () => ReadonlyArray<string>;
  /** Engines this runtime runs on its person's own login (the heartbeat's `engines_signed_in`); undefined: not known yet. */
  readonly enginesSignedIn?: () => ReadonlyArray<string> | undefined;
  /** The repositories this Mac has checked out, by hash (the heartbeat's `repos`, heartbeatRepos.ts); undefined: not known yet. */
  readonly repos?: () => ReadonlyArray<HeartbeatRepo> | undefined;
  /** The stop this runtime parked for (the heartbeat's `parked`, CONTRACT §5.1): named in every heartbeat until the stop is gone. */
  readonly parked?: () => string | undefined;
  /** What a heartbeat's reply says of this computer's life (lifecycle.ts): told after every heartbeat Cloud took. */
  readonly onLifecycle?: (lifecycle: Lifecycle) => void;
  /**
   * The chats this computer holds at once and how many it has now (the heartbeat's `capacity`, session-protocol/capacity.ts):
   * what Cloud's scheduler places by; undefined: not measured yet.
   */
  readonly capacity?: () => { readonly chats: number; readonly used: number } | undefined;
  /**
   * This runtime's own version (the heartbeat's `version`, CONTRACT §5.4), which Cloud holds against its minimum for a
   * Cloud computer: one below it reads "This computer updates when it next wakes." Left out when empty or past the 64
   * characters Cloud takes.
   */
  readonly version?: string;
  /** After a Cloud from before `repos` refused them, how long heartbeats go without them before trying again (REPOS_RETRY_MS). */
  readonly reposRetryMs?: number;
  readonly log: (message: string) => void;
  readonly onToken?: (token: Token) => void;
  readonly fetch?: typeof fetch;
  /** The wall clock (default Date.now). */
  readonly now?: () => number;
  /** The monotonic clock timers run on (default performance.now). */
  readonly monotonic?: () => number;
  readonly heartbeatMs?: number;
  /** Relay WebSocket URL; default wss://<cloud host>/relay/v1/runtime. */
  readonly relayUrl?: string;
  /** false: tokens and heartbeats only, no relay (moves on This Mac with Remote control off). Default true. */
  readonly relay?: boolean;
  /** The relay connection is ended after this long without a ping (default 60 s). */
  readonly relaySilenceMs?: number;
  /** A mint or heartbeat Cloud has not answered after this long is abandoned (default 10 s). */
  readonly cloudTimeoutMs?: number;
  /**
   * After another instance of this runtime took the relay (4409): try again
   * after this long, doubling up to an hour. Unset: stay off until stopped
   * (This Mac, where the person turns the link off and on).
   */
  readonly replacedRetryMs?: number;
}

/** Cloud refuses an issued_at more than 60 s off its clock; only skew past Date's 1 s resolution is corrected. */
const SKEW_TOLERANCE_MS = 5_000;
/** An issued_at this close to Cloud's clock (its 60 s window, less Date's 1 s resolution and transit) was not refused for skew. */
const ON_CLOUD_CLOCK_MS = 58_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** A relay connection that stayed up this long resets the backoff. */
const STABLE_MS = 30_000;
/** Longest a replaced link waits before trying the relay again. */
const REPLACED_MAX_MS = 60 * 60_000;
/** After a Cloud refused repos in the heartbeat, how long heartbeats go without them before they are tried again. */
export const REPOS_RETRY_MS = 60 * 60_000;
/** How often the same repos list goes to Cloud again, though it keeps the last one (a heartbeat between names none). */
export const REPOS_RESEND_MS = 30 * 60_000;
/**
 * A 400 that is about the heartbeat's repos: an older Cloud's strict decode of a field it does not know ("Invalid
 * JSON."), or one naming repos. Any other (another field refused) leaves them in.
 */
const reposRefusal = (body: unknown) => {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message !== "string" || message === "Invalid JSON." || /\brepos\b/.test(message);
};
/** A 400 that is about the heartbeat's `parks` or `parked`: a Cloud from before the stop handshake ("Invalid JSON."), or one naming them. */
const parksRefusal = (body: unknown) => {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message !== "string" || message === "Invalid JSON." || /\bpark(s|ed)\b/.test(message);
};
/** A 400 that is about the heartbeat's kept chats: a Cloud from before them ("Invalid JSON."), or one naming them. */
const keptRefusal = (body: unknown) => {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message !== "string" || message === "Invalid JSON." || /\bkept\b/.test(message);
};
/** A 400 that is about the heartbeat's capacity: a Cloud from before it ("Invalid JSON."), or one naming it. */
const capacityRefusal = (body: unknown) => {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message !== "string" || message === "Invalid JSON." || /\bcapacity\b/.test(message);
};
/** A 400 that is about the heartbeat's version: a Cloud from before it ("Invalid JSON."), or one naming it. */
const versionRefusal = (body: unknown) => {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message !== "string" || message === "Invalid JSON." || /\bversion\b/.test(message);
};
/** The longest version Cloud's heartbeat takes. */
const VERSION_MAX_CHARS = 64;
/** A loop with nothing to do sleeps until woken (setTimeout's longest delay). */
const PARKED_MS = 2 ** 31 - 1;
/** How often the link checks that its process ran. */
const TICK_MS = 1_000;
/**
 * A tick this much late, the process did not run: its wall clock moved on that much further than its timers (restored
 * from a memory snapshot, the guest agent stepping the clock on; or the host asleep, where the monotonic clock stops
 * too), or its timers ran that late (SIGSTOP, an event loop stalled).
 */
const FROZEN_MS = 5_000;
/**
 * The core's relay pings every 25 s and closes a connection whose pong is that late: a process whose timers stopped
 * longer may have lost its relay connection with no close it can see. Shorter, the relay connection is kept (the
 * silence watchdog still drops one that stopped answering).
 */
const RELAY_PING_MS = 25_000;
/** A pooled connection to Cloud may be dead though open after a restore: a call is abandoned after this long. */
const CLOUD_TIMEOUT_MS = 10_000;
/** A token this close to its expiry on Cloud's clock (or a sixth of its life, if that is shorter) is never dialed with. */
const EXPIRY_MARGIN_MS = 30_000;

/** Resolves after `ms`, or earlier on wake(). */
class Sleeper {
  private wakers = new Set<() => void>();
  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }
  wake() {
    for (const waker of [...this.wakers]) waker();
  }
}

export class CloudLink {
  status: LinkStatus = "connecting";
  token: Token | undefined;
  private stopped = false;
  private skewMs = 0;
  private lastIssued = 0;
  private wasActive = false;
  /**
   * The heartbeat fields past its first ones that Cloud's last answer said it reads (`accepts`): its decoder refuses a
   * field it does not know with a 400, so each goes out only once Cloud lists it (docs/).
   */
  private accepts: ReadonlySet<string> = new Set();
  private relay: RelayConnection | undefined;
  /** The relay connection was dropped as dead (thawed): dial again at once. */
  private redial = false;
  /** A call needs a token newer than the link's (freshToken): mint now, whatever its refresh point. */
  private mintNow = false;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly tokenTimer = new Sleeper();
  private readonly heartbeatTimer = new Sleeper();
  /** A heartbeat asked for (beat, poke) while one was on its way: it goes as soon as that one is back. */
  private heartbeatOwed = false;
  /** Heartbeats begun so far, and who waits for one begun after they asked to have ended (beatHeard). */
  private beats = 0;
  private readonly beatWaiters = new Set<{ readonly after: number; readonly done: () => void }>();
  private readonly relayTimer = new Sleeper();
  private readonly tokenWaiters = new Set<() => void>();
  /** Calls in tokenFor waiting on a mint: told when it fails. */
  private readonly mintFailed = new Set<(error: CloudError) => void>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  readonly done: Promise<unknown>;

  private readonly options: LinkOptions;

  constructor(options: LinkOptions) {
    this.options = options;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    let wall = this.now();
    let mono = this.monotonic();
    this.ticker = setInterval(() => {
      const [w, m] = [this.now(), this.monotonic()];
      const [wallMs, monoMs] = [w - wall, m - mono];
      [wall, mono] = [w, m];
      if (wallMs - monoMs > FROZEN_MS) this.thawed(wallMs, monoMs, true);
      else if (monoMs - TICK_MS > FROZEN_MS) this.thawed(wallMs, monoMs, monoMs - TICK_MS > RELAY_PING_MS);
    }, TICK_MS);
    this.ticker.unref();
    this.done = Promise.all([this.tokenLoop(), this.heartbeatLoop(), options.relay === false ? Promise.resolve() : this.relayLoop()]);
  }

  get identity() {
    return this.options.identity;
  }

  get relayed() {
    return this.options.relay !== false;
  }

  /** Called whenever activity may have changed: a turn starting or a client attaching heartbeats at once. */
  poke() {
    const active = this.options.active();
    if (active && !this.wasActive) this.beat();
    this.wasActive = active;
  }

  /**
   * Heartbeats now, whatever the timer says (the suspending mark goes out at once, and so does its clearing). Asked
   * while a heartbeat is on its way, the next goes right after it: that one may say what is no longer so (woken, the
   * Mac's timer-due heartbeat leaves before its pass sees the wake, H1).
   */
  beat() {
    this.heartbeatOwed = true;
    this.heartbeatTimer.wake();
  }

  /**
   * beat(), answered once a heartbeat that left after this was asked is back, heard or not: what says something Cloud
   * must hear before the next step (the lid: this Mac is going to sleep) waits on it, and never on a heartbeat of its own.
   */
  beatHeard(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      this.beatWaiters.add({ after: this.beats, done: resolve });
      this.beat();
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ticker);
    this.status = "stopped";
    this.relay?.close();
    for (const timer of [this.tokenTimer, this.heartbeatTimer, this.relayTimer]) timer.wake();
    for (const waiter of this.tokenWaiters) waiter();
    for (const waiter of this.beatWaiters) waiter.done();
    this.beatWaiters.clear();
  }

  /** Cloud's clock from a response's Date header: its time then, if it said. */
  private observe(response: Response) {
    const date = Date.parse(response.headers.get("date") ?? "");
    if (Number.isNaN(date)) return undefined;
    const skew = date - this.now();
    this.skewMs = Math.abs(skew) > SKEW_TOLERANCE_MS ? skew : 0;
    return date;
  }

  /**
   * Trades a signed assertion for a token. issued_at is Cloud's clock (local
   * clock plus any skew its Date header showed) and always later than the
   * last one Cloud took, so its replay fence never sees a repeat. A refusal
   * on Cloud's clock is that fence (another mint for this runtime, such as
   * computers.ts while the link is down, took the second), so the next goes
   * past it; one off Cloud's clock moved no fence and must not hold the next back.
   * A refusal is retried: once the Date header corrected the clock, then a
   * second later (two mints in one second, e.g. right after a restart).
   */
  async mint(): Promise<Token> {
    const { identity } = this.options;
    let refusal: CloudError | undefined;
    for (let attempt = 0; attempt < 3 && !this.stopped; attempt++) {
      if (attempt === 2) await new Promise((r) => setTimeout(r, 1_000));
      const issuedAt = Math.max(Math.floor((this.now() + this.skewMs) / 1000), this.lastIssued + 1);
      const response = await this.fetch(`${identity.cloudUrl}/api/v1/code/runtimes/${identity.runtimeId}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: identity.organizationId, issued_at: issuedAt, signature: signAssertion(identity, issuedAt) }),
        signal: AbortSignal.timeout(this.options.cloudTimeoutMs ?? CLOUD_TIMEOUT_MS),
      });
      const cloudAt = this.observe(response);
      if (response.ok || (cloudAt !== undefined && Math.abs(issuedAt * 1000 - cloudAt) <= ON_CLOUD_CLOCK_MS)) {
        this.lastIssued = Math.max(this.lastIssued, issuedAt);
      }
      if (response.ok) {
        const body = (await response.json()) as { token: string; expires_at: string };
        return { value: body.token, expiresAt: Date.parse(body.expires_at), issuedAt };
      }
      refusal = await cloudFailure(response);
      if (response.status !== 401) throw refusal;
    }
    throw refusal ?? new CloudError(0, "the Cloud link stopped");
  }

  /** Refresh at two thirds of the token's life, measured on Cloud's clock (expires_at - issued_at). */
  private refreshDelay(token: Token) {
    return Math.max(5_000, ((token.expiresAt - token.issuedAt * 1000) * 2) / 3);
  }

  /** Expired, or about to, on Cloud's clock: never dialed or sent with. */
  private expiring(token: Token) {
    const life = token.expiresAt - token.issuedAt * 1000;
    return token.expiresAt - (this.now() + this.skewMs) < Math.min(EXPIRY_MARGIN_MS, life / 6);
  }

  /**
   * Sleeps until the token's refresh point by whichever clock reaches it first: Cloud's (the wall clock plus skew),
   * which a restore steps on while timers stand still, or the monotonic one since the mint, which a wall clock stepped
   * back would hide. Woken, it looks again (thawed), or returns: a call wants a newer token (freshToken), or the token
   * is no longer the link's.
   */
  private async untilRefresh(token: Token, mintedAt: number) {
    this.mintNow = false;
    while (!this.stopped && !this.mintNow && this.token === token) {
      const due = this.refreshDelay(token);
      const left = Math.min(token.issuedAt * 1000 + due - (this.now() + this.skewMs), mintedAt + due - this.monotonic());
      if (left <= 0) return;
      await this.tokenTimer.sleep(left);
    }
  }

  /**
   * The process did not run for a while (FROZEN_MS) and runs again, with no timer having said so. The token refresh
   * looks at Cloud's clock again, and a token that expired meanwhile is dropped so nothing uses it, a fresh one minted
   * first; a heartbeat goes out at once. With `dropRelay` (a restore, the host asleep, or timers stopped past the
   * relay's ping window) the relay connection may be dead however open it looks (the peer forgot it, or a restored
   * guest's network is new): it is dropped without a close handshake and dialed again at once.
   */
  private thawed(wallMs: number, monoMs: number, dropRelay: boolean) {
    if (this.stopped || this.status === "replaced") return;
    this.options.log(
      `Cloud link: this process did not run for a while (wall clock +${Math.round(wallMs / 1000)} s, timers +${Math.round(monoMs / 1000)} s); ${dropRelay ? "reconnecting" : "heartbeating"}`,
    );
    if (this.token !== undefined && this.expiring(this.token)) this.token = undefined;
    this.tokenTimer.wake();
    if (dropRelay) {
      this.redial = true;
      this.relay?.drop();
      this.relayTimer.wake();
    }
    // Owed, not only woken: a heartbeat on its way across the freeze has no sleeper to wake, and the next goes right after it.
    this.beat();
  }

  private async tokenLoop() {
    let failures = 0;
    while (!this.stopped) {
      // Another instance holds the relay: this one neither mints nor heartbeats until the relay loop retries.
      if (this.status === "replaced") {
        await this.tokenTimer.sleep(PARKED_MS);
        continue;
      }
      try {
        const token = await this.mint();
        const mintedAt = this.monotonic();
        if (this.stopped) return;
        this.token = token;
        failures = 0;
        // A refusal that has passed (the relay may have stayed up on the older token).
        if (this.status === "unauthorized") this.status = this.relay?.isOpen() ? "connected" : "connecting";
        this.relay?.sendToken(token.value);
        this.options.onToken?.(token);
        for (const waiter of this.tokenWaiters) waiter();
        this.tokenWaiters.clear();
        await this.untilRefresh(token, mintedAt);
      } catch (error) {
        failures++;
        const refused = error instanceof CloudError && error.status === 401;
        if (refused) this.status = "unauthorized";
        this.options.log(`Cloud link: minting a runtime token failed (${(error as Error).message})`);
        // A call waiting on this mint (tokenFor) fails with it now: a revoked runtime hears so, not a timeout.
        for (const failed of this.mintFailed) failed(error instanceof CloudError ? error : new CloudError(503, `Could not reach Caveman: ${(error as Error).message}`));
        this.mintFailed.clear();
        // ponytail: a revoked runtime keeps retrying every 5 min; the supervisor stops it when the setting goes off.
        await this.tokenTimer.sleep(Math.min(5 * 60_000, BACKOFF_MIN_MS * 2 ** Math.min(failures, 10)));
      }
    }
  }

  /**
   * The runtime's token for any call: the link's own, or, when Cloud refused `stale` (the link's), one it mints at once.
   * Every part of the runtime takes its token here while the link runs: a mint of their own would cut the link's to
   * Cloud's last minute of grace (kind review K14). Fails after `waitMs` without one (Cloud not reached, the link off).
   */
  async tokenFor(stale: string | undefined, waitMs: number): Promise<string> {
    const current = this.token;
    if (current !== undefined && current.value !== stale) return current.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed: ((error: CloudError) => void) | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CloudError(503, "Caveman gave this runtime no token in time.")), waitMs);
      failed = reject;
      this.mintFailed.add(reject);
    });
    try {
      await Promise.race([this.freshToken(current), late]);
    } finally {
      clearTimeout(timer);
      this.mintFailed.delete(failed!);
    }
    const token = this.token;
    if (this.stopped || token === undefined || token.value === stale) throw new CloudError(503, "The Cloud link stopped before it had a token.");
    return token.value;
  }

  /** Mints now and waits for a token newer than `stale`. */
  private freshToken(stale: Token | undefined) {
    if (this.token !== undefined && this.token !== stale) return Promise.resolve();
    const fresh = new Promise<void>((resolve) => this.tokenWaiters.add(resolve));
    if (stale !== undefined) {
      this.mintNow = true;
      this.tokenTimer.wake();
    }
    return fresh;
  }

  /** Until when heartbeats go without repos: a Cloud from before them refused them (tried again after REPOS_RETRY_MS). */
  private reposRefusedUntil = 0;
  /** Until when heartbeats go without `parks` and `parked`: a Cloud from before the stop handshake refused them (tried again after REPOS_RETRY_MS). */
  private parksRefusedUntil = 0;
  /** Until when suspending heartbeats go without `kept`: a Cloud from before it refused it (tried again after REPOS_RETRY_MS). */
  private keptRefusedUntil = 0;
  /** A Cloud from before `capacity` refused it: heartbeats go without it until then. */
  private capacityRefusedUntil = 0;
  /** A Cloud from before `version` refused it: heartbeats go without it until then. */
  private versionRefusedUntil = 0;
  /**
   * The repos list Cloud last took, and when: Cloud keeps it while a heartbeat names none, so it goes again only when it
   * changed, or after REPOS_RESEND_MS.
   */
  private reposSent: { readonly key: string; readonly at: number } | undefined;

  private async heartbeatLoop() {
    const every = this.options.heartbeatMs ?? 30_000;
    while (!this.stopped) {
      if (this.status === "replaced") {
        await this.heartbeatTimer.sleep(PARKED_MS);
        continue;
      }
      const token = this.token;
      if (token === undefined) {
        await this.freshToken(undefined);
        continue;
      }
      const active = this.options.active();
      this.wasActive = active;
      this.heartbeatOwed = false;
      const beat = ++this.beats;
      // A runtime that parks when told to says so in every heartbeat (CONTRACT §5.1): Cloud waits for `parked` only from one that does.
      const parks = this.options.parked !== undefined && Date.now() >= this.parksRefusedUntil;
      const parked = parks ? this.options.parked?.() : undefined;
      const engines = this.options.enginesSignedIn?.();
      const listed = Date.now() < this.reposRefusedUntil ? undefined : this.options.repos?.();
      const reposKey = listed === undefined ? undefined : JSON.stringify(listed);
      const sent = this.reposSent;
      const repos = listed !== undefined && (sent === undefined || sent.key !== reposKey || Date.now() - sent.at > REPOS_RESEND_MS) ? listed : undefined;
      const suspending = this.options.suspending?.() === true;
      // Every suspending heartbeat names the chats the lid kept here (none too): Cloud keeps the list until one says awake.
      const kept = suspending && Date.now() >= this.keptRefusedUntil ? this.options.kept?.() : undefined;
      const capacity = Date.now() >= this.capacityRefusedUntil ? this.options.capacity?.() : undefined;
      const said = this.options.version?.trim() ?? "";
      const version = said !== "" && said.length <= VERSION_MAX_CHARS && Date.now() >= this.versionRefusedUntil ? said : undefined;
      try {
        const response = await this.fetch(`${this.options.identity.cloudUrl}/api/v1/code/runtime/heartbeat`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.value}`, "content-type": "application/json" },
          body: JSON.stringify({
            active,
            ...(suspending ? { suspending: true } : {}),
            ...(kept === undefined ? {} : { kept }),
            ...(parks ? { parks: true } : {}),
            ...(parked === undefined ? {} : { parked }),
            ...(engines === undefined ? {} : { engines_signed_in: engines }),
            ...(repos === undefined ? {} : { repos }),
            ...this.whatThisIs(),
            ...(capacity === undefined ? {} : { capacity }),
            ...(version === undefined ? {} : { version }),
          }),
          signal: AbortSignal.timeout(this.options.cloudTimeoutMs ?? CLOUD_TIMEOUT_MS),
        });
        this.observe(response);
        // An accepted reply is read once: the fields Cloud takes (whatThisIs) and the computer's lifecycle (below).
        const answer: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
        this.accepts = acceptedFields(answer);
        if (response.status === 401) {
          await this.freshToken(token);
          continue;
        }
        const refusal =
          response.status === 400 && (repos !== undefined || kept !== undefined || parks || capacity !== undefined || version !== undefined) ? await response.json().catch(() => undefined) : undefined;
        if (refusal !== undefined && capacity !== undefined && capacityRefusal(refusal)) {
          // The newest field first: a Cloud from before capacity refuses it, and the same heartbeat goes again at once
          // without it (liveness never waits on it), and it again in an hour. It goes before version and parks: a Cloud
          // that knows them and not capacity answers the same "Invalid JSON.", and must not lose either for it.
          this.capacityRefusedUntil = Date.now() + (this.options.reposRetryMs ?? REPOS_RETRY_MS);
          this.options.log("Cloud link: Cloud does not take capacity in the heartbeat; heartbeats go without it for now");
          continue;
        }
        if (refusal !== undefined && version !== undefined && versionRefusal(refusal)) {
          // Next the version, which Cloud learned after the stop handshake and before capacity: a Cloud from before it
          // refuses it, the same heartbeat goes again at once without it, and it again in an hour. Such a Cloud marks no
          // computer outdated, so nothing is lost; one that knows it and is refused another field keeps it.
          this.versionRefusedUntil = Date.now() + (this.options.reposRetryMs ?? REPOS_RETRY_MS);
          this.options.log("Cloud link: Cloud does not take version in the heartbeat; heartbeats go without it for now");
          continue;
        }
        if (refusal !== undefined && parks && parksRefusal(refusal)) {
          // A Cloud from before the stop handshake refuses it, never names a stop, and stops the computer without a word
          // as before. The same heartbeat goes again at once without it, and it again in an hour.
          this.parksRefusedUntil = Date.now() + (this.options.reposRetryMs ?? REPOS_RETRY_MS);
          this.options.log("Cloud link: Cloud does not take parks in the heartbeat; heartbeats go without it for now");
          continue;
        }
        if (refusal !== undefined && kept !== undefined && keptRefusal(refusal)) {
          // The newer field first: a Cloud from before kept chats refuses it, and the same heartbeat goes again at once
          // without it (its suspending mark still lands), and it again in an hour.
          this.keptRefusedUntil = Date.now() + (this.options.reposRetryMs ?? REPOS_RETRY_MS);
          this.options.log("Cloud link: Cloud does not take kept chats in the heartbeat; heartbeats go without them for now");
          continue;
        }
        if (refusal !== undefined && repos !== undefined && reposRefusal(refusal)) {
          // A Cloud from before repos in the heartbeat (its strict decode refuses the field), or one refusing these: the
          // same heartbeat again at once without them, so liveness never waits on them, and them again in an hour.
          this.reposRefusedUntil = Date.now() + (this.options.reposRetryMs ?? REPOS_RETRY_MS);
          this.reposSent = undefined;
          this.options.log("Cloud link: Cloud does not take repos in the heartbeat; heartbeats go without them for now");
          continue;
        }
        if (response.ok && repos !== undefined) this.reposSent = { key: reposKey!, at: Date.now() };
        // The one place a heartbeat's reply is read (CONTRACT §5.1): when Cloud will ask for a stop, and the stop it wants now.
        if (response.ok) this.options.onLifecycle?.(readLifecycle(answer));
        if (!response.ok) {
          // Not known to have landed: the next heartbeat names them again.
          this.reposSent = undefined;
          this.options.log(`Cloud link: heartbeat answered ${response.status}`);
        }
      } catch (error) {
        this.reposSent = undefined;
        this.options.log(`Cloud link: heartbeat failed (${(error as Error).message})`);
      }
      for (const waiter of [...this.beatWaiters]) {
        if (waiter.after >= beat) continue;
        this.beatWaiters.delete(waiter);
        waiter.done();
      }
      if (!this.heartbeatOwed) await this.heartbeatTimer.sleep(every);
    }
  }

  /** Which build this runtime is, as far as Cloud reads it: its version, the protocol revision it speaks, its features. */
  private whatThisIs() {
    const fields = { runtime_version: RUNTIME_VERSION, protocol_revision: PROTOCOL_REVISION, capabilities: RUNTIME_CAPABILITIES };
    return Object.fromEntries(Object.entries(fields).filter(([name]) => this.accepts.has(name)));
  }

  private relayUrl() {
    if (this.options.relayUrl) return this.options.relayUrl;
    const url = new URL("/relay/v1/runtime", this.options.identity.cloudUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    return url.toString();
  }

  private async relayLoop() {
    let backoff = BACKOFF_MIN_MS;
    let replacedWait = this.options.replacedRetryMs;
    while (!this.stopped) {
      // Never a dial on a token past its time: Cloud refuses it, and the relay would read the runtime as revoked. One past
      // its refresh point but not its expiry still dials: a mint that fails (Cloud deploying) does not take the relay too.
      if (this.token !== undefined && this.expiring(this.token)) {
        this.token = undefined;
        this.tokenTimer.wake();
      }
      if (this.token === undefined) await this.freshToken(undefined);
      if (this.stopped) return;
      const token = this.token!;
      const started = this.monotonic();
      this.redial = false;
      const connection = dialRelay({
        url: this.relayUrl(),
        token: token.value,
        onOpen: this.options.onStream,
        log: this.options.log,
        ...(this.options.relaySilenceMs ? { silenceMs: this.options.relaySilenceMs } : {}),
      });
      this.relay = connection;
      void connection.opened.then(
        () => {
          if (!this.stopped) this.status = "connected";
          // A token minted while the dial was in flight.
          if (this.token !== token && this.token) connection.sendToken(this.token.value);
        },
        () => {},
      );
      const end = await connection.ended;
      this.relay = undefined;
      if (this.stopped) return;
      this.status = end.kind === "replaced" ? "replaced" : end.kind === "unauthorized" ? "unauthorized" : "connecting";
      if (end.kind === "replaced") {
        // Another process holding this runtime's key took the relay; two would take turns forever.
        if (replacedWait === undefined) {
          this.options.log("Cloud link: another instance of this runtime connected to the relay; this one stays off it");
          return;
        }
        this.options.log(`Cloud link: another instance of this runtime connected to the relay; trying again in ${Math.round(replacedWait / 1000)} s`);
        await this.relayTimer.sleep(replacedWait);
        replacedWait = Math.min(REPLACED_MAX_MS, replacedWait * 2);
        if (this.stopped) return;
        this.status = "connecting";
        this.token = undefined;
        this.tokenTimer.wake();
        this.heartbeatTimer.wake();
        continue;
      }
      if (end.kind === "unauthorized") await this.freshToken(token);
      else this.options.log(`Cloud link: relay connection closed (${end.code}${end.reason ? ` ${end.reason}` : ""})`);
      if (this.monotonic() - started >= STABLE_MS || this.redial) backoff = BACKOFF_MIN_MS;
      if (this.redial) continue;
      // 1012: the relay restarts or lost its routing; reconnect soon, jittered so replicas' runtimes spread out.
      await this.relayTimer.sleep(backoff * (0.5 + Math.random() / 2));
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    }
  }
}

/** The fields a heartbeat answer says Cloud reads (`accepts`); none from a Cloud from before it, or a refusal. */
function acceptedFields(reply: unknown): ReadonlySet<string> {
  const answer = reply as { accepts?: unknown } | undefined;
  return new Set(Array.isArray(answer?.accepts) ? answer.accepts.filter((field): field is string => typeof field === "string") : []);
}
