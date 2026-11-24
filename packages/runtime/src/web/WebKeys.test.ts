// Web tool keys (the search providers' and Firecrawl's): checked with one call before they are kept; a key the provider refuses is not stored; a
// limited or unreachable provider keeps the key with a note; Settings sees only whether one is set and its tail.
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { clearWebKey, noteWebKeyRefused, readWebKeys, setWebKey, webKeyStatus, WebKeyChecker, type WebKeyCheck } from "./WebKeys.ts";

const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const checking = (answers: Record<string, WebKeyCheck>) => {
  const seen: Array<[string, string]> = [];
  return { seen, check: async (provider: string, key: string) => (seen.push([provider, key]), answers[key] ?? { ok: true as const }) };
};

describe("web keys", () => {
  it.effect("keep a key the provider accepts, sealed in the host's store, and show only its tail", () =>
    Effect.gen(function* () {
      const checker = checking({});
      const set = yield* setWebKey("brave", "  BSA-brave-key-0123456789abcd  ").pipe(Effect.provideService(WebKeyChecker, checker.check));
      expect(set).toEqual({ checked: true });
      expect(checker.seen).toEqual([["brave", "BSA-brave-key-0123456789abcd"]]);
      expect(yield* readWebKeys()).toEqual({ brave: "BSA-brave-key-0123456789abcd" });
      expect(yield* webKeyStatus()).toEqual([
        { id: "brave", configured: true, hint: "...abcd" },
        { id: "perplexity", configured: false },
        { id: "exa", configured: false },
        { id: "firecrawl", configured: false },
      ]);
      yield* clearWebKey("brave");
      expect(yield* readWebKeys()).toEqual({});
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never store a key the provider refuses", () =>
    Effect.gen(function* () {
      const checker = checking({ "pplx-revoked-key-000000": { ok: false, kind: "auth", message: "401: invalid api key" } });
      const refused = yield* Effect.flip(setWebKey("perplexity", "pplx-revoked-key-000000").pipe(Effect.provideService(WebKeyChecker, checker.check)));
      expect(refused._tag).toBe("WebKeyRefused");
      expect(refused.message).toBe("Perplexity refused the key (401: invalid api key). It was not saved.");
      expect(yield* readWebKeys()).toEqual({});
      const blank = yield* Effect.flip(setWebKey("exa", "   ").pipe(Effect.provideService(WebKeyChecker, checker.check)));
      expect(blank.message).toBe("That is not an Exa API key.");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keep a Firecrawl key beside the search keys, checked and refused like them", () =>
    Effect.gen(function* () {
      const checker = checking({ "fc-revoked-key-0000000000": { ok: false, kind: "auth", message: "401: Unauthorized: Invalid token" } });
      const refused = yield* Effect.flip(setWebKey("firecrawl", "fc-revoked-key-0000000000").pipe(Effect.provideService(WebKeyChecker, checker.check)));
      expect(refused.message).toBe("Firecrawl refused the key (401: Unauthorized: Invalid token). It was not saved.");
      yield* setWebKey("firecrawl", "fc-0123456789abcdef0123").pipe(Effect.provideService(WebKeyChecker, checker.check));
      expect(checker.seen.map(([provider]) => provider)).toEqual(["firecrawl", "firecrawl"]);
      expect(yield* readWebKeys()).toEqual({ firecrawl: "fc-0123456789abcdef0123" });
      yield* noteWebKeyRefused("firecrawl", "fc-0123456789abcdef0123", true);
      expect((yield* webKeyStatus()).find((p) => p.id === "firecrawl")).toEqual({ id: "firecrawl", configured: true, hint: "...0123", refused: true });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keep a key whose provider is limited or unreachable, saying so", () =>
    Effect.gen(function* () {
      const checker = checking({ "exa-limited-key-0000000": { ok: false, kind: "limit", message: "429: slow down" } });
      const set = yield* setWebKey("exa", "exa-limited-key-0000000").pipe(Effect.provideService(WebKeyChecker, checker.check));
      expect(set).toEqual({ checked: false, note: "Saved. Exa is rate limiting it right now: 429: slow down" });
      expect(yield* readWebKeys()).toEqual({ exa: "exa-limited-key-0000000" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("mark a kept key its provider refuses at search time, until it answers again or is replaced", () =>
    Effect.gen(function* () {
      const checker = checking({});
      const key = "BSA-brave-key-0123456789abcd";
      yield* setWebKey("brave", key).pipe(Effect.provideService(WebKeyChecker, checker.check));
      const brave = Effect.map(webKeyStatus(), (providers) => providers.find((p) => p.id === "brave"));
      yield* noteWebKeyRefused("brave", key, true);
      expect(yield* brave).toEqual({ id: "brave", configured: true, hint: "...abcd", refused: true });
      // The key itself still works for search: only marked.
      expect(yield* readWebKeys()).toEqual({ brave: key });
      yield* noteWebKeyRefused("brave", key, false);
      expect(yield* brave).toEqual({ id: "brave", configured: true, hint: "...abcd" });
      // A search that started with a key since replaced marks nothing.
      yield* noteWebKeyRefused("brave", key, true);
      yield* setWebKey("brave", "BSA-brave-new-key-9876543210wxyz").pipe(Effect.provideService(WebKeyChecker, checker.check));
      expect(yield* brave).toEqual({ id: "brave", configured: true, hint: "...wxyz" });
      yield* noteWebKeyRefused("brave", key, true);
      expect(yield* brave).toEqual({ id: "brave", configured: true, hint: "...wxyz" });
    }).pipe(Effect.provide(layer)),
  );
});
