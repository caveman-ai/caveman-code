// What the box is and what its one round button does, as pure functions, so every box (Home's, a chat's, a subagent's,
// a Chief's) reads the same rules and a test can pin them (docs/ "Composer", O6).
//
// The round button reads voice, then send, then stop: voice chat with the field empty, send once there are words, and
// stop while a turn runs and the field is empty. While a turn runs, words steer it (the desktop's Enter); queueing for
// after the turn is the hold menu's other item and a VoiceOver action, never the default. Right after a send it holds a
// neutral beat (600 ms) before it turns into stop, so a second tap meant for send never stops the turn it just started.

/**
 * Which box this is. `new` starts a chat (Home, a list, a workspace), `thread` follows up in one, `subagent` is a
 * child's (no voice chat, no retry of its own), `chief` talks to a Chief (its round button calls instead of voice).
 */
export type Variant = "new" | "thread" | "subagent" | "chief";

export type Primary = "voice" | "call" | "send" | "steer" | "stop" | "settling" | "none";

export interface PrimaryInput {
  /** Nothing typed or heard. */
  empty: boolean;
  /** A turn is running in this chat. */
  running: boolean;
  /** Inside the neutral beat after a send. */
  settling: boolean;
  variant: Variant;
  /** Voice chat is already on (the bar above the box holds it, so the round button steps aside). */
  voiceOn: boolean;
}

/** How long the round button holds still after a send before it can become stop. */
export const SETTLE_MS = 600;

export function resolvePrimary({ empty, running, settling, variant, voiceOn }: PrimaryInput): Primary {
  if (settling) return "settling";
  if (!empty) return running ? "steer" : "send";
  if (running) return "stop";
  if (variant === "chief") return "call";
  // A subagent has no voice chat: its box is `+`, the field and the mic.
  if (variant === "subagent" || voiceOn) return "none";
  return "voice";
}

/** What VoiceOver says the round button does, and what the hold menu offers beside it. */
export function primaryLabel(primary: Primary, who?: string): string {
  switch (primary) {
    case "voice":
      return "Start voice chat";
    case "call":
      return `Call ${who ?? "the Chief"}`;
    case "send":
      return who ? `Send to ${who}` : "Send";
    case "steer":
      return "Steer the work";
    case "stop":
      return "Stop";
    case "settling":
      return "Sent";
    case "none":
      return "";
  }
}

export interface PlaceholderInput {
  variant: Variant;
  running: boolean;
  /** Who a Chief's box talks to: "the Chief", "Oona". */
  who?: string;
  /** A new chat's own ask ("Start a chat in marketing"). */
  custom?: string;
  /** The mode `+` set, by its word. */
  mode?: string | null;
  /** The mic is on and nothing has been heard yet. */
  listening?: boolean;
}

/** What the empty field asks for, in each state (DECISIONS.md: never "Follow up…" while a turn runs). */
export function resolvePlaceholder({ variant, running, who, custom, mode, listening }: PlaceholderInput): string {
  if (listening) return "Listening…";
  if (variant === "chief") return `Ask ${who ?? "the Chief"}…`;
  if (running) return "Steer the work…";
  if (mode === "Goal") return "Describe the goal to keep pursuing";
  if (mode === "Plan") return "What should it plan?";
  if (mode === "Grill me") return "What should it grill you on?";
  if (variant === "new") return custom ?? "What should we build?";
  return "Follow up…";
}

/**
 * The box's geometry, in points (DECISIONS.md Home 7 and 8). At rest a 56pt capsule
 * with 36pt circles drawn 10 in from its ends and hit at 44; focused, a card of the same width and corner, 12 above the
 * keyboard, that grows with the words to 40% of the screen. A new chat's card starts at 198, room for its context row
 * and a few lines; a chat's starts at what it holds (grabber, one line, toolbar: 110), so a steer typed over the
 * keyboard leaves the work in view.
 */
export const BOX = {
  rest: 56,
  radius: 28,
  /** The capsule's bottom above the home indicator's safe area. */
  lift: 8,
  /** The card's bottom above the keyboard. */
  overKeyboard: 12,
  /** A new chat's card's least height (a chat's card has none past what it holds). */
  card: 198,
  /** The card's most, as a share of the screen. */
  most: 0.4,
  /** Circles inside the box: drawn this big, hit at 44. */
  circle: 36,
  /** From the box's edge to a circle, and between neighbours. */
  pad: 10,
  gap: 8,
  /** The field's line: 17 on 22 (the desktop's composer at a phone's reading size). */
  line: 22,
  /** The field's top in the card: under the grabber, or under the grabber and the context row. */
  fieldTop: 30,
  fieldTopWithRow: 62,
  /** The thumbnails of what's attached, over the toolbar. */
  thumbs: 56,
  /** A queued follow-up's row, opened in a chat's card over the field. */
  queued: 44,
  /** At rest in a chat, the next queued follow-up as the box's own first row, over a hairline (composer/Queue.tsx). */
  tray: 36,
  /** At rest, a draft shows up to this many lines, then "…". */
  restLines: 3,
  /** What rides on the box (`above`) sits this far over its top. */
  above: 10,
} as const;

export interface CardInput {
  /** How tall the words are, laid out at the card's width. */
  words: number;
  /** The context row is shown (a new chat's: where it runs). */
  row: boolean;
  /** Something is attached. */
  thumbs: boolean;
  /** How tall the opened queue stands over the field (a chat's card), else 0. */
  tray?: number;
  screen: number;
}

/**
 * The card's height for what's in it, at most 40% of the screen with the field scrolling past that. A new chat's card
 * (the one with a context row) is never under 198; a chat's is as tall as its one line, its toolbar and what's opened
 * over them.
 */
export function cardHeight({ words, row, thumbs, tray = 0, screen }: CardInput): number {
  const top = (row ? BOX.fieldTopWithRow : BOX.fieldTop) + tray;
  const foot = BOX.pad + BOX.circle + 12 + (thumbs ? BOX.thumbs + 10 : 0);
  const want = top + Math.max(BOX.line, words) + foot;
  // Thumbnails take the room a new chat's empty field doesn't need before its card grows for them.
  const least = row ? BOX.card : top + BOX.line + foot;
  const most = Math.max(least, Math.round(screen * BOX.most));
  return Math.min(most, Math.max(least, want));
}
