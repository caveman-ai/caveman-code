import { afterEach, expect, test, vi } from "vitest";
import { restoreRefs, type ThreadRef } from "../components/thread-refs.ts";
import { DRAFTS_KEY, flushDrafts, keepDraft, keptDraft, readDraft, writeDraft, type DraftStorage } from "./composer-drafts.ts";

const memory = (): DraftStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

test("a chat's draft comes back after leaving it, with its pills; sending (an empty draft) clears it", () => {
  const s = memory();
  const ref: ThreadRef = { id: 7, workspace_id: "w2", title: "Auth fix", start: 4, end: 13 };
  writeDraft(s, "chat:w1", { text: "see @Auth fix and finish", refs: [ref] });
  writeDraft(s, "new-chat", { text: "a new idea", refs: [] });
  const back = readDraft(s, "chat:w1")!;
  expect(back.text).toBe("see @Auth fix and finish");
  expect(back.refs).toEqual([{ workspace_id: "w2", title: "Auth fix", start: 4, end: 13 }]);
  expect(restoreRefs(back.text, back.refs).map((r) => [r.title, r.start, r.end])).toEqual([["Auth fix", 4, 13]]);
  writeDraft(s, "chat:w1", { text: "", refs: [] });
  expect(readDraft(s, "chat:w1")).toBeNull();
  expect(readDraft(s, "new-chat")?.text).toBe("a new idea");
  writeDraft(s, "new-chat", { text: "  ", refs: [] });
  expect(s.data.has(DRAFTS_KEY)).toBe(false);
});

test("drafts are capped (newest kept) and a broken store reads as empty", () => {
  const s = memory();
  for (let i = 0; i < 55; i++) writeDraft(s, `chat:${i}`, { text: `draft ${i}`, refs: [] }, 1000 + i);
  expect(readDraft(s, "chat:0")).toBeNull();
  expect(readDraft(s, "chat:54")?.text).toBe("draft 54");
  expect(Object.keys(JSON.parse(s.data.get(DRAFTS_KEY)!) as object)).toHaveLength(50);
  s.data.set(DRAFTS_KEY, "{not json");
  expect(readDraft(s, "chat:54")).toBeNull();
  // A huge paste is not stored.
  writeDraft(s, "chat:big", { text: "x".repeat(100_001), refs: [] });
  expect(readDraft(s, "chat:big")).toBeNull();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Composer.tsx keeps each edit (keepDraft), flushes its box when it unmounts (flushDrafts) and reads it back on mount
// (keptDraft).
test("a pasted log too long to store comes back after leaving the box, and goes once the box is sent", () => {
  const s = memory();
  vi.stubGlobal("localStorage", s);
  keepDraft("new-chat:log", { text: "a short note", refs: [] });
  flushDrafts("new-chat:log");
  const log = "x".repeat(150_000);
  keepDraft("new-chat:log", { text: log, refs: [] });
  flushDrafts("new-chat:log");
  expect(keptDraft("new-chat:log")?.text.length).toBe(log.length);
  // Never stored, and the older short draft is not what comes back after a reload.
  expect(readDraft(s, "new-chat:log")).toBeNull();
  keepDraft("new-chat:log", { text: "", refs: [] });
  flushDrafts("new-chat:log");
  expect(keptDraft("new-chat:log")).toBeNull();
});

test("a pasted log too long to store outlives the background write while the box stays open", () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", memory());
  const log = "y".repeat(150_000);
  keepDraft("chief:log", { text: log, refs: [] });
  vi.advanceTimersByTime(300);
  expect(keptDraft("chief:log")?.text.length).toBe(log.length);
  // Cut back under the limit, it is stored again.
  keepDraft("chief:log", { text: "y", refs: [] });
  vi.advanceTimersByTime(300);
  expect(keptDraft("chief:log")?.text).toBe("y");
  expect(readDraft(localStorage as DraftStorage, "chief:log")?.text).toBe("y");
});

test("a kept pill whose text no longer matches is dropped, the rest get fresh ids", () => {
  const text = "@Auth fix and /review";
  const refs = [
    { workspace_id: "w2", title: "Auth fix", start: 0, end: 9 },
    { workspace_id: "w3", title: "Gone", start: 2, end: 7 },
    { workspace_id: "", title: "review", skill: "review", start: 14, end: 21 },
  ];
  const out = restoreRefs(text, refs);
  expect(out.map((r) => r.title)).toEqual(["Auth fix", "review"]);
  expect(new Set(out.map((r) => r.id)).size).toBe(2);
});
