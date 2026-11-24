import { expect, test } from "vitest";
import { commentKey, keepComments, keptComments, reviewMessage, withComment, withoutComment, type LineComment } from "./comments.ts";

test("comments become one message in file and line order, each with its line's code", () => {
  const comments: LineComment[] = [
    { path: "webhook/retry.go", side: "new", line: 44, code: "  return s.now().Add(jitter(wait))", text: "Use the injected clock here too." },
    { path: "docs/webhooks.md", side: "new", line: 12, code: "| 1 | 30 s |", text: " Say the cap. " },
    { path: "webhook/retry.go", side: "old", line: 41, code: "return s.now().Add(wait).Truncate(time.Minute)", text: "Why was this here?" },
  ];
  expect(reviewMessage(comments)).toBe(
    [
      "Review comments on the changes:",
      "",
      "docs/webhooks.md:12\n`| 1 | 30 s |`\nSay the cap.",
      "",
      "webhook/retry.go, removed line 41\n`return s.now().Add(wait).Truncate(time.Minute)`\nWhy was this here?",
      "",
      "webhook/retry.go:44\n`return s.now().Add(jitter(wait))`\nUse the injected clock here too.",
    ].join("\n"),
  );
});

test("a line's key tells its side apart; comments are kept per chat until cleared", () => {
  expect(commentKey({ path: "a.ts", side: "new", line: 3 })).not.toBe(commentKey({ path: "a.ts", side: "old", line: 3 }));
  const c: LineComment = { path: "a.ts", side: "new", line: 3, code: "x", text: "y" };
  keepComments("w1", [c]);
  expect(keptComments("w1")).toEqual([c]);
  expect(keptComments("w2")).toEqual([]);
  keepComments("w1", []);
  expect(keptComments("w1")).toEqual([]);
});

test("a second comment on a line keeps the first, and Remove takes away only the one beside it", () => {
  const anchor = { path: "src/a.ts", side: "new", line: 12, code: "const x = 1;" } as const;
  const first = withComment([], anchor, "rename this");
  // + on the same line again: LineNotes shows "rename this" above an empty box.
  const both = withComment(first, anchor, "and add a test");
  expect(both.map((c) => c.text)).toEqual(["rename this", "and add a test"]);
  expect(reviewMessage(both)).toBe("Review comments on the changes:\n\nsrc/a.ts:12\n`const x = 1;`\nrename this\n\nsrc/a.ts:12\n`const x = 1;`\nand add a test");
  expect(withoutComment(both, both[0]!).map((c) => c.text)).toEqual(["and add a test"]);
});
