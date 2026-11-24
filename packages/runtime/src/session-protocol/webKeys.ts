// Settings > Models & keys > Web search (web.keys.*): the Caveman engine's web tool keys, web_search's and the
// Firecrawl key web_fetch reads hard pages with (web/WebKeys.ts). A key arrives once and goes straight to the sealed
// store after one check call; nothing here returns, logs or journals one. A key the provider refuses is key_refused
// and not stored. `credits` says Caveman credits are on, so searches run on them, at cost, when no own key answers
// (web/credits.ts). The keys are the runtime's owner's, as its other secrets are: any other principal is forbidden.
// On a Cloud computer whose person's credentials stay outside it no key is taken (insideComputer.ts): it is refused
// before the check call, so it is sent nowhere, and searches there run on credits. One an earlier run kept can still be cleared.
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { ProviderInstanceId } from "@caveman-app/protocol";
import { readCavemanKeys } from "@caveman-app/provider-caveman/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OUTSIDE_WEB_KEY } from "../cloudLink/credentialRule.ts";
import { clearWebKey, setWebKey, webKeyStatus, WebKeyChecker, type CheckWebKey } from "../web/WebKeys.ts";
import { type Handler, ProtocolError } from "./handlers.ts";
import type { InsideComputer } from "./insideComputer.ts";

type WebKeyMethod = "web.keys.status" | "web.keys.set" | "web.keys.clear";

const CAVEMAN = ProviderInstanceId.make("caveman");
/** The Caveman engine's credits key slot (provider-caveman credits.ts CREDITS_PROVIDER). */
const CREDITS = "caveman";

export const makeWebKeyHandlers = (
  host: Option.Option<ProviderHost.ProviderHost["Service"]>,
  /** The check search (tests stub it, as they do the Caveman engine's key test). */
  check: CheckWebKey,
  /** Who may use this runtime's secrets (handlers.ts secretsAllowed). */
  allowed: (principal: string | undefined) => boolean,
  /** Whether a key may be kept on this computer (insideComputer.ts). */
  insideComputer: InsideComputer,
  /** Where Firecrawl Local is on this computer (web/firecrawlLocal.ts FirecrawlLocalBinary). */
  firecrawlLocal: () => string | undefined,
): { readonly [M in WebKeyMethod]: Handler<M> } => {
  const onHost = <A, E>(effect: Effect.Effect<A, E, ProviderHost.ProviderHost>): Effect.Effect<A, E | ProtocolError> =>
    Option.isNone(host)
      ? Effect.fail(new ProtocolError({ reason: "engine_unavailable", message: "This runtime has no secret store for web search keys." }))
      : effect.pipe(Effect.provideService(ProviderHost.ProviderHost, host.value));
  const status = onHost(
    Effect.gen(function* () {
      const providers = [...(yield* webKeyStatus())];
      const credits = (yield* readCavemanKeys(CAVEMAN).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>)))[CREDITS] !== undefined;
      return { providers, credits, firecrawl_local: firecrawlLocal() !== undefined };
    }),
  );
  const handlers: { readonly [M in WebKeyMethod]: Handler<M> } = {
    "web.keys.status": () => status,
    "web.keys.set": (p) =>
      insideComputer(OUTSIDE_WEB_KEY).pipe(
        Effect.andThen(onHost(setWebKey(p.provider, p.key).pipe(Effect.provideService(WebKeyChecker, check)))),
        Effect.mapError((error) =>
          error instanceof ProtocolError
            ? error
            : new ProtocolError({ reason: error._tag === "WebKeyRefused" ? "key_refused" : "internal", message: error.message }),
        ),
        Effect.flatMap((kept) => Effect.map(status, (now) => ({ ...now, ...(kept.note === undefined ? {} : { note: kept.note }) }))),
      ),
    "web.keys.clear": (p) =>
      onHost(clearWebKey(p.provider)).pipe(
        Effect.mapError((error) => (error instanceof ProtocolError ? error : new ProtocolError({ reason: "internal", message: error.message }))),
        Effect.andThen(status),
      ),
  };
  const forbidden = new ProtocolError({ reason: "forbidden", message: "these web search keys belong to this runtime's owner" });
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params: never, ctx: { readonly connectionId: string; readonly principal?: string }) =>
        allowed(ctx.principal) ? (handler as (p: never, c: typeof ctx) => Effect.Effect<unknown, ProtocolError>)(params, ctx) : Effect.fail(forbidden),
    ]),
  ) as unknown as typeof handlers;
};
