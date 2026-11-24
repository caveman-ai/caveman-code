// The keyboard's place (place.ts): the `+` menu stands at the keyboard's own height, so swapping the one for the other
// leaves the box, and the chat over it, where they were; the chat rides up with the box only as far as the box rises
// past the empty room under its last line; and only the box that told it lifts its own chat.
import { describe, expect, it, vi } from "vitest";
import { blankOf, clearRise, KEYBOARD_GUESS, liftOf, menuHeight, rideOf, riseNow, riseOf, setRise } from "./place";
import { BOX } from "./state";

// Reanimated and its worklets don't load outside an app; the arithmetic here needs only a value to hold.
vi.mock("react-native-reanimated", () => ({
  makeMutable: <T,>(value: T) => ({ value }),
  Easing: { out: (f: (t: number) => number) => f, quad: (t: number) => t * t },
  useAnimatedReaction: vi.fn(),
  useDerivedValue: vi.fn(),
  useSharedValue: vi.fn(),
  withTiming: (to: number) => to,
}));
vi.mock("react-native-worklets", () => ({ scheduleOnUI: (fn: () => void) => fn() }));

describe("menuHeight", () => {
  it("is the keyboard's last height", () => {
    expect(menuHeight(336, 874)).toBe(336);
    expect(menuHeight(301, 874)).toBe(301);
  });

  it("guesses a phone's keyboard before one has shown", () => {
    expect(menuHeight(0, 874)).toBe(KEYBOARD_GUESS);
  });

  it("stays within reason for the screen", () => {
    expect(menuHeight(120, 874)).toBe(280);
    expect(menuHeight(700, 874)).toBe(437);
    // A screen too short for the least: half of it.
    expect(menuHeight(336, 500)).toBe(250);
  });
});

describe("riseOf", () => {
  it("is nothing with the foot empty", () => {
    expect(riseOf(0, 34)).toBe(0);
  });

  it("is the same for the keyboard and the menu at its height, so the swap moves nothing", () => {
    const keyboard = 336;
    expect(riseOf(menuHeight(keyboard, 874), 34)).toBe(riseOf(keyboard, 34));
  });

  it("measures from where the box rests to where it rides", () => {
    // Resting 8 over a 34pt home indicator; riding 12 over a 336pt keyboard.
    expect(riseOf(336, 34)).toBe(336 + BOX.overKeyboard - (34 + BOX.lift));
  });
});

describe("liftOf, the box's top over its rest", () => {
  it("is nothing at rest", () => {
    expect(liftOf(0, 34, 56, 56)).toBe(0);
  });

  it("is the rise over a keyboard, as the box's own place has it", () => {
    expect(liftOf(336, 34, 56, 56)).toBe(riseOf(336, 34));
    // Part of the way up, it is part of the rise; under the box's resting place, nothing.
    expect(liftOf(168, 34, 56, 56)).toBe(168 + BOX.overKeyboard - (34 + BOX.lift));
    expect(liftOf(20, 34, 56, 56)).toBe(0);
  });

  it("grows with the card, line by line", () => {
    // A chat's card is 110 with one line; a second line makes it 132.
    expect(liftOf(336, 34, 110, 56)).toBe(riseOf(336, 34) + 54);
    expect(liftOf(336, 34, 132, 56)).toBe(riseOf(336, 34) + 76);
  });

  it("grows only past what opening the box freed over it", () => {
    // The floating row stepping away as the card opens frees 26 over a chat's box: the card grows into that first.
    expect(liftOf(0, 34, 110, 56, 26)).toBe(28);
    expect(liftOf(0, 34, 70, 56, 26)).toBe(0);
  });

  it("never drops the chat under its rest", () => {
    // A queued follow-up's row at rest stands taller than the opened card: the chat stays where it was.
    expect(liftOf(0, 34, 110, 92, 26)).toBe(0);
  });
});

describe("rideOf, how far the chat rides with the box", () => {
  it("is the box's whole lift for a chat at its end with no room under it", () => {
    expect(rideOf(306, 0)).toBe(306);
  });

  it("is nothing while the box rises within the empty room under the last line", () => {
    expect(rideOf(306, 420)).toBe(0);
  });

  it("is what the box rises past that room", () => {
    expect(rideOf(306, 120)).toBe(186);
  });
});

describe("blankOf, the empty room under a chat's last row", () => {
  it("is the room under a sent turn", () => {
    expect(blankOf(380, 874, 874)).toBe(380);
  });

  it("is what a short chat leaves of the screen", () => {
    expect(blankOf(0, 874, 500)).toBe(374);
  });

  it("is nothing for a chat longer than its screen", () => {
    expect(blankOf(0, 874, 3000)).toBe(0);
  });
});

describe("the box's rise, as React knows it", () => {
  it("is heard by its own chat only", () => {
    setRise("chat-a", 306);
    expect(riseNow("chat-a")).toBe(306);
    expect(riseNow("chat-b")).toBe(0);
    clearRise("chat-a");
    expect(riseNow("chat-a")).toBe(0);
  });

  it("isn't taken away by another box going", () => {
    setRise("chat-a", 306);
    clearRise("chat-b");
    setRise("chat-b", 0);
    expect(riseNow("chat-a")).toBe(306);
    setRise("chat-a", 0);
    expect(riseNow("chat-a")).toBe(0);
  });
});
