// What pays for calls and dictation. A person's own voice engine keys (Settings > Chief > Calls), sealed like the web
// search keys (web/WebKeys.ts): one blob in the runtime's secret store through ProviderHost.credentials, under a key in
// the OS keychain. A key is checked with its engine before it is kept; a refused one is never stored. Without one,
// their Caveman credits pay, through Caveman Cloud's relay on Caveman's own key (voicePayment). Nothing here returns,
// logs or journals a key.
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CREDITS_NOT_OFFERED, VoiceEngineError, type VoiceCredential } from "./engine.ts";

const NAMESPACE = "caveman-voice";
const BINDING = "keys";

const Stored = Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), keys: Schema.Record(Schema.String, Schema.String) }));
const decodeStored = Schema.decodeUnknownEffect(Stored);
const encodeStored = Schema.encodeEffect(Stored);

export class VoiceKeyStoreError extends Error {}

const credentials = ProviderHost.ProviderHost.pipe(Effect.flatMap((host) => host.credentials(NAMESPACE, BINDING)));

/** Every stored key by engine id; a damaged blob reads as none, never as a crash. */
export const readVoiceKeys = Effect.fn("readVoiceKeys")(function* () {
  const stored = yield* (yield* credentials).get.pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  if (Option.isNone(stored)) return {} as Record<string, string>;
  const decoded = yield* decodeStored(new TextDecoder().decode(stored.value)).pipe(Effect.option);
  return Option.isNone(decoded) ? ({} as Record<string, string>) : Object.fromEntries(Object.entries(decoded.value.keys).filter(([, key]) => key.trim() !== ""));
});

/** Keeps `key` for `engine`, or (null) removes it. The caller checked it with the engine first. */
export const writeVoiceKey = Effect.fn("writeVoiceKey")(function* (engine: string, key: string | null) {
  const store = yield* credentials;
  const { [engine]: _old, ...others } = yield* readVoiceKeys();
  const keys = key === null ? others : { ...others, [engine]: key };
  const write =
    Object.keys(keys).length === 0
      ? store.remove
      : encodeStored({ version: 1 as const, keys }).pipe(Effect.orDie, Effect.flatMap((text) => store.set(new TextEncoder().encode(text))));
  yield* write.pipe(Effect.mapError(() => new VoiceKeyStoreError("Could not store the key.")));
});

/** Settings' line for a stored key: its last four characters, as model keys show. */
export const keyHint = (key: string) => (key.length >= 20 ? `...${key.slice(-4)}` : undefined);

/** What a pasted key must at least look like before an engine is asked about it. */
export const plausibleKey = (raw: string) => {
  const key = raw.trim();
  return key !== "" && key.length <= 512 && !/\s/.test(key) ? key : undefined;
};

/**
 * Caveman credits as voice reads them: the credits key and the gateway it runs on, now. A Cloud computer's asks Cloud
 * only when it holds none, so it is read when a call or dictation starts, never for a status.
 */
export type VoiceCredits = () => Promise<{ readonly key: string; readonly gateway: string } | undefined>;

/**
 * Caveman credits as voice sees them: how to read them now, or `unavailable` while Caveman Cloud answered that it
 * doesn't offer voice on them (remembered until the runtime restarts or the person signs in again); undefined: off.
 */
export type VoiceCreditsState = VoiceCredits | "unavailable" | undefined;

/**
 * What pays for a call or dictation: the person's own key for the engine when they added one, else their Caveman
 * credits (the order web search uses: their key first). Undefined when neither is here; credits Cloud doesn't offer
 * voice on fail `not_offered`, so a start says why and points to a key.
 */
export const voicePayment = (key: string | undefined, credits: VoiceCreditsState): Effect.Effect<VoiceCredential, VoiceEngineError> | undefined => {
  if (key !== undefined) return Effect.succeed({ kind: "key", key });
  if (credits === undefined) return undefined;
  if (credits === "unavailable") return Effect.fail(new VoiceEngineError(CREDITS_NOT_OFFERED, "not_offered"));
  return Effect.tryPromise({ try: credits, catch: () => new VoiceEngineError("Caveman credits couldn't be read on this computer.", "unavailable") }).pipe(
    Effect.flatMap((now) =>
      now === undefined || now.key === ""
        ? Effect.fail(new VoiceEngineError("This Cloud computer has no Caveman credits key right now. Try again in a moment.", "unavailable"))
        : Effect.succeed({ kind: "credits" as const, key: now.key, gateway: now.gateway }),
    ),
  );
};
