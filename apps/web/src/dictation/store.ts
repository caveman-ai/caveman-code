// Dictation: talk into a box and the words land in it (docs/chief.md "Dictation"). One at a time in the app, since
// there is one microphone: the box that holds it gets the settled words typed in (its `onFinal`) and shows the words
// still being heard in grey. The runtime mints the connection (dictation.start) and records the minutes
// (dictation.end); the audio and the words go between this client and the voice engine only.
import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import { useSyncExternalStore } from "react";
import { requestId } from "../state/runtime.tsx";
import { openDictation, type DictationLink, type Words } from "../call/engine.ts";
import { MicBlocked, microphone, openCapture, type Capture } from "../call/media.ts";
import { SILENT, type WaveSource } from "../call/wave.ts";

export type DictationPhase = "idle" | "starting" | "live" | "finishing";

export interface DictationError {
  readonly text: string;
  /** The one thing that fixes it: a key in Settings, or the microphone allowed. */
  readonly fix?: "mic" | "key";
}

export interface DictationState {
  readonly phase: DictationPhase;
  /** The box that holds it (its draft key); null when idle. */
  readonly owner: string | null;
  /** Words being heard, not settled yet: shown in grey, never in the draft. */
  readonly heard: string;
  /** Why the last one could not start or stopped, for the box that asked. */
  readonly error: (DictationError & { readonly owner: string }) | null;
}

const IDLE: DictationState = { phase: "idle", owner: null, heard: "", error: null };

/** A dictation stops itself after this long. */
export const MAX_MS = 10 * 60_000;
/** ...and after this long with no words: a mic left on by mistake stops listening (and billing). */
export const QUIET_MS = 90_000;
/** How long the last words may take to come back after the mic stops. */
const FLUSH_MS = 2_000;

let state: DictationState = IDLE;
const listeners = new Set<() => void>();
function set(patch: Partial<DictationState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** What is open now. Bumped per dictation, so a late answer from an old one changes nothing. */
const s: {
  generation: number;
  ctx: AudioContext | null;
  capture: Capture | null;
  link: DictationLink | null;
  client: Client | null;
  id: string | null;
  onFinal: ((text: string) => void) | null;
  timers: Array<ReturnType<typeof setTimeout>>;
  quiet: ReturnType<typeof setTimeout> | null;
  stopping: Promise<void> | null;
} = { generation: 0, ctx: null, capture: null, link: null, client: null, id: null, onFinal: null, timers: [], quiet: null, stopping: null };

/** A refused start as the box says it. */
export function dictationError(error: unknown): DictationError {
  if (error instanceof MicBlocked) return { text: "Caveman Code can't hear you: the microphone is off for it.", fix: "mic" };
  const message = error instanceof Error ? error.message : String(error);
  // The runtime names what would pay ("no_key: dictation needs a Caveman plan or credits, or a Deepgram key …"): the line stays right when that changes.
  // Caveman Cloud doesn't offer dictation on credits yet: its words, and the way to a key of their own.
  if (/^not_offered/.test(message)) return { text: message.replace(/^not_offered:\s*/, ""), fix: "key" };
  if (/^no_key/.test(message)) return { text: `Talking to type needs ${/needs (an? .+? key)/.exec(message)?.[1] ?? "a key"}, as calls do.`, fix: "key" };
  // Refused by whoever pays (a key revoked): the runtime's words say what to do.
  if (error instanceof SessionProtocolError && error.error.data?.reason === "key_refused") return { text: message, fix: "key" };
  // The runtime says which: unreachable ("Couldn't reach Deepgram: …") or refused (Cloud's own words on credits).
  if (error instanceof SessionProtocolError && error.error.data?.reason === "engine_unavailable") return { text: message };
  return { text: `Couldn't start listening: ${message}` };
}

/** Lets go of everything a dictation holds and tells the runtime how much it streamed. */
function release() {
  s.timers.forEach(clearTimeout);
  s.timers = [];
  if (s.quiet) clearTimeout(s.quiet);
  s.quiet = null;
  const sent = s.link?.sentMs ?? 0;
  s.link?.close();
  s.link = null;
  s.capture?.close();
  s.capture = null;
  if (s.client && s.id) void s.client.call("dictation.end", { request_id: requestId(), dictation_id: s.id, audio_ms: sent }).catch(() => undefined);
  s.client = null;
  s.id = null;
  s.onFinal = null;
  void s.ctx?.suspend().catch(() => undefined);
}

function listenQuiet(generation: number) {
  if (s.quiet) clearTimeout(s.quiet);
  s.quiet = setTimeout(() => generation === s.generation && void stopDictation(), QUIET_MS);
}

function heard(generation: number, words: Words) {
  if (generation !== s.generation) return;
  if (words.text !== "") listenQuiet(generation);
  if (!words.final) return set({ heard: words.text });
  if (words.text !== "") s.onFinal?.(words.text);
  set({ heard: "" });
}

/**
 * Starts listening for the box `owner`: the settled words go to `onFinal`, in order. Another box dictating stops
 * first (its last words still land there). `workspaceId`: the chat whose box it is, for its spend.
 */
export async function startDictation(client: Client, options: { readonly owner: string; readonly workspaceId?: string; readonly onFinal: (text: string) => void }): Promise<void> {
  if (state.phase !== "idle") await stopDictation();
  const generation = ++s.generation;
  set({ phase: "starting", owner: options.owner, heard: "", error: null });
  s.ctx ??= new AudioContext({ latencyHint: "interactive" });
  const ctx = s.ctx;
  // Resumed inside the click, while the page may still start audio.
  void ctx.resume().catch(() => undefined);
  const [mic, started] = await Promise.allSettled([
    microphone(),
    client.call("dictation.start", { request_id: requestId(), ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}) }),
  ]);
  const fail = (error: unknown) => {
    if (mic.status === "fulfilled") for (const track of mic.value.getTracks()) track.stop();
    if (generation !== s.generation) return;
    s.generation++;
    release();
    set({ phase: "idle", owner: null, heard: "", error: { ...dictationError(error), owner: options.owner } });
  };
  if (mic.status === "rejected") return fail(mic.reason);
  if (started.status === "rejected") return fail(started.reason);
  if (generation !== s.generation) return fail(null);
  s.client = client;
  s.id = started.value.dictation_id;
  s.onFinal = options.onFinal;
  let capture: Capture;
  try {
    capture = await openCapture(ctx, mic.value, started.value.connect.input_rate);
  } catch (error) {
    return fail(error);
  }
  // Stopped while the mic opened: it closes again at once.
  if (generation !== s.generation) return capture.close();
  s.capture = capture;
  s.link = openDictation(started.value.connect, capture, {
    words: (words) => heard(generation, words),
    closed: (reason) => {
      // The engine hung up on its own: what was settled stays in the box.
      if (reason === null || generation !== s.generation || state.phase === "finishing") return;
      s.generation++;
      release();
      set({ phase: "idle", owner: null, heard: "", error: { text: `Stopped listening: ${reason}.`, owner: options.owner } });
    },
  });
  s.timers.push(setTimeout(() => generation === s.generation && void stopDictation(), MAX_MS));
  listenQuiet(generation);
  set({ phase: "live" });
}

/** Stops listening. The words still being heard settle and land first; resolves once they have. */
export function stopDictation(): Promise<void> {
  if (s.stopping) return s.stopping;
  if (state.phase === "idle") return Promise.resolve();
  if (state.phase === "starting") {
    // Not listening yet: nothing heard to wait for.
    s.generation++;
    release();
    set(IDLE);
    return Promise.resolve();
  }
  set({ phase: "finishing" });
  const link = s.link;
  s.stopping = (link ? link.finish(FLUSH_MS) : Promise.resolve()).then(() => {
    s.generation++;
    release();
    s.stopping = null;
    set({ phase: "idle", owner: null, heard: "" });
  });
  return s.stopping;
}

/** Stops it if the box `owner` holds it (the box is going away). */
export const stopDictationFor = (owner: string): Promise<void> => (state.owner === owner ? stopDictation() : Promise.resolve());

/** What goes between a box's text and the words dictated after it: a space, unless it is empty or ends in one. */
export const spaceBefore = (text: string): string => (text === "" || /\s$/.test(text) ? "" : " ");

export function clearDictationError(): void {
  if (state.error) set({ error: null });
}

/** The dictation now, whichever box holds it. */
export const dictationState = (): DictationState => state;

/** What the person sounds like now, for the mic's wave (read once a frame, outside React); silence while nothing listens. */
export const micSource: WaveSource = {
  level: () => (s.capture ?? SILENT).level(),
  bands: (into) => (s.capture ?? SILENT).bands(into),
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The dictation as the box `owner` sees it: another box's shows as idle here, its error too. */
export function useDictation(owner: string): DictationState {
  const mine = useSyncExternalStore(subscribe, () => (state.owner === owner || state.error?.owner === owner ? state : IDLE));
  return mine;
}
