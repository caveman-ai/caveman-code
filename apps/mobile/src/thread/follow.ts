// Following a chat's end, as data (screens/Thread.tsx): a latch the reader owns. Only a hand lets go of it: a drag, a
// wheel turned up, a key, VoiceOver's three-finger scroll (each reaches the list as onUserScroll), or the start of a
// drag on a phone. The list moving by itself never does: a fold closing, the browser clamping the offset as the
// content shrinks, room under a sent turn coming and going. Coming back within 4pt of the end, the jump circle or
// sending takes it back. Pure, so it can be read and tested without React Native.

/** Within this of the end you are at it: following comes back. */
export const AT_END = 4;
/** More than this between the last real row and the foot's band: you are away, and the jump circle shows. */
export const AWAY = 16;
/** A scroll this soon after a hand touched the list is the hand's. */
export const HAND_MS = 300;

export interface Follow {
  following: boolean;
  /** When a hand last touched the list. */
  handAt: number;
  /** When a hand last let go of the end. */
  releasedAt: number;
}

export const createFollow = (following = true): Follow => ({ following, handAt: Number.NEGATIVE_INFINITY, releasedAt: Number.NEGATIVE_INFINITY });

const release = (f: Follow, now: number) => {
  if (f.following) f.releasedAt = now;
  f.following = false;
};

/**
 * A hand on the list. `distance` is how far it is from the end now; `up`: it is already moving away from the end
 * (a wheel turned up), so it lets go even at the end, before the list has scrolled.
 */
export function touch(f: Follow, now: number, distance: number, up = false) {
  f.handAt = now;
  if (up || distance > AT_END) release(f, now);
}

/**
 * A scroll event. `ours`: within 2pt of where the screen itself last put the list (a glide, a pin). `hold`: a fold
 * opened by hand keeps its line under your thumb until then, and nothing takes the end back meanwhile.
 */
export function scrolled(f: Follow, e: { now: number; distance: number; ours: boolean; hold?: number }) {
  if (e.distance <= AT_END) {
    if (e.now >= (e.hold ?? 0)) f.following = true;
    return;
  }
  // Only a hand moves the list away from the end: a scroll that isn't ours and comes with no hand on the list is the
  // list itself (content that shrank, a clamped offset), and the latch holds.
  if (!e.ours && e.now - f.handAt < HAND_MS) release(f, e.now);
}

/**
 * Away from the end, measured from the bottom of the last real row: the room a sent turn keeps under itself
 * (`anchored`) is no distance at all.
 */
export const awayOf = (distance: number, anchored = 0) => distance - anchored > AWAY;

/**
 * Whether the screen holds a turn open that just finished, rather than folding it now (DECISIONS.md O4): while a
 * finger is down, until it lifts; while you are reading inside it, which is only so when a hand let go of the end
 * since the turn began and the turn is on screen.
 */
export function holdOf(f: Follow, e: { touching: boolean; began: number; inView: boolean }): "release" | "view" | null {
  if (e.touching) return "release";
  if (!f.following && f.releasedAt >= e.began && e.inView) return "view";
  return null;
}
