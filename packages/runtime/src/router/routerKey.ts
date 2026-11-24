// One runtime-owned credential for paid Auto. Only lifecycle refreshes mint;
// route calls read it. The account store seals the paid-plan key like its sign-in.
//
// A Cloud computer keeps no Caveman sign-in (session-protocol/account.ts), so nothing above mints there. Its routing
// credential is the credits key Cloud mints its runtime (cloudLink/computerCredits.ts): the person's own, short-lived,
// in memory only, and scoped to ask the router (Caveman Cloud's broker keys carry `router:write`). It is the one key
// of the person's the credential rule leaves on such a computer (cloud-computers CONTRACT §2), so Auto asks with it
// there and nothing else is brought in. The policy stays in Cloud either way: an ask names what is connected and gets
// back one model and an effort.
import type { CreditsCredentialSource, RoutingCredentialSource } from "@caveman-app/engine-core/server/ProviderHost";
import { gatewayOf } from "@caveman-app/provider-caveman/server";
import { accountCall, freshSession, type AccountStore } from "../cloudLink/account.ts";
import { cloudGateway } from "../cloudLink/hosted.ts";
import { appProxyTokens } from "./proxyLauncher.ts";

export function makeRouterKey(input: {
  readonly store: AccountStore;
  readonly credits: () => Promise<string | undefined>;
  /** A Cloud computer's credits source: its routing credential, in place of a sign-in it never has. Absent on a Mac. */
  readonly computer?: CreditsCredentialSource | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly changed?: () => Promise<void>;
}) {
  const { store, computer } = input;
  const now = input.now ?? Date.now;
  const fetchImpl = input.fetch ?? fetch;
  let flight: Promise<void> | undefined;
  let retryAt = 0;
  let failures = 0;
  let generation = 0;
  const refused = new Set<string>();
  const remember = (key: string | undefined) => {
    if (key) appProxyTokens.add(key);
    return key;
  };
  // The proxies take a new credential on their own time: a route ask or an account call waits on the key, never on
  // their spawns and readiness polls (index.ts keeps those off the startup path).
  const tell = () => void input.changed?.().catch(() => undefined);
  const get: RoutingCredentialSource["get"] = async () => {
    if (computer !== undefined) {
      // Asked only for a request that sends it (a route ask): this may mint, as a Caveman turn's own request does.
      const credit = computer.available() ? await computer.get().catch(() => undefined) : undefined;
      const key = credit !== undefined && credit.key !== "" && !refused.has(credit.key) ? remember(credit.key) : undefined;
      return key ? { key, url: gatewayOf(credit) } : undefined;
    }
    const session = await store.load();
    if (!session) return undefined;
    const credits = await input.credits();
    const key = remember(credits && !refused.has(credits) ? credits : Date.parse(session.routing_expires_at ?? "") > now() ? session.routing_key : undefined);
    // A Cloud that named no gateway (a sign-in kept before builds read it) is asked at its own origin, as before.
    return key && !refused.has(key) ? { key, url: cloudGateway(session) ?? session.cloud_url } : undefined;
  };
  const clear = async () => {
    generation++;
    retryAt = 0;
    failures = 0;
    const session = await store.load();
    if (session?.routing_key) await store.save({ ...session, routing_key: undefined, routing_expires_at: undefined });
  };
  const refresh = (): Promise<void> => {
    if (flight) return flight;
    flight = (async () => {
      const epoch = generation;
      const session = await freshSession(store, fetchImpl, now());
      if (!session) { await clear(); return; }
      const credits = await input.credits();
      if (credits && !refused.has(credits)) { remember(credits); return; }
      remember(session.routing_key);
      if (session.routing_key && !refused.has(session.routing_key) && Date.parse(session.routing_expires_at ?? "") > now() + 5 * 60_000) return;
      if (now() < retryAt) return;
      try {
        const response = await accountCall(store, "/api/v1/code/router/keys", { method: "POST", signal: AbortSignal.timeout(5_000) }, fetchImpl);
        const current = await store.load();
        if (epoch !== generation || !current || current.cloud_url !== session.cloud_url) { await response.body?.cancel(); return; }
        if (response.status === 402) {
          await clear();
          retryAt = now() + 60_000;
          return;
        }
        if (response.status === 403) await clear();
        if (!response.ok) {
          const after = Number(response.headers.get("retry-after"));
          await response.body?.cancel();
          retryAt = now() + Math.max(Number.isFinite(after) ? after * 1000 : 0, Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures++, 6)));
          return;
        }
        const value = await response.json() as { full_key?: unknown; expires_at?: unknown; scopes?: unknown };
        if (typeof value.full_key !== "string" || !value.full_key.startsWith("cave_") || typeof value.expires_at !== "string" || !(Date.parse(value.expires_at) > now()) || !Array.isArray(value.scopes) || !value.scopes.includes("router:write")) {
          retryAt = now() + 60_000;
          return;
        }
        // Sign-out while reading the answer must not restore the old account.
        const latest = await store.load();
        if (epoch !== generation || !latest || latest.cloud_url !== session.cloud_url) return;
        remember(value.full_key);
        await store.save({ ...latest, routing_key: value.full_key, routing_expires_at: value.expires_at });
        failures = 0;
        retryAt = 0;
      } catch {
        retryAt = now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures++, 6));
      }
    })().finally(() => { flight = undefined; tell(); });
    return flight;
  };
  /**
   * Whether Auto can be asked here, for a model list or a status probe. On a Cloud computer it asks Cloud nothing
   * (credits may pay there, and the key held, if any, was not refused): only a request mints a key.
   */
  const offered = async (): Promise<boolean> => {
    if (computer === undefined) return (await get()) !== undefined;
    const held = computer.peek();
    return computer.available() && (held === undefined || !refused.has(held.key));
  };
  const rejected: RoutingCredentialSource["rejected"] = async (key, status, remint = true) => {
    if (computer !== undefined) {
      // Nothing to mint again here: the key is Cloud's to renew, and the next one it mints asks afresh.
      if ([401, 402, 403].includes(status) && !refused.has(key)) {
        refused.add(key);
        tell();
      }
      return;
    }
    if (![401, 402, 403].includes(status) || (await get())?.key !== key) return;
    refused.add(key);
    await clear();
    if (status === 402 || !remint) {
      retryAt = now() + 60_000;
      tell();
    } else await refresh();
  };
  return { get, offered, refresh, clear, rejected };
}

let current: ReturnType<typeof makeRouterKey> | undefined;
export const setRouterKey = (owner: typeof current): void => { current = owner; };
export const routingCredential: RoutingCredentialSource = {
  get: async () => current?.get(),
  offered: async () => (await current?.offered()) ?? false,
  rejected: async (key, status, remint) => { await current?.rejected(key, status, remint); },
};
