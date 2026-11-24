// A Cloud computer's Caveman credits (agent-continuity.md "Caveman · credits or plan"): a Caveman chat on a Cloud computer
// pays from its person's Caveman credits and plan, exactly as on their Mac. Nothing long-lived is on the computer for
// it. Its runtime asks Caveman Cloud (POST /api/v1/code/runtime/credits/key, with its runtime token) for a credits key
// of the person Cloud's records bind the computer to, which Cloud makes short-lived (an hour) and which spends only
// while the runtime is active and still bound to that person. The key lives in this process's memory only: never in
// the secret store, the volume or an engine's environment. It joins the computer's scrubber.
//
// Only a request that sends it asks for one (ProviderHost.credits get: a Caveman turn, a credits web search); a status
// probe or a model list reads whether credits may pay here and what is held (available, peek) and asks nothing. Past
// half its life it is renewed in the background while the request goes on with the key held. Cloud unreachable or
// busy: asked again after 3 s, then twice as long each time up to 5 minutes, or as long as its Retry-After says, the
// key held kept while it runs. Cloud saying this computer is not to spend credits (not a Cloud computer, a service
// account's or another person's work on it, no project, credits off, the runtime revoked) or naming no gateway it may
// use: the key dropped and nothing asked for 15 minutes. An answer that is no key: nothing asked for a minute.
import type { CreditsCredentialSource } from "@caveman-app/engine-core/server/ProviderHost";
import { CREDITS_GATEWAY_OVERRIDE } from "@caveman-app/provider-caveman/server";
import * as Effect from "effect/Effect";

import { CloudValues } from "./computerSecrets.ts";
import { call } from "./computers.ts";
import { HOSTED_CLOUD, serviceOrigin } from "./hosted.ts";
import { CloudError, readIdentity } from "./identity.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";

/** Cloud's answer (Caveman Cloud code.CreditsKey). */
export interface MintedCredits {
  readonly id: string;
  readonly key: string;
  readonly expires_at: string;
  /** Where the key runs, when Cloud names its gateway. */
  readonly gateway_url?: string;
}

/** What the source needs of the computer's link: the route, its Cloud, and the computer's scrubber. */
export interface ComputerCreditsCloud {
  readonly mint: () => Promise<MintedCredits>;
  readonly cloudUrl: () => string | undefined;
  /** Every key handed to this computer joins its scrubber (CloudValues). */
  readonly remember: (key: string) => void;
  /** Why no key is held now (Cloud refused, or could not be reached): the runtime's log, never the key. */
  readonly warn?: (message: string) => void;
  /**
   * The runtime id this computer runs under now. A key spends only while the runtime it was made for is active, and
   * a wake gives the computer a new one: where the VM's memory is kept across a stop the same process resumes holding
   * a key of the runtime it stopped under, which Cloud refuses from then on. Such a key is not handed out again.
   */
  readonly runtime?: () => string | undefined;
}

/** Renewed once this much of its life is gone. */
const RENEW_AT = 0.5;
/** Read as gone this long before it expires: the edge stops a key at the minute it expires, rounded down. */
const EXPIRY_MARGIN_MS = 2 * 60_000;
/** After a failure that may pass (Cloud unreachable or busy, a refusal that may lift): doubling from this, up to the max. */
const BACKOFF_MS = 3_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** After an answer that is no key: never a loop that mints for nothing. */
const MALFORMED_MS = 60_000;
/** After Cloud said this computer is not to spend credits, or named no gateway it may use: set up so until changed. */
const QUIET_MS = 15 * 60_000;
/** Cloud's codes for a computer that is not to spend credits (with any 401, and 404: no credits on computers here). */
const NOT_HERE = new Set([
  "cave_code_credits_computer_only",
  "cave_code_service_account_session",
  "cave_code_computer_shared",
  "cave_forbidden",
  "cave_code_credits_forbidden",
  "cave_code_credits_no_project",
  "cave_code_credits_unavailable",
]);

/** Cloud's answer named no gateway its keys may run on here. */
class NoGateway extends Error {}

interface Held {
  readonly key: string;
  readonly gateway?: string;
  readonly mintedAt: number;
  readonly expiresAt: number;
  /** The runtime id it was made for (ComputerCreditsCloud.runtime), when the computer says. */
  readonly runtime?: string;
}

type Credit = { readonly key: string; readonly gateway?: string };

export class ComputerCredits implements CreditsCredentialSource {
  readonly #now: () => number;
  #cloud: ComputerCreditsCloud | undefined;
  #held: Held | undefined;
  #asking: Promise<void> | undefined;
  /** Nothing is asked before this; credits are not offered before `#offUntil`. */
  #retryAt = 0;
  #offUntil = 0;
  #failures = 0;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** The computer's link joined (computerSecrets.ts layerBroker): from now on a request asks Cloud. */
  connect(cloud: ComputerCreditsCloud) {
    this.#cloud = cloud;
    this.#held = undefined;
    this.#retryAt = this.#offUntil = this.#failures = 0;
  }

  disconnect() {
    this.#cloud = undefined;
    this.#held = undefined;
  }

  readonly available = (): boolean => this.#cloud !== undefined && this.#now() >= this.#offUntil;

  readonly peek = (): Credit | undefined => {
    const held = this.#held;
    if (this.#cloud === undefined || held === undefined || this.#now() >= held.expiresAt - EXPIRY_MARGIN_MS) return undefined;
    // Made for a runtime this computer no longer is (it woke under a new identity): as if none were held.
    if (held.runtime !== undefined && this.#cloud.runtime?.() !== held.runtime) return undefined;
    return held.gateway === undefined ? { key: held.key } : { key: held.key, gateway: held.gateway };
  };

  readonly get = async (): Promise<Credit | undefined> => {
    if (this.#cloud === undefined) return undefined;
    const held = this.peek();
    if (held !== undefined) {
      // Past half its life: renewed in the background, the request goes on with the key held.
      const h = this.#held!;
      if (this.#now() >= h.mintedAt + (h.expiresAt - h.mintedAt) * RENEW_AT) void this.#ask();
      return held;
    }
    await this.#ask();
    return this.peek();
  };

  /** One ask at a time, and none before `#retryAt`. */
  #ask(): Promise<void> {
    if (this.#asking !== undefined) return this.#asking;
    if (this.#now() < this.#retryAt) return Promise.resolve();
    this.#asking = this.#mint().finally(() => (this.#asking = undefined));
    return this.#asking;
  }

  async #mint() {
    const cloud = this.#cloud;
    if (cloud === undefined) return;
    const at = this.#now();
    // Read before the ask: an identity replaced while Cloud answers leaves a key that is asked for again.
    const runtime = cloud.runtime?.();
    try {
      const answer = await cloud.mint();
      const expiresAt = Date.parse(answer.expires_at);
      const cloudUrl = cloud.cloudUrl();
      if (typeof answer.key !== "string" || !answer.key.startsWith("cave_") || !Number.isFinite(expiresAt) || expiresAt <= at || cloudUrl === undefined) {
        throw new MalformedAnswer("Caveman sent no credits key.");
      }
      // The hosted Cloud's keys run on Caveman's own gateway (provider-caveman gatewayOf); any other Cloud's only on the one
      // it names, as This Mac's sign-in keeps it (cloudSignin.ts), unless a dev build points every key at its own.
      const gateway = cloudUrl === HOSTED_CLOUD ? undefined : serviceOrigin(cloudUrl, answer.gateway_url);
      if (cloudUrl !== HOSTED_CLOUD && gateway === undefined && CREDITS_GATEWAY_OVERRIDE === undefined) {
        throw new NoGateway("This Caveman server named no gateway its credits may run on here, so its Caveman chats can't run on them.");
      }
      cloud.remember(answer.key);
      if (this.#cloud !== cloud) return;
      this.#held = { key: answer.key, ...(gateway === undefined ? {} : { gateway }), mintedAt: at, expiresAt, ...(runtime === undefined ? {} : { runtime }) };
      this.#retryAt = this.#offUntil = this.#failures = 0;
    } catch (error) {
      if (this.#cloud !== cloud) return;
      cloud.warn?.(`Caveman credits for this computer's Caveman chats: ${error instanceof Error ? error.message : String(error)}`);
      const now = this.#now();
      const backoff = () => Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** Math.min(this.#failures++, 10));
      if (error instanceof NoGateway || (error instanceof CloudError && (error.status === 401 || error.status === 404 || NOT_HERE.has(error.code ?? "")))) {
        // Not to spend credits here: the key held goes (the broker refuses it too), and nothing is asked for long.
        this.#held = undefined;
        this.#retryAt = this.#offUntil = now + QUIET_MS;
      } else if (error instanceof MalformedAnswer) {
        this.#retryAt = now + Math.max(MALFORMED_MS, backoff());
      } else if (error instanceof CloudError && error.status === 403) {
        // Asleep or idle: it ends the key held (the broker refuses it too); the computer may get its chat any moment.
        this.#held = undefined;
        this.#retryAt = now + backoff();
      } else {
        // Unreachable, busy, or a refusal that passes (a policy on its way): a key that still runs stays.
        this.#retryAt = now + Math.max(backoff(), error instanceof CloudError ? (error.retryAfterMs ?? 0) : 0);
      }
    }
  }
}

/** Cloud's answer was no key. */
class MalformedAnswer extends Error {}

const byLink = new Map<string, ComputerCredits>();

/**
 * A runtime's memory ends with its process, and the key it held with it: a computer that wakes is a new process. A
 * test that stops a computer's runtime and starts another in the one test process says so here.
 */
export const forgetComputerCredits = (linkDir: string) => void byLink.delete(linkDir);

/**
 * A Cloud computer's runtime's credits source (ProviderHostLive): Cloud's credits route through the computer's link
 * (its runtime token), and every key it hands over joins the computer's scrubber (CloudValues). Undefined off a Cloud
 * computer: This Mac's credits key is the person's own, kept with their sign-in.
 */
export const computerCreditsSource = Effect.gen(function* () {
  const computer = yield* CloudComputer;
  if (computer === undefined) return undefined;
  // One per computer however many ProviderHosts the runtime builds: two would each renew, and Cloud keeps only a
  // runtime's two newest keys, so one's renewals would end the key the other holds.
  const known = byLink.get(computer.linkDir);
  if (known !== undefined) return known;
  const link = yield* CloudLinkState;
  const values = yield* CloudValues;
  const credits = new ComputerCredits();
  byLink.set(computer.linkDir, credits);
  credits.connect({
    mint: () => {
      const id = readIdentity(computer.linkDir);
      return id === undefined ? Promise.reject(new Error("This computer has no Cloud identity yet")) : call<MintedCredits>(id, link, "POST", "credits/key", {});
    },
    cloudUrl: () => readIdentity(computer.linkDir)?.cloudUrl,
    runtime: () => readIdentity(computer.linkDir)?.runtimeId,
    warn: (message) => void Effect.runFork(Effect.logWarning(message)),
    remember: (key) => {
      const entry = `caveman:credits\0CAVEMAN_CREDITS_KEY\0${key}`;
      if (values.seen.has(entry)) return;
      values.seen.set(entry, key);
      values.version++;
    },
  });
  return credits;
});
