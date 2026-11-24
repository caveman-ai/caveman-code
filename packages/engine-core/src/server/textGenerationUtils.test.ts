// ), packages/provider-core/src/server/textGenerationUtils.test.ts @ 86ce795392.
import { describe, expect, it } from "vitest";

import { limitSection, sanitizeCommitSubject, sanitizeThreadTitle } from "./textGenerationUtils.ts";

describe("limitSection", () => {
  it("cuts a long section without splitting an emoji", () => {
    expect(limitSection(`${"a".repeat(9)}🚀 more`, 10)).toBe(`${"a".repeat(9)}\n\n[truncated]`);
  });
});

describe("sanitizeCommitSubject", () => {
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "an emoji with a skin tone", prefixLength: 70, character: "👍🏽" },
    { name: "a flag", prefixLength: 69, character: "🇮🇹" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });

  it("keeps a complete character that ends exactly at the limit", () => {
    const expected = `${"a".repeat(70)}🚀`;

    expect(sanitizeCommitSubject(`${expected} more`)).toBe(expected);
  });

  it("uses the existing fallback when a single character exceeds the limit", () => {
    expect(sanitizeCommitSubject(`a${"\u0301".repeat(72)} more`)).toBe("Update project files");
  });

  it("keeps the existing ASCII limit and subject normalization", () => {
    expect(sanitizeCommitSubject("a".repeat(80))).toBe("a".repeat(72));
    expect(sanitizeCommitSubject("  Fix tests...\nignored  ")).toBe("Fix tests");
    expect(sanitizeCommitSubject("...")).toBe("Update project files");
  });
});

describe("sanitizeThreadTitle", () => {
  it.each([
    { name: "a split surrogate pair", prefixLength: 116, character: "🚀", retained: "" },
    { name: "a complete surrogate pair", prefixLength: 115, character: "🚀", retained: "🚀" },
    { name: "a BMP character", prefixLength: 116, character: "界", retained: "界" },
  ])("truncates without splitting $name", ({ prefixLength, character, retained }) => {
    const prefix = "a".repeat(prefixLength);
    const title = `${prefix}${character} more`;

    expect(sanitizeThreadTitle(title)).toBe(`${prefix}${retained}...`);
  });
});
