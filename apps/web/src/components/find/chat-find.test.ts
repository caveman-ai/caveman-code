import { expect, test } from "vitest";
import { rows } from "../transcript/rows.ts";
import { findHits, hitCount, occurrences, shownText, stepHit } from "./chat-find.ts";
import { findable, rowHolds } from "./useChatFind.ts";

test("counts matches case-insensitively, without overlaps", () => {
  expect(occurrences("Retry retry RETRY", "retry")).toEqual([0, 6, 12]);
  expect(occurrences("aaaa", "aa")).toEqual([0, 2]);
  expect(occurrences("anything", "")).toEqual([]);
});

test("an answer is searched as the page shows it, not as its markdown", () => {
  const md = "## Fix\n\n- **Jitter** the [retry window](docs/retry.md#L2) by `30 s`\n\n```go\nwait := jitter(base)\n```";
  const shown = shownText(md);
  expect(shown).toContain("Fix");
  expect(shown).toContain("Jitter the retry window by 30 s");
  expect(shown).toContain("wait := jitter(base)");
  expect(shown).not.toContain("docs/retry.md");
  expect(shown).not.toContain("**");
  expect(shown).not.toContain("```");
});

test("hits run in transcript order, each message's in reading order; the count wraps both ways", () => {
  const hits = findHits(
    [
      { id: "u1", text: "the retry fires at once" },
      { id: "a1", text: "No retry jitter. Retry storms follow." },
      { id: "u2", text: "ship it" },
    ],
    "retry",
  );
  expect(hits).toEqual([
    { id: "u1", occurrence: 0 },
    { id: "a1", occurrence: 0 },
    { id: "a1", occurrence: 1 },
  ]);
  expect(findHits([{ id: "u1", text: "x" }], "  ")).toEqual([]);
  expect(stepHit(2, 3, 1)).toBe(0);
  expect(stepHit(0, 3, -1)).toBe(2);
  expect(stepHit(0, 0, 1)).toBe(0);
  expect(hitCount(1, 3)).toBe("2/3");
  expect(hitCount(0, 0)).toBe("0/0");
});

test("find reads the person's messages, every answer and what each tool worked on, folded ones too", () => {
  const at = "2026-10-17T10:00:00.000Z";
  const items = [
    { kind: "user", id: "u1", text: "fix the **retry**", at, delivery: "message" },
    { kind: "assistant", id: "a1", text: "Looking at retry.go first.", streaming: false, at },
    { kind: "tool", id: "t1", name: "read", verb: "Read", subject: "retry.go", icon: "read", toolKind: "read", status: "done", output: "", at, added: 0, removed: 0, input: {}, result: null },
    { kind: "compaction", id: "c1", status: "done", before: 100, after: 10, at },
    { kind: "assistant", id: "a2", text: "Fixed: the **retry** now jitters.", streaming: false, at },
    { kind: "turn_end", id: "e1", outcome: "completed", at, cursor: 9 },
  ] as unknown as Parameters<typeof findable>[0];
  // The person's words as typed; answers as the page shows them; the tool's subject. t1 folds into Worked for; a1 stays in view.
  expect(findable(items)).toEqual([
    { id: "u1", text: "fix the **retry**" },
    { id: "a1", text: "Looking at retry.go first." },
    { id: "t1", text: "retry.go" },
    { id: "a2", text: "Fixed: the retry now jitters." },
  ]);
  // Stepping to the tool call mounts the fold that holds it.
  const fold = rows(items).find((r) => r.kind === "fold")!;
  expect(rowHolds(fold, "t1")).toBe(true);
  expect(rowHolds(fold, "a2")).toBe(false);
});
