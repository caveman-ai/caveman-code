import { formatThreadReference } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import type { TranscriptItem } from "../state/transcript-model.ts";
import { historyKey, promptEntries, stepPrompt } from "./prompt-history.ts";

const at = "2026-10-17T10:00:00.000Z";
const user = (id: string, text: string, extra: Partial<Extract<TranscriptItem, { kind: "user" }>> = {}): TranscriptItem => ({ kind: "user", id, text, at, delivery: "message", ...extra });

test("the history is the person's own messages, a repeat once, another agent's left out", () => {
  const link = formatThreadReference("w2", "Auth fix");
  const entries = promptEntries([
    user("u1", "fix the retry"),
    { kind: "assistant", id: "a1", text: "Done.", streaming: false, at },
    user("u2", "fix the retry"),
    user("m1", "the lead says hi", { from: { title: "Lead" } }),
    user("u3", `and see ${link}`),
  ]);
  expect(entries.map((e) => [e.id, e.shown])).toEqual([
    ["u2", "fix the retry"],
    ["u3", "and see @Auth fix"],
  ]);
});

test("↑ walks back from an empty box, ↓ forward and out to an empty box; typed text is never replaced", () => {
  const entries = promptEntries([user("u1", "one"), user("u2", "two")]);
  const back1 = stepPrompt("back", entries, null, "")!;
  expect(back1.entry?.shown).toBe("two");
  const back2 = stepPrompt("back", entries, back1.position, "two")!;
  expect(back2.entry?.shown).toBe("one");
  expect(stepPrompt("back", entries, back2.position, "one")).toBeNull();
  const fwd = stepPrompt("forward", entries, back2.position, "one")!;
  expect(fwd.entry?.shown).toBe("two");
  expect(stepPrompt("forward", entries, fwd.position, "two")).toEqual({ position: null, entry: null });
  // Typed by hand (or edited after a recall): arrows move the caret instead.
  expect(stepPrompt("back", entries, null, "draft")).toBeNull();
  expect(stepPrompt("back", entries, back1.position, "two, edited")).toBeNull();
  expect(stepPrompt("forward", entries, null, "")).toBeNull();
  expect(stepPrompt("back", [], null, "")).toBeNull();
});

test("only a bare ↑ on the first line or ↓ on the last walks the history", () => {
  const bare = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
  expect(historyKey({ ...bare, key: "ArrowUp" }, "", 0, 0)).toBe("back");
  expect(historyKey({ ...bare, key: "ArrowDown" }, "", 0, 0)).toBe("forward");
  expect(historyKey({ ...bare, key: "ArrowUp" }, "one\ntwo", 2, 2)).toBe("back");
  expect(historyKey({ ...bare, key: "ArrowUp" }, "one\ntwo", 5, 5)).toBeNull();
  expect(historyKey({ ...bare, key: "ArrowDown" }, "one\ntwo", 2, 2)).toBeNull();
  expect(historyKey({ ...bare, key: "ArrowDown" }, "one\ntwo", 5, 5)).toBe("forward");
  expect(historyKey({ ...bare, key: "ArrowUp", shiftKey: true }, "", 0, 0)).toBeNull();
  expect(historyKey({ ...bare, key: "ArrowUp", metaKey: true }, "", 0, 0)).toBeNull();
  expect(historyKey({ ...bare, key: "ArrowUp" }, "abc", 0, 3)).toBeNull();
  expect(historyKey({ ...bare, key: "ArrowLeft" }, "", 0, 0)).toBeNull();
});
