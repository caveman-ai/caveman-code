// The app's one audio session, for talking out loud. A Chief's call, voice chat and dictation each hold it while they
// run (counted by reason), and it lets go when the last one does. Holding it asks for the microphone (once a launch;
// denied, a toast offers Settings and the scripted conversation goes on without it), sets the session to play and
// record (speaker unless a headset or Bluetooth is on; other apps' audio paused while you talk), and keeps a recorder
// going with metering, at low quality to one scratch file, only so the microphone is live and its level can drive the
// bars (`micLevel`, about 12 times a second). Letting go stops the recorder, deletes the file and puts the session back
// the way the app has it otherwise, so music a call paused can carry on.
//
// A call or voice chat also keeps the app going with the phone locked or the app in the background: the session is
// set to record and play there (UIBackgroundModes `audio`, app.json's expo-audio plugin), and a recording that goes on
// is what keeps iOS running the app, its timers and the Live Activity's Mute and End (system/talk.ts) with it. A phone
// call stops the recorder; expo-audio starts it again when the call ends, and if it doesn't, a watchdog here does.
//
// `speak` says a line in the best English voice the phone has (premium, then enhanced), one line after another, and
// says when it's done; the level ducks while it speaks, so the Chief's voice in the speaker never reads as you talking.
// The words are still the prototype's scripted lines (docs/, "Voice and calls with
// the phone locked"); the session, the speech and the background are real. On the web, and in a build without the
// native modules, all of it is a quiet no-op: no level (the bars act it out as before) and no speech.
import type { AudioMode, AudioRecorder } from "expo-audio";
import { AppState, Linking, Platform } from "react-native";
import { makeMutable, type SharedValue, withTiming } from "react-native-reanimated";
import { notice } from "../shell/ui";
import { createStore, useSelector } from "../store/core";
import { bestVoice, forSpeech, levelOf, readingMs, smooth } from "./speaking";
import { endTalk, muteTalk, talkStore } from "./talk";

type ExpoAudio = typeof import("expo-audio");
type ExpoSpeech = typeof import("expo-speech");

/** Who holds the session: a Chief's call, voice chat, or dictation into a box. */
export type Reason = "call" | "voice" | "dictation";

export interface AudioState {
  /** Who holds it now, each once. */
  held: readonly Reason[];
  /** The microphone: not asked yet, given, refused, or no audio here at all (the web, a build without expo-audio). */
  mic: "unknown" | "granted" | "denied" | "none";
  /** The recorder is running, so `micLevel` is the microphone's real level. */
  live: boolean;
  /** Set to go on in the background (a call or voice chat holds it). */
  background: boolean;
  /** Your side is muted: the level reads 0. */
  muted: boolean;
  /** A line is being said. */
  speaking: boolean;
}

const NATIVE = Platform.OS === "ios" || Platform.OS === "android";
const START: AudioState = { held: [], mic: NATIVE ? "unknown" : "none", live: false, background: false, muted: false, speaking: false };

export const audioStore = createStore<AudioState, Partial<AudioState>>(START, (s, patch) => {
  for (const key of Object.keys(patch) as (keyof AudioState)[]) {
    const was = s[key];
    const now = patch[key];
    const changed = Array.isArray(was) && Array.isArray(now) ? was.length !== now.length || was.some((x, i) => x !== now[i]) : was !== now;
    if (changed) return { ...s, ...patch };
  }
  return s;
});
const patch = (next: Partial<AudioState>) => audioStore.dispatch(next);
export const useAudio = <T>(pick: (s: AudioState) => T) => useSelector(audioStore, pick);

/** The microphone's level, 0 to 1, on the UI thread for the bars; 0 whenever there is no real one. */
export const micLevel = makeMutable(0);

/** The microphone's level for the bars while a real one comes in; nothing on the web, without the mic, or with none. */
export function useMicLevel(): SharedValue<number> | undefined {
  const live = useAudio((s) => s.live);
  return live ? micLevel : undefined;
}

// ---------------------------------------------------------------- the native modules, when there are any

/** A native module, or null on the web or in a build without it (its import throws there). */
function load<T>(get: () => T): T | null {
  if (!NATIVE) return null;
  try {
    return get();
  } catch {
    return null;
  }
}
let audioModule: ExpoAudio | null | undefined;
let speechModule: ExpoSpeech | null | undefined;
const expoAudio = () => (audioModule === undefined ? (audioModule = load(() => require("expo-audio") as ExpoAudio)) : audioModule);
const expoSpeech = () => (speechModule === undefined ? (speechModule = load(() => require("expo-speech") as ExpoSpeech)) : speechModule);

/** Whether a line can be said aloud here: false on the web and without expo-speech, where callers show it instead. */
export const canSpeak = () => !!expoSpeech();

// ---------------------------------------------------------------- holding it

const holds = new Map<Reason, number>();
const heldNow = (): Reason[] => [...holds.keys()];
const wantsBackground = (held: readonly Reason[]) => held.includes("call") || held.includes("voice");

/** Holds the session for `reason` until the function it returns is called (once; again does nothing). */
export function holdAudio(reason: Reason): () => void {
  holds.set(reason, (holds.get(reason) ?? 0) + 1);
  changed();
  let let_go = false;
  return () => {
    if (let_go) return;
    let_go = true;
    const left = (holds.get(reason) ?? 1) - 1;
    if (left > 0) holds.set(reason, left);
    else holds.delete(reason);
    changed();
  };
}

/** Your side muted or not: the level reads 0 while muted. The recorder goes on, since it keeps the app running. */
export function setMicMuted(muted: boolean) {
  patch({ muted });
  if (muted) micLevel.value = withTiming(0, { duration: 120 });
}

let work: Promise<void> = Promise.resolve();
function changed() {
  const held = heldNow();
  patch({ held, background: wantsBackground(held) });
  if (!wantsBackground(held)) stopSpeaking();
  if (wantsBackground(held)) void pickVoice();
  // One change to the session at a time, each reading what's wanted when it runs.
  work = work.then(settle, settle).catch(() => {});
}

/** What the session is set to when nothing holds it: the app's ordinary playback, mixing with other apps. */
const RESTING: Partial<AudioMode> = { playsInSilentMode: true, interruptionMode: "mixWithOthers", allowsRecording: false, shouldPlayInBackground: false, allowsBackgroundRecording: false, shouldRouteThroughEarpiece: false };
let modeSet = "";
let engaged = false;

async function setMode(A: ExpoAudio, mode: Partial<AudioMode>) {
  const key = JSON.stringify(mode);
  if (key === modeSet) return;
  await A.setAudioModeAsync(mode);
  modeSet = key;
}

async function settle() {
  const A = expoAudio();
  if (!A) return;
  const held = heldNow();
  if (held.length) {
    const background = wantsBackground(held);
    engaged = true;
    const mic = await askForMic(A);
    if (!heldNow().length) return;
    await setMode(A, { playsInSilentMode: true, interruptionMode: "doNotMix", allowsRecording: mic, shouldPlayInBackground: background, allowsBackgroundRecording: background && mic, shouldRouteThroughEarpiece: false });
    if (mic && !recorder && heldNow().length) await startRecorder(A);
    return;
  }
  await stopRecorder();
  if (!engaged) return;
  engaged = false;
  await setMode(A, RESTING);
  // Letting go of the session tells the app that was playing before the call it can carry on; then it is ready again
  // for anything else the app plays.
  await A.setIsAudioActiveAsync(false).catch(() => {});
  await A.setIsAudioActiveAsync(true).catch(() => {});
}

// ---------------------------------------------------------------- the microphone

let asked = false;
let toldOff = false;

async function askForMic(A: ExpoAudio): Promise<boolean> {
  if (audioStore.get().mic === "granted") return true;
  try {
    let answer = await A.getRecordingPermissionsAsync();
    if (!answer.granted && answer.canAskAgain && !asked) {
      asked = true;
      answer = await A.requestRecordingPermissionsAsync();
    }
    patch({ mic: answer.granted ? "granted" : "denied" });
    if (!answer.granted) tellMicOff();
    return answer.granted;
  } catch {
    patch({ mic: "none" });
    return false;
  }
}

/** Once a launch: the microphone is off, the conversation goes on without hearing you, and Settings turns it on. */
function tellMicOff() {
  if (toldOff) return;
  toldOff = true;
  notice({
    id: `mic-off-${Date.now()}`,
    text: "Microphone off",
    detail: "Turn it on in Settings to be heard",
    tone: "info",
    icon: "micOff",
    ms: 6000,
    action: { label: "Settings", onPress: () => void Linking.openSettings().catch(() => {}) },
  });
}

/** Low quality to one scratch file, overwritten each time: it is there only to keep the microphone live and metered. */
const LISTENING = {
  extension: ".m4a",
  sampleRate: 22050,
  numberOfChannels: 1,
  bitRate: 24000,
  isMeteringEnabled: true,
  directory: "cache",
  fileName: "caveman-listening",
  ...(Platform.OS === "android" ? { outputFormat: "mpeg4", audioEncoder: "aac" } : { outputFormat: "aac ", audioQuality: 0 }),
};

let recorder: AudioRecorder | null = null;

async function startRecorder(A: ExpoAudio) {
  let made: AudioRecorder | null = null;
  try {
    // The constructor takes the options already flattened for the platform, as expo-audio's own hook hands them.
    made = new A.AudioModule.AudioRecorder(LISTENING as never);
    recorder = made;
    await made.prepareToRecordAsync();
    if (recorder !== made) return;
    made.record();
    shown = 0;
    patch({ live: true });
    meter();
  } catch (error) {
    if (__DEV__) console.warn("[audio] the microphone didn't start", error);
    if (recorder === made) recorder = null;
    patch({ live: false });
    if (made) await drop(made);
  }
}

async function stopRecorder() {
  stopMeter();
  const was = recorder;
  recorder = null;
  shown = 0;
  micLevel.value = withTiming(0, { duration: 120 });
  patch({ live: false });
  if (was) await drop(was);
}

async function drop(r: AudioRecorder) {
  let uri: string | null = null;
  try {
    uri = r.uri;
  } catch {}
  try {
    await r.stop();
  } catch {}
  try {
    r.release();
  } catch {}
  if (!uri) return;
  try {
    const { File } = require("expo-file-system") as typeof import("expo-file-system");
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {}
}

// ---------------------------------------------------------------- the level, and the watchdog

/** About 12 times a second with the app in front; once a second behind it, for the watchdog only. */
const METER_MS = 83;
const BEHIND_MS = 1000;
/** How much of your level shows while a line is being said: the speaker's own voice comes back in through the mic. */
const DUCK = 0.1;
/** How often the watchdog tries a stopped recorder again. */
const RETRY_MS = 2000;

let ticker: ReturnType<typeof setInterval> | null = null;
let shown = 0;
let lastTry = 0;
let inFront = AppState.currentState === "active";

function meter() {
  stopMeter();
  ticker = setInterval(tick, inFront ? METER_MS : BEHIND_MS);
}
function stopMeter() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function tick() {
  const r = recorder;
  if (!r) return;
  revive(r, false);
  if (!inFront) return;
  let db: number | undefined;
  try {
    db = r.getStatus().metering;
  } catch {}
  const s = audioStore.get();
  const heard = s.muted ? 0 : levelOf(db) * (s.speaking ? DUCK : 1);
  shown = smooth(shown, heard);
  micLevel.value = withTiming(shown, { duration: METER_MS + 10 });
}

/**
 * A recorder that stopped without being asked to (a phone call came in, Siri, the media daemon restarted) starts
 * again: expo-audio resumes it after an interruption that says to, and this catches the rest. Its own state can say
 * recording while the microphone isn't (a start tried during the phone call), so it reads the recorder itself, and
 * pauses before starting so the start is a real one. Behind the app only a call or voice chat may record.
 */
function revive(r: AudioRecorder, now: boolean) {
  let recording = true;
  try {
    recording = r.isRecording;
  } catch {}
  if (recording) return;
  if (!inFront && !audioStore.get().background) return;
  const t = Date.now();
  if (!now && t - lastTry < RETRY_MS) return;
  lastTry = t;
  try {
    if (r.getStatus().isRecording) r.pause();
    r.record();
  } catch {}
}

if (NATIVE) {
  AppState.addEventListener("change", (state) => {
    const front = state === "active";
    if (front === inFront) return;
    inFront = front;
    if (!recorder) return;
    meter();
    if (front) revive(recorder, true);
  });
}

// ---------------------------------------------------------------- speaking

/** The phone's default rate (AVSpeechUtteranceDefaultSpeechRate), which the better voices are tuned to. */
const RATE = 1;

interface Line {
  text: string;
  done: (spoken: boolean) => void;
}
const lines: Line[] = [];
let saying: Line | null = null;
let guard: ReturnType<typeof setTimeout> | null = null;
/** The voice to talk in: undefined until looked up, null for the platform's own en-US. */
let voiceId: string | null | undefined;
let lookingUp: Promise<void> | null = null;

const regionOf = () => {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return /^en-([A-Z]{2})\b/i.exec(locale)?.[1];
  } catch {
    return undefined;
  }
};

function pickVoice(): Promise<void> {
  const S = expoSpeech();
  if (!S || voiceId !== undefined) return Promise.resolve();
  lookingUp ??= Promise.race([
    S.getAvailableVoicesAsync().then((voices) => {
      voiceId = bestVoice(voices, regionOf())?.identifier ?? null;
    }),
    new Promise<void>((done) => setTimeout(done, 1200)),
  ])
    .catch(() => {})
    .then(() => {
      lookingUp = null;
      // Too slow to answer: the platform's voice this time, and the next line asks again.
    });
  return lookingUp;
}

/**
 * Says `text` aloud after whatever is being said, as plain words (speaking.ts `forSpeech`). Resolves true once it has
 * been said to the end, false when it couldn't be (the web, no voice) or was stopped (`stopSpeaking`, the call ended).
 */
export function speak(text: string): Promise<boolean> {
  const S = expoSpeech();
  const words = forSpeech(text);
  if (!S || !words) return Promise.resolve(false);
  return new Promise((done) => {
    lines.push({ text: words, done });
    void next(S);
  });
}

async function next(S: ExpoSpeech) {
  if (saying || !lines.length) return;
  const line = lines.shift()!;
  saying = line;
  patch({ speaking: true });
  await pickVoice();
  if (saying !== line) return;
  const finish = (spoken: boolean) => {
    if (saying !== line) return;
    saying = null;
    if (guard) clearTimeout(guard);
    guard = null;
    if (!lines.length) patch({ speaking: false });
    line.done(spoken);
    void next(S);
  };
  // A voice that never says it's done (an interruption mid-line) can't hold the conversation forever.
  guard = setTimeout(() => finish(true), readingMs(line.text) * 2.5 + 4000);
  try {
    S.speak(line.text, {
      ...(voiceId ? { voice: voiceId } : { language: "en-US" }),
      rate: RATE,
      pitch: 1,
      useApplicationAudioSession: true,
      onDone: () => finish(true),
      onStopped: () => finish(false),
      onError: () => finish(false),
    });
  } catch {
    finish(false);
  }
}

/** Stops what is being said and drops what waits to be said. */
export function stopSpeaking() {
  const waiting = lines.splice(0);
  const was = saying;
  saying = null;
  if (guard) clearTimeout(guard);
  guard = null;
  if (audioStore.get().speaking) patch({ speaking: false });
  for (const line of waiting) line.done(false);
  if (!was) return;
  was.done(false);
  void expoSpeech()?.stop().catch(() => {});
}

// In development the session sits beside the store's on `globalThis.__cc`: `__cc.audio.get()`, `__cc.talk.get()`, and
// the lock screen's two buttons as `__cc.audio.muteTalk()` and `__cc.audio.endTalk()`.
if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, audio: { get: audioStore.get, level: () => micLevel.value, muteTalk, endTalk }, talk: (g.__cc?.talk as unknown) ?? talkStore };
}
