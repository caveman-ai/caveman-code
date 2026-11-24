// The one conversation out loud the app is having, if any: a Chief's call, or voice chat in a box. Whoever runs it
// (screens/Chief.tsx for a call, shell/composer/voice.ts for voice chat) says it started, how it stands, and how to
// mute and end it; everything outside the screen reads it here: the Live Activity and Dynamic Island show it with
// Mute and End, and the audio session (system/audio.ts) keeps the microphone and the speaker going while it is on,
// with the phone locked or the app in the background.
import { createStore } from "../store/core";

export interface Talk {
  kind: "call" | "voice";
  /** Who you're talking to, as the lock screen says it: "Chief", "Oona", "Voice chat". */
  who: string;
  /** The Chief on a call: its sprite on the lock screen, and where a tap goes back to. */
  chief?: string;
  /** The chat voice chat is in, when it is in one: where a tap goes back to. */
  chat?: string;
  /** When it started, for the clock (ms since the epoch). */
  since: number;
  muted: boolean;
  /** What's happening, in a word or two: "Calling…", "Listening", "Speaking". */
  state: string;
}

interface Controls {
  mute: () => void;
  end: () => void;
}

const store = createStore<Talk | null, Talk | null>(null, (_, next) => next);
let controls: Controls | null = null;

export const talkStore = store;
export const talkNow = () => store.get();

/** A call or voice chat began, or changed: who runs it hands over how to mute and end it. */
export function setTalk(talk: Talk, how: Controls) {
  controls = how;
  store.dispatch(talk);
}

/** It changed in place (muted, its state): nothing new to hand over. */
export function updateTalk(patch: Partial<Talk>) {
  const now = store.get();
  if (now) store.dispatch({ ...now, ...patch });
}

/** It's over. */
export function clearTalk() {
  controls = null;
  store.dispatch(null);
}

/** Mute or end from outside the screen that runs it (the Live Activity's buttons). */
export const muteTalk = () => controls?.mute();
export const endTalk = () => controls?.end();
