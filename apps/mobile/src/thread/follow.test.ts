// Following the end (follow.ts): only a hand lets go of it. A queued follow-up that runs to its end with nobody
// touching the phone keeps the reader at the end through every shrink and clamp, its turn folds, and the jump circle
// never shows.
import { describe, expect, it } from "vitest";
import { awayOf, createFollow, holdOf, scrolled, touch } from "./follow";

describe("following the end", () => {
  it("holds through a queued follow-up that runs to settle with no input", () => {
    const f = createFollow();
    const began = 1_000;
    let now = began;
    // The answer streams: the list glides after each line (ours), landing at the end.
    for (let i = 0; i < 20; i++) {
      now += 16;
      scrolled(f, { now, distance: 6, ours: true });
      scrolled(f, { now, distance: 0, ours: true });
    }
    // The turn before it folds away: the content shrinks 1503 → 1321, the browser clamps the offset back by 182.
    // That scroll isn't the screen's own, and it isn't a hand's.
    now += 16;
    scrolled(f, { now, distance: 182, ours: false });
    expect(f.following).toBe(true);
    // The room under the sent turn comes and goes: still not a hand.
    now += 16;
    scrolled(f, { now, distance: 52, ours: false });
    expect(f.following).toBe(true);
    // The turn finishes: nothing holds it open, so it folds now.
    expect(holdOf(f, { touching: false, began, inView: true })).toBe(null);
    // And the jump circle stays away: the room under a sent turn is no distance from the end.
    expect(awayOf(0, 0)).toBe(false);
    expect(awayOf(52, 52)).toBe(false);
  });

  it("lets go when a hand scrolls away, and holds a turn you are reading inside", () => {
    const f = createFollow();
    const began = 1_000;
    // A wheel turned up at the end lets go before the list has moved.
    touch(f, 2_000, 0, true);
    expect(f.following).toBe(false);
    expect(holdOf(f, { touching: false, began, inView: true })).toBe("view");
    // Scrolled out of it: the turn folds.
    expect(holdOf(f, { touching: false, began, inView: false })).toBe(null);
    // Back within 4pt of the end: following again.
    scrolled(f, { now: 3_000, distance: 2, ours: false });
    expect(f.following).toBe(true);
  });

  it("lets go when a drag that began at the end moves away, but not long after the hand lifted", () => {
    const f = createFollow();
    touch(f, 1_000, 0);
    expect(f.following).toBe(true);
    scrolled(f, { now: 1_050, distance: 40, ours: false });
    expect(f.following).toBe(false);
    const g = createFollow();
    touch(g, 1_000, 0);
    scrolled(g, { now: 5_000, distance: 40, ours: false });
    expect(g.following).toBe(true);
  });

  it("doesn't hold a turn for a hand that let go before it began", () => {
    const f = createFollow();
    touch(f, 500, 100);
    expect(holdOf(f, { touching: false, began: 1_000, inView: true })).toBe(null);
    expect(holdOf(f, { touching: true, began: 1_000, inView: true })).toBe("release");
  });

  it("measures away from the last real row", () => {
    expect(awayOf(300, 0)).toBe(true);
    expect(awayOf(300, 290)).toBe(false);
    expect(awayOf(17, 0)).toBe(true);
  });
});
