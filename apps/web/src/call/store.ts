// A call with the Chief on this client: one store per runtime connection, so the call outlives the page it started on
// (the sidebar's pill keeps it; the Chief page shows the stage). It rings at once, asks for the microphone, starts
// the call on the runtime, connects the voice engine, and pipes every engine message to the runtime in order
// (chief.voice.signal) and every runtime message back. It also takes the Chief's ring back.
import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import type { ChiefProfile, NotificationParams, VoiceCall } from "@caveman-app/session-protocol";
import { useEffect, useSyncExternalStore } from "react";
import { requestId, useRuntimeClient } from "../state/runtime.tsx";
import { openEngine, type Cue, type EngineLink } from "./engine.ts";
import { MicBlocked, microphone, openMedia, type CallMedia } from "./media.ts";
import { CallSounds, type Ring } from "./sounds.ts";
import { SILENT, type WaveSource } from "./wave.ts";
import { stopDictation } from "../dictation/store.ts";
import { THIS_COMPUTER } from "../lib/platform.ts";

export type CallPhase = "idle" | "calling" | "live" | "ending";
export type Ringing = NotificationParams<"chief.voice.ringing">;

export interface CallState {
  readonly phase: CallPhase;
  readonly call: VoiceCall | null;
  readonly muted: boolean;
  /** Space held while muted: talking anyway. */
  readonly talking: boolean;
  /** Who is audible right now. */
  readonly speaking: "none" | "person" | "chief";
  /** The voice is working out what to say, or handing off to the Chief. */
  readonly thinking: boolean;
  /** The line on screen: what was said last, by whom. */
  readonly caption: { readonly who: "person" | "chief"; readonly text: string } | null;
  /** The last time a handoff went to the Chief (the stage says so for a moment). */
  readonly handedAt: number | null;
  /** The Chief picked up: the ring stopped and its voice began (the timer counts from here). */
  readonly answered: boolean;
  /** When it was answered, by this client's clock. */
  readonly liveAt: number | null;
  readonly error: { readonly text: string; readonly fix?: "mic" | "key" } | null;
  /** A call on another device: no call from here meanwhile. */
  readonly elsewhere: VoiceCall | null;
  /** The Chief ringing back. */
  readonly incoming: Ringing | null;
  /** Rings that arrived while muted, quietly (the muted pill counts them; nothing is lost, the board has them). */
  readonly missed: ReadonlyArray<Ringing>;
  /** Just ended: "Call ended · 2:14", for a moment. */
  readonly ended: { readonly reason: string; readonly ms: number } | null;
  /**
   * The Chief the call is with (ChiefProfile.id; absent: the home Chief), from its first ring until its "Call ended"
   * is gone: `call` is null until the start answers, and again once it is over.
   */
  readonly chiefId: string | undefined;
}

const IDLE: CallState = { phase: "idle", call: null, muted: false, talking: false, speaking: "none", thinking: false, caption: null, handedAt: null, answered: false, liveAt: null, error: null, elsewhere: null, incoming: null, missed: [], ended: null, chiefId: undefined };

/** Not live this long after the click: give up, so nothing is left running. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Unanswered, a ring back stops after this. */
const RING_BACK_MS = 30_000;
/** Engine messages the runtime never reads. */

interface Store {
  state: CallState;
  readonly listeners: Set<() => void>;
  refs: number;
  stop: (() => void) | null;
  ctx: AudioContext | null;
  sounds: CallSounds | null;
  media: CallMedia | null;
  link: EngineLink | null;
  ring: Ring | null;
  incomingRing: Ring | null;
  timers: Array<ReturnType<typeof setTimeout>>;
  seq: number;
  pending: Array<Record<string, unknown>>;
  wake: WakeLockSentinel | null;
  /** Bumped per call and when one is let go, so a late answer from an old one changes nothing. */
  generation: number;
}

const stores = new WeakMap<Client, Store>();
function storeFor(client: Client): Store {
  let s = stores.get(client);
  if (!s) stores.set(client, (s = { state: IDLE, listeners: new Set(), refs: 0, stop: null, ctx: null, sounds: null, media: null, link: null, ring: null, incomingRing: null, timers: [], seq: 0, pending: [], wake: null, generation: 0 }));
  return s;
}
function set(s: Store, patch: Partial<CallState>) {
  s.state = { ...s.state, ...patch };
  s.listeners.forEach((l) => l());
}

/** What this device calls itself on the other devices' screens ("On a call on iPhone"). */
export function deviceName(nav: { readonly userAgent: string } = navigator): string {
  if (typeof window !== "undefined" && window.cavemanDesktop) return THIS_COMPUTER;
  const ua = nav.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "a browser";
}

/**
 * Whether the call's stage takes this Chief's page, in the box's place: while the call is on and a moment after (its
 * ending), on the page of the Chief it is with (`chief` null: a runtime from before several Chiefs, whose one Chief has
 * every call).
 */
export function callStageOn(state: Pick<CallState, "phase" | "ended" | "chiefId">, chief: Pick<ChiefProfile, "id" | "home"> | null): boolean {
  if (state.phase === "idle" && state.ended === null) return false;
  return chief === null || (state.chiefId === undefined ? chief.home : state.chiefId === chief.id);
}

/** A refused start as the stage says it. */
export function startError(error: unknown): CallState["error"] {
  const message = error instanceof Error ? error.message : String(error);
  // The runtime names what would pay ("no_key: calls need a Caveman plan or credits, or a Deepgram key …"): the line stays right when that changes.
  if (/^no_key/.test(message)) return { text: `Calls need ${/need (an? .+? key)/.exec(message)?.[1] ?? "a key"}.`, fix: "key" };
  // Caveman Cloud doesn't offer calls on credits yet: its words, and the way to a key of their own.
  if (/^not_offered/.test(message)) return { text: message.replace(/^not_offered:\s*/, ""), fix: "key" };
  // Refused by whoever pays (a key revoked): the runtime's words say what to do.
  if (error instanceof SessionProtocolError && error.error.data?.reason === "key_refused") return { text: message, fix: "key" };
  if (/^busy/.test(message)) return { text: `You're ${message.replace(/^busy:\s*/, "")} already.` };
  if (/^cap/.test(message)) return { text: "Today's limit for the Chief is reached." };
  // The runtime says which: unreachable ("Couldn't reach Deepgram: …") or refused (Cloud's own words on credits).
  if (error instanceof SessionProtocolError && error.error.data?.reason === "engine_unavailable") return { text: message };
  return { text: `Couldn't call the Chief: ${message}` };
}

const endedLine = (reason: string) =>
  ({ quiet: "Hung up after a quiet spell", max_length: "Call ended after 30 minutes", cap: "Today's limit reached", connection_lost: "The call dropped", provider: "The voice dropped the call", runtime_restart: "The runtime restarted" })[reason] ?? "Call ended";
export { endedLine };

function audio(s: Store) {
  s.ctx ??= new AudioContext({ latencyHint: "interactive" });
  s.sounds ??= new CallSounds(s.ctx);
  s.sounds.unlock();
  return { ctx: s.ctx, sounds: s.sounds };
}

/** Everything a call holds, let go: nothing keeps sounding, listening or billing, and nothing still on its way picks it up again. */
function release(s: Store) {
  s.generation++;
  s.timers.forEach(clearTimeout);
  s.timers = [];
  s.ring?.stop();
  s.ring = null;
  s.link?.close();
  s.link = null;
  s.media?.close();
  s.media = null;
  s.pending = [];
  void s.wake?.release().catch(() => undefined);
  s.wake = null;
}

/** The call is over here: let the last words finish (a goodbye), hang up, and show the ending for a moment. */
async function hangUpLocally(client: Client, s: Store, reason: string, options: { readonly drain?: boolean; readonly silent?: boolean } = {}) {
  if (s.state.phase === "idle" || s.state.phase === "ending") return;
  const generation = s.generation;
  const ms = s.state.liveAt === null ? 0 : Date.now() - s.state.liveAt;
  const wasLive = s.state.phase === "live" && s.state.answered;
  set(s, { phase: "ending", thinking: false });
  if (options.drain && s.media) await s.media.drained(3_000);
  if (s.generation !== generation) return;
  release(s);
  if (wasLive && !options.silent) s.sounds?.hangUp();
  set(s, { ...IDLE, elsewhere: s.state.elsewhere, incoming: s.state.incoming, missed: s.state.missed, error: s.state.error, ended: wasLive ? { reason, ms } : null, chiefId: wasLive ? s.state.chiefId : undefined });
  s.timers.push(setTimeout(() => s.state.phase === "idle" && set(s, { ended: null, chiefId: undefined }), 2_600));
  void client;
}

/** Engine messages, gathered within one tick and sent to the runtime as one signal, in order. */
function pipe(client: Client, s: Store, call: VoiceCall, message: Record<string, unknown>) {
  s.pending.push(message);
  if (s.pending.length > 1) return;
  queueMicrotask(() => {
    const events = s.pending.splice(0);
    if (events.length === 0 || s.state.call?.id !== call.id) return;
    const seq = s.seq++;
    client.call("chief.voice.signal", { request_id: `${call.id}:${seq}`, call_id: call.id, seq, events }).then(
      (r) => {
        if (s.state.call?.id === call.id) s.link?.send(r.send);
      },
      (error: unknown) => {
        // The runtime has no such call any more (it ended it, or restarted): hang up here too.
        if (error instanceof SessionProtocolError && error.error.data?.reason === "not_found") void hangUpLocally(client, s, "connection_lost");
      },
    );
  });
}

/** The engine's cues as the stage shows them: who speaks, what was said, a handoff. */
function onCue(s: Store, cue: Cue) {
  switch (cue.type) {
    case "live":
      if (s.state.phase === "calling") {
        set(s, { phase: "live" });
        // No greeting within a beat of going live: pick up anyway, with a quiet tap.
        s.timers.push(
          setTimeout(() => {
            if (!s.state.answered && s.state.phase === "live") {
              s.ring?.stop();
              s.ring = null;
              s.sounds?.pickUp();
              set(s, { answered: true, liveAt: Date.now() });
            }
          }, 2_500),
        );
      }
      break;
    case "person_speaking":
      set(s, { speaking: "person", thinking: false });
      break;
    case "turn":
      if (cue.role === "person") set(s, { caption: { who: "person", text: cue.text }, speaking: s.state.speaking === "person" ? "none" : s.state.speaking, thinking: true });
      else set(s, { caption: { who: "chief", text: cue.text } });
      break;
    case "thinking":
      set(s, { thinking: true });
      break;
    case "voice_speaking":
    case "error":
      set(s, { thinking: false });
      break;
    case "handoff":
      set(s, { handedAt: Date.now(), thinking: true });
      break;
  }
}

/** `chief_id`: which Chief to call (absent: the home Chief); `answer`: the ring back being answered, which calls the Chief that rang. */
export async function startCall(client: Client, options: { readonly answer?: Ringing; readonly chief_id?: string } = {}): Promise<void> {
  const s = storeFor(client);
  if (s.state.phase !== "idle") return;
  // One microphone: a call takes it from talking to type.
  void stopDictation();
  const generation = ++s.generation;
  const { ctx, sounds } = audio(s);
  stopIncoming(s);
  set(s, { ...IDLE, elsewhere: s.state.elsewhere, phase: "calling", chiefId: options.chief_id ?? options.answer?.chief_id });
  s.ring = sounds.ring();
  const current = () => s.generation === generation;
  const starting = client.call("chief.voice.start", { request_id: requestId(), device: deviceName(), ...(options.answer ? { answer: options.answer.item_id } : {}), ...(options.chief_id ? { chief_id: options.chief_id } : {}) });
  // Until the state holds the call, nothing else can end it: a start left behind (hung up while it rang, the microphone
  // refused first) is ended here, whenever it answers.
  const endStarted = (reason?: "provider") =>
    void starting.then((r) => client.call("chief.voice.end", { request_id: requestId(), call_id: r.call.id, ...(reason ? { reason } : {}) })).catch(() => undefined);
  // Until the call's audio owns it, the microphone is the start's to let go, even granted after the start gave up.
  const asking = microphone();
  const letGoMicrophone = () => void asking.then((stream) => stream.getTracks().forEach((t) => t.stop())).catch(() => undefined);
  let held = false;
  try {
    const [stream, started] = await Promise.all([asking, starting]);
    if (!current()) {
      stream.getTracks().forEach((t) => t.stop());
      endStarted();
      return;
    }
    held = true;
    // The runtime says the call is connecting before it answers the start, so that update can come first and be taken
    // for a call on another device; it is this one.
    set(s, { call: started.call, chiefId: started.call.chief_id, ...(s.state.elsewhere?.id === started.call.id ? { elsewhere: null } : {}) });
    const media = await openMedia(ctx, stream, { input: started.connect.input_rate, output: started.connect.output_rate });
    if (!current()) {
      media.close();
      return;
    }
    s.media = media;
    // The voice waits for one full ring, then the ring stops as it starts speaking.
    media.hold(true);
    void s.ring?.first.then(() => current() && media.hold(false));
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    media.onPlaying = (playing) => {
      clearTimeout(quietTimer);
      if (playing) {
        s.ring?.stop();
        s.ring = null;
        set(s, { speaking: "chief", thinking: false, ...(s.state.answered ? {} : { answered: true, liveAt: Date.now() }) });
      } else quietTimer = setTimeout(() => s.state.speaking === "chief" && set(s, { speaking: "none" }), 250);
    };
    const callNow = started.call;
    s.seq = 0;
    s.link = openEngine(started.connect, media, {
      message: (m) => current() && pipe(client, s, callNow, m),
      cue: (c) => current() && onCue(s, c),
      closed: (reason, said) => {
        if (!current() || s.state.phase === "ending" || s.state.phase === "idle") return;
        set(s, { error: said ? { text: reason } : s.state.phase === "calling" ? { text: `Couldn't reach the Chief's voice (${reason}).` } : null });
        void client.call("chief.voice.end", { request_id: requestId(), call_id: callNow.id, reason: "connection_lost" }).catch(() => undefined);
        void hangUpLocally(client, s, "connection_lost");
      },
    });
    s.timers.push(
      setTimeout(() => {
        if (!current() || s.state.phase !== "calling") return;
        set(s, { error: { text: "Couldn't reach the Chief. Try again in a moment." } });
        void client.call("chief.voice.end", { request_id: requestId(), call_id: callNow.id, reason: "provider" }).catch(() => undefined);
        void hangUpLocally(client, s, "provider", { silent: true });
      }, CONNECT_TIMEOUT_MS),
    );
    // A phone on a walk: keep its screen from locking mid-call, which would stop the microphone.
    const wake = (await navigator.wakeLock?.request("screen").catch(() => null)) ?? null;
    if (current()) s.wake = wake;
    else void wake?.release().catch(() => undefined);
  } catch (error) {
    letGoMicrophone();
    if (!current()) {
      // Hung up meanwhile: a call the state held was ended by the hang up.
      if (!held) endStarted();
      return;
    }
    endStarted("provider");
    release(s);
    set(s, {
      ...IDLE,
      elsewhere: s.state.elsewhere,
      error: error instanceof MicBlocked ? { text: "Caveman Code can't hear you: the microphone is off for it.", fix: "mic" } : startError(error),
    });
  }
}

export function endCall(client: Client): void {
  const s = storeFor(client);
  const call = s.state.call;
  if (call) void client.call("chief.voice.end", { request_id: requestId(), call_id: call.id }).catch(() => undefined);
  void hangUpLocally(client, s, "person");
}

export function setMuted(client: Client, muted: boolean): void {
  const s = storeFor(client);
  const call = s.state.call;
  if (!call || s.state.phase !== "live" || s.state.muted === muted) return;
  set(s, { muted, talking: false });
  s.link?.setMuted(muted);
  s.sounds?.tick(!muted);
  void client.call("chief.voice.update", { request_id: requestId(), call_id: call.id, muted }).catch(() => undefined);
}

/** Space held while muted: the mic is open until it is let go. */
export function holdToTalk(client: Client, held: boolean): void {
  const s = storeFor(client);
  if (!s.state.muted || s.state.phase !== "live" || s.state.talking === held) return;
  s.link?.setMuted(!held);
  set(s, { talking: held });
}

export function clearError(client: Client): void {
  set(storeFor(client), { error: null });
}

function stopIncoming(s: Store) {
  s.incomingRing?.stop();
  s.incomingRing = null;
  if (s.state.incoming) set(s, { incoming: null });
}
export function declineIncoming(client: Client): void {
  stopIncoming(storeFor(client));
}
/** Unmuted, or looked at: the quiet rings are no longer counted. */
export function clearMissed(client: Client): void {
  const s = storeFor(client);
  if (s.state.missed.length > 0) set(s, { missed: [] });
}
export function answerIncoming(client: Client): void {
  const s = storeFor(client);
  const incoming = s.state.incoming;
  stopIncoming(s);
  if (incoming) void startCall(client, { answer: incoming });
}

function ringBack(client: Client, s: Store, ringing: Ringing) {
  // Muted: no ring, no card; the pill counts it and the board has it.
  if (ringing.muted) return set(s, { missed: [...s.state.missed.filter((m) => m.item_id !== ringing.item_id), ringing] });
  if (s.state.phase !== "idle" || s.state.elsewhere) return;
  s.incomingRing?.stop();
  set(s, { incoming: ringing });
  // A context that was never unlocked by a gesture stays silent; the card still shows.
  if (s.ctx?.state === "running" && s.sounds) s.incomingRing = s.sounds.ring({ back: true });
  if (document.visibilityState === "hidden" && typeof Notification !== "undefined" && Notification.permission === "granted") {
    const n = new Notification("The Chief is calling", { body: ringing.line, tag: `chief-ring-${ringing.item_id}`, silent: false });
    n.onclick = () => {
      window.cavemanDesktop?.showWindow?.();
      window.focus();
      answerIncoming(client);
      n.close();
    };
  }
  s.timers.push(setTimeout(() => s.state.incoming?.item_id === ringing.item_id && stopIncoming(s), RING_BACK_MS));
}

function retain(client: Client, s: Store): () => void {
  if (s.refs++ === 0) {
    const offs = [
      client.on("chief.voice.send", (m) => {
        if (s.state.call?.id === m.call_id) s.link?.send(m.messages);
      }),
      client.on("chief.voice.updated", (call) => {
        if (s.state.call?.id === call.id) {
          if (call.state === "ended") void hangUpLocally(client, s, call.end_reason ?? "person", { drain: call.end_reason === "goodbye" || call.end_reason === "quiet" || call.end_reason === "max_length" || call.end_reason === "cap" });
          else set(s, { call });
          return;
        }
        set(s, { elsewhere: call.state === "ended" ? null : call });
      }),
      client.on("chief.voice.ringing", (r) => ringBack(client, s, r)),
    ];
    s.stop = () => offs.forEach((off) => off());
  }
  return () => {
    if (--s.refs > 0) return;
    s.stop?.();
    s.stop = null;
  };
}

/** The call on this client, and the Chief ringing back. */
export function useCall(): CallState {
  const { client } = useRuntimeClient();
  const s = client ? storeFor(client) : null;
  useEffect(() => (client && s ? retain(client, s) : undefined), [client, s]);
  return useSyncExternalStore(
    (l) => {
      if (!s) return () => undefined;
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    () => s?.state ?? IDLE,
    () => IDLE,
  );
}

/** What a call sounds like, for its line to draw, read once a frame: the person, the voice, and the call's own sounds (the ring, the hang-up). */
export interface CallSignal {
  readonly mic: WaveSource;
  readonly voice: WaveSource;
  readonly sounds: WaveSource;
}

export function callSignal(client: Client | null): CallSignal {
  const s = client ? storeFor(client) : null;
  // The call's audio comes and goes under the stage: each source reads whatever is open now, and silence otherwise.
  const from = (pick: (store: Store) => WaveSource | undefined): WaveSource => ({
    level: () => (s ? (pick(s) ?? SILENT) : SILENT).level(),
    bands: (into) => (s ? (pick(s) ?? SILENT) : SILENT).bands(into),
  });
  return {
    mic: from((store) => store.media?.mic),
    voice: from((store) => store.media?.voice),
    sounds: from((store) => store.sounds?.heard),
  };
}
