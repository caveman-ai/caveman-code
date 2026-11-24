import { describe, expect, it } from "vitest";
import { arrowHead, clock, commit, copyName, copyScale, EMPTY, fitScale, halo, INKS, isSlip, MAX_PIXELS, redo, toolForKey, undo, withText, type Mark, type TextEdit } from "./model.ts";

const box: Mark = { kind: "rect", color: "#e5484d", width: 4, from: [0, 0], to: [10, 10] };
const line: Mark = { kind: "line", color: "#e5484d", width: 4, from: [0, 0], to: [10, 0] };
const words: Mark = { kind: "text", color: "#e5484d", size: 18, at: [5, 5], text: "here" };

describe("history", () => {
  it("takes steps back and puts them back", () => {
    const one = commit(EMPTY, [box]);
    const two = commit(one, [box, line]);
    expect(undo(two).marks).toEqual([box]);
    expect(undo(undo(two)).marks).toEqual([]);
    expect(redo(undo(two)).marks).toEqual([box, line]);
  });

  it("stops at either end", () => {
    expect(undo(EMPTY)).toBe(EMPTY);
    const one = commit(EMPTY, [box]);
    expect(redo(one)).toBe(one);
  });

  it("a new step drops what was taken back", () => {
    const back = undo(commit(commit(EMPTY, [box]), [box, line]));
    const next = commit(back, [box, words]);
    expect(next.future).toEqual([]);
    expect(redo(next)).toBe(next);
  });

  it("the same marks are no step", () => {
    const one = commit(EMPTY, [box]);
    expect(commit(one, one.marks)).toBe(one);
  });

  it("clearing can be taken back", () => {
    const cleared = commit(commit(EMPTY, [box, line]), []);
    expect(cleared.marks).toEqual([]);
    expect(undo(cleared).marks).toEqual([box, line]);
  });
});

describe("withText", () => {
  const fresh: TextEdit = { index: null, color: "#ffffff", size: 20, at: [3, 4], text: "fix this  \n" };

  it("adds new words, without the space typed after them", () => {
    expect(withText([box], fresh)).toEqual([box, { kind: "text", color: "#ffffff", size: 20, at: [3, 4], text: "fix this" }]);
  });

  it("keeps a line break inside the words", () => {
    expect(withText([], { ...fresh, text: "one\ntwo" })[0]).toMatchObject({ text: "one\ntwo" });
  });

  it("nothing typed is no mark", () => {
    const marks = [box];
    expect(withText(marks, { ...fresh, text: "  \n " })).toBe(marks);
  });

  it("changes words taken up again, in their place", () => {
    const next = withText([box, words, line], { index: 1, color: words.color, size: 18, at: [5, 5], text: "there" });
    expect(next).toEqual([box, { ...words, text: "there" }, line]);
  });

  it("words taken up and left alone are no step", () => {
    const marks = [box, words];
    expect(withText(marks, { index: 1, color: words.color, size: 18, at: [5, 5], text: "here" })).toBe(marks);
  });

  it("words emptied are removed", () => {
    expect(withText([box, words], { index: 1, color: words.color, size: 18, at: [5, 5], text: "" })).toEqual([box]);
  });
});

describe("fitScale", () => {
  it("shows a screenshot whole, a phone's too", () => {
    expect(fitScale(2000, 1000, 1000, 800)).toBe(0.5);
    expect(fitScale(1000, 2000, 1000, 800)).toBe(0.4);
    expect(fitScale(1170, 2532, 1400, 800)).toBeCloseTo(800 / 2532);
  });

  it("grows a small image, up to 3x", () => {
    expect(fitScale(200, 100, 1000, 800)).toBe(3);
    expect(fitScale(400, 300, 1000, 800)).toBe(2.5);
    expect(fitScale(50, 60, 1000, 800)).toBe(3);
  });

  it("a full-page capture takes the width and scrolls, at no more than its own size", () => {
    expect(fitScale(1440, 12000, 1000, 800)).toBeCloseTo(1000 / 1440);
    expect(fitScale(800, 9000, 1000, 800)).toBe(1);
  });

  it("is 1 before the stage or the picture has a size", () => {
    expect(fitScale(0, 0, 1000, 800)).toBe(1);
    expect(fitScale(100, 100, -48, -48)).toBe(1);
  });
});

describe("copyScale", () => {
  it("a picture shown at its size or smaller is copied at its size", () => {
    expect(copyScale(2000, 1000, 0.5)).toBe(1);
    expect(copyScale(1280, 800, 1)).toBe(1);
  });

  it("one shown enlarged is copied at the next whole multiple, so marks sized for the screen still read", () => {
    // 18px words on a 300 x 150 crop shown at 3x are 6px of its own pixels: 18px again in a 900 x 450 copy.
    expect(copyScale(300, 150, 3)).toBe(3);
    expect(copyScale(1000, 700, 1.2)).toBe(2);
    expect(copyScale(400, 300, 2.5)).toBe(3);
  });

  it("never asks for more pixels than a canvas draws", () => {
    expect(copyScale(5000, 4000, 0.2)).toBeCloseTo(Math.sqrt(MAX_PIXELS / (5000 * 4000)));
    const k = copyScale(3000, 2500, 1.4);
    expect(k).toBeGreaterThan(1);
    expect(3000 * k * 2500 * k).toBeLessThanOrEqual(MAX_PIXELS + 1);
  });
});

describe("shapes", () => {
  it("a drag shorter than the minimum is a click", () => {
    expect(isSlip([0, 0], [2, 2], 4)).toBe(true);
    expect(isSlip([0, 0], [3, 4], 4)).toBe(false);
  });

  it("an arrow's head sits on its tip, square to the shaft", () => {
    const { neck, wings } = arrowHead([0, 0], [100, 0], 4);
    expect(neck).toEqual([82, 0]);
    expect(wings).toEqual([[82, 9], [82, -9]]);
  });

  it("a short arrow keeps a head shorter than itself", () => {
    const { neck } = arrowHead([0, 0], [10, 0], 4);
    expect(neck[0]).toBeCloseTo(3);
  });

  it("an arrow with no length has a head anyway", () => {
    const { neck, wings } = arrowHead([5, 5], [5, 5], 4);
    for (const n of [...neck, ...wings.flat()]) expect(Number.isFinite(n)).toBe(true);
  });
});

describe("halo", () => {
  it("is dark around light inks and light around the rest", () => {
    const dark = "rgba(0, 0, 0, 0.6)";
    const light = "rgba(255, 255, 255, 0.9)";
    const by = Object.fromEntries(INKS.map((ink) => [ink.label, halo(ink.value)]));
    expect(by).toEqual({ Red: light, Orange: dark, Yellow: dark, Green: light, Blue: light, White: dark, Black: light });
  });
});

describe("toolForKey", () => {
  it("names a tool by its key, in either case", () => {
    expect(["p", "R", "o", "a", "L", "t"].map(toolForKey)).toEqual(["pen", "rect", "ellipse", "arrow", "line", "text"]);
    expect(toolForKey("x")).toBeNull();
    expect(toolForKey("Enter")).toBeNull();
  });
});

describe("copyName", () => {
  it("names the copy after the file", () => {
    expect(copyName("shot.png", true, "image/png")).toBe("shot-annotated.png");
    expect(copyName("photo.JPG", true, "image/jpeg")).toBe("photo-annotated.jpg");
    expect(copyName("run.webm", false, "image/png")).toBe("run-frame.png");
  });

  it("a copy marked up again keeps one suffix", () => {
    expect(copyName("shot-annotated.png", true, "image/png")).toBe("shot-annotated.png");
    expect(copyName("run-frame.png", true, "image/png")).toBe("run-annotated.png");
  });

  it("a name with no extension, or none at all, still gets one", () => {
    expect(copyName("Pasted image", true, "image/png")).toBe("Pasted image-annotated.png");
    expect(copyName("", true, "image/png")).toBe("image-annotated.png");
  });
});

describe("clock", () => {
  it("reads minutes, seconds and tenths", () => {
    expect(clock(0)).toBe("0:00.0");
    expect(clock(7.46)).toBe("0:07.4");
    expect(clock(67.4)).toBe("1:07.4");
    expect(clock(Number.NaN)).toBe("0:00.0");
    expect(clock(Number.POSITIVE_INFINITY)).toBe("0:00.0");
  });
});
