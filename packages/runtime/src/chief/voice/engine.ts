// The seam between a call with the Chief (Call.ts), or dictation (Dictation.ts), and the engine that listens and talks
// (docs/chief.md "Calls", "Dictation").
// A call speaks only these signals and actions; an adapter (deepgram.ts) turns them into one engine's wire. Adding
// an engine (GPT-Live, say) is an adapter like it, provided as VoiceEngineRef (deepgram.ts holds the default), and a
// media adapter in the web client (apps/web/src/call/engine.ts); the call, its prompt and the UI stay as they are.
import type { DictationConnect, Settings, VoiceConnect } from "@caveman-app/session-protocol";
import type * as Effect from "effect/Effect";

/** What the engine heard or did, in its order. */
export type Heard =
  /** It took the call's settings: the call is live. */
  | { readonly type: "ready" }
  /** A finished turn as transcribed: the person's words, or what the voice said. */
  | { readonly type: "turn"; readonly role: "person" | "voice"; readonly text: string }
  | { readonly type: "person_speaking" }
  | { readonly type: "voice_speaking" }
  /** The voice finished sending a reply's audio (the client may still be playing it). */
  | { readonly type: "voice_done" }
  /** The voice hands what the person just asked to the Chief. Answer it with `answer` and this id. */
  | { readonly type: "handoff"; readonly id: string; readonly name: string }
  /** The voice said goodbye and hangs up. */
  | { readonly type: "goodbye"; readonly id: string; readonly name: string }
  /** The voice puts the work it is walking through on the person's screen: its pull request, its files (one, maybe), or the chat. Answer it with `answer`. */
  | { readonly type: "show"; readonly id: string; readonly name: string; readonly what: "work" | "files" | "chat"; readonly file?: string }
  /** The person kept talking: these handoffs never happened (send no answer). */
  | { readonly type: "cancelled"; readonly ids: ReadonlyArray<string> }
  /** A `say` was not spoken because someone was mid-turn. */
  | { readonly type: "refused" }
  | { readonly type: "error"; readonly message: string; readonly fatal: boolean };

/** What the call asks of the engine. */
export type VoiceAction =
  /** The result of a handoff or a goodbye, for the voice to go on from. */
  | { readonly type: "answer"; readonly id: string; readonly name: string; readonly text: string }
  /** Speak these words, as they are, when nobody is mid-turn. */
  | { readonly type: "say"; readonly text: string }
  /** Quiet context the voice keeps for the rest of the call. */
  | { readonly type: "know"; readonly text: string }
  /** Its whole prompt again, fresh (appended context ran out of room). */
  | { readonly type: "renew"; readonly prompt: string };

/** One call's setup, the same for every engine. */
export interface VoiceSetup {
  /** The voice's instructions and the call's opening context, as one prompt. */
  readonly prompt: string;
  /** Its first words, spoken as they are. */
  readonly greeting: string;
  /** A voice id from the engine's `voices`. */
  readonly voice: string;
  /** Names it should hear right: projects, chats. */
  readonly keyterms: ReadonlyArray<string>;
  /** How long it waits on a pause before the person's turn counts as done; the adapter maps it to the engine's own knobs. */
  readonly patience: VoicePatience;
}

/** How tolerant a call's turn-taking is of pauses (Settings.chief_voice_patience). */
export type VoicePatience = NonNullable<Settings["chief_voice_patience"]>;

export interface VoiceVoice {
  readonly id: string;
  readonly label: string;
  /** A few words on how it sounds. */
  readonly hint: string;
}

/**
 * What pays for one call or dictation. key: the person's own key for the engine, which mints a short-lived token;
 * credits: their Caveman credits key, which Caveman Cloud's gateway turns into a one-time ticket for a socket it
 * relays the engine on with Caveman's own key (Caveman Cloud the spec). Neither key ever reaches the client.
 * `session` is the chat the minutes are for, on credits.
 */
export type VoiceCredential =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "credits"; readonly key: string; readonly gateway: string; readonly session?: string };

/** How the client connects for one call or dictation, and what a minute of it costs on what pays (Cloud says, on credits). */
export interface VoiceMinted<C> {
  readonly connect: C;
  readonly usdPerMinute: number;
}

/** What a person is told while Caveman Cloud doesn't offer voice on credits (VoiceEngineError `not_offered`). */
export const CREDITS_NOT_OFFERED = "Calls and dictation on Caveman credits aren't on yet. Add a key of your own to use them now.";

/**
 * A key the engine refused, or one it could not check: never stored when refused. not_offered: Caveman Cloud's gateway
 * answered that it doesn't offer voice on credits (a gateway from before it, or voice not configured there).
 */
export class VoiceEngineError extends Error {
  readonly kind: "refused" | "unavailable" | "not_offered";
  constructor(message: string, kind: VoiceEngineError["kind"]) {
    super(message);
    this.kind = kind;
  }
}

export interface VoiceEngine {
  readonly id: string;
  /** Its name in Settings and the disclosure ("Calls send your voice to Deepgram"). */
  readonly label: string;
  /** Where a person gets a key, and the one line Settings says about the key it needs. */
  readonly keyUrl: string;
  readonly keyHelp: string;
  readonly voices: ReadonlyArray<VoiceVoice>;
  /** Characters of prompt the voice keeps, appended context included; past it the call renews it. */
  readonly promptLimit: number;
  /** Checks a key with the engine, so a wrong one is never stored. */
  readonly check: (key: string) => Effect.Effect<void, VoiceEngineError>;
  /** How the client connects for one call, minted on what pays: a short-lived credential, never the key. */
  readonly connect: (credential: VoiceCredential, setup: VoiceSetup) => Effect.Effect<VoiceMinted<VoiceConnect>, VoiceEngineError>;
  /** One of the engine's JSON messages as signals (none for what a call does not need). */
  readonly decode: (message: unknown) => ReadonlyArray<Heard>;
  /** An action as the engine's messages. */
  readonly encode: (action: VoiceAction) => ReadonlyArray<unknown>;
  /** Dictation (Dictation.ts): speech to text for any box, paid as calls are. */
  readonly dictation: {
    /** How the client connects to dictate, minted on what pays; `keyterms` are names to hear right. */
    readonly connect: (credential: VoiceCredential, keyterms: ReadonlyArray<string>) => Effect.Effect<VoiceMinted<DictationConnect>, VoiceEngineError>;
  };
}
