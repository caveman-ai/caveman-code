import { describe, expect, test } from "vitest";
import { formatThreadReference, parseThreadReferences } from "../src/references.ts";

describe("thread references", () => {
  test("round-trip and positions", () => {
    const id = "6f1c2b9e-4d3a-4f7e-9a51-0c2d8e7b1a44";
    const link = formatThreadReference(id, "Fix [flaky]\nCI");
    expect(link).toBe(`[Fix flaky CI](t3-context://v1/thread/${id})`);
    const text = `see ${link} and ${formatThreadReference("w2", "Other")}`;
    const refs = parseThreadReferences(text);
    expect(refs.map((r) => [r.workspace_id, r.label])).toEqual([[id, "Fix flaky CI"], ["w2", "Other"]]);
    expect(text.slice(refs[0]!.start, refs[0]!.end)).toBe(link);
  });
  test("ignores other kinds and bad ids", () => {
    expect(parseThreadReferences("[a](t3-context://v1/file/x) [b](t3-context://v1/thread/bad id)")).toEqual([]);
    expect(formatThreadReference("w1", "  ")).toBe("[thread](t3-context://v1/thread/w1)");
  });
  test("a long label is cut before an emoji, never through it", () => {
    const link = formatThreadReference("w1", `${"x".repeat(199)}😀`);
    expect(link).toBe(`[${"x".repeat(199)}](t3-context://v1/thread/w1)`);
    expect(link.isWellFormed()).toBe(true);
  });
});
