// Voice chat, as one session for the whole app rather than one box's state: it starts from a box's round button, and it
// keeps going when what you said starts a chat and the app pushes it (Home's box sends, the thread's box carries on).
// Whichever box is on the focused screen draws its bar and does its listening; the rest only read it.
//
// While it is on it holds the app's audio session (system/audio.ts), so the microphone is live, its level drives the
// bars, and it goes on with the phone locked or the app in the background; and it is the conversation out loud the
// lock screen shows (system/talk.ts), whose Mute and End reach it here from anywhere. The prototype hears one scripted
// line per session (shell/composer/hearing.ts) and sends it; the agent's reply is spoken aloud when it lands in the
// chat, after a short acknowledgement if it is slow to come, and then it listens again. A real build streams the
// microphone to the runtime instead.
import { focusedRoute } from "../../nav/ref";
import { store } from "../../store/store";
import { canSpeak, holdAudio, setMicMuted, speak, stopSpeaking } from "../../system/audio";
import { ackFor, replyTo } from "../../system/speaking";
import { clearTalk, setTalk, talkNow, updateTalk } from "../../system/talk";
import { createStore, useSelector } from "../../store/core";

export type VoicePhase = "listening" | "hearing" | "answering";

export interface VoiceSession {
  on: boolean;
  muted: boolean;
  phase: VoicePhase;
  /** The words coming in, before they're sent. */
  heard: string;
  /** The prototype's one line has been said and sent. */
  said: boolean;
  /** When it started, for its clock. */
  since: number;
}

const OFF: VoiceSession = { on: false, muted: false, phase: "listening", heard: "", said: false, since: 0 };

export const voice = createStore<VoiceSession, (s: VoiceSession) => VoiceSession>(OFF, (s, change) => change(s));
const set = (patch: Partial<VoiceSession>) => voice.dispatch((s) => ({ ...s, ...patch }));

export const useVoice = <T>(pick: (s: VoiceSession) => T) => useSelector(voice, pick);

/** Voice chat is the conversation the lock screen shows: what it's doing there, in a word. */
const ours = () => talkNow()?.kind === "voice";
const says = (state: string) => {
  if (ours() && talkNow()?.state !== state) updateTalk({ state });
};
/** The chat on screen, when it's one: where a tap on the lock screen goes back to. */
const chatOnScreen = () => {
  const top = focusedRoute();
  return top?.name === "Thread" ? top.id : undefined;
};

let release: (() => void) | null = null;

export function startVoice() {
  if (voice.get().on) return;
  const since = Date.now();
  voice.dispatch(() => ({ ...OFF, on: true, since }));
  release?.();
  release = holdAudio("voice");
  setMicMuted(false);
  setTalk({ kind: "voice", who: "Voice chat", chat: chatOnScreen(), since, muted: false, state: "Listening" }, { mute: toggleMute, end: endVoice });
}

export function endVoice() {
  const was = voice.get().on;
  stopAnswering();
  voice.dispatch(() => OFF);
  if (!was) return;
  stopSpeaking();
  release?.();
  release = null;
  setMicMuted(false);
  if (ours()) clearTalk();
}

export function toggleMute() {
  const now = voice.get();
  if (!now.on) return;
  const muted = !now.muted;
  voice.dispatch((s) => ({ ...s, muted }));
  setMicMuted(muted);
  if (ours()) updateTalk({ muted });
}

export const hearVoice = (heard: string) => set({ heard, phase: heard ? "hearing" : "listening" });

// ---------------------------------------------------------------- the answer

/** With nothing to say it aloud (the web), "Answering…" holds this long, as the prototype always had it. */
const QUIET_ANSWER_MS = 3200;
/** The answer not there by now: a short acknowledgement first, as a person says "on it" before the work. */
const ACK_MS = 1500;
/** How long the answer is waited for after the acknowledgement, still listening meanwhile. */
const REPLY_WAIT_MS = 60_000;

let answering: { stop: () => void } | null = null;
let acks = 0;

function stopAnswering() {
  answering?.stop();
  answering = null;
}

/** Back to listening, here and on the lock screen. */
function listenAgain() {
  voice.dispatch((s) => (s.on && s.phase === "answering" ? { ...s, phase: "listening" } : s));
  says("Listening");
}

/**
 * What was heard (`words`) has been sent: it waits for the answer, says it, then listens again. The answer is the
 * agent's first words after your message in the chat it went to (speaking.ts `replyTo`), heard from the store as they
 * land, never from a frame, so it is heard with the app in the background too. The chat it went to becomes the one
 * the lock screen goes back to, whether or not anything here can speak.
 */
export function voiceSent(words = "") {
  set({ heard: "", said: true, phase: "answering" });
  says("Thinking");
  stopAnswering();

  const quiet = !canSpeak();
  const since = Date.now();
  let chat: string | null = null;
  let replied = false;
  let over = false;
  let watching = true;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const unwatch = store.watch((next, prev) => {
    if (next.board.chats !== prev.board.chats) look();
  });
  const unlook = () => {
    if (watching) unwatch();
    watching = false;
  };
  const stop = () => {
    over = true;
    unlook();
    timers.forEach(clearTimeout);
  };
  const mine = { stop };
  answering = mine;

  // Nothing here can say it (the web): "Answering…" for as long as the prototype always held it, and only the chat
  // is looked for.
  if (quiet) {
    timers.push(
      setTimeout(() => {
        if (answering === mine) listenAgain();
      }, QUIET_ANSWER_MS),
      setTimeout(unlook, REPLY_WAIT_MS),
    );
    look();
    return;
  }

  const say = (text: string, then: () => void) => {
    voice.dispatch((s) => (s.on ? { ...s, phase: "answering" } : s));
    says("Speaking");
    // Ended, or a new answer began, while it spoke: that one moves the session on, not this.
    void speak(text).then(() => {
      if (answering === mine) then();
    });
  };
  function look() {
    if (over || !watching) return;
    const chats = store.get().board.chats;
    const found = replyTo(chat ? chats.filter((c) => c.id === chat) : chats, words, since);
    if (!found) return;
    if (found.chat !== chat) {
      chat = found.chat;
      if (ours() && talkNow()?.chat !== chat) updateTalk({ chat });
    }
    if (quiet) return unlook();
    if (!found.text || replied) return;
    replied = true;
    stop();
    say(found.text, () => {
      if (answering === mine) answering = null;
      listenAgain();
    });
  }

  timers.push(
    setTimeout(() => {
      if (replied || over) return;
      say(ackFor(acks++), () => {
        if (!replied && !over) listenAgain();
      });
    }, ACK_MS),
    setTimeout(() => {
      stop();
      if (answering === mine) answering = null;
      listenAgain();
    }, ACK_MS + REPLY_WAIT_MS),
  );
  look();
}

// In development the session sits beside the store's on `globalThis.__cc`: `__cc.voice.get()`.
if (__DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, voice };
}
