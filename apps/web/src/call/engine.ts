// How this client talks to a call's voice engine (the runtime's chief/voice/engine.ts decides everything else).
// Deepgram over a websocket: open the socket with the short-lived token the runtime minted (on Caveman credits, Cloud's
// one-time ticket for its relay, which speaks the same wire), send the settings after
// the engine's first message, stream the microphone once it took them, play what comes back, hand the call each
// JSON message the runtime needs (it pipes them there) and tell the stage what is happening in engine-free cues.
// Dictation (openDictation) is the same engine's speech to text: the mic out, the words back, nothing to the runtime.
// This file is the only one in the client that knows an engine's wire; another engine is another `open` here.
import type { DictationConnect, VoiceConnect } from "@caveman-app/session-protocol";
import type { Capture, CallMedia } from "./media.ts";

export interface EngineLink {
  /** Messages the runtime wrote for the engine, sent as they are. */
  send(messages: ReadonlyArray<unknown>): void;
  setMuted(muted: boolean): void;
  close(): void;
}

/** What the stage shows from the engine, the same for every engine. */
export type Cue =
  /** It took the call's settings: the line is open. */
  | { readonly type: "live" }
  | { readonly type: "person_speaking" }
  /** A finished turn as transcribed. */
  | { readonly type: "turn"; readonly role: "person" | "voice"; readonly text: string }
  | { readonly type: "thinking" }
  | { readonly type: "voice_speaking" }
  /** The voice handed what the person asked to the Chief. */
  | { readonly type: "handoff" }
  | { readonly type: "error" };

/** Deepgram's messages the runtime never reads (Call.ts decodes the rest). */
const NOT_PIPED = new Set(["Welcome", "History", "LatencyReport", "AgentThinking", "PromptUpdated", "ThinkUpdated", "SpeakUpdated"]);

/** A Deepgram message as the stage's cue, if it is one. */
export function deepgramCue(message: Record<string, unknown>): Cue | null {
  switch (message.type) {
    case "SettingsApplied":
      return { type: "live" };
    case "UserStartedSpeaking":
      return { type: "person_speaking" };
    case "ConversationText": {
      const text = String(message.content ?? "").trim();
      return text === "" ? null : { type: "turn", role: message.role === "user" ? "person" : "voice", text };
    }
    case "AgentThinking":
      return { type: "thinking" };
    case "AgentStartedSpeaking":
      return { type: "voice_speaking" };
    case "FunctionCallRequest": {
      const functions = Array.isArray(message.functions) ? (message.functions as Array<{ name?: string }>) : [];
      return functions.some((f) => f.name === "hand_to_chief") ? { type: "handoff" } : null;
    }
    case "Error":
      return { type: "error" };
    default:
      return null;
  }
}

export interface EngineEvents {
  /** The engine's messages the runtime needs, in order. */
  message(message: Record<string, unknown>): void;
  /** What the stage shows. */
  cue(cue: Cue): void;
  /** The engine is gone: closed by it, or the network. `said`: the far end closed with words for the person (Cloud's relay: "Your Caveman credits ran out.", or a restart's "Start the call again."). */
  closed(reason: string, said: boolean): void;
}

export function openEngine(connect: VoiceConnect, media: CallMedia, on: EngineEvents): EngineLink {
  const ws = new WebSocket(connect.url, [...connect.protocols]);
  ws.binaryType = "arraybuffer";
  let streaming = false;
  let muted = false;
  let closed = false;
  // A muted mic still sends: silence, so the engine's clock and its sense of the room keep going.
  const silence = new ArrayBuffer(Math.round(connect.input_rate * 0.02) * 2);
  media.onFrame = (pcm) => {
    if (streaming && ws.readyState === WebSocket.OPEN) ws.send(muted ? silence : pcm);
  };
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") return media.play(e.data);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      return;
    }
    // The few things the call can't wait a round trip to the runtime for.
    if (message.type === "Welcome") ws.send(JSON.stringify(connect.settings));
    else if (message.type === "SettingsApplied") streaming = true;
    else if (message.type === "UserStartedSpeaking") media.flush();
    const cue = deepgramCue(message);
    if (cue) on.cue(cue);
    if (!NOT_PIPED.has(String(message.type))) on.message(message);
  };
  const gone = (reason: string, said = false) => {
    if (closed) return;
    closed = true;
    streaming = false;
    on.closed(reason, said);
  };
  // 4000-4999 are an application's own close codes, and 1012 a server restarting (Cloud's relay draining for a deploy):
  // with a reason, it is meant to be read.
  ws.onclose = (e) => gone(e.reason || (e.code === 1000 ? "closed" : `closed (${e.code})`), ((e.code >= 4000 && e.code < 5000) || e.code === 1012) && e.reason !== "");
  ws.onerror = () => gone("couldn't reach the voice");
  return {
    send: (messages) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const m of messages) ws.send(JSON.stringify(m));
    },
    setMuted: (m) => void (muted = m),
    close: () => {
      closed = true;
      streaming = false;
      media.onFrame = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "hung up");
    },
  };
}

/** What dictation hears: the words of the stretch being said, `final` once settled (they never change after). */
export interface Words {
  readonly text: string;
  readonly final: boolean;
}

/** A Deepgram speech-to-text message as words, if it carries any (an empty final settles nothing new). */
export function deepgramWords(message: Record<string, unknown>): Words | null {
  if (message.type !== "Results") return null;
  const channel = message.channel as { alternatives?: ReadonlyArray<{ transcript?: unknown }> } | undefined;
  const transcript = channel?.alternatives?.[0]?.transcript;
  return { text: typeof transcript === "string" ? transcript.trim() : "", final: message.is_final === true };
}

export interface DictationLink {
  /** Stop listening: Deepgram sends what it still holds, then closes. Resolves then, or after `maxMs`. */
  finish(maxMs: number): Promise<void>;
  close(): void;
  /** The mic sent so far, in ms (20 ms frames): what the engine bills. */
  readonly sentMs: number;
}

/** Frames held while the socket opens (5 s), so the first words said after the click are not lost. */
const OPENING_FRAMES = 250;

export function openDictation(connect: DictationConnect, capture: Capture, on: { words(words: Words): void; closed(reason: string | null): void }): DictationLink {
  const ws = new WebSocket(connect.url, [...connect.protocols]);
  const frameMs = 20;
  let frames = 0;
  let finishing = false;
  let done = false;
  const waiting: Array<() => void> = [];
  const opening: ArrayBuffer[] = [];
  const send = (pcm: ArrayBuffer) => {
    ws.send(pcm);
    frames++;
  };
  // The settings ride in the URL: audio goes from the first frame.
  capture.onFrame = (pcm) => {
    if (finishing) return;
    if (ws.readyState === WebSocket.OPEN) send(pcm);
    else if (ws.readyState === WebSocket.CONNECTING && opening.length < OPENING_FRAMES) opening.push(pcm);
  };
  // CloseStream: Deepgram finishes what it has, sends the last words, then closes.
  const closeStream = () => ws.send(JSON.stringify({ type: "CloseStream" }));
  ws.onopen = () => {
    for (const pcm of opening.splice(0)) send(pcm);
    if (finishing) closeStream();
  };
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const words = deepgramWords(message);
    if (words) on.words(words);
  };
  const gone = (reason: string | null) => {
    if (done) return;
    done = true;
    capture.onFrame = null;
    waiting.splice(0).forEach((resolve) => resolve());
    on.closed(reason);
  };
  ws.onclose = (e) => gone(finishing || e.code === 1000 ? null : e.reason || `closed (${e.code})`);
  ws.onerror = () => gone(finishing ? null : "couldn't reach the voice engine");
  return {
    finish: (maxMs) => {
      if (done) return Promise.resolve();
      finishing = true;
      capture.onFrame = null;
      if (ws.readyState === WebSocket.OPEN) closeStream();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ws.close(1000, "done");
          gone(null);
        }, maxMs);
        waiting.push(() => (clearTimeout(timer), resolve()));
      });
    },
    close: () => {
      finishing = true;
      capture.onFrame = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "done");
      gone(null);
    },
    get sentMs() {
      return frames * frameMs;
    },
  };
}
