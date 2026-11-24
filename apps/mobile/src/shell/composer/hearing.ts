// What the prototype "hears": the words of a scripted line arriving one at a time, like a person saying them. Voice
// mode, dictation and a call all listen through it; the microphone is already live under them (system/audio.ts, its
// level on the bars), and a real build hears the words from it instead (docs/chief.md "Dictation", the call's engine).
// Its timers are plain timeouts, never frames, so the words keep coming with the phone locked.
import { useEffect, useRef, useState } from "react";

const WORD_MS = 230;
const PAUSE_MS = 900;

/** Words of `text` arriving while `active`; `onDone` after the last word and a breath. */
export function useHearing(text: string, active: boolean, onDone?: (heard: string) => void) {
  const words = text.split(" ");
  const [count, setCount] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    setCount(0);
    if (!active) return;
    const timers = words.map((_, i) => setTimeout(() => setCount(i + 1), 500 + (i + 1) * WORD_MS));
    timers.push(setTimeout(() => done.current?.(text), 500 + words.length * WORD_MS + PAUSE_MS));
    return () => timers.forEach(clearTimeout);
  }, [active, text, words.length]);
  return { heard: words.slice(0, count).join(" "), hearing: active && count > 0 && count < words.length };
}
