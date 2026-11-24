// , apps/web/src/components/chat/timelineScrollTarget.ts at 13aa882c22 (MIT).
// A tool/code scroller owns its gesture until it reaches an edge that permits scroll chaining.
export function isConversationScrollTarget(target: EventTarget | null, viewport: HTMLElement, deltaY: number): boolean {
  if (!(target instanceof Element) || !viewport.contains(target) || deltaY === 0) return false;
  for (let element: Element | null = target; element && element !== viewport; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
    const canScroll = deltaY < 0 ? element.scrollTop > 0 : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return false;
  }
  return true;
}

/** Editing or operating a control must not detach the surrounding conversation. */
export function isConversationScrollKey(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"], [role="combobox"], [role="menu"], [role="listbox"], [role="tree"], [role="tablist"]');
}

/**
 * How a conversation moves, in one place so the scroll lab (apps/web/src/components/transcript/turn-top.browser.html)
 * can tune it live against the real scroller: every frame reads it. The values here are what ships.
 */
export const conversationTuning = {
  /** The end shows the latest turn from its start, with empty room under a short reply. */
  room: true,
  /** At most this share of the view is ever empty room: under 1, a short turn stops partway up instead of at the top. */
  maxRoom: 1,
  /** Px past the content's top padding where the latest turn's start lands. */
  inset: 0,
  /**
   * How firmly a sent message pulls the view to the end, in 1/s. The pull is a critically damped spring: the view
   * eases out of rest and into the end without passing it, and at 18 is there in about a third of a second.
   */
  arriveRate: 18,
  /** Further from the end than this many screens, an arrival does not travel the whole way... */
  arriveFar: 1.5,
  /** ...it starts this many screens from the end: enough travel to read as coming down the chat. */
  arriveFrom: 0.75,
  /** The share of the way to the end a following view moves each frame. */
  glide: 0.2,
};
export type ConversationTuning = typeof conversationTuning;
export const DEFAULT_TUNING: Readonly<ConversationTuning> = { ...conversationTuning };

const tuned = new Set<() => void>();
/** Changes the tuning and has every mounted conversation take it up at once (the lab's sliders). */
export function tune(next: Partial<ConversationTuning>): void {
  Object.assign(conversationTuning, next);
  for (const f of tuned) f();
}
/** Called when the tuning changes; returns the unsubscribe. */
export function onTune(f: () => void): () => void {
  tuned.add(f);
  return () => void tuned.delete(f);
}

/**
 * The view `ms` later on its way to `target`: where it is and how fast it moves (px/s). The spring's own solution,
 * not a step of it, so a 60 Hz and a 120 Hz screen trace the same curve and a late frame lands where it should.
 */
export function arriveStep(at: number, speed: number, target: number, ms: number, rate = conversationTuning.arriveRate): { at: number; speed: number } {
  const t = Math.max(0, ms) / 1000;
  const away = at - target;
  const pull = speed + rate * away;
  const decay = Math.exp(-rate * t);
  return { at: target + (away + pull * t) * decay, speed: (speed - rate * pull * t) * decay };
}

/** What a conversation marks as its latest turn's start: the row the end brings to the top. */
export const TURN_ANCHOR = "data-conversation-anchor";
/**
 * An absolutely placed column whose bottom reaches down through the room, so what sticks inside it (the message rail)
 * stays in view over the room instead of being carried up with the content's end.
 */
export const ROOM_REACH = "data-conversation-reach";

/**
 * The empty room kept under a conversation's content so its end shows the latest turn from its start, `inset` from
 * the top (where the first message of a new chat sits): a short reply leaves space under it rather than leaving the
 * question halfway down the screen. None once the turn fills the view; the end is then its last line, as before.
 * `anchorTop` is the turn's start from the content's top, `contentHeight` the content's height without the room;
 * `maxShare` caps the room at that share of the view.
 */
export function tailRoom(anchorTop: number, contentHeight: number, viewHeight: number, inset: number, maxShare = 1): number {
  return Math.max(0, Math.min(viewHeight * maxShare, Math.ceil(anchorTop + viewHeight - inset - contentHeight)));
}
