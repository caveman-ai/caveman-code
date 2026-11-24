// ), packages/shared/src/httpObservability.ts @ 6d46336476.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";
import * as UrlParams from "effect/http/UrlParams";

export const layer = Layer.mergeAll(
  Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop"]),
  ),
  Layer.effect(
    UrlParams.CurrentRedactedNames,
    // Socket tickets and proofs, pairing tokens, and OAuth codes travel in query strings.
    Effect.map(UrlParams.CurrentRedactedNames, (names) => [
      ...names,
      "wsTicket",
      "dpop",
      "token",
      "pairingUrl",
      "code",
      "state",
      "challenge",
    ]),
  ),
);
