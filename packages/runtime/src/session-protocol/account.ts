// Settings -> Account and Plan on the Session Protocol (account.get, account.checkout,
// account.credits, account.billing, account.auto_topup, account.auto_topup_card, account.gifts,
// account.gift_send): the person's Caveman account through the sign-in
// cloud.signin keeps sealed in the runtime's secret store (cloudLink/account.ts).
// Only this runtime's owner may call them, as with secrets.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { accountAutoTopup, accountAutoTopupCard, accountBilling, accountCheckout, accountGifts, accountGiftSend, accountSummary, ACCOUNT_SECRET, decodeSession, mintCreditsKey, revokeCreditsKey, SignedOut, type AccountSession, type AccountStore } from "../cloudLink/account.ts";
import { creditsGatewayFor, HOSTED_CLOUD } from "../cloudLink/hosted.ts";
import { CloudError, pinAllows } from "../cloudLink/identity.ts";
import { CloudComputer } from "../cloudLink/index.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { type Handler, ProtocolError } from "./handlers.ts";

type AccountMethod = "account.get" | "account.checkout" | "account.credits" | "account.billing" | "account.auto_topup" | "account.auto_topup_card" | "account.gifts" | "account.gift_send";

/** The Caveman engine's credits key slot (engineAccounts). */
export interface CreditsSlot {
  /** `gateway`: where the key runs, for a key a Cloud other than Caveman's hosted one minted (provider-caveman gatewayOf). */
  readonly set: (key: string | null, gateway?: string) => Effect.Effect<unknown, ProtocolError>;
  readonly has: Effect.Effect<boolean>;
}

/**
 * Where ProjectSecrets keeps the sign-in: a key no repository has (keyOf
 * yields host/owner/name or local:<path>), so no engine is ever handed it. It
 * is sealed under the OS keychain's key like a repository secret, and the
 * tokens join the scrub of every transcript, terminal and model request.
 * PUBLIC_ names are not secrets and are never scrubbed.
 */
export const ACCOUNT_SECRETS = "caveman:account";
const FIELDS = {
  cloud_url: "PUBLIC_CAVEMAN_CLOUD_URL",
  access_token: "CAVEMAN_CLOUD_ACCESS_TOKEN",
  refresh_token: "CAVEMAN_CLOUD_REFRESH_TOKEN",
  credits_key_id: "PUBLIC_CAVEMAN_CREDITS_KEY_ID",
  routing_key: "CAVEMAN_ROUTING_KEY",
  routing_expires_at: "PUBLIC_CAVEMAN_ROUTING_EXPIRES_AT",
  gateway_url: "PUBLIC_CAVEMAN_GATEWAY_URL",
} as const satisfies Record<keyof AccountSession, string>;

/** The kept sign-in (memory where the runtime runs no secret store, as in some tests). A sign-in kept unsealed by an earlier build is sealed on first read. */
export const makeAccountStore = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(ProjectSecrets);
  // Pinned to a Cloud (CAVEMAN_CLOUD_URL): a sign-in kept for another reads as none, and is never sent anything.
  const allowed = (session: AccountSession | undefined) => (session && pinAllows(session.cloud_url) ? session : undefined);
  // A Cloud computer keeps no Caveman sign-in: its person signs in on their Mac, and its credits key is the one Cloud
  // mints its runtime (computerCredits.ts). Its secret store is Cloud's, per repository, which holds no account: a read
  // there was a refused round trip on every model call. In memory, as where the runtime runs no secret store.
  if (Option.isNone(found) || (yield* CloudComputer) !== undefined) {
    let kept: AccountSession | undefined;
    return { load: async () => allowed(kept), save: async (session) => void (kept = session) } satisfies AccountStore;
  }
  const secrets = found.value;
  const plain = yield* Effect.serviceOption(ServerSecretStore);
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const write = (session: AccountSession | undefined) =>
    Effect.gen(function* () {
      const entries = Object.entries(FIELDS).flatMap(([field, name]) => {
        const value = session?.[field as keyof AccountSession];
        return value ? [{ name, value: Redacted.make(value) }] : [];
      });
      if (entries.length > 0) yield* secrets.set(ACCOUNT_SECRETS, entries);
      for (const name of Object.values(FIELDS)) if (!entries.some((e) => e.name === name)) yield* secrets.remove(ACCOUNT_SECRETS, name);
    });
  const read = secrets.resolve(ACCOUNT_SECRETS).pipe(
    Effect.map((entries) => {
      const value = (name: string) => entries.find((e) => e.name === name)?.value;
      const cloud_url = value(FIELDS.cloud_url);
      const access_token = value(FIELDS.access_token);
      if (!cloud_url || !access_token) return undefined;
      const refresh_token = value(FIELDS.refresh_token);
      const credits_key_id = value(FIELDS.credits_key_id);
      const routing_key = value(FIELDS.routing_key);
      const routing_expires_at = value(FIELDS.routing_expires_at);
      const gateway_url = value(FIELDS.gateway_url);
      return {
        cloud_url,
        access_token,
        ...(refresh_token ? { refresh_token } : {}),
        ...(credits_key_id ? { credits_key_id } : {}),
        ...(routing_key ? { routing_key } : {}),
        ...(routing_expires_at ? { routing_expires_at } : {}),
        ...(gateway_url ? { gateway_url } : {}),
      } satisfies AccountSession;
    }),
  );
  // ponytail: a locked keychain reads as signed out; say "unlock" in the UI if that confuses.
  const legacy = Option.isNone(plain)
    ? Effect.succeed(undefined)
    : plain.value.get(ACCOUNT_SECRET).pipe(
        Effect.flatMap((bytes) => {
          const session = Option.isSome(bytes) ? decodeSession(bytes.value) : undefined;
          return session === undefined ? Effect.succeed(undefined) : write(session).pipe(Effect.andThen(plain.value.remove(ACCOUNT_SECRET)), Effect.as(session));
        }),
      );
  const store: AccountStore = {
    load: () => run(read.pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : legacy)), Effect.orElseSucceed(() => undefined))).then(allowed),
    save: (session) => run(write(session).pipe(Effect.orDie)),
  };
  return store;
});

/**
 * A credits key and the gateway it runs on: none kept for Caveman's hosted
 * Cloud (its gateway, as every build stored it), else the one the Cloud named
 * at sign-in. A Cloud that named none gets no key: it would run nowhere.
 */
async function mintOnOwnGateway(store: AccountStore, fetchImpl: typeof fetch): Promise<{ key: string; gateway?: string }> {
  const session = await store.load();
  if (!session) throw new SignedOut("Sign in to Caveman to see your account.");
  const gateway = creditsGatewayFor(session);
  if (session.cloud_url !== HOSTED_CLOUD && gateway === undefined) {
    throw new CloudError(409, "This Caveman server did not say where its gateway is. Sign out and sign in again, or ask whoever runs it.");
  }
  const key = await mintCreditsKey(store, fetchImpl);
  return gateway === undefined ? { key } : { key, gateway };
}

export const makeAccountHandlers = (store: AccountStore, allowed: (principal: string | undefined) => boolean, credits: CreditsSlot, fetchImpl: typeof fetch = fetch, refreshRouting: () => Promise<void> = async () => {}) => {
  const failure = (error: unknown) =>
    new ProtocolError({ reason: error instanceof SignedOut ? "cloud_unauthorized" : "internal", message: error instanceof Error ? error.message : String(error) });
  // One credits change at a time: two enables would both mint, and one key would be neither held nor kept for revoking.
  const creditsLock = Semaphore.makeUnsafe(1);
  const handlers: { readonly [M in AccountMethod]: Handler<M> } = {
    "account.get": () =>
      Effect.gen(function* () {
        const on = yield* credits.has;
        const read = yield* Effect.promise(async () => {
          if (!(await store.load())) return { signed_in: false };
          try {
            return { signed_in: true, ...(await accountSummary(store, fetchImpl)) };
          } catch (error) {
            // Signed out on the way (the sign-in ended) reads as signed out, with why.
            return { signed_in: !(error instanceof SignedOut), error: error instanceof Error ? error.message : String(error) };
          }
        });
        yield* Effect.promise(refreshRouting);
        return { ...read, credits_on: on };
      }),
    // On keeps a key the engine already holds; off revokes it in Cloud (a failure leaves its id for sign-out to retry).
    // A Cloud other than Caveman's hosted one gets its key run on the gateway it named, and none minted without one (hosted.ts).
    "account.credits": (p) =>
      (p.enabled
        ? Effect.flatMap(credits.has, (held) =>
            held
              ? Effect.void
              : Effect.tryPromise({ try: () => mintOnOwnGateway(store, fetchImpl), catch: failure }).pipe(Effect.flatMap(({ key, gateway }) => credits.set(key, gateway))),
          )
        : Effect.promise(() => revokeCreditsKey(store, fetchImpl).catch(() => undefined)).pipe(Effect.andThen(credits.set(null)))
      ).pipe(Effect.andThen(Effect.promise(refreshRouting)), creditsLock.withPermits(1), Effect.as({ enabled: p.enabled })),
    "account.checkout": (p) =>
      p.kind === "plan" && !p.plan
        ? Effect.fail(new ProtocolError({ reason: "invalid_params", message: "a plan checkout names its plan" }))
        : p.kind === "topup" && !(Number.isInteger(p.amount_usd) && (p.amount_usd ?? 0) > 0)
          ? Effect.fail(new ProtocolError({ reason: "invalid_params", message: "a top-up names whole dollars" }))
          : Effect.tryPromise({
              try: () =>
                accountCheckout(
                  store,
                  p.kind === "plan" ? { kind: "plan", plan: p.plan!, interval: p.interval ?? "month", seats: p.seats } : { kind: "topup", amount_usd: p.amount_usd! },
                  fetchImpl,
                ),
              catch: failure,
            }),
    "account.billing": (p) => Effect.tryPromise({ try: () => accountBilling(store, p.action, fetchImpl), catch: failure }),
    // Pay as you go: Cloud holds the bounds and refuses what is out of them; this only keeps the dollars whole.
    "account.auto_topup": (p) =>
      [p.month_limit_usd, p.amount_usd, p.below_usd].some((usd) => usd !== undefined && !(Number.isInteger(usd) && usd > 0))
        ? Effect.fail(new ProtocolError({ reason: "invalid_params", message: "a limit, an amount and a threshold name whole dollars" }))
        : Effect.tryPromise({
            try: () => accountAutoTopup(store, { enabled: p.enabled, month_limit_usd: p.month_limit_usd, amount_usd: p.amount_usd, below_usd: p.below_usd }, fetchImpl),
            catch: failure,
          }),
    "account.auto_topup_card": () => Effect.tryPromise({ try: () => accountAutoTopupCard(store, fetchImpl), catch: failure }),
    "account.gifts": () => Effect.tryPromise({ try: () => accountGifts(store, fetchImpl), catch: failure }),
    "account.gift_send": (p) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())
        ? Effect.tryPromise({ try: () => accountGiftSend(store, p.code, p.email.trim(), fetchImpl), catch: failure })
        : Effect.fail(new ProtocolError({ reason: "invalid_params", message: "That doesn't look like an email address." })),
  };
  const forbidden = new ProtocolError({ reason: "forbidden", message: "the Caveman account belongs to this runtime's owner" });
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params: never, ctx: { readonly connectionId: string; readonly principal?: string }) =>
        allowed(ctx.principal) ? (handler as (p: never, c: typeof ctx) => Effect.Effect<unknown, ProtocolError>)(params, ctx) : Effect.fail(forbidden),
    ]),
  ) as unknown as typeof handlers;
};
