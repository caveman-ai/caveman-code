// Dictation: talk into any box and the words land in it (docs/chief.md "Dictation"). It runs on the calls' voice
// engine, paid as calls are: the person's own key, else Caveman credits (engine.ts, keys.ts). The runtime only mints
// the connection, with names to hear right (projects, chats), and records the minutes; the client holds the socket,
// the audio and the words, which never come here.
import { randomUUID } from "node:crypto";

import type { DictationConnect } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { type Handler, ProtocolError } from "../../session-protocol/handlers.ts";
import type { VoiceCredential, VoiceEngine, VoiceEngineError } from "./engine.ts";
import { voicePayment, type VoiceCreditsState } from "./keys.ts";

/** A dictation never ended is forgotten after this (and not recorded): the client stops one at 10 minutes. */
const FORGET_MS = 30 * 60_000;
/** Room for the client's clock and the network between its last frame and dictation.end. */
const SLACK_MS = 5_000;
/** Names it should hear right, at most: Deepgram takes 500 tokens of them in all. */
const MAX_KEYTERMS = 30;

export interface DictationDeps {
  readonly engine: VoiceEngine;
  /** The voice engines' sealed keys by engine id (keys.ts). */
  readonly keys: Effect.Effect<Readonly<Record<string, string>>>;
  /** Caveman credits, which pay when there is no key of the person's own; absent while they are off. */
  readonly credits: Effect.Effect<VoiceCreditsState>;
  /** Project names, then chat titles, the box's own chat first. */
  readonly names: (workspaceId: string | undefined) => Effect.Effect<ReadonlyArray<string>>;
  /** Whether a chat is on this runtime: spend is only ever recorded against one that is. */
  readonly hasWorkspace: (workspaceId: string) => Effect.Effect<boolean>;
  /** A spend row: the dictated minutes at what a minute cost on what paid, in that chat's bucket (null: no chat yet). */
  readonly recordSpend: (workspaceId: string | null, usd: number, durationMs: number, paid: VoiceCredential["kind"]) => Effect.Effect<void>;
  readonly now?: () => number;
}

/**
 * Names worth a keyterm: long enough to mishear, short enough to be a name, each once. No control characters: Cloud
 * refuses a dictation on credits whose keyterms carry one.
 */
export const keytermsOf = (names: ReadonlyArray<string>) =>
  [...new Set(names.map((n) => n.trim()))].filter((n) => n.length >= 3 && n.length <= 40 && !/\p{Cc}/u.test(n)).slice(0, MAX_KEYTERMS);

export const makeDictation = (deps: DictationDeps) => {
  const now = deps.now ?? Date.now;
  const engine = deps.engine;
  const open = new Map<string, { readonly workspaceId: string | null; readonly startedMs: number; readonly paid: VoiceCredential["kind"]; readonly usdPerMinute: number }>();

  const start = (input: { readonly workspaceId?: string }) =>
    Effect.gen(function* () {
      for (const [id, d] of open) if (now() - d.startedMs > FORGET_MS) open.delete(id);
      const payment = voicePayment((yield* deps.keys)[engine.id], yield* deps.credits);
      if (payment === undefined)
        return yield* Effect.fail(new ProtocolError({ reason: "invalid_state", message: `no_key: dictation needs a Caveman plan or credits, or a ${engine.label} key (Settings > Chief > Calls)` }));
      // While Cloud doesn't offer voice on credits, `not_offered:` (invalid_state) points the box to a key.
      // Refused (credits ran out, a key revoked) is the person's to fix; unavailable is the engine's or Cloud's.
      const unavailable = (e: VoiceEngineError) =>
        e.kind === "not_offered"
          ? new ProtocolError({ reason: "invalid_state", message: `not_offered: ${e.message}` })
          : new ProtocolError({ reason: e.kind === "refused" ? "key_refused" : "engine_unavailable", message: e.message });
      const credential = yield* payment.pipe(Effect.mapError(unavailable));
      const workspaceId = input.workspaceId !== undefined && (yield* deps.hasWorkspace(input.workspaceId)) ? input.workspaceId : null;
      const keyterms = keytermsOf(yield* deps.names(workspaceId ?? undefined));
      // On credits the minutes are the chat's being dictated into, when there is one.
      const paying = credential.kind === "credits" && workspaceId !== null ? { ...credential, session: workspaceId } : credential;
      const minted = yield* engine.dictation.connect(paying, keyterms).pipe(Effect.mapError(unavailable));
      const connect: DictationConnect = minted.connect;
      const id = `dc-${randomUUID().slice(0, 8)}`;
      open.set(id, { workspaceId, startedMs: now(), paid: credential.kind, usdPerMinute: minted.usdPerMinute });
      return { dictation_id: id, connect };
    });

  const end = (input: { readonly dictationId: string; readonly audioMs: number }) =>
    Effect.gen(function* () {
      const d = open.get(input.dictationId);
      if (d === undefined) return {};
      open.delete(input.dictationId);
      const ms = Math.max(0, Math.min(input.audioMs, now() - d.startedMs + SLACK_MS));
      if (ms > 0)
        yield* deps.recordSpend(d.workspaceId, (ms / 60_000) * d.usdPerMinute, ms, d.paid).pipe(Effect.catchCause((cause) => Effect.logWarning("dictation: spend not recorded", cause)));
      return {};
    });

  return { start, end };
};

export type Dictation = ReturnType<typeof makeDictation>;

/** dictation.* for the runtime's owner only: the key or credits it spends are theirs. */
export const makeDictationHandlers = (
  dictation: Dictation,
  allowed: (principal: string | undefined) => boolean,
): { readonly "dictation.start": Handler<"dictation.start">; readonly "dictation.end": Handler<"dictation.end"> } => {
  const forbidden = new ProtocolError({ reason: "forbidden", message: "dictation belongs to this runtime's owner" });
  return {
    "dictation.start": (p, ctx) => (allowed(ctx.principal) ? dictation.start(p.workspace_id === undefined ? {} : { workspaceId: p.workspace_id }) : Effect.fail(forbidden)),
    "dictation.end": (p, ctx) => (allowed(ctx.principal) ? dictation.end({ dictationId: p.dictation_id, audioMs: p.audio_ms }) : Effect.fail(forbidden)),
  };
};
