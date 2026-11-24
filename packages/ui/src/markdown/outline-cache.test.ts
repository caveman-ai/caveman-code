import { unified } from "unified";
import { afterEach, expect, test, vi } from "vitest";
import { markdownOutline } from "./Markdown";

afterEach(() => vi.restoreAllMocks());

// Count the real parser, rather than substituting an outline implementation.
const countParses = () => vi.spyOn(Object.getPrototypeOf(unified), "parse");

test("revisiting the exact source reuses its outline without exposing cached objects", () => {
  const parse = countParses();
  const source = "# Cached outline\n\n## Install\n\n## Install\n\n```md\n# hidden\n```\n\n### Café & *friends*";
  const first = markdownOutline(source);
  const expected = first.map((entry) => ({ ...entry }));
  // A consumer may reorder/splice its array; runtime JS can also alter an entry despite readonly typing.
  first.reverse();
  Object.assign(first[0]!, { id: "consumer-change", text: "changed" });
  first.pop();
  expect(markdownOutline(source)).toEqual(expected);
  expect(parse).toHaveBeenCalledTimes(1);
  const edited = markdownOutline(source.replace("## Install", "## Start"));
  expect(edited.map((entry) => entry.id)).toEqual(["md-cached-outline", "md-start", "md-install", "md-café--friends"]);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(markdownOutline(source)).toEqual(expected);
  expect(parse).toHaveBeenCalledTimes(2);
});

test("entry pressure evicts the least recently used outline, not the one just revisited", () => {
  const source = (i: number) => `# Outline count limit ${i}`;
  for (let i = 0; i < 32; i++) markdownOutline(source(i));
  const parse = countParses();
  markdownOutline(source(0));
  expect(parse).not.toHaveBeenCalled();
  markdownOutline(source(32));
  markdownOutline(source(0));
  expect(parse).toHaveBeenCalledTimes(1);
  markdownOutline(source(1));
  expect(parse).toHaveBeenCalledTimes(2);
});

test("source size bounds retained outlines even below the entry limit", () => {
  const first = `# Outline size first\n\n${"a".repeat(300_000)}`;
  const second = `# Outline size second\n\n${"b".repeat(300_000)}`;
  markdownOutline(first);
  const parse = countParses();
  markdownOutline(first);
  expect(parse).not.toHaveBeenCalled();
  markdownOutline(second);
  markdownOutline(second);
  expect(parse).toHaveBeenCalledTimes(1);
  markdownOutline(first);
  expect(parse).toHaveBeenCalledTimes(2);
});

test("an oversized heading bypasses the cache without evicting a useful small outline", () => {
  const small = "# Outline kept beside oversized source";
  // The source fits alone, but its derived heading text and id exceed the combined budget.
  const huge = `# ${"z".repeat(200_000)}`;
  markdownOutline(small);
  const parse = countParses();
  expect(markdownOutline(huge)[0]!.text.length).toBe(200_000);
  expect(markdownOutline(huge)[0]!.text.length).toBe(200_000);
  markdownOutline(small);
  expect(parse).toHaveBeenCalledTimes(2);
});
