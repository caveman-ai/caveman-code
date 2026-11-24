// Talking out loud, as plain functions (system/audio.ts and shell/composer/voice.ts run them; speaking.test.ts checks
// them): the words a line is spoken as, the voice it is spoken in, how long it takes to read when nothing speaks it,
// the microphone's level from its decibels, and the agent's reply to what voice chat sent.
import type { Chat } from "../board/model";

/** A voice the phone offers (expo-speech's `Voice`, which says "Enhanced" or "Default"; a premium voice is "Default"). */
export interface VoiceInfo {
  identifier: string;
  name: string;
  quality: string;
  language: string;
}

/** The most a line says out loud: a reply longer than this is cut at its last full sentence. */
export const SPOKEN_MAX = 320;

/**
 * A line as it is said: no markdown, no code, links by their words or their host, list items and lines as sentences,
 * "#491" as "number 491", and at most `max` characters, cut where a sentence ends. Chat ids (`[[id]]`) are the
 * caller's to turn into titles first (chief/turns.ts `spoken`).
 */
export function forSpeech(text: string, max = SPOKEN_MAX): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/([^/\s)]+)\S*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, "$1$2")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, "")
    .replace(/\s*→\s*/g, " to ")
    .replace(/[ \t]+·[ \t]+/g, ", ")
    .replace(/#(\d+)/g, "number $1");
  const said = plain
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,…]$/.test(line) ? line : `${line}.`))
    .join(" ");
  if (said.length <= max) return said;
  const cut = said.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max / 4) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : max)}…`;
}

/** How long a line takes to read when nothing says it aloud (the web, no voice): the prototype's speech bubble. */
export const readingMs = (text: string) => Math.max(2800, text.split(/\s+/).filter(Boolean).length * 280);

/** Novelty voices iOS ships beside the real ones (Fred, Bubbles, the Eloquence set): never a Chief's voice. */
const NOVELTY = /speech\.synthesis\.voice|eloquence|\.(?:albert|bahh|bells|boing|bubbles|cellos|deranged|goodnews|badnews|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph)\b/i;
/** Voices that sound like a person at the default rate, when two of the same quality tie. */
const NATURAL = /^(?:ava|zoe|evan|nathan|samantha|allison|susan|tom|noelle|joelle|serena|daniel|jamie|stephanie|karen|moira|tessa)\b/i;

/**
 * How good a voice is for talking to you, higher better, below 0 never: premium over enhanced over the compact ones,
 * then the phone's own English (`region`, "GB"), then American, then British English.
 */
export function voiceRank(voice: VoiceInfo, region?: string): number {
  const language = voice.language.replace("_", "-");
  if (!/^en(?:-|$)/i.test(language) || NOVELTY.test(voice.identifier)) return -1;
  const id = voice.identifier.toLowerCase();
  let rank = id.includes(".premium.") ? 300 : id.includes(".enhanced.") || voice.quality === "Enhanced" ? 200 : 100;
  const lang = language.toLowerCase();
  if (region && lang === `en-${region.toLowerCase()}`) rank += 30;
  else if (lang === "en-us") rank += 20;
  else if (lang === "en-gb") rank += 10;
  if (NATURAL.test(voice.name)) rank += 3;
  return rank;
}

/** The best voice there is to talk in, or null when the phone has no English voice worth it. */
export function bestVoice(voices: readonly VoiceInfo[], region?: string): VoiceInfo | null {
  let best: VoiceInfo | null = null;
  let bestRank = -1;
  for (const voice of voices) {
    const rank = voiceRank(voice, region);
    if (rank > bestRank) [best, bestRank] = [voice, rank];
  }
  return best;
}

/**
 * The microphone's average power (dBFS, -160 to 0, as AVAudioRecorder meters it) as 0 to 1: a quiet room near 0, a
 * voice at arm's length most of the way up.
 */
export function levelOf(db: number | undefined | null): number {
  if (db === undefined || db === null || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 55) / 40));
}

/** The level the bars show next: up at once with a word, back down gently between words. */
export const smooth = (shown: number, heard: number) => shown + (heard - shown) * (heard > shown ? 0.7 : 0.3);

/** What the voice says at once when the answer isn't there yet, in turn, like a person would. */
const ACKS = ["On it.", "Okay, on it.", "Sure, I'll do that.", "Got it."] as const;
export const ackFor = (n: number) => ACKS[((n % ACKS.length) + ACKS.length) % ACKS.length]!;

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Where what voice chat sent landed, and the agent's first words back: the chat with your message (`words`, sent at or
 * after `since`) and the first text after it, or null text while it hasn't said anything yet. Null while the message
 * isn't on the board.
 */
export function replyTo(chats: readonly Pick<Chat, "id" | "items">[], words: string, since: number): { chat: string; text: string | null } | null {
  if (!words.trim()) return null;
  for (const chat of chats) {
    const items = chat.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      // `since` is taken before the box sends, so your message is never older than it.
      if (item.kind !== "you" || item.at < since || !same(item.text, words)) continue;
      for (let j = i + 1; j < items.length; j++) {
        const next = items[j]!;
        if (next.kind === "text" && next.text.trim()) return { chat: chat.id, text: next.text };
      }
      return { chat: chat.id, text: null };
    }
  }
  return null;
}
