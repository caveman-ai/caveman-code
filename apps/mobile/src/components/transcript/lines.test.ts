// Pure reading of the transcript (lines.ts, markdown-parse.ts): a bubble never folds from a measurement taken at a
// passing narrow width, and a streaming table never shows a raw "|" row or a header with nothing under it.
import { describe, expect, it } from "vitest";
import { bubbleFolds } from "./lines";
import { holdBack } from "./markdown-parse";

const FOLD = 8 * 22;

describe("your bubble", () => {
  it("doesn't fold a 40-character message measured at width 8", () => {
    expect(bubbleFolds("Then run the whole transcript suite again", { height: 900, width: 8 }, 290, FOLD)).toBe(false);
  });
  it("folds a long message by its words alone", () => {
    expect(bubbleFolds("x".repeat(700), null, 290, FOLD)).toBe(true);
    expect(bubbleFolds(Array.from({ length: 10 }, () => "line").join("\n"), null, 290, FOLD)).toBe(true);
  });
  it("folds a shorter one by its height only when measured at a real width", () => {
    const text = "word ".repeat(100);
    expect(bubbleFolds(text, { height: 300, width: 280 }, 290, FOLD)).toBe(true);
    expect(bubbleFolds(text, { height: 300, width: 120 }, 290, FOLD)).toBe(false);
  });
});

describe("a streaming table", () => {
  const table = "Files:\n\n| File | Lines |\n|---|---|\n| Transcript.tsx | +30 |\n";
  it("sets a row as its words arrive once the delimiter is in, closed so it never reads as a raw '|' line", () => {
    expect(holdBack(`${table}| lines.ts | +1`)).toBe(`${table}| lines.ts | +1 |`);
    expect(holdBack(`${table}| lines.ts |`)).toBe(`${table}| lines.ts |`);
    expect(holdBack(`${table}| `)).toBe(table.slice(0, -1));
  });
  it("holds the whole table until its delimiter row is in", () => {
    expect(holdBack("Files:\n\n| File | Lines |\n")).toBe("Files:\n");
    expect(holdBack("Files:\n\n| File | Lines |\n|---|--")).toBe("Files:\n");
  });
  it("leaves a table whose delimiter is in, and text with no table, as they are", () => {
    expect(holdBack(table)).toBe(table);
    expect(holdBack("Plain words still arriving")).toBe("Plain words still arriving");
  });
});
