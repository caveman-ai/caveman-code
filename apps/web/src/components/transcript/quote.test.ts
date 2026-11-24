import { expect, test } from "vitest";
import { placeQuote, quoteBlock } from "./QuoteSelection.tsx";

test("a quote goes in the box behind > on each line, with a blank line to write under", () => {
  expect(quoteBlock("  the retry fires at once  ")).toBe("> the retry fires at once\n\n");
  expect(quoteBlock("first line\r\n\r\nthird line")).toBe("> first line\n>\n> third line\n\n");
});

test("at the caret when the box has it, else at the end, always on lines of its own", () => {
  const q = "> x\n\n";
  expect(placeQuote("", null, q)).toEqual({ at: 0, insert: q });
  expect(placeQuote("why is", null, q)).toEqual({ at: 6, insert: `\n\n${q}` });
  expect(placeQuote("why is\n", null, q)).toEqual({ at: 7, insert: `\n${q}` });
  expect(placeQuote("a\n\nb", 3, q)).toEqual({ at: 3, insert: q });
});
