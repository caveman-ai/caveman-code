// Sessions their views let go of that stay attached (runtime.tsx LIVE_UNSEEN): a chat switched away from, kept rendered
// and hidden by its pane, or the split view behind the Chief. Shown again, such a chat is live at once: there is no
// re-attach to wait for and nothing to catch up on after it paints. The most recent ones stay; the oldest detaches.

export interface UnseenSessions {
  /** Keep `key` attached with nobody showing it; past the limit the oldest kept one detaches. */
  keep(key: object, detach: () => void): void;
  /** A view holds it again: true when it was still attached (nothing to open). */
  take(key: object): boolean;
  has(key: object): boolean;
}

export function unseenSessions(limit: number): UnseenSessions {
  // Insertion order is age: the first entry is the one let go of longest ago.
  const kept = new Map<object, () => void>();
  return {
    keep(key, detach) {
      kept.delete(key);
      kept.set(key, detach);
      while (kept.size > limit) {
        const [oldest, close] = kept.entries().next().value!;
        kept.delete(oldest);
        close();
      }
    },
    take: (key) => kept.delete(key),
    has: (key) => kept.has(key),
  };
}
