import { expect, test } from "vitest";
import { answered, answerFor, failed, rangeOf, type Answer } from "./answer.ts";

const file = (path: string) => ({
  path,
  status: "added" as const,
  additions: 7,
  deletions: 0,
  patch: "@@ -0,0 +1 @@\n+x\n",
});
const all = rangeOf(undefined, undefined);
const turn3 = rangeOf("checkpoint:2", "checkpoint:3");
const none: Answer = { range: all, diff: null, error: null };

test("after a scope switch the scope before's files never show under the new one's name, loading or failed", () => {
  const allChanges = answered(none, all, {
    from: "main",
    to: "WORKTREE",
    files: [file("all-only/a.ts"), file("all-only/b.ts")],
  });
  // Turn 3 picked in the scope menu: its fs.diff is out.
  expect(answerFor(allChanges, turn3)).toEqual({ range: turn3, diff: null, error: null });
  // It fails: the surface's own error with Retry, not all changes labelled Turn 3.
  expect(answerFor(failed(allChanges, turn3, "checkpoint not readable"), turn3)).toEqual({
    range: turn3,
    diff: null,
    error: "checkpoint not readable",
  });
});

test("a failed Refresh of the scope shown keeps its files and says why on the Refresh button", () => {
  const shown = answered(none, turn3, { from: "c2", to: "c3", files: [file("src/x.ts")] });
  const refreshed = answerFor(failed(shown, turn3, "relay closed"), turn3);
  expect(refreshed.diff).toBe(shown.diff);
  expect(refreshed.error).toBe("relay closed");
  // The next answer clears it and keeps the unchanged files' objects.
  const again = answered(refreshed, turn3, { from: "c2", to: "c3", files: [file("src/x.ts")] });
  expect(again).toEqual({ range: turn3, diff: shown.diff, error: null });
});
