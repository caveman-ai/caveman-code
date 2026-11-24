// Muting the Chief's ring back ("Mute for…" on the incoming card): held in Settings on the runtime, so it spans
// every device and a relaunch, and the runtime itself stops ringing (chief/voice/Call.ts `ringMuted`). A timed mute
// is `chief_voice_ring_muted_until`; "until I turn it back on" is Ring me back off. Pure, so the card and the pill
// stay small and the dates are testable.
import type { Settings } from "@caveman-app/session-protocol";

export type MuteOption = "15m" | "1h" | "morning" | "manual";

export const MUTE_OPTIONS: ReadonlyArray<{ readonly id: MuteOption; readonly label: string }> = [
  { id: "15m", label: "15 minutes" },
  { id: "1h", label: "1 hour" },
  { id: "morning", label: "Until tomorrow morning" },
  { id: "manual", label: "Until I turn it back on" },
];

/** Tomorrow at 8 in the morning, local time. */
export const tomorrowMorning = (now: Date): Date => {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
};

/** The settings a choice saves. */
export function muteSettings(option: MuteOption, now: Date): Pick<Settings, "chief_voice_ring_back" | "chief_voice_ring_muted_until"> {
  switch (option) {
    case "15m":
      return { chief_voice_ring_muted_until: new Date(now.getTime() + 15 * 60_000).toISOString() };
    case "1h":
      return { chief_voice_ring_muted_until: new Date(now.getTime() + 60 * 60_000).toISOString() };
    case "morning":
      return { chief_voice_ring_muted_until: tomorrowMorning(now).toISOString() };
    case "manual":
      return { chief_voice_ring_back: false };
  }
}

/** One click: rings again, whichever way they were muted. */
export const unmuteSettings = (): Pick<Settings, "chief_voice_ring_back" | "chief_voice_ring_muted_until"> => ({ chief_voice_ring_back: true, chief_voice_ring_muted_until: null });

export type RingMute = { readonly kind: "manual" } | { readonly kind: "until"; readonly until: Date };

/** How rings are muted right now, or null. Off until further notice wins over a timed mute. */
export function ringMute(settings: Pick<Settings, "chief_voice_ring_back" | "chief_voice_ring_muted_until"> | null | undefined, now: Date): RingMute | null {
  if (!settings) return null;
  if (settings.chief_voice_ring_back === false) return { kind: "manual" };
  const until = typeof settings.chief_voice_ring_muted_until === "string" ? new Date(settings.chief_voice_ring_muted_until) : null;
  return until !== null && until.getTime() > now.getTime() ? { kind: "until", until } : null;
}

/** "Calls muted", or "Calls muted until 9:15 AM" (with the day when it is not today). */
export function muteLabel(mute: RingMute, now: Date, locale = "en-US"): string {
  if (mute.kind === "manual") return "Calls muted";
  const sameDay = mute.until.toDateString() === now.toDateString();
  const time = mute.until.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Calls muted until ${time}` : `Calls muted until ${mute.until.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}
