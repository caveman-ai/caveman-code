// Where the shell's columns go (split.ts): the iPhone Duo unfolded gets two columns either way up and the rail on its
// side; folded, in a narrow window and on any iPhone, even on its side, it stays the phone.
import { describe, expect, it } from "vitest";
import { deriveLayout } from "./split";

const none = { top: 0, bottom: 0, left: 0, right: 0 };

describe("deriveLayout", () => {
  it("gives the Duo's inner screen on its side two columns and the rail", () => {
    expect(deriveLayout(890, 626, none)).toEqual({
      split: true,
      side: 285,
      rail: 72,
      three: false,
    });
  });

  it("gives the Duo's inner screen upright two columns and no rail", () => {
    expect(deriveLayout(626, 890, none)).toEqual({ split: true, side: 260, rail: 0, three: false });
  });

  it("keeps the Duo folded, and every iPhone either way up, on the phone's shell", () => {
    for (const [w, h] of [
      [466, 678],
      [402, 874],
      [874, 402],
      [440, 956],
      [956, 440],
    ] as const) {
      expect(deriveLayout(w, h, none).split).toBe(false);
    }
  });

  it("counts only the room inside the side insets", () => {
    // 640 wide, but 48 of it on each side is the system's: too narrow for two columns.
    expect(deriveLayout(640, 700, { ...none, left: 48, right: 48 }).split).toBe(false);
  });

  it("takes the vertical bar's width from the system when it says, else 72", () => {
    expect(deriveLayout(890, 626, { ...none, right: 88 }).rail).toBe(88);
    expect(deriveLayout(890, 626, { ...none, right: 20 }).rail).toBe(72);
  });

  it("opens the inspector beside the sidebar only where both fit with the panel", () => {
    expect(deriveLayout(1280, 800, none)).toEqual({
      split: true,
      side: 340,
      rail: 72,
      three: true,
    });
    expect(deriveLayout(1024, 700, none).three).toBe(false);
  });
});
