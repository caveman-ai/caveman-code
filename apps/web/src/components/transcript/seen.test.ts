import { expect, test } from "vitest";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import { seenItems } from "./seen.ts";

const reply = (id: string): TranscriptItem => ({ kind: "assistant", id, text: id, streaming: true, at: "2026-11-06T00:00:00Z" });

test("a returned snapshot settles items received while away, then new output is fresh again", () => {
  const seen = seenItems();
  seen.open([reply("old")]);
  expect(seen.isNew("new")).toBe(true);
  seen.catchUp([reply("old"), reply("new")]);
  expect(seen.isNew("old")).toBe(false);
  expect(seen.isNew("new")).toBe(false);
  expect(seen.isNew("next")).toBe(true);
  seen.add("next");
  expect(seen.isNew("next")).toBe(false);
});

test("catch-up includes a native subagent's nested messages", () => {
  const seen = seenItems();
  seen.open([reply("old")]);
  seen.catchUp([{ kind: "subagent", id: "agent", title: "Nested agent", workspaceId: null, agent: "claude-agent", runner: null, summary: null, status: "running", startedAt: "2026-11-06T00:00:00Z", finishedAt: null, items: [reply("nested")] }]);
  expect(seen.isNew("agent")).toBe(false);
  expect(seen.isNew("nested")).toBe(false);
  expect(seen.isNew("old")).toBe(false);
});
