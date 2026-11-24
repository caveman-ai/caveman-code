// Deepgram's Voice Agent as the Chief's voice engine (engine.ts). One socket does it all: Flux hears the person
// and knows when they are done, a managed model talks, Flux TTS speaks. The client holds the socket (the media goes
// from the person's device to Deepgram) and every JSON message comes to the runtime through chief.voice.signal, and
// what the call says goes back the same way. Dictation is Deepgram's streaming speech to text, paid the same way; its
// words stay on the client.
// What pays decides where the socket goes (keys.ts voicePayment): on the person's own key, straight to Deepgram with
// a short-lived token minted here; on Caveman credits, to Caveman Cloud's gateway with a one-time ticket, where Cloud
// opens Deepgram's socket on Caveman's key and relays it frame for frame, billing the minutes to the credits
// (Caveman Cloud the spec, code_voice.go). The wire is Deepgram's either way.
// Wire: developers.deepgram.com/reference/voice-agent/voice-agent (read 2026-10-19),
// developers.deepgram.com/reference/speech-to-text/listen-streaming (read 2026-10-20).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { creditsHeaders } from "../../cloudLink/creditsGateway.ts";
import { CREDITS_NOT_OFFERED, VoiceEngineError, type Heard, type VoiceAction, type VoiceCredential, type VoiceEngine, type VoicePatience, type VoiceSetup, type VoiceVoice } from "./engine.ts";

const AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";
const LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const API_URL = "https://api.deepgram.com";

/** Caveman Cloud's gateway routes for voice on credits (Caveman Cloud the spec): a ticket for one connection, and the socket it opens. */
export const CREDITS_VOICE_PATH = "/v1/code/voice";
export const CREDITS_SOCKET_PATH = "/v1/code/voice/socket";

/** Voice Agent API, Standard tier, pay as you go: $4.50 an hour of socket time (deepgram.com/pricing, 2026-10-19). */
export const PRICE_SOURCE = "deepgram.com/pricing: Voice Agent API Standard, pay as you go, $0.075/min of websocket time (2026-10-19)";
export const USD_PER_MINUTE = 0.075;

/** Nova-3 multilingual streaming, pay as you go. */
export const DICTATION_PRICE_SOURCE = "deepgram.com/pricing: Nova-3 Multilingual streaming, pay as you go, $0.0092/min, 2026-11-07";
export const DICTATION_USD_PER_MINUTE = 0.0092;

/** The gateway's voice socket: its origin on ws(s), as the gateway serves both. */
export const creditsSocketUrl = (gateway: string) => `${gateway.replace(/\/+$/, "").replace(/^http/, "ws")}${CREDITS_SOCKET_PATH}`;

/**
 * The streaming URL for dictation: Nova-3 hearing any of its languages and switching between them mid-sentence,
 * formatted as written text (punctuation, numbers), with words as they firm up. Spoken punctuation stays words ("add
 * a comma" means the code). A final segment lands after 300 ms of pause, so the box fills as the person talks.
 */
export const deepgramDictationUrl = (keyterms: ReadonlyArray<string>, base: string = LISTEN_URL) => {
  const url = new URL(base);
  const params: ReadonlyArray<readonly [string, string]> = [
    ["model", "nova-3"],
    ["language", "multi"],
    ["encoding", "linear16"],
    ["sample_rate", "16000"],
    ["channels", "1"],
    ["interim_results", "true"],
    ["smart_format", "true"],
    ["endpointing", "300"],
    // Deepgram keeps none of it to train on.
    ["mip_opt_out", "true"],
    // One parameter per term; Deepgram takes 500 tokens of them in all.
    ...keyterms.map((term) => ["keyterm", term] as const),
  ];
  for (const [name, value] of params) url.searchParams.append(name, value);
  return url.toString();
};

/** The managed model that talks, then its fallback (both Standard tier, so the price holds). Fast first: it hands the work off. */
const THINK = [
  { type: "open_ai", model: "gpt-4.1-mini", temperature: 0.6 },
  { type: "anthropic", model: "claude-haiku-4-5", temperature: 0.6 },
] as const;

/** Flux's featured voices (developers.deepgram.com/docs/flux-tts/voices); the first is the default. */
export const DEEPGRAM_VOICES: ReadonlyArray<VoiceVoice> = [
  { id: "flux-cliff-en", label: "Cliff", hint: "Deep, calm, a little rasp" },
  { id: "flux-kit-en", label: "Kit", hint: "British, friendly, quick" },
  { id: "flux-hannah-en", label: "Hannah", hint: "Clear and confident" },
  { id: "flux-miles-en", label: "Miles", hint: "Calm and steady" },
  { id: "flux-sienna-en", label: "Sienna", hint: "Warm and professional" },
  { id: "flux-colin-en", label: "Colin", hint: "British, warm, assured" },
  { id: "flux-brooke-en", label: "Brooke", hint: "Fast and bright" },
  { id: "flux-cole-en", label: "Cole", hint: "Young and easygoing" },
];

/**
 * What the voice may call. Both wait for the person's turn to be confirmed (`defer_until_eot`): a handoff makes a
 * note and a goodbye hangs up, so neither may fire on a guess that they had finished.
 */
export const FUNCTIONS = [
  {
    name: "hand_to_chief",
    description:
      "Hand what the person just asked to the Chief, who does the work: starting, steering or stopping chats, queueing, scheduling, remembering, and anything the board you were given does not answer. You pass nothing: the Chief hears their exact words.",
    parameters: { type: "object", properties: {}, required: [] },
    defer_until_eot: true,
  },
  {
    name: "end_call",
    description: "Hang up. Only after the person said goodbye (or that's all) and you said a short goodbye back.",
    parameters: { type: "object", properties: {}, required: [] },
    defer_until_eot: true,
  },
  // Not deferred: what is on screen should move as the voice moves, not after the person's next turn.
  {
    name: "show",
    description:
      "Put the work you're walking through on the person's screen in the app, on every device they have open: its pull request (what: work), its changed files (what: files; file: one path from the report, if you have one), or the chat itself (what: chat). Call it as you start a walkthrough and each time you move to another part, then say one short line about what they're looking at.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["work", "files", "chat"], description: "work: the pull request (or the changes, if there is none); files: the changed files; chat: the chat." },
        file: { type: "string", description: "With files: one file to show, by its path." },
      },
      required: ["what"],
    },
    defer_until_eot: false,
  },
] as const;

const think = (prompt: string) => THINK.map((provider) => ({ provider, prompt, functions: FUNCTIONS }));

/**
 * Flux's turn-taking by how patient the call is (developers.deepgram.com/docs/flux/configuration, read 2026-10-20).
 * `eot_threshold`: the confidence it needs to call a turn over (higher: fewer cut-offs, a little more wait; Deepgram's
 * default 0.7). `eot_timeout_ms`: the silence that ends a turn regardless (Deepgram: 7-10 s "for users with frequent
 * pauses", its default 5 s). Thinking starts early at `eager_eot_threshold`, so an answer is often ready when the
 * turn is confirmed. 2026-10-20: at 0.7 a thought that paused on "Yeah. I don't know." was cut and its rest became
 * a second note; normal now waits for more certainty and a longer pause.
 */
export const TURN_TAKING: Record<VoicePatience, { readonly eager_eot_threshold: number; readonly eot_threshold: number; readonly eot_timeout_ms: number }> = {
  quick: { eager_eot_threshold: 0.5, eot_threshold: 0.7, eot_timeout_ms: 4_000 },
  normal: { eager_eot_threshold: 0.5, eot_threshold: 0.8, eot_timeout_ms: 7_000 },
  patient: { eager_eot_threshold: 0.6, eot_threshold: 0.9, eot_timeout_ms: 10_000 },
};

/** The Settings message for one call (developers.deepgram.com/docs/configure-voice-agent). */
export const deepgramSettings = (setup: VoiceSetup) => ({
  type: "Settings",
  tags: ["caveman-chief"],
  // Deepgram keeps none of it to train on: the call's audio stays the person's.
  mip_opt_out: true,
  audio: {
    input: { encoding: "linear16", sample_rate: 16_000 },
    output: { encoding: "linear16", sample_rate: 24_000, container: "none" },
  },
  agent: {
    greeting: setup.greeting,
    listen: {
      provider: {
        type: "deepgram",
        version: "v2",
        model: "flux-general-en",
        ...TURN_TAKING[setup.patience],
        ...(setup.keyterms.length === 0 ? {} : { keyterms: [...setup.keyterms] }),
      },
    },
    think: think(setup.prompt),
    speak: { provider: { type: "deepgram", version: "v2", model: setup.voice } },
  },
});

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Warnings that mean a `say` was dropped because someone was speaking. */
const REFUSED = new Set(["INJECT_AGENT_MESSAGE_DURING_USER_SPEECH", "INJECT_AGENT_MESSAGE_DURING_AGENT_SPEECH"]);
/** Errors after which the session does not go on. */
const FATAL = new Set(["INTERNAL_SERVER_ERROR", "CLIENT_MESSAGE_TIMEOUT", "INVALID_SETTINGS", "FAILED_TO_START_LISTENING", "ASR_CONNECTION_CLOSED", "SERVER_GOING_AWAY", "MAXIMUM_SESSION_LENGTH_REACHED", "UNPARSABLE_CLIENT_MESSAGE"]);

export const decodeDeepgram = (message: unknown): ReadonlyArray<Heard> => {
  const m = record(message);
  switch (m.type) {
    case "SettingsApplied":
      return [{ type: "ready" }];
    case "ConversationText": {
      const content = text(m.content).trim();
      return content === "" ? [] : [{ type: "turn", role: m.role === "user" ? "person" : "voice", text: content }];
    }
    case "UserStartedSpeaking":
      return [{ type: "person_speaking" }];
    case "AgentStartedSpeaking":
      return [{ type: "voice_speaking" }];
    case "AgentAudioDone":
      return [{ type: "voice_done" }];
    case "FunctionCallRequest":
      return (Array.isArray(m.functions) ? m.functions : []).flatMap((raw): ReadonlyArray<Heard> => {
        const fn = record(raw);
        const id = text(fn.id);
        const name = text(fn.name);
        // A server-side call is Deepgram's to answer; we define none, so this is only ever ours.
        if (id === "" || fn.client_side === false) return [];
        if (name === "end_call") return [{ type: "goodbye", id, name }];
        if (name === "show") {
          const args = record(typeof fn.arguments === "string" ? (() => { try { return JSON.parse(fn.arguments as string) as unknown; } catch { return {}; } })() : fn.arguments);
          const what = text(args.what);
          const file = text(args.file);
          return [{ type: "show", id, name, what: what === "files" || what === "chat" ? what : "work", ...(file === "" ? {} : { file }) }];
        }
        return [{ type: "handoff", id, name }];
      });
    case "FunctionCallCancelled":
      return [{ type: "cancelled", ids: (Array.isArray(m.functions) ? m.functions : []).map((f) => text(record(f).id)).filter((id) => id !== "") }];
    case "InjectionRefused":
      return [{ type: "refused" }];
    case "Warning":
      return REFUSED.has(text(m.code)) ? [{ type: "refused" }] : [];
    case "Error":
      return [{ type: "error", message: text(m.description) || text(m.code) || "Deepgram failed", fatal: FATAL.has(text(m.code)) }];
    default:
      return [];
  }
};

export const encodeDeepgram = (action: VoiceAction): ReadonlyArray<unknown> => {
  switch (action.type) {
    case "answer":
      return [{ type: "FunctionCallResponse", id: action.id, name: action.name, content: action.text }];
    case "say":
      // After anything already queued to say, never over a turn in progress (refused then; the call says it later).
      return [{ type: "InjectAgentMessage", message: action.text, behavior: "queue" }];
    case "know":
      // UpdatePrompt adds to the prompt; it never replaces it.
      return [{ type: "UpdatePrompt", prompt: `\n\n${action.text}` }];
    case "renew":
      return [{ type: "UpdateThink", think: think(action.prompt) }];
  }
};

/**
 * Cloud refusing a ticket, in words a person can act on. Cloud writes its refusals for people (credits used up and
 * when they come back, a guardrailed project, a rate limit), so its own message is said otherwise.
 */
const creditsRefusal = (status: number, body: unknown) => {
  const error = record(record(body).error);
  const code = text(error.code);
  const said = text(error.message).replace(/\s+/g, " ").trim().slice(0, 200);
  // Not configured, or a gateway from before voice (its route not found): nothing Caveman sells here yet.
  if (code === "cave_code_voice_not_configured" || status === 404) return new VoiceEngineError(CREDITS_NOT_OFFERED, "not_offered");
  if (status === 401) return new VoiceEngineError("Caveman Cloud didn't take this computer's credits key. Sign in again in Settings.", "unavailable");
  return new VoiceEngineError(said || `Caveman Cloud answered ${status}.`, "unavailable");
};

const refusal = (status: number, body: unknown) => {
  const b = record(body);
  const said = text(b.err_msg) || text(b.message) || text(b.details);
  if (status === 401) return new VoiceEngineError("Deepgram refused the key. Check it in the Deepgram console under API Keys.", "refused");
  // Minting call tokens needs Member permission (developers.deepgram.com/guides/fundamentals/token-based-authentication).
  if (status === 403) return new VoiceEngineError("That key can't start calls: it needs Member permission or higher. Make one under API Keys > Advanced in the Deepgram console.", "refused");
  return new VoiceEngineError(`Deepgram answered ${status}${said ? `: ${said}` : ""}.`, "unavailable");
};

export const makeDeepgram = (options: { readonly fetch?: Fetch; readonly apiUrl?: string; readonly agentUrl?: string; readonly listenUrl?: string } = {}): VoiceEngine => {
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  /** A token for one connection: it only has to be valid while the socket opens. */
  const grant = (key: string, ttlSeconds: number) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchImpl(`${options.apiUrl ?? API_URL}/v1/auth/grant`, {
          method: "POST",
          headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl_seconds: ttlSeconds }),
          signal,
        });
        const body = await response.json().catch(() => ({}));
        if (response.status !== 200) throw refusal(response.status, body);
        const token = text(record(body).access_token);
        if (token === "") throw new VoiceEngineError("Deepgram answered without a token.", "unavailable");
        return token;
      },
      catch: (error) => (error instanceof VoiceEngineError ? error : new VoiceEngineError(`Couldn't reach Deepgram: ${error instanceof Error ? error.message : String(error)}`, "unavailable")),
    }).pipe(
      Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.fail(new VoiceEngineError("Deepgram did not answer in time.", "unavailable")) }),
    );
  /**
   * A one-time ticket for one connection on Caveman credits: Cloud holds its first minute and answers what a minute
   * costs. `body` is all Cloud reads from us (a dictation's keyterms; a call's settings go over the socket, checked there).
   */
  const ticket = (credits: { readonly key: string; readonly gateway: string; readonly session?: string }, body: { readonly kind: "agent" } | { readonly kind: "dictation"; readonly keyterms: ReadonlyArray<string> }) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchImpl(`${credits.gateway.replace(/\/+$/, "")}${CREDITS_VOICE_PATH}`, {
          method: "POST",
          headers: creditsHeaders(credits.key, credits.session),
          body: JSON.stringify(body),
          signal,
        });
        const answer = record(await response.json().catch(() => ({})));
        if (response.status !== 200) throw creditsRefusal(response.status, answer);
        const issued = text(answer.ticket);
        if (!issued.startsWith("cvt_")) throw new VoiceEngineError("Caveman Cloud answered without a ticket.", "unavailable");
        const usd = answer.usd_per_minute;
        return { ticket: issued, usdPerMinute: typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : undefined };
      },
      catch: (error) => (error instanceof VoiceEngineError ? error : new VoiceEngineError(`Couldn't reach Caveman Cloud: ${error instanceof Error ? error.message : String(error)}`, "unavailable")),
    }).pipe(
      // Cloud holds the first minute on the credits ledger before it answers, which may wait a few seconds for room.
      Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new VoiceEngineError("Caveman Cloud did not answer in time.", "unavailable")) }),
    );
  /**
   * The socket for one connection on what pays: Deepgram's own URL with a token from the person's key (it only has to
   * be valid while the socket opens), or the gateway's with a ticket, at the price Cloud bills (the list price if it
   * sent none). A browser authenticates a socket with the scheme and the credential as subprotocols, as Deepgram's
   * JS SDK does; the gateway takes the same.
   */
  const socket = (credential: VoiceCredential, kind: Parameters<typeof ticket>[1], deepgramUrl: string, listUsdPerMinute: number) =>
    credential.kind === "key"
      ? grant(credential.key, 60).pipe(Effect.map((token) => ({ url: deepgramUrl, protocols: ["bearer", token], usdPerMinute: listUsdPerMinute })))
      : ticket(credential, kind).pipe(Effect.map((t) => ({ url: creditsSocketUrl(credential.gateway), protocols: ["bearer", t.ticket], usdPerMinute: t.usdPerMinute ?? listUsdPerMinute })));
  return {
    id: "deepgram",
    label: "Deepgram",
    keyUrl: "https://console.deepgram.com/",
    // A temporary token is minted per call, which needs Member permission (developers.deepgram.com/reference/auth/tokens/grant).
    keyHelp: "A key with Member permission.",
    voices: DEEPGRAM_VOICES,
    // Its managed models take 25,000 characters of prompt (developers.deepgram.com/docs/voice-agent-update-prompt); room kept spare.
    promptLimit: 23_000,
    check: (key) => grant(key, 1).pipe(Effect.asVoid),
    connect: (credential, setup) =>
      socket(credential, { kind: "agent" }, options.agentUrl ?? AGENT_URL, USD_PER_MINUTE).pipe(
        Effect.map(({ url, protocols, usdPerMinute }) => ({
          connect: { transport: "websocket" as const, url, protocols, settings: deepgramSettings(setup), input_rate: 16_000, output_rate: 24_000 },
          usdPerMinute,
        })),
      ),
    decode: decodeDeepgram,
    encode: encodeDeepgram,
    dictation: {
      // A temporary token may open /v1/listen too. On credits Cloud builds the same query itself, from the keyterms sent.
      connect: (credential, keyterms) =>
        socket(credential, { kind: "dictation", keyterms }, deepgramDictationUrl(keyterms, options.listenUrl), DICTATION_USD_PER_MINUTE).pipe(
          Effect.map(({ url, protocols, usdPerMinute }) => ({ connect: { transport: "websocket" as const, url, protocols, input_rate: 16_000 }, usdPerMinute })),
        ),
    },
  };
};

/** The engine calls run on: Deepgram, unless something swaps it (a test's fake, another engine). */
export class VoiceEngineRef extends Context.Reference<VoiceEngine>("caveman/chief/VoiceEngine", { defaultValue: () => makeDeepgram() }) {}
