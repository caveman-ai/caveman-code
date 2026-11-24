// A box's side of voice chat: the box on the focused screen listens while the session is on (voice.ts), sends what it
// heard through its own `onSend`, starts the session when a screen asks it to, and tells its screen how the session
// stands. Every box reads the one session, so starting a chat by voice on Home carries on in the chat it pushes.
import { useEffect, useRef } from "react";
import { haptic } from "../../motion";
import { useHearing } from "./hearing";
import { hearVoice, startVoice, useVoice, type VoiceSession, voiceSent } from "./voice";

export interface VoiceReport {
  /** Off, listening for you, words coming in, sent and being answered, muted, or done for now. */
  mode: "off" | "listening" | "hearing" | "answering" | "muted" | "spent";
  heard: string;
}

export function useVoiceChat({ speech, listens, onSend, ask, onVoice }: { /** What the prototype hears. */ speech: string; /** This box is the one on the focused screen, and may listen. */ listens: boolean; onSend: (words: string) => void; /** Bumped to start the session from outside. */ ask: number; onVoice?: (voice: VoiceReport) => void }): VoiceSession {
  const voice = useVoice((s) => s);
  const listening = voice.on && !voice.muted && !voice.said && listens;
  const talk = useHearing(speech, listening, (words) => {
    haptic.done();
    voiceSent(words);
    onSend(words);
  });
  useEffect(() => {
    if (listening) hearVoice(talk.heard);
  }, [listening, talk.heard]);
  useEffect(() => {
    if (ask > 0) startVoice();
  }, [ask]);

  const mode: VoiceReport["mode"] = !voice.on ? "off" : voice.muted ? "muted" : voice.phase;
  const report = useRef(onVoice);
  report.current = onVoice;
  useEffect(() => {
    report.current?.({ mode, heard: voice.heard });
  }, [mode, voice.heard]);
  return voice;
}
